<script setup lang="ts">
/**
 * BackupsView - 备份列表(P3 修复版)
 */

import { onMounted, onUnmounted, ref, h } from 'vue';
import {
  NDataTable,
  NTag,
  NSpace,
  NButton,
  NEmpty,
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
  return new Date(ts).toLocaleString('zh-CN');
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
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
  { title: '大小', key: 'sizeBytes', width: 110, render: (r) => formatSize(r.sizeBytes) },
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

let refreshTimer: number | null = null;

onMounted(() => {
  load();
  refreshTimer = window.setInterval(() => {
    load(); // 自动刷,不加 loading 避免闪烁
  }, 1000);
  window.api.onSyncResult?.(() => {
    load();
  });
});

onUnmounted(() => {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
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
  <div class="page">
    <header class="hero">
      <h1>备份管理</h1>
      <p class="subtitle">
        共 {{ items.length }} 个备份 · 每次同步前(若有变更)自动创建 · {{ lastLoadLog || '加载中...' }}
      </p>
    </header>

    <n-space align="center" :wrap="true" style="margin-bottom: 16px">
      <n-text depth="3" style="font-size: 13px; white-space: nowrap">保留备份数:</n-text>
      <n-input-number
        :value="config.backupCount"
        :min="1"
        :max="20"
        :step="1"
        size="small"
        :loading="backupCountSaving"
        style="width: 110px"
        @update:value="onChangeBackupCount"
      />
      <n-text depth="3" style="font-size: 12px">(修改后下次同步生效)</n-text>
    </n-space>

    <n-alert
      v-if="loadError"
      type="error"
      closable
      style="margin-bottom: 16px"
      title="加载失败"
    >
      {{ loadError }}
    </n-alert>

    <n-alert
      v-if="lastActionError"
      type="error"
      closable
      style="margin-bottom: 16px"
      title="操作失败"
    >
      <pre style="white-space: pre-wrap; margin: 0; font-size: 12px">{{ lastActionError }}</pre>
    </n-alert>

    <n-alert
      v-if="lastSuccessAt && !lastActionError"
      type="success"
      style="margin-bottom: 16px"
      closable
    >
      ✓ 操作成功 · {{ formatTime(lastSuccessAt) }}
    </n-alert>

    <div class="table-wrap">
      <n-empty
        v-if="!loading && items.length === 0"
        description="还没有备份"
        style="margin-top: 60px"
      />
      <n-data-table
        v-else
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

    <div class="footer-bar">
      <n-button @click="load" size="small">刷新</n-button>
      <span class="hint">"回退" 会先把 target 当前内容做一份安全快照,再覆盖。任意时刻可以二次回退。</span>
    </div>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  padding: 16px;
  width: 100%;
  box-sizing: border-box;
}

@media (min-width: 768px) {
  .page {
    padding: 24px;
  }
}

@media (min-width: 1200px) {
  .page {
    padding: 32px;
  }
}

.hero h1 {
  margin: 0 0 4px;
  font-size: 24px;
}

.subtitle {
  margin: 0 0 16px;
  color: #6b7785;
  font-size: 13px;
}

.table-wrap {
  flex: 1 1 0;
  min-height: 300px;
  background: #fff;
  border: 1px solid #e4e7eb;
  border-radius: 8px;
  padding: 12px;
  display: flex;
  flex-direction: column;
}

.footer-bar {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-top: 16px;
  font-size: 12px;
  color: #6b7785;
}

.hint {
  margin-left: 8px;
}
</style>
