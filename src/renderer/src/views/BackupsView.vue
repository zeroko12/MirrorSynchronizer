<script setup lang="ts">
/**
 * BackupsView - 备份列表(P3 修复版)
 */

import { onMounted, ref, h } from 'vue';
import { formatBytes, formatTimestamp } from '../utils/format';
import { usePolling } from '../composables/usePolling';
import { UI_LIST_POLL_MS } from '@core/constants';
import {
  NDataTable,
  NInputNumber,
  NTag,
  NSpace,
  NButton,
  NPopconfirm,
  NAlert,
  useMessage,
  type DataTableColumns,
} from 'naive-ui';
import { getApi } from '../api';

interface BackupItem {
  id: number;
  createdAt: number;
  sourceDir: string;
  targetDir: string;
  snapshotPath: string;
  fileCount: number;
  sizeBytes: number;
  _stale?: boolean;
}

import { useConfig } from '../composables/useConfig';

const items = ref<BackupItem[]>([]);
const loading = ref(false);
const loadError = ref<string | null>(null);
const lastActionError = ref<string | null>(null);
const lastSuccessAt = ref<number | null>(null);
const lastLoadLog = ref<string>('');
const message = useMessage();
let isFirstLoad = true;

const { config, save } = useConfig();
const backupCountSaving = ref(false);

async function onChangeBackupCount(value: number | null) {
  if (value == null) return;
  if (value === config.value.backupCount) return;
  backupCountSaving.value = true;
  config.value = { ...config.value, backupCount: value };
  const ok = await save();
  backupCountSaving.value = false;
  if (ok) {
    message.success(`已设置保留 ${value} 个备份,下次同步时生效`);
  } else {
    message.error('保存失败');
  }
}

function formatTime(ts: number): string {
  return formatTimestamp(ts);
}

async function onRollback(b: BackupItem) {
  lastActionError.value = null;
  if (b._stale) {
    lastActionError.value = '快照文件已丢失,无法回退';
    message.error(lastActionError.value);
    return;
  }
  message.info(`正在回退到 ${formatTime(b.createdAt)} ...`);
  const res = await getApi().backupRollback(b.id);
  if (res.ok) {
    lastSuccessAt.value = Date.now();
    message.success(
      `已回退到 ${formatTime(b.createdAt)}` +
        (res.safetySnapshotPath ? ` · 当前状态已自动备份` : ''),
    );
    await load();
  } else {
    lastActionError.value = `回退失败: ${res.error}`;
    message.error(lastActionError.value);
  }
}

async function onDelete(b: BackupItem) {
  lastActionError.value = null;
  message.info(`正在删除 ${formatTime(b.createdAt)} ...`);
  const res = await getApi().backupDelete(b.id);
  if (res.ok) {
    lastSuccessAt.value = Date.now();
    message.success(`已删除 ${formatTime(b.createdAt)} 的备份`);
    await load();
  } else {
    lastActionError.value = `删除失败: ${res.error}`;
    message.error(lastActionError.value);
  }
}

const columns: DataTableColumns<BackupItem> = [
  {
    title: '时间',
    key: 'createdAt',
    width: 180,
    fixed: 'left',
    render: (r) =>
      h('span', { style: 'font-family: ui-monospace' }, formatTime(r.createdAt)),
  },
  { title: '文件数', key: 'fileCount', width: 90 },
  { title: '大小', key: 'sizeBytes', width: 110, render: (r) => formatBytes(r.sizeBytes) },
  {
    title: '状态',
    key: 'status',
    width: 100,
    render: (r) =>
      r._stale
        ? h(NTag, { type: 'warning', size: 'small' }, () => '文件已丢')
        : r.id < 0
          ? h(NTag, { type: 'default', size: 'small', quaternary: true }, () => '未登记')
          : h(NTag, { type: 'success', size: 'small' }, () => '可用'),
  },
  {
    title: '来源',
    key: 'sourceDir',
    minWidth: 200,
    ellipsis: { tooltip: true },
    render: (r) =>
      h('span', { style: 'font-family: ui-monospace; font-size: 12px; color: #666' }, r.sourceDir || '(冷启动数据)'),
  },
  {
    title: '操作',
    key: 'actions',
    width: 180,
    fixed: 'right',
    render: (r) =>
      h(NSpace, { size: 8 }, () => [
        h(
          NPopconfirm,
          {
            onPositiveClick: () => onRollback(r),
            positiveText: '确认回退',
            negativeText: '取消',
          },
          {
            trigger: () =>
              h(NButton, { size: 'small', type: 'primary', disabled: !!r._stale }, () => '回退'),
            default: () =>
              h('div', { style: 'max-width: 280px' }, [
                h('p', null, '确认回退到此备份?'),
                h('p', { style: 'font-size: 12px; color: #666; margin: 4px 0' }, '当前 target 内容会被覆盖(覆盖前会自动做一份安全快照)'),
                h('p', { style: 'font-size: 12px; color: #999' }, `目标: ${r.targetDir}`),
              ]),
          },
        ),
        h(
          NPopconfirm,
          {
            onPositiveClick: () => onDelete(r),
            positiveText: '确认删除',
            negativeText: '取消',
          },
          {
            trigger: () => h(NButton, { size: 'small', type: 'error' }, () => '删除'),
            default: () => h('span', null, '确认删除此备份?此操作不可撤销。'),
          },
        ),
      ]),
  },
];

// 自动刷(1s)+ onSyncResult 触发刷新
usePolling(() => {
  load();
}, UI_LIST_POLL_MS, { immediate: false });
onMounted(() => {
  load();
  window.api.onSyncResult?.(() => {
    load();
  });
});

// 重写 load:首加载用 loading,自动刷不用
async function load() {
  if (isFirstLoad) loading.value = true;
  try {
    const r = await getApi().backupList();
    items.value = r;
    lastLoadLog.value = `${new Date().toLocaleTimeString()} 拉到 ${r.length} 个备份`;
    loadError.value = null;
  } catch (e) {
    loadError.value = (e as Error).message;
    lastLoadLog.value = `${new Date().toLocaleTimeString()} 失败: ${(e as Error).message}`;
  } finally {
    if (isFirstLoad) {
      isFirstLoad = false;
      loading.value = false;
    }
  }
}
</script>

<template>
  <div class="ops-view-container">
    <div class="view-unified-wrap">
      <div class="ops-panel-card">
      <!-- 运维面板头部 -->
      <div class="panel-header">
        <div class="header-left">
          <div class="header-title-row">
            
            <span class="panel-title">历史备份与还原</span>
          </div>
          <span class="panel-subtitle">
            共保留 {{ items.length }} 个历史版本 · 遇到更新问题时可随时一键还原到之前的版本
          </span>
        </div>

        <div class="header-actions">
          <div class="quota-control">
            <span class="quota-label">最多保留:</span>
            <n-input-number
              :value="config.backupCount"
              :min="1"
              :max="50"
              :step="1"
              size="small"
              :loading="backupCountSaving"
              style="width: 100px"
              @update:value="onChangeBackupCount"
            />
          </div>
          <n-button size="medium" @click="load">刷新列表</n-button>
        </div>
      </div>

      <!-- 操作与告警反馈 -->
      <div v-if="loadError || lastActionError || (lastSuccessAt && !lastActionError)" class="panel-alerts-area">
        <n-alert
          v-if="loadError"
          type="error"
          closable
          title="备份列表加载失败"
        >
          {{ loadError }}
        </n-alert>
        <n-alert
          v-if="lastActionError"
          type="error"
          closable
          title="还原或删除失败"
        >
          <pre style="white-space: pre-wrap; margin: 0; font-size: 12px">{{ lastActionError }}</pre>
        </n-alert>
        <n-alert
          v-if="lastSuccessAt && !lastActionError"
          type="success"
          closable
        >
          ✓ 版本还原成功 · {{ formatTime(lastSuccessAt) }}
        </n-alert>
      </div>

      <!-- 面板主体表格 -->
      <div class="panel-body">
        <div v-if="!loading && items.length === 0" class="empty-state-box">
          <svg class="empty-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <polyline points="21 8 21 21 3 21 3 8" />
            <rect x="1" y="3" width="22" height="5" />
            <line x1="10" y1="12" x2="14" y2="12" />
          </svg>
          <span class="empty-title">暂无历史备份</span>
          <span class="empty-desc">
            系统在每次执行更新替换文件前，会自动为您备份当前版本，方便随时一键撤销与还原。
          </span>
        </div>

        <div v-else class="table-container">
          <n-data-table
            :columns="columns"
            :data="items"
            :loading="loading"
            :row-key="(r: BackupItem) => r.id"
            :pagination="false"
            size="small"
            :bordered="false"
            table-layout="fixed"
            flex-height
            style="width: 100%; min-width: 0; height: 100%"
          />
        </div>
      </div>

      <!-- 面板底部状态栏 -->
      <div class="panel-footer">
        <span class="footer-tip">
          🛡️ 安全提示: 点击"回退"还原前，系统会自动为您备份当前的文件状态，任意时刻均可二次还原，数据安全有保障。
        </span>
      </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ops-view-container {
  height: 100%;
  overflow-y: auto;
  padding: 20px 24px;
  box-sizing: border-box;
  scrollbar-gutter: stable;
}

.view-unified-wrap {
  max-width: 1000px;
  margin: 0 auto;
  height: 100%;
  display: flex;
  flex-direction: column;
}

.ops-panel-card {
  flex: 1;
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
}

.panel-header {
  padding: 16px 20px;
  border-bottom: 1px solid #f1f5f9;
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-shrink: 0;
}

.header-left {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.header-title-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.panel-tag {
  font-size: 10px;
  font-weight: 700;
  color: #2563eb;
  background: #eff6ff;
  border: 1px solid #dbeafe;
  padding: 1px 6px;
  border-radius: 4px;
  font-family: monospace;
}

.panel-title {
  font-size: 15px;
  font-weight: 700;
  color: #0f172a;
}

.panel-subtitle {
  font-size: 12px;
  color: #64748b;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 16px;
}

.quota-control {
  display: flex;
  align-items: center;
  gap: 8px;
  background: #f8fafc;
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid #e2e8f0;
}

.quota-label {
  font-size: 12px;
  color: #475569;
  font-weight: 500;
}

.panel-alerts-area {
  padding: 12px 20px 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.panel-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
}

.table-container {
  flex: 1;
  height: 100%;
  min-height: 0;
}

.empty-state-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 20px;
  text-align: center;
}

.empty-svg {
  width: 48px;
  height: 48px;
  color: #cbd5e1;
  margin-bottom: 12px;
}

.empty-title {
  font-size: 14px;
  font-weight: 600;
  color: #334155;
  margin-bottom: 6px;
}

.empty-desc {
  font-size: 12px;
  color: #64748b;
  max-width: 460px;
  line-height: 1.6;
}

.panel-footer {
  padding: 12px 20px;
  border-top: 1px solid #f1f5f9;
  background: #f8fafc;
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: #64748b;
  flex-shrink: 0;
}

.footer-tip {
  color: #64748b;
}
</style>
