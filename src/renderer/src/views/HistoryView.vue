<script setup lang="ts">
/**
 * HistoryView - 同步历史日志(P3 修复版,极简布局 + 强诊断)
 *
 * 布局:页面 padding, 表格用 wrapper div 显式 height 撑开
 * 这样不依赖复杂的 flex 链条,出问题容易定位
 */

import { onMounted, onUnmounted, ref, computed, h } from 'vue';
import {
  NAlert,
  NDataTable,
  NTag,
  NSpace,
  NButton,
  NEmpty,
  NModal,
  type DataTableColumns,
} from 'naive-ui';
import { getApi } from '../api';

interface HistoryItem {
  id: number;
  startedAt: number;
  durationMs: number;
  sourceDir: string;
  targetDir: string;
  addedCount: number;
  modifiedCount: number;
  deletedCount: number;
  unchangedCount: number;
  mappingCopiedCount: number;
  mappingSkippedExistingCount: number;
  mappingSkippedCount: number;
  fatalError: string | null;
  backupId: number | null;
}

const items = ref<HistoryItem[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(50);
const loading = ref(false);
const loadError = ref<string | null>(null);
const lastLoadLog = ref<string>('');
let isFirstLoad = true;

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));

// 首加载用 loading,自动刷不用(避免 spinner 闪烁)
async function load() {
  if (isFirstLoad) loading.value = true;
  try {
    const res = await getApi().historyList({
      limit: pageSize.value,
      offset: (page.value - 1) * pageSize.value,
    });
    items.value = res.items;
    total.value = res.total;
    lastLoadLog.value = `${new Date().toLocaleTimeString()} 拉到 ${res.items.length} 条,共 ${res.total} 条`;
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

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN');
}

const columns: DataTableColumns<HistoryItem> = [
  { title: '时间', key: 'startedAt', width: 160, fixed: 'left', render: (r) => formatTime(r.startedAt) },
  { title: '耗时', key: 'durationMs', width: 80, render: (r) => `${r.durationMs}ms` },
  {
    title: '变化',
    key: 'changes',
    width: 180,
    render: (r) =>
      h(NSpace, { size: 4 }, () => [
        r.addedCount > 0
          ? h(NTag, { type: 'info', size: 'small' }, () => `+${r.addedCount}`)
          : null,
        r.modifiedCount > 0
          ? h(NTag, { type: 'warning', size: 'small' }, () => `~${r.modifiedCount}`)
          : null,
        r.deletedCount > 0
          ? h(NTag, { type: 'error', size: 'small' }, () => `−${r.deletedCount}`)
          : null,
        r.addedCount + r.modifiedCount + r.deletedCount === 0
          ? h(NTag, { type: 'default', size: 'small', quaternary: true }, () => '无变化')
          : null,
      ]),
  },
  { title: '未变', key: 'unchangedCount', width: 70 },
  { title: '映射', key: 'mapping', width: 100, render: (r) => `${r.mappingCopiedCount} 已拷` },
  {
    title: '备份',
    key: 'backupId',
    width: 80,
    render: (r) =>
      r.backupId
        ? h(NTag, { type: 'success', size: 'small' }, () => `#${r.backupId}`)
        : h(NTag, { type: 'default', size: 'small', quaternary: true }, () => '—'),
  },
  {
    title: '状态',
    key: 'status',
    width: 80,
    render: (r) =>
      r.fatalError
        ? h(NTag, { type: 'error', size: 'small' }, () => '失败')
        : h(NTag, { type: 'success', size: 'small' }, () => '成功'),
  },
  {
    title: '源 → 目标',
    key: 'paths',
    minWidth: 200,
    ellipsis: { tooltip: true },
    render: (r) => `${r.sourceDir} → ${r.targetDir}`,
  },
  {
    title: '',
    key: 'actions',
    width: 50,
    fixed: 'right',
    render: (r) =>
      h(NButton, { size: 'tiny', text: true, type: 'primary', onClick: () => showDetails(r) }, () => '详情'),
  },
];

const detailsVisible = ref(false);
const detailsItem = ref<HistoryItem | null>(null);

function showDetails(r: HistoryItem) {
  detailsItem.value = r;
  detailsVisible.value = true;
}

let refreshTimer: number | null = null;

onMounted(() => {
  load();
  refreshTimer = window.setInterval(() => {
    load(); // 自动刷,不加 loading
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
</script>

<template>
  <div class="page">
    <header class="hero">
      <h1>同步历史</h1>
      <p class="subtitle">
        共 {{ total }} 条记录 · 每页 {{ pageSize }} 条 · {{ lastLoadLog || '加载中...' }}
      </p>
    </header>

    <n-alert
      v-if="loadError"
      type="error"
      closable
      style="margin-bottom: 16px"
      title="加载失败"
    >
      {{ loadError }}
    </n-alert>

    <div class="table-wrap">
      <n-empty
        v-if="!loading && items.length === 0"
        description="还没有同步记录"
        style="margin-top: 60px"
      />
      <n-data-table
        v-else
        :columns="columns"
        :data="items"
        :loading="loading"
        :row-key="(r: HistoryItem) => r.id"
        :pagination="false"
        size="small"
        :bordered="false"
        table-layout="fixed"
        flex-height
        style="width: 100%; min-width: 0; height: 100%"
      />
    </div>

    <div class="pager" v-if="totalPages > 1">
      <n-button :disabled="page <= 1" @click="page--; load()">上一页</n-button>
      <span>第 {{ page }} / {{ totalPages }} 页</span>
      <n-button :disabled="page >= totalPages" @click="page++; load()">下一页</n-button>
      <n-button text type="primary" @click="load" style="margin-left: auto">刷新</n-button>
    </div>

    <n-modal v-model:show="detailsVisible" preset="card" title="同步详情" style="max-width: 600px">
      <div v-if="detailsItem" class="details">
        <p><b>时间:</b> {{ formatTime(detailsItem.startedAt) }}</p>
        <p><b>耗时:</b> {{ detailsItem.durationMs }}ms</p>
        <p>
          <b>变化:</b>
          <n-tag v-if="detailsItem.addedCount > 0" type="info" size="small">+{{ detailsItem.addedCount }} 新增</n-tag>
          <n-tag v-if="detailsItem.modifiedCount > 0" type="warning" size="small">~{{ detailsItem.modifiedCount }} 修改</n-tag>
          <n-tag v-if="detailsItem.deletedCount > 0" type="error" size="small">−{{ detailsItem.deletedCount }} 删除</n-tag>
        </p>
        <p><b>未变:</b> {{ detailsItem.unchangedCount }}</p>
        <p v-if="detailsItem.fatalError" style="color: #a02d3a"><b>错误:</b> {{ detailsItem.fatalError }}</p>
        <p style="word-break: break-all; font-size: 12px; color: #666"><b>源:</b> {{ detailsItem.sourceDir }}</p>
        <p style="word-break: break-all; font-size: 12px; color: #666"><b>目标:</b> {{ detailsItem.targetDir }}</p>
      </div>
    </n-modal>
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

/* 显式高度 wrapper,避免复杂 flex 链条 */
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

.pager {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
  font-size: 13px;
  color: #6b7785;
}
</style>
