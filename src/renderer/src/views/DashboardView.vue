<script setup lang="ts">
/**
 * DashboardView.vue - 状态看板 (用户友好版)
 *
 * 核心目标:
 * 1. 简单直观呈现当前是否为最新版本
 * 2. 醒目、便捷的一键同步与应用更新操作
 * 3. 清晰明了的更新来源与本机目录展示
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
import { labelOf } from '@core/labels';

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

const isConfigured = computed(() => {
  return Boolean(config.value?.sourceDir && config.value?.targetDir);
});

const statusSummary = computed(() => {
  if (!isConfigured.value) {
    return {
      title: '尚未配置目录',
      desc: '请先设置更新源目录和本机程序目录',
      badgeClass: 'badge-gray',
      badgeText: '未配置',
      icon: 'config',
    };
  }
  if (pendingApplyCount.value > 0) {
    return {
      title: `发现新版本 (${pendingApplyCount.value} 个文件待更新)`,
      desc: '更新文件已下载完成，点击下方按钮即可立即生效',
      badgeClass: 'badge-blue',
      badgeText: '有新版本',
      icon: 'download',
    };
  }
  const lr = status.value?.lastResult;
  if (!lr) {
    return {
      title: '准备就绪',
      desc: '尚未执行首次检查，可点击立即同步',
      badgeClass: 'badge-green',
      badgeText: '就绪',
      icon: 'ready',
    };
  }
  if (!lr.ok) {
    return {
      title: '同步遇到问题',
      desc: recentHistory.value[0]?.fatalError || (status.value?.lastFatalReason ? labelOf(status.value.lastFatalReason) : '未能成功同步，请检查网络或路径权限'),
      badgeClass: 'badge-red',
      badgeText: '同步异常',
      icon: 'error',
    };
  }
  return {
    title: '已是最新版本',
    desc: '本机文件与更新源保持一致',
    badgeClass: 'badge-green',
    badgeText: '已对齐',
    icon: 'success',
  };
});

async function handleSyncNow() {
  syncing.value = true;
  try {
    const res = await getApi().runSyncNowForce();
    if (res.ok) {
      message.success('同步检查完成');
    } else {
      message.warning(res.error || '同步未执行');
    }
    await refreshTelemetry();
  } catch (err) {
    message.error((err as Error).message || '同步异常');
  } finally {
    syncing.value = false;
  }
}

async function handleApplyStaging() {
  applyingStaging.value = true;
  try {
    const res = await getApi().syncApplyNow();
    if (res.ok) {
      message.success(`更新已应用: ${res.applied} 个文件已生效`);
      await refreshTelemetry();
    } else {
      message.error(res.error || '应用更新失败');
    }
  } finally {
    applyingStaging.value = false;
  }
}

async function handleTestConnection() {
  if (!config.value?.sourceDir) return;
  pinging.value = true;
  try {
    const res = await getApi().sourceTest(config.value.sourceDir);
    if (res.ok) {
      message.success(`更新源连接正常 (包含 ${res.fileCount} 个文件)`);
    } else {
      message.error(`更新源无法连接: ${res.error || '请检查路径'}`);
    }
  } finally {
    pinging.value = false;
  }
}

async function handleRollbackLatest() {
  if (backups.value.length === 0) return;
  rollingBack.value = true;
  try {
    const targetB = backups.value[0];
    const res = await getApi().backupRollback(targetB.id);
    if (res.ok) {
      message.success('已成功还原到上一个备份版本');
      await refreshTelemetry();
    } else {
      message.error(res.error || '还原失败');
    }
  } finally {
    rollingBack.value = false;
  }
}

function formatRelativeTime(ts: number | null): string {
  if (!ts) return '尚未同步';
  return new Date(ts).toLocaleString('zh-CN');
}
</script>

<template>
  <div class="user-dashboard-view">
    <n-spin :show="configLoading">
      <div class="dashboard-body">
        <!-- 1. 核心状态大看板 -->
        <div class="status-hero-card">
          <div class="hero-left">
            <div class="hero-badge-row">
              <span class="status-pill" :class="statusSummary.badgeClass">
                {{ statusSummary.badgeText }}
              </span>
              <span class="hero-sync-mode">
                模式: {{ config?.syncMode === 'bidirectional' ? '双向同步' : '单向镜像 (推荐)' }}
              </span>
            </div>
            <h2 class="hero-title">{{ statusSummary.title }}</h2>
            <p class="hero-desc">{{ statusSummary.desc }}</p>
          </div>

          <div class="hero-actions">
            <!-- 暂存更新模式下，有待更新文件时高亮显示应用按钮 -->
            <n-button
              v-if="pendingApplyCount > 0"
              type="primary"
              size="large"
              :loading="applyingStaging"
              class="primary-action-btn"
              @click="handleApplyStaging"
            >
              立即应用新版本 ({{ pendingApplyCount }})
            </n-button>

            <!-- 常规同步按钮 -->
            <n-button
              v-else
              type="primary"
              size="large"
              :loading="syncing"
              class="primary-action-btn"
              @click="handleSyncNow"
            >
              <template #icon>
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2">
                  <polyline points="23 4 23 10 17 10" />
                  <polyline points="1 20 1 14 7 14" />
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                </svg>
              </template>
              立即检查并同步
            </n-button>

            <div class="hero-sub-actions">
              <n-button size="small" :loading="pinging" @click="handleTestConnection">
                测试源连接
              </n-button>
              <n-popconfirm
                v-if="backups.length > 0"
                @positive-click="handleRollbackLatest"
                positive-text="确认还原"
                negative-text="取消"
              >
                <template #trigger>
                  <n-button size="small" :loading="rollingBack">
                    还原上一版本
                  </n-button>
                </template>
                确认还原到上一个历史版本吗？当前内容会被自动备份。
              </n-popconfirm>
            </div>
          </div>
        </div>

        <!-- 2. 路径流向对比卡片 -->
        <div class="path-compare-grid">
          <div class="path-card">
            <div class="path-card-header">
              <span class="path-label">更新来源目录</span>
              <span class="path-meta">{{ fileCount ? `${fileCount.source} 个文件` : '-' }}</span>
            </div>
            <div class="path-value-text" :title="config?.sourceDir">
              {{ config?.sourceDir || '未设置更新来源路径' }}
            </div>
          </div>

          <div class="path-arrow-col">
            <svg class="arrow-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
            <span class="arrow-tip">{{ config?.syncMode === 'bidirectional' ? '双向' : '更新至' }}</span>
          </div>

          <div class="path-card">
            <div class="path-card-header">
              <span class="path-label">本机程序目录</span>
              <span class="path-meta">{{ fileCount ? `${fileCount.target} 个文件` : '-' }}</span>
            </div>
            <div class="path-value-text" :title="config?.targetDir">
              {{ config?.targetDir || '未设置本机安装路径' }}
            </div>
          </div>
        </div>

        <!-- 3. 三栏快捷指标 -->
        <div class="quick-stats-grid">
          <div class="stat-box" @click="emit('navigate', 'history')">
            <span class="stat-title">上次检查时间</span>
            <span class="stat-value small-text">{{ formatRelativeTime(recentHistory.length > 0 ? recentHistory[0].startedAt : null) }}</span>
            <span class="stat-foot">耗时 {{ status?.lastResult?.durationMs ?? 0 }}ms</span>
          </div>

          <div class="stat-box" @click="emit('navigate', 'backups')">
            <span class="stat-title">可用历史备份</span>
            <span class="stat-value">{{ backups.length }} <span class="stat-unit">个版本</span></span>
            <span class="stat-foot">随时可一键还原</span>
          </div>

          <div class="stat-box" @click="emit('navigate', 'mappings')">
            <span class="stat-title">受保护文件规则</span>
            <span class="stat-value">{{ config?.fileMappings?.length ?? 0 }} <span class="stat-unit">条</span></span>
            <span class="stat-foot">免受更新覆盖</span>
          </div>
        </div>

        <!-- 4. 最近同步记录 -->
        <div class="recent-records-card">
          <div class="records-header">
            <span class="records-title">最近同步动态</span>
            <n-button text type="primary" size="small" @click="emit('navigate', 'history')">
              查看全部记录 &gt;
            </n-button>
          </div>

          <div class="records-list">
            <div v-if="recentHistory.length === 0" class="empty-record">
              暂无同步记录，点击上方按钮开始第一次检查
            </div>

            <div v-for="item in recentHistory" :key="item.id" class="record-item">
              <div class="record-time">
                {{ new Date(item.startedAt).toLocaleString('zh-CN') }}
              </div>
              <div class="record-status">
                <span class="mini-tag" :class="item.fatalError === null ? 'tag-ok' : 'tag-err'">
                  {{ item.fatalError === null ? '成功' : '失败' }}
                </span>
              </div>
              <div class="record-changes">
                <span v-if="item.addedCount > 0" class="change-tag add">+{{ item.addedCount }} 新增</span>
                <span v-if="item.modifiedCount > 0" class="change-tag mod">~{{ item.modifiedCount }} 修改</span>
                <span v-if="item.deletedCount > 0" class="change-tag del">-{{ item.deletedCount }} 删除</span>
                <span v-if="item.addedCount === 0 && item.modifiedCount === 0 && item.deletedCount === 0" class="change-tag none">
                  无文件变动
                </span>
              </div>
              <div class="record-duration">
                {{ item.durationMs }}ms
              </div>
            </div>
          </div>
        </div>
      </div>
    </n-spin>
  </div>
</template>

<style scoped>
.user-dashboard-view {
  height: 100%;
  overflow-y: auto;
  padding: 20px 24px;
  box-sizing: border-box;
}

.dashboard-body {
  max-width: 960px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* 核心状态卡片 */
.status-hero-card {
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 20px 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.03);
}

.hero-left {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.hero-badge-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.status-pill {
  font-size: 11px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 4px;
}

.badge-green {
  background: #dcfce7;
  color: #166534;
}

.badge-blue {
  background: #dbeafe;
  color: #1e40af;
}

.badge-red {
  background: #fee2e2;
  color: #991b1b;
}

.badge-gray {
  background: #f1f5f9;
  color: #475569;
}

.hero-sync-mode {
  font-size: 12px;
  color: #64748b;
}

.hero-title {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  color: #0f172a;
}

.hero-desc {
  margin: 0;
  font-size: 13px;
  color: #64748b;
}

.hero-actions {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 10px;
}

.primary-action-btn {
  font-weight: 600;
  padding: 0 20px;
}

.hero-sub-actions {
  display: flex;
  gap: 8px;
}

/* 路径对比卡片 */
.path-compare-grid {
  display: grid;
  grid-template-columns: 1fr 60px 1fr;
  align-items: center;
  gap: 12px;
}

.path-card {
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 14px 16px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.02);
}

.path-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}

.path-label {
  font-size: 12px;
  font-weight: 600;
  color: #475569;
}

.path-meta {
  font-size: 11px;
  color: #94a3b8;
}

.path-value-text {
  font-size: 13px;
  color: #0f172a;
  font-family: "SFMono-Regular", Consolas, monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.path-arrow-col {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: #94a3b8;
}

.arrow-svg {
  width: 20px;
  height: 20px;
}

.arrow-tip {
  font-size: 10px;
  font-weight: 600;
  margin-top: 2px;
}

/* 快捷指标网格 */
.quick-stats-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}

.stat-box {
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 14px 16px;
  cursor: pointer;
  transition: all 0.15s ease;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.stat-box:hover {
  border-color: #cbd5e1;
  background: #f8fafc;
}

.stat-title {
  font-size: 12px;
  color: #64748b;
}

.stat-value {
  font-size: 20px;
  font-weight: 700;
  color: #0f172a;
}

.stat-value.small-text {
  font-size: 14px;
  font-weight: 600;
  padding: 3px 0;
}

.stat-unit {
  font-size: 12px;
  font-weight: normal;
  color: #94a3b8;
}

.stat-foot {
  font-size: 11px;
  color: #94a3b8;
}

/* 最近动态卡片 */
.recent-records-card {
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 16px 20px;
}

.records-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.records-title {
  font-size: 13px;
  font-weight: 700;
  color: #1e293b;
}

.records-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.empty-record {
  text-align: center;
  color: #94a3b8;
  font-size: 12px;
  padding: 20px 0;
}

.record-item {
  display: flex;
  align-items: center;
  padding: 8px 10px;
  border-radius: 6px;
  background: #f8fafc;
  font-size: 12px;
  gap: 12px;
}

.record-time {
  font-family: monospace;
  color: #475569;
  width: 160px;
}

.record-status {
  width: 50px;
}

.mini-tag {
  font-size: 10px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 3px;
}

.mini-tag.tag-ok {
  background: #dcfce7;
  color: #166534;
}

.mini-tag.tag-err {
  background: #fee2e2;
  color: #991b1b;
}

.record-changes {
  flex: 1;
  display: flex;
  gap: 6px;
}

.change-tag {
  font-size: 11px;
  font-family: monospace;
  padding: 1px 5px;
  border-radius: 3px;
}

.change-tag.add {
  background: #e0f2fe;
  color: #0369a1;
}

.change-tag.mod {
  background: #fef3c7;
  color: #b45309;
}

.change-tag.del {
  background: #fee2e2;
  color: #b91c1c;
}

.change-tag.none {
  color: #94a3b8;
}

.record-duration {
  font-family: monospace;
  color: #94a3b8;
  width: 60px;
  text-align: right;
}
</style>
