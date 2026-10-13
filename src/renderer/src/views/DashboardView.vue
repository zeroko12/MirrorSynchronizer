<script setup lang="ts">
/**
 * DashboardView.vue - 专业运维监控看板 (Ops Monitoring Console)
 *
 * 核心架构:
 * 1. 同步链路拓扑 (Pipeline Topology): 源端 -> 传输引擎 -> 部署目标
 * 2. 关键运行指标 (Telemetry KPIs): 节点状态、文件基数、耗时、快照数
 * 3. 运维控制台指令 (Ops Command Bar): 立即同步、应用暂存、秒级回滚、连通性探测
 * 4. 审计流水摘要 (Audit Stream): 最近执行事务记录
 */

import { ref, computed, onMounted } from 'vue';
import {
  NButton,
  NSpin,
  NPopconfirm,
  useMessage,
} from 'naive-ui';
import { getApi, type StatusInfo, type BackupItem, type HistoryItem } from '../api';
import { useConfig } from '../composables/useConfig';
import { usePolling } from '../composables/usePolling';
import { UI_STATUS_POLL_MS } from '@core/constants';
import { tryLog } from '../utils/try-log';

const emit = defineEmits<{
  (e: 'navigate', tab: 'settings' | 'mappings' | 'backups' | 'history'): void;
}>();

const message = useMessage();
const { config, loading: configLoading, load: loadConfig } = useConfig();

const status = ref<StatusInfo | null>(null);
const backups = ref<BackupItem[]>([]);
const recentHistory = ref<HistoryItem[]>([]);
const fileCount = ref<{ source: number; target: number } | null>(null);
const pendingApplyCount = ref(0);

const syncing = ref(false);
const applyingStaging = ref(false);
const rollingBack = ref(false);
const pinging = ref(false);

async function refreshTelemetry() {
  const s = await tryLog('getStatus', () => getApi().getStatus());
  if (s) status.value = s;

  const fc = await tryLog('countFiles', () => getApi().countFiles());
  if (fc) fileCount.value = fc;

  const bList = await tryLog('backupList', () => getApi().backupList());
  if (bList) backups.value = bList;

  const hList = await tryLog('historyList', () => getApi().historyList({ limit: 5 }));
  if (hList?.items) recentHistory.value = hList.items;

  const pending = await tryLog('syncPendingApplyCount', () => getApi().syncPendingApplyCount());
  if (typeof pending === 'number') pendingApplyCount.value = pending;
}

usePolling(refreshTelemetry, UI_STATUS_POLL_MS, { immediate: true });

onMounted(async () => {
  await loadConfig();
  await refreshTelemetry();
});

// 节点就绪与状态判定
const isConfigured = computed(() => {
  return Boolean(config.value?.sourceDir && config.value?.targetDir);
});

const pipelineStatus = computed(() => {
  if (!isConfigured.value) return { code: 'UNCONFIGURED', label: '节点未配置', type: 'default' };
  if (pendingApplyCount.value > 0) return { code: 'PENDING_APPLY', label: '暂存就绪 (待应用)', type: 'info' };
  const lr = status.value?.lastResult;
  if (!lr) return { code: 'WAITING_FIRST_RUN', label: '就绪 (待执行首次同步)', type: 'default' };
  if (!lr.ok) return { code: 'ERROR', label: '同步告警', type: 'error' };
  if (lr.added > 0 || lr.modified > 0 || lr.deleted > 0) return { code: 'DIFF_ACTIVE', label: '已对齐最新版本', type: 'success' };
  return { code: 'IN_SYNC', label: '两端状态完全同步', type: 'success' };
});

const sourceProtocol = computed(() => {
  const src = config.value?.sourceDir || '';
  if (/^https?:\/\//i.test(src)) return 'HTTP(S)';
  if (/^webdav:\/\//i.test(src)) return 'WEBDAV';
  if (/^\\\\/i.test(src)) return 'SMB (UNC)';
  return 'LOCAL FS';
});

// 运维指令执行
async function handleTriggerSync() {
  if (!isConfigured.value) {
    emit('navigate', 'settings');
    return;
  }
  syncing.value = true;
  try {
    const res = await getApi().runSyncNowForce();
    if (res.ok) {
      message.success('同步事务执行完毕');
    } else {
      message.warning(res.error || '同步未完全执行');
    }
    await refreshTelemetry();
  } catch (err) {
    message.error(`执行失败: ${(err as Error).message}`);
  } finally {
    syncing.value = false;
  }
}

async function handleApplyStaging() {
  applyingStaging.value = true;
  try {
    const res = await getApi().syncApplyNow();
    if (res.ok) {
      message.success(`成功原子替换 ${res.applied} 个暂存文件`);
      await refreshTelemetry();
    } else {
      message.error(res.error || '应用失败');
    }
  } catch (err) {
    message.error(`操作异常: ${(err as Error).message}`);
  } finally {
    applyingStaging.value = false;
  }
}

async function handleQuickRollback() {
  if (backups.value.length === 0) {
    message.warning('当前无可用快照');
    return;
  }
  const latestBackup = backups.value[0];
  rollingBack.value = true;
  try {
    const res = await getApi().backupRollback(latestBackup.id);
    if (res.ok) {
      message.success(`已执行原子回退至快照: ${new Date(latestBackup.createdAt).toLocaleString('zh-CN')}`);
      await refreshTelemetry();
    } else {
      message.error(res.error || '回退失败');
    }
  } catch (err) {
    message.error(`回退异常: ${(err as Error).message}`);
  } finally {
    rollingBack.value = false;
  }
}

async function handlePingSource() {
  if (!config.value?.sourceDir) return;
  pinging.value = true;
  try {
    const res = await getApi().sourceTest(config.value.sourceDir);
    if (res.ok) {
      message.success(`源端探测正常 (已发现 ${res.fileCount} 个条目)`);
    } else {
      message.error(`源端不可达: ${res.error || '连接超时'}`);
    }
  } catch (err) {
    message.error(`探测失败: ${(err as Error).message}`);
  } finally {
    pinging.value = false;
  }
}

function formatRelativeTime(ts: number | null | undefined): string {
  if (!ts) return '-';
  const diffSec = Math.floor((Date.now() - ts) / 1000);
  if (diffSec < 60) return `${diffSec}秒前`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}分钟前`;
  return new Date(ts).toLocaleTimeString('zh-CN');
}
</script>

<template>
  <div class="ops-dashboard">
    <n-spin :show="configLoading || syncing">
      <div class="dashboard-stream">
        <!-- 1. 链路拓扑与通道状态栏 (Pipeline Topology) -->
        <div class="topology-panel">
          <div class="topology-header">
            <div class="pipeline-title-group">
              <span class="pipeline-tag">PIPELINE TOPOLOGY</span>
              <span class="pipeline-state-dot" :class="pipelineStatus.code.toLowerCase()" />
              <span class="pipeline-state-label">{{ pipelineStatus.label }}</span>
            </div>

            <div class="topology-controls">
              <n-button
                size="tiny"
                quaternary
                :loading="pinging"
                class="ops-action-btn"
                @click="handlePingSource"
              >
                测试连通性
              </n-button>
              <n-button
                size="tiny"
                type="primary"
                :loading="syncing"
                class="ops-action-btn"
                @click="handleTriggerSync"
              >
                立即同步
              </n-button>
            </div>
          </div>

          <!-- 拓扑三节点视图 -->
          <div class="pipeline-flow">
            <!-- 节点 1: 源端 -->
            <div class="flow-node">
              <div class="node-badge-row">
                <span class="node-kind-badge">{{ sourceProtocol }}</span>
                <span class="node-meta">源端存储</span>
              </div>
              <div class="node-path monospace-text" :title="config?.sourceDir">
                {{ config?.sourceDir || '未配置 SOURCE_DIR' }}
              </div>
              <div class="node-metrics">
                <span class="metric-item">条目: <b>{{ fileCount ? fileCount.source : '-' }}</b></span>
                <span class="metric-divider">/</span>
                <span class="metric-item status-ok">连接正常</span>
              </div>
            </div>

            <!-- 通道传输介质与模式 -->
            <div class="flow-channel">
              <div class="channel-line">
                <div class="channel-pulse" />
              </div>
              <div class="channel-badge">
                <span v-if="config?.syncMode === 'bidirectional'">BIDIRECTIONAL (双向)</span>
                <span v-else>MIRROR (单向镜像)</span>
              </div>
              <div class="channel-mode-sub">
                {{ config?.applyMode === 'staging' ? 'STAGING 原子切换' : 'DIRECT 直接覆写' }}
              </div>
            </div>

            <!-- 节点 2: 目标部署节点 -->
            <div class="flow-node">
              <div class="node-badge-row">
                <span class="node-kind-badge target">DEPLOY TARGET</span>
                <span class="node-meta">目标本地目录</span>
              </div>
              <div class="node-path monospace-text" :title="config?.targetDir">
                {{ config?.targetDir || '未配置 TARGET_DIR' }}
              </div>
              <div class="node-metrics">
                <span class="metric-item">条目: <b>{{ fileCount ? fileCount.target : '-' }}</b></span>
                <span class="metric-divider">/</span>
                <span class="metric-item">保护规则: <b>{{ config?.fileMappings?.filter(m => m.enabled).length ?? 0 }}</b></span>
              </div>
            </div>
          </div>
        </div>

        <!-- 2. 运维监控 KPI 指标卡片行 -->
        <div class="kpi-grid">
          <div class="kpi-card" @click="emit('navigate', 'settings')">
            <div class="kpi-label">目标节点总数</div>
            <div class="kpi-value monospace-text">
              {{ fileCount ? fileCount.target.toLocaleString() : '0' }}
              <span class="kpi-unit">FILES</span>
            </div>
            <div class="kpi-footer">
              源端基准: {{ fileCount ? fileCount.source.toLocaleString() : '0' }}
            </div>
          </div>

          <div class="kpi-card">
            <div class="kpi-label">上次同步耗时</div>
            <div class="kpi-value monospace-text">
              {{ status?.lastResult ? status.lastResult.durationMs : 0 }}
              <span class="kpi-unit">MS</span>
            </div>
            <div class="kpi-footer">
              上次执行: {{ formatRelativeTime(recentHistory[0]?.startedAt) }}
            </div>
          </div>

          <div class="kpi-card" @click="emit('navigate', 'backups')">
            <div class="kpi-label">快照版本归档</div>
            <div class="kpi-value monospace-text">
              {{ backups.length }}
              <span class="kpi-unit">SNAPSHOTS</span>
            </div>
            <div class="kpi-footer">
              <n-popconfirm
                v-if="backups.length > 0"
                @positive-click="handleQuickRollback"
              >
                <template #trigger>
                  <span class="link-span" @click.stop>一键回退到上一版</span>
                </template>
                确定回滚目标目录到上一快照吗?
              </n-popconfirm>
              <span v-else>暂无备份</span>
            </div>
          </div>

          <div class="kpi-card" @click="emit('navigate', 'mappings')">
            <div class="kpi-label">受保护规则项</div>
            <div class="kpi-value monospace-text">
              {{ config?.fileMappings?.filter(m => m.enabled).length ?? 0 }}
              <span class="kpi-unit">RULES</span>
            </div>
            <div class="kpi-footer">
              豁免镜像删除与本地保护
            </div>
          </div>
        </div>

        <!-- 3. Staging 暂存更新警告操作条 (若有就绪文件) -->
        <div v-if="pendingApplyCount > 0" class="staging-alert-panel">
          <div class="staging-alert-content">
            <span class="staging-pill">STAGING READY</span>
            <span class="staging-text">
              检测到 <b>{{ pendingApplyCount }}</b> 个更新文件已暂存，目标程序处于保护状态。点击立即执行秒级原子切换。
            </span>
          </div>
          <n-button
            type="primary"
            size="small"
            :loading="applyingStaging"
            @click="handleApplyStaging"
          >
            立即应用至目标程序
          </n-button>
        </div>

        <!-- 4. 事务流水审计表格 (Audit Stream Table) -->
        <div class="audit-panel">
          <div class="audit-header">
            <span class="audit-title">TRANSACTION AUDIT STREAM (最近事务流水)</span>
            <n-button text type="primary" size="tiny" @click="emit('navigate', 'history')">
              查看全部历史日志 →
            </n-button>
          </div>

          <div class="audit-table-wrapper">
            <table class="ops-table">
              <thead>
                <tr>
                  <th style="width: 170px">执行时间 (UTC/Local)</th>
                  <th style="width: 100px">结果状态</th>
                  <th style="width: 90px">耗时</th>
                  <th style="width: 220px">变更指标 (+增 / ~改 / -删)</th>
                  <th>事务详情</th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="recentHistory.length === 0">
                  <td colspan="5" class="empty-td">暂无同步事务记录</td>
                </tr>
                <tr v-for="item in recentHistory" :key="item.id">
                  <td class="monospace-text">{{ new Date(item.startedAt).toLocaleString('zh-CN') }}</td>
                  <td>
                    <span
                      class="status-pill"
                      :class="item.fatalError === null ? 'status-ok' : 'status-err'"
                    >
                      {{ item.fatalError === null ? 'SUCCESS' : 'FAILED' }}
                    </span>
                  </td>
                  <td class="monospace-text">{{ item.durationMs }}ms</td>
                  <td>
                    <span class="diff-chip add">+{{ item.addedCount }}</span>
                    <span class="diff-chip mod">~{{ item.modifiedCount }}</span>
                    <span class="diff-chip del">-{{ item.deletedCount }}</span>
                  </td>
                  <td class="log-detail-td">
                    <span v-if="item.fatalError" class="err-text">{{ item.fatalError }}</span>
                    <span v-else-if="item.addedCount === 0 && item.modifiedCount === 0 && item.deletedCount === 0" class="muted-text">
                      两端无差异 (一致)
                    </span>
                    <span v-else class="normal-text">
                      同步成功落盘 (包含 {{ item.mappingCopiedCount }} 个映射项)
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </n-spin>
  </div>
</template>

<style scoped>
.ops-dashboard {
  padding: 20px 24px;
  height: 100%;
  overflow-y: auto;
  box-sizing: border-box;
}

.dashboard-stream {
  max-width: 1100px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* 拓扑卡片 (Topology) */
.topology-panel {
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 16px 20px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
}

.topology-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid #f1f5f9;
}

.pipeline-title-group {
  display: flex;
  align-items: center;
  gap: 10px;
}

.pipeline-tag {
  font-size: 11px;
  font-weight: 700;
  color: #64748b;
  letter-spacing: 0.5px;
  font-family: monospace;
}

.pipeline-state-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #94a3b8;
}

.pipeline-state-dot.in_sync,
.pipeline-state-dot.diff_active {
  background: #10b981;
  box-shadow: 0 0 6px rgba(16, 185, 129, 0.6);
}

.pipeline-state-dot.pending_apply {
  background: #3b82f6;
  box-shadow: 0 0 6px rgba(59, 130, 246, 0.6);
}

.pipeline-state-dot.error {
  background: #ef4444;
  box-shadow: 0 0 6px rgba(239, 68, 68, 0.6);
}

.pipeline-state-label {
  font-size: 13px;
  font-weight: 600;
  color: #1e293b;
}

.topology-controls {
  display: flex;
  gap: 8px;
}

/* 拓扑节点流 */
.pipeline-flow {
  display: grid;
  grid-template-columns: 1fr 180px 1fr;
  align-items: center;
  gap: 16px;
}

.flow-node {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  padding: 12px 14px;
}

.node-badge-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.node-kind-badge {
  font-size: 10px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 4px;
  background: #e2e8f0;
  color: #334155;
  font-family: monospace;
}

.node-kind-badge.target {
  background: #dbeafe;
  color: #1e40af;
}

.node-meta {
  font-size: 11px;
  color: #94a3b8;
}

.node-path {
  font-size: 12px;
  color: #0f172a;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-bottom: 8px;
}

.node-metrics {
  font-size: 11px;
  color: #64748b;
  display: flex;
  align-items: center;
  gap: 6px;
}

.metric-divider {
  color: #cbd5e1;
}

.status-ok {
  color: #10b981;
  font-weight: 500;
}

/* 中间通道 */
.flow-channel {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
}

.channel-line {
  width: 100%;
  height: 2px;
  background: #cbd5e1;
  position: relative;
  margin-bottom: 8px;
}

.channel-badge {
  font-size: 10px;
  font-weight: 700;
  color: #2563eb;
  background: #eff6ff;
  border: 1px solid #bfdbfe;
  padding: 2px 8px;
  border-radius: 12px;
  letter-spacing: 0.5px;
  font-family: monospace;
}

.channel-mode-sub {
  font-size: 10px;
  color: #94a3b8;
  margin-top: 4px;
}

/* 运维 KPI 指标卡片 */
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}

.kpi-card {
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 14px 16px;
  cursor: pointer;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.kpi-card:hover {
  border-color: #94a3b8;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
}

.kpi-label {
  font-size: 12px;
  color: #64748b;
  font-weight: 500;
  margin-bottom: 6px;
}

.kpi-value {
  font-size: 22px;
  font-weight: 700;
  color: #0f172a;
  line-height: 1.2;
}

.kpi-unit {
  font-size: 11px;
  font-weight: 600;
  color: #94a3b8;
  margin-left: 4px;
}

.kpi-footer {
  margin-top: 8px;
  font-size: 11px;
  color: #94a3b8;
}

.link-span {
  color: #2563eb;
  cursor: pointer;
  font-weight: 500;
}

.link-span:hover {
  text-decoration: underline;
}

/* Staging 提示条 */
.staging-alert-panel {
  background: #eff6ff;
  border: 1px solid #bfdbfe;
  border-radius: 6px;
  padding: 10px 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.staging-alert-content {
  display: flex;
  align-items: center;
  gap: 10px;
}

.staging-pill {
  font-size: 10px;
  font-weight: 700;
  background: #2563eb;
  color: #ffffff;
  padding: 2px 6px;
  border-radius: 4px;
  font-family: monospace;
}

.staging-text {
  font-size: 12px;
  color: #1e3a8a;
}

/* 审计表格面板 */
.audit-panel {
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 16px;
}

.audit-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.audit-title {
  font-size: 12px;
  font-weight: 700;
  color: #475569;
  letter-spacing: 0.5px;
  font-family: monospace;
}

.audit-table-wrapper {
  overflow-x: auto;
}

.ops-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.ops-table th {
  text-align: left;
  padding: 8px 10px;
  background: #f8fafc;
  color: #64748b;
  font-weight: 600;
  border-bottom: 1px solid #e2e8f0;
  font-size: 11px;
}

.ops-table td {
  padding: 10px;
  border-bottom: 1px solid #f1f5f9;
  color: #334155;
}

.empty-td {
  text-align: center;
  color: #94a3b8;
  padding: 24px 0 !important;
}

.monospace-text {
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, Courier, monospace;
}

.status-pill {
  font-size: 10px;
  font-weight: 700;
  padding: 2px 6px;
  border-radius: 4px;
  font-family: monospace;
}

.status-pill.status-ok {
  background: #dcfce7;
  color: #166534;
}

.status-pill.status-err {
  background: #fee2e2;
  color: #991b1b;
}

.diff-chip {
  display: inline-block;
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 11px;
  font-family: monospace;
  font-weight: 600;
  margin-right: 4px;
}

.diff-chip.add {
  background: #e0f2fe;
  color: #0369a1;
}

.diff-chip.mod {
  background: #fef3c7;
  color: #b45309;
}

.diff-chip.del {
  background: #fee2e2;
  color: #b91c1c;
}

.log-detail-td {
  font-size: 12px;
}

.err-text {
  color: #dc2626;
}

.muted-text {
  color: #94a3b8;
}

.normal-text {
  color: #475569;
}
</style>
