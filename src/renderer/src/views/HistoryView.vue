<script setup lang="ts">
/**
 * HistoryView - 同步历史日志(P3 修复版,极简布局 + 强诊断)
 *
 * 布局:页面 padding, 表格用 wrapper div 显式 height 撑开
 * 这样不依赖复杂的 flex 链条,出问题容易定位
 */

import { onMounted, ref, computed, h } from 'vue';
import { usePolling } from '../composables/usePolling';
import { UI_LIST_POLL_MS } from '@core/constants';
import {
  NAlert,
  NDataTable,
  NTag,
  NSpace,
  NButton,
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
  {
    title: '时间',
    key: 'startedAt',
    width: 145,
    render: (r) => formatTime(r.startedAt),
  },
  {
    title: '耗时',
    key: 'durationMs',
    width: 75,
    render: (r) => `${r.durationMs}ms`,
  },
  {
    title: '变动概览',
    key: 'changes',
    width: 145,
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
  { title: '未变', key: 'unchangedCount', width: 65 },
  { title: '映射保护', key: 'mapping', width: 90, render: (r) => `${r.mappingCopiedCount} 已拷` },
  {
    title: '快照备份',
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
    width: 75,
    render: (r) =>
      r.fatalError
        ? h(NTag, { type: 'error', size: 'small' }, () => '失败')
        : h(NTag, { type: 'success', size: 'small' }, () => '成功'),
  },
  {
    title: '同步路径',
    key: 'paths',
    minWidth: 150,
    ellipsis: { tooltip: true },
    render: (r) => `${r.sourceDir} → ${r.targetDir}`,
  },
  {
    title: '',
    key: 'actions',
    width: 55,
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
</script>

<template>
  <div class="ops-view-container">
    <div class="view-unified-wrap">
      <div class="ops-panel-card">
      <!-- 运维面板头部 -->
      <div class="panel-header">
        <div class="header-left">
          <div class="header-title-row">
            
            <span class="panel-title">同步历史记录</span>
          </div>
          <span class="panel-subtitle">
            共记录 {{ total }} 次同步操作 · 详细记录每次检查的时间、更新文件数与结果
          </span>
        </div>

        <div class="header-actions">
          <n-button size="medium" @click="load">刷新记录</n-button>
        </div>
      </div>

      <!-- 告警信息 -->
      <div v-if="loadError" class="panel-alerts-area">
        <n-alert type="error" closable title="记录加载失败">
          {{ loadError }}
        </n-alert>
      </div>

      <!-- 面板主体表格 -->
      <div class="panel-body">
        <div v-if="!loading && items.length === 0" class="empty-state-box">
          <svg class="empty-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
          </svg>
          <span class="empty-title">暂无同步记录</span>
          <span class="empty-desc">
            当开始执行检查与同步时，每次的操作详情都会自动记录在此处。
          </span>
        </div>

        <div v-else class="table-container">
          <n-data-table
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
      </div>

      <!-- 面板底部工具栏与分页 -->
      <div class="panel-footer">
        <span class="footer-tip">
          变动说明: +新增下载 · ~更新修改 · −删除多余文件
        </span>

        <div class="pager" v-if="totalPages > 1">
          <n-button size="small" :disabled="page <= 1" @click="page--; load()">上一页</n-button>
          <span class="pager-text">{{ page }} / {{ totalPages }} 页</span>
          <n-button size="small" :disabled="page >= totalPages" @click="page++; load()">下一页</n-button>
        </div>
      </div>
      </div>
    </div>

    <!-- 事务详情 Modal -->
    <n-modal v-model:show="detailsVisible" preset="card" title="同步详情" style="max-width: 620px">
      <div v-if="detailsItem" class="details-grid">
        <div class="detail-row">
          <span class="detail-key">执行时刻:</span>
          <span class="detail-val monospace-text">{{ formatTime(detailsItem.startedAt) }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-key">总耗时:</span>
          <span class="detail-val monospace-text">{{ detailsItem.durationMs }}ms</span>
        </div>
        <div class="detail-row">
          <span class="detail-key">变更统计:</span>
          <div class="detail-val change-tags">
            <n-tag v-if="detailsItem.addedCount > 0" type="info" size="small">+{{ detailsItem.addedCount }} 新增</n-tag>
            <n-tag v-if="detailsItem.modifiedCount > 0" type="warning" size="small">~{{ detailsItem.modifiedCount }} 修改</n-tag>
            <n-tag v-if="detailsItem.deletedCount > 0" type="error" size="small">−{{ detailsItem.deletedCount }} 删除</n-tag>
            <n-tag type="default" size="small">{{ detailsItem.unchangedCount }} 相同未变</n-tag>
          </div>
        </div>
        <div class="detail-row" v-if="detailsItem.fatalError">
          <span class="detail-key">致命异常:</span>
          <span class="detail-val error-text">{{ detailsItem.fatalError }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-key">源节点路径:</span>
          <span class="detail-val monospace-text path-text">{{ detailsItem.sourceDir }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-key">目标部署路径:</span>
          <span class="detail-val monospace-text path-text">{{ detailsItem.targetDir }}</span>
        </div>
      </div>
    </n-modal>
  </div>
</template>

<style scoped>
.ops-view-container {
  height: 100%;
  overflow-x: hidden !important;
  overflow-y: auto;
  padding: 20px 24px;
  box-sizing: border-box;
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
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
}

.panel-header {
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color);
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
  color: var(--panel-tag-color);
  background: var(--panel-tag-bg);
  border: 1px solid var(--panel-tag-border);
  padding: 1px 6px;
  border-radius: 4px;
  font-family: monospace;
}

.panel-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--text-main);
}

.panel-subtitle {
  font-size: 12px;
  color: var(--text-muted);
}

.panel-alerts-area {
  padding: 12px 20px 0;
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
  color: var(--text-main);
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
  border-top: 1px solid var(--border-color);
  background: var(--bg-subtle);
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

.pager {
  display: flex;
  align-items: center;
  gap: 10px;
}

.pager-text {
  font-family: monospace;
  font-size: 12px;
  color: #475569;
}

.details-grid {
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-size: 13px;
}

.detail-row {
  display: grid;
  grid-template-columns: 100px 1fr;
  align-items: baseline;
  gap: 12px;
}

.detail-key {
  color: #64748b;
  font-weight: 500;
}

.detail-val {
  font-size: 13px;
  color: var(--text-main);
}

.monospace-text {
  font-family: "SFMono-Regular", Consolas, monospace;
}

.path-text {
  word-break: break-all;
  background: var(--bg-subtle);
  color: var(--text-main);
  border: 1px solid var(--border-color);
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
}

.change-tags {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.error-text {
  color: #ef4444;
  font-weight: 600;
}
</style>
