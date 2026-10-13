<script setup lang="ts">
/**
 * DashboardView.vue - 极简现代化更新中心主面板
 *
 * 核心设计:
 * - 拒绝冗杂信息轰炸:普通用户只需看懂"当前状态"和"一键操作"
 * - 状态大卡片:展示"已是最新" / "发现可用更新" / "正在同步" / "未配置"
 * - 核心一键按钮:检查更新 / 立即同步 / 快速回滚
 * - 关键状态网格:源类型、目标路径、保护项数、历史快照数
 * - 近期更新简报:最近 3 条同步记录
 */

import { ref, computed, onMounted } from 'vue';
import {
  NButton,
  NCard,
  NTag,
  NText,
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

async function refreshAll() {
  const s = await tryLog('getStatus', () => getApi().getStatus());
  if (s) status.value = s;

  const fc = await tryLog('countFiles', () => getApi().countFiles());
  if (fc) fileCount.value = fc;

  const bList = await tryLog('backupList', () => getApi().backupList());
  if (bList) backups.value = bList;

  const hList = await tryLog('historyList', () => getApi().historyList({ limit: 3 }));
  if (hList?.items) recentHistory.value = hList.items;

  const pending = await tryLog('syncPendingApplyCount', () => getApi().syncPendingApplyCount());
  if (typeof pending === 'number') pendingApplyCount.value = pending;
}

usePolling(refreshAll, UI_STATUS_POLL_MS, { immediate: true });

onMounted(async () => {
  await loadConfig();
  await refreshAll();
});

// 状态研判
const isConfigured = computed(() => {
  return Boolean(config.value?.sourceDir && config.value?.targetDir);
});

const isUpToDate = computed(() => {
  if (!isConfigured.value) return false;
  if (pendingApplyCount.value > 0) return false;
  const lr = status.value?.lastResult;
  if (!lr) return true;
  return lr.ok && lr.added === 0 && lr.modified === 0 && lr.deleted === 0;
});

const hasUpdatesAvailable = computed(() => {
  if (!isConfigured.value) return false;
  const lr = status.value?.lastResult;
  if (!lr) return false;
  return lr.ok && (lr.added > 0 || lr.modified > 0 || lr.deleted > 0);
});

// 源类型徽标
const sourceKindTag = computed(() => {
  const src = config.value?.sourceDir || '';
  if (/^https?:\/\//i.test(src)) return { type: 'info', label: 'HTTP 源' };
  if (/^webdav:\/\//i.test(src)) return { type: 'info', label: 'WebDAV' };
  if (/^\\\\/i.test(src)) return { type: 'warning', label: 'SMB 共享' };
  return { type: 'default', label: '本地目录' };
});

// 核心操作
async function handleCheckOrSyncNow() {
  if (!isConfigured.value) {
    emit('navigate', 'settings');
    return;
  }
  syncing.value = true;
  try {
    const res = await getApi().runSyncNowForce();
    if (res.ok) {
      message.success('同步已执行完毕');
    } else {
      message.warning(res.error || '同步未完全执行');
    }
    await refreshAll();
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
      message.success(`成功应用 ${res.applied} 个更新文件`);
      await refreshAll();
    } else {
      message.error(res.error || '应用失败');
    }
  } catch (err) {
    message.error(`应用出错: ${(err as Error).message}`);
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
      message.success(`已一键回退至快照: ${new Date(latestBackup.createdAt).toLocaleString('zh-CN')}`);
      await refreshAll();
    } else {
      message.error(res.error || '回退失败');
    }
  } catch (err) {
    message.error(`回退异常: ${(err as Error).message}`);
  } finally {
    rollingBack.value = false;
  }
}

function formatRelativeTime(ts: number | null | undefined): string {
  if (!ts) return '尚未检查';
  const diffSec = Math.floor((Date.now() - ts) / 1000);
  if (diffSec < 60) return '刚刚';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
  return new Date(ts).toLocaleString('zh-CN');
}
</script>

<template>
  <div class="dashboard-page">
    <n-spin :show="configLoading || syncing">
      <div class="dashboard-container">
        <!-- 1. 未配置欢迎引导卡片 -->
        <n-card
          v-if="!isConfigured"
          class="hero-card hero-not-configured"
          :bordered="false"
        >
          <div class="hero-content">
            <div class="hero-icon">⚙️</div>
            <div class="hero-body">
              <h2 class="hero-title">欢迎使用自动更新检测中心</h2>
              <p class="hero-subtitle">
                您尚未配置源目录或目标目录。两步简单设置，即可开始自动监控与一键更新。
              </p>
              <n-button
                type="primary"
                size="large"
                class="hero-btn"
                @click="emit('navigate', 'settings')"
              >
                立即开始配置
              </n-button>
            </div>
          </div>
        </n-card>

        <!-- 2. 状态主卡片 (已配置) -->
        <n-card
          v-else
          class="hero-card"
          :class="{
            'hero-up-to-date': isUpToDate,
            'hero-update-ready': hasUpdatesAvailable,
            'hero-staging-ready': pendingApplyCount > 0,
          }"
          :bordered="false"
        >
          <div class="hero-content">
            <!-- 图标区 -->
            <div class="hero-icon">
              <span v-if="pendingApplyCount > 0">🚀</span>
              <span v-else-if="hasUpdatesAvailable">📥</span>
              <span v-else-if="status?.lastResult && !status.lastResult.ok">⚠️</span>
              <span v-else>✨</span>
            </div>

            <!-- 主文案区 -->
            <div class="hero-body">
              <div class="hero-badge-row">
                <n-tag
                  v-if="pendingApplyCount > 0"
                  type="info"
                  size="small"
                  round
                >
                  暂存更新已就绪
                </n-tag>
                <n-tag
                  v-else-if="hasUpdatesAvailable"
                  type="warning"
                  size="small"
                  round
                >
                  检测到可用更新
                </n-tag>
                <n-tag
                  v-else
                  type="success"
                  size="small"
                  round
                >
                  已是最新版本
                </n-tag>

                <n-tag
                  :type="sourceKindTag.type as any"
                  size="small"
                  round
                >
                  {{ sourceKindTag.label }}
                </n-tag>

                <n-tag
                  v-if="config.syncMode === 'bidirectional'"
                  type="warning"
                  size="small"
                  round
                >
                  双向同步模式
                </n-tag>
                <n-tag
                  v-else
                  type="default"
                  size="small"
                  round
                >
                  镜像更新模式
                </n-tag>
              </div>

              <h2 class="hero-title">
                <template v-if="pendingApplyCount > 0">
                  有 {{ pendingApplyCount }} 个更新文件等待安全应用
                </template>
                <template v-else-if="hasUpdatesAvailable">
                  已检测到最新更新内容
                </template>
                <template v-else>
                  软件当前处于最新状态
                </template>
              </h2>

              <p class="hero-subtitle">
                <span>上次检查: {{ formatRelativeTime(recentHistory[0]?.startedAt) }}</span>
                <span v-if="fileCount"> · 目标程序共 {{ fileCount.target }} 个文件</span>
                <span v-if="status?.running"> · 自动守护中 (每 {{ status.intervalSec }} 秒)</span>
              </p>

              <!-- 主操作按钮组 -->
              <div class="hero-actions">
                <n-button
                  v-if="pendingApplyCount > 0"
                  type="primary"
                  size="large"
                  :loading="applyingStaging"
                  @click="handleApplyStaging"
                >
                  立即应用更新文件
                </n-button>
                <n-button
                  v-else
                  type="primary"
                  size="large"
                  :loading="syncing"
                  @click="handleCheckOrSyncNow"
                >
                  立即检查并同步
                </n-button>

                <n-popconfirm
                  v-if="backups.length > 0"
                  @positive-click="handleQuickRollback"
                >
                  <template #trigger>
                    <n-button
                      size="large"
                      quaternary
                      :loading="rollingBack"
                    >
                      一键回退到上一版
                    </n-button>
                  </template>
                  确定回退到最近快照 ({{ new Date(backups[0]?.createdAt ?? 0).toLocaleString('zh-CN') }}) 吗? 目标目录将被恢复。
                </n-popconfirm>

                <n-button
                  size="large"
                  tertiary
                  @click="emit('navigate', 'settings')"
                >
                  配置参数
                </n-button>
              </div>
            </div>
          </div>
        </n-card>

        <!-- 3. 快捷指标网格 -->
        <div class="stats-grid">
          <n-card class="stat-card" hoverable @click="emit('navigate', 'settings')">
            <div class="stat-header">
              <span class="stat-title">同步路径</span>
              <span class="stat-icon">📁</span>
            </div>
            <div class="stat-body">
              <div class="stat-row">
                <span class="stat-label">源:</span>
                <span class="stat-value text-ellipsis" :title="config?.sourceDir">{{ config?.sourceDir || '未设置' }}</span>
              </div>
              <div class="stat-row">
                <span class="stat-label">目标:</span>
                <span class="stat-value text-ellipsis" :title="config?.targetDir">{{ config?.targetDir || '未设置' }}</span>
              </div>
            </div>
          </n-card>

          <n-card class="stat-card" hoverable @click="emit('navigate', 'backups')">
            <div class="stat-header">
              <span class="stat-title">版本快照中心</span>
              <span class="stat-icon">📦</span>
            </div>
            <div class="stat-main-number">
              {{ backups.length }}
              <span class="stat-unit">个可用快照</span>
            </div>
            <div class="stat-footer-text">
              {{ backups[0] ? `最新备份: ${new Date(backups[0].createdAt).toLocaleString('zh-CN')}` : '暂无历史备份' }}
            </div>
          </n-card>

          <n-card class="stat-card" hoverable @click="emit('navigate', 'mappings')">
            <div class="stat-header">
              <span class="stat-title">本地配置保护</span>
              <span class="stat-icon">🛡️</span>
            </div>
            <div class="stat-main-number">
              {{ config?.fileMappings?.filter((m) => m.enabled).length ?? 0 }}
              <span class="stat-unit">条规则生效</span>
            </div>
            <div class="stat-footer-text">
              用户个性化配置文件受豁免保护
            </div>
          </n-card>
        </div>

        <!-- 4. 最近同步活动简报 -->
        <n-card class="activity-card" title="最近动态与日志" :bordered="false">
          <template #header-extra>
            <n-button text type="primary" size="small" @click="emit('navigate', 'history')">
              查看完整历史 →
            </n-button>
          </template>

          <div v-if="recentHistory.length === 0" class="empty-activity">
            <n-text depth="3">暂无同步记录，点击上方按钮开始首次同步</n-text>
          </div>

          <div v-else class="activity-list">
            <div
              v-for="item in recentHistory"
              :key="item.id"
              class="activity-item"
            >
              <div class="activity-status-dot" :class="{ ok: item.fatalError === null, fail: item.fatalError !== null }" />
              <div class="activity-info">
                <div class="activity-time">
                  {{ new Date(item.startedAt).toLocaleString('zh-CN') }}
                  <n-tag size="tiny" :type="item.fatalError === null ? 'success' : 'error'" style="margin-left: 8px">
                    {{ item.fatalError === null ? '成功' : '失败' }}
                  </n-tag>
                  <span class="activity-duration">耗时 {{ item.durationMs }}ms</span>
                </div>
                <div class="activity-summary">
                  <n-tag v-if="item.addedCount > 0" size="tiny" type="info">+{{ item.addedCount }} 新增</n-tag>
                  <n-tag v-if="item.modifiedCount > 0" size="tiny" type="warning" style="margin-left: 4px">~{{ item.modifiedCount }} 修改</n-tag>
                  <n-tag v-if="item.deletedCount > 0" size="tiny" type="error" style="margin-left: 4px">-{{ item.deletedCount }} 删除</n-tag>
                  <n-text v-if="item.addedCount === 0 && item.modifiedCount === 0 && item.deletedCount === 0" depth="3">
                    无变动 (文件均一致)
                  </n-text>
                </div>
              </div>
            </div>
          </div>
        </n-card>
      </div>
    </n-spin>
  </div>
</template>

<style scoped>
.dashboard-page {
  padding: 24px;
  overflow-y: auto;
  height: 100%;
  box-sizing: border-box;
}

.dashboard-container {
  max-width: 980px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

/* Hero 大卡片 */
.hero-card {
  border-radius: 16px;
  padding: 24px 28px;
  background: linear-gradient(135deg, #ffffff 0%, #f6f8fb 100%);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.05);
  transition: all 0.3s ease;
}

.hero-up-to-date {
  background: linear-gradient(135deg, #f0fdf4 0%, #e6f7ec 100%);
  border-left: 5px solid #22c55e;
}

.hero-update-ready {
  background: linear-gradient(135deg, #fffbeb 0%, #fef3c7 100%);
  border-left: 5px solid #f59e0b;
}

.hero-staging-ready {
  background: linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%);
  border-left: 5px solid #3b82f6;
}

.hero-not-configured {
  background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%);
  border-left: 5px solid #64748b;
}

.hero-content {
  display: flex;
  align-items: center;
  gap: 24px;
}

.hero-icon {
  font-size: 48px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.hero-body {
  flex: 1;
}

.hero-badge-row {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}

.hero-title {
  margin: 0 0 6px 0;
  font-size: 22px;
  font-weight: 700;
  color: #1e293b;
}

.hero-subtitle {
  margin: 0 0 16px 0;
  font-size: 13px;
  color: #64748b;
}

.hero-actions {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

/* 统计卡片网格 */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 16px;
}

.stat-card {
  border-radius: 12px;
  cursor: pointer;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.03);
  transition: transform 0.2s ease, box-shadow 0.2s ease;
}

.stat-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.08);
}

.stat-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.stat-title {
  font-size: 14px;
  font-weight: 600;
  color: #334155;
}

.stat-icon {
  font-size: 18px;
}

.stat-row {
  display: flex;
  font-size: 12px;
  margin-bottom: 6px;
  gap: 6px;
}

.stat-label {
  color: #64748b;
  flex-shrink: 0;
}

.stat-value {
  color: #0f172a;
  font-family: monospace;
}

.stat-main-number {
  font-size: 28px;
  font-weight: 700;
  color: #0f172a;
}

.stat-unit {
  font-size: 13px;
  font-weight: 400;
  color: #64748b;
  margin-left: 6px;
}

.stat-footer-text {
  margin-top: 8px;
  font-size: 12px;
  color: #64748b;
}

.text-ellipsis {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 活动简报 */
.activity-card {
  border-radius: 12px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.03);
}

.activity-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.activity-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  background: #f8fafc;
  border-radius: 8px;
}

.activity-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.activity-status-dot.ok {
  background: #22c55e;
}

.activity-status-dot.fail {
  background: #ef4444;
}

.activity-info {
  flex: 1;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.activity-time {
  font-size: 12px;
  color: #475569;
}

.activity-duration {
  font-size: 11px;
  color: #94a3b8;
  margin-left: 8px;
}

.activity-summary {
  display: flex;
  align-items: center;
}

.empty-activity {
  text-align: center;
  padding: 24px 0;
}
</style>
