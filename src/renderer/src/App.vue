<script setup lang="ts">
/**
 * App.vue - 自动化同步与软件更新运维工作台
 *
 * 定位: 专业运维基础设施工具 (Ops / SRE Console)
 * 布局: 左侧深色导航侧边栏 (Sidebar) + 顶部状态条 (Header) + 内容区
 */

import { ref, computed, onMounted } from 'vue';
import {
  NConfigProvider,
  NMessageProvider,
  NButton,
  NTag,
  zhCN,
  dateZhCN,
} from 'naive-ui';
import DashboardView from './views/DashboardView.vue';
import SettingsView from './views/SettingsView.vue';
import BackupsView from './views/BackupsView.vue';
import HistoryView from './views/HistoryView.vue';
import MappingsView from './views/MappingsView.vue';
import UpdateDialog from './views/UpdateDialog.vue';
import { getApi, type StatusInfo } from './api';
import { usePolling } from './composables/usePolling';
import { UI_STATUS_POLL_MS } from '@core/constants';
import { tryLog } from './utils/try-log';

const tab = ref<'dashboard' | 'settings' | 'mappings' | 'backups' | 'history'>('dashboard');
const updateDialogRef = ref<InstanceType<typeof UpdateDialog> | null>(null);
const status = ref<StatusInfo | null>(null);
const syncing = ref(false);

async function refreshStatus() {
  const s = await tryLog('getStatus', () => getApi().getStatus());
  if (s) status.value = s;
}

usePolling(refreshStatus, UI_STATUS_POLL_MS, { immediate: true });

onMounted(() => {
  refreshStatus();
  window.api.onUpdatePrompt?.((payload) => {
    updateDialogRef.value?.showPrompt(payload);
  });
});

const viewTitles: Record<string, { title: string; subtitle: string }> = {
  dashboard: { title: '运行与监控概览', subtitle: '实时同步链路拓扑、关键指标监控与即时控制' },
  settings: { title: '同步与更新配置', subtitle: '源/目标节点网络协议、定时调度周期与冲突策略' },
  mappings: { title: '本地规则与文件保护', subtitle: '配置专属本地文件保护、豁免镜像删除与自动补回规则' },
  backups: { title: '快照版本与秒级回滚', subtitle: '历史快照归档检索、空间占用与一键还原' },
  history: { title: '运维审计日志', subtitle: '同步事务执行记录、文件增改删流水与错误回溯' },
};

const currentViewMeta = computed(() => viewTitles[tab.value] ?? viewTitles.dashboard);

async function handleHeaderQuickSync() {
  syncing.value = true;
  try {
    await getApi().runSyncNowForce();
    await refreshStatus();
  } finally {
    syncing.value = false;
  }
}

function handleNavigate(targetTab: 'dashboard' | 'settings' | 'backups' | 'history' | 'mappings') {
  tab.value = targetTab;
}
</script>

<template>
  <n-config-provider :locale="zhCN" :date-locale="dateZhCN">
    <n-message-provider>
      <div class="ops-workbench">
        <!-- 1. 左侧专业深色侧边栏 -->
        <aside class="ops-sidebar">
          <!-- 品牌标识 -->
          <div class="sidebar-brand">
            <div class="brand-badge">
              <svg class="brand-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                <line x1="12" y1="22.08" x2="12" y2="12" />
              </svg>
            </div>
            <div class="brand-info">
              <span class="brand-name">MirrorSync</span>
              <span class="brand-role">OPS CONSOLE</span>
            </div>
          </div>

          <!-- 导航菜单 -->
          <nav class="sidebar-menu">
            <button
              class="menu-item"
              :class="{ active: tab === 'dashboard' }"
              @click="tab = 'dashboard'"
            >
              <svg class="menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="3" width="7" height="9" />
                <rect x="14" y="3" width="7" height="5" />
                <rect x="14" y="12" width="7" height="9" />
                <rect x="3" y="16" width="7" height="5" />
              </svg>
              <span class="menu-label">监控看板</span>
            </button>

            <button
              class="menu-item"
              :class="{ active: tab === 'settings' }"
              @click="tab = 'settings'"
            >
              <svg class="menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="4" y1="21" x2="4" y2="14" />
                <line x1="4" y1="10" x2="4" y2="3" />
                <line x1="12" y1="21" x2="12" y2="12" />
                <line x1="12" y1="8" x2="12" y2="3" />
                <line x1="20" y1="21" x2="20" y2="16" />
                <line x1="20" y1="12" x2="20" y2="3" />
                <line x1="1" y1="14" x2="7" y2="14" />
                <line x1="9" y1="8" x2="15" y2="8" />
                <line x1="17" y1="16" x2="23" y2="16" />
              </svg>
              <span class="menu-label">同步配置</span>
            </button>

            <button
              class="menu-item"
              :class="{ active: tab === 'mappings' }"
              @click="tab = 'mappings'"
            >
              <svg class="menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
              <span class="menu-label">保护规则</span>
            </button>

            <button
              class="menu-item"
              :class="{ active: tab === 'backups' }"
              @click="tab = 'backups'"
            >
              <svg class="menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="21 8 21 21 3 21 3 8" />
                <rect x="1" y="3" width="22" height="5" />
                <line x1="10" y1="12" x2="14" y2="12" />
              </svg>
              <span class="menu-label">快照版本</span>
            </button>

            <button
              class="menu-item"
              :class="{ active: tab === 'history' }"
              @click="tab = 'history'"
            >
              <svg class="menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="4 17 10 11 4 5" />
                <line x1="12" y1="19" x2="20" y2="19" />
              </svg>
              <span class="menu-label">审计日志</span>
            </button>
          </nav>

          <!-- 侧边栏底部引擎心跳状态 -->
          <div class="sidebar-footer">
            <div class="daemon-panel">
              <div class="daemon-indicator-row">
                <span class="pulse-dot" :class="{ 'pulse-active': status?.running }" />
                <span class="daemon-status-text">
                  {{ status?.running ? '调度引擎正常运行' : '调度引擎已暂停' }}
                </span>
              </div>
              <div class="daemon-meta">
                <span>周期: {{ status?.intervalSec ?? 300 }}s</span>
                <span class="version-badge">v0.3.4</span>
              </div>
            </div>
          </div>
        </aside>

        <!-- 2. 右侧工作区 -->
        <div class="ops-main-wrapper">
          <!-- 顶部运维状态栏 -->
          <header class="ops-topbar">
            <div class="topbar-title-group">
              <h1 class="view-main-title">{{ currentViewMeta.title }}</h1>
              <span class="view-sub-desc">{{ currentViewMeta.subtitle }}</span>
            </div>

            <div class="topbar-actions">
              <n-tag
                v-if="status?.sourceDir"
                size="small"
                :bordered="false"
                type="default"
                class="topbar-node-tag"
              >
                节点已就绪
              </n-tag>

              <n-button
                type="primary"
                size="small"
                :loading="syncing"
                class="ops-sync-btn"
                @click="handleHeaderQuickSync"
              >
                <template #icon>
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="23 4 23 10 17 10" />
                    <polyline points="1 20 1 14 7 14" />
                    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                  </svg>
                </template>
                立即执行同步
              </n-button>
            </div>
          </header>

          <!-- 主内容视图容器 -->
          <main class="ops-content-container">
            <DashboardView v-show="tab === 'dashboard'" @navigate="handleNavigate" />
            <SettingsView v-show="tab === 'settings'" />
            <MappingsView v-show="tab === 'mappings'" />
            <BackupsView v-show="tab === 'backups'" />
            <HistoryView v-show="tab === 'history'" />
          </main>
        </div>

        <UpdateDialog ref="updateDialogRef" />
      </div>
    </n-message-provider>
  </n-config-provider>
</template>

<style>
/* 运维工具全局基础重置与排版 */
html,
body {
  margin: 0;
  padding: 0;
  height: 100%;
  background: #090d16;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  color: #1e293b;
  overflow: hidden;
  user-select: none;
}

#app {
  height: 100vh;
  display: flex;
}

.ops-workbench {
  display: flex;
  width: 100%;
  height: 100%;
}

/* 侧边栏样式 */
.ops-sidebar {
  width: 220px;
  background: #0f172a;
  border-right: 1px solid #1e293b;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}

.sidebar-brand {
  height: 60px;
  padding: 0 18px;
  display: flex;
  align-items: center;
  gap: 12px;
  border-bottom: 1px solid #1e293b;
}

.brand-badge {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  color: #ffffff;
  box-shadow: 0 2px 8px rgba(37, 99, 235, 0.3);
}

.brand-svg {
  width: 18px;
  height: 18px;
}

.brand-info {
  display: flex;
  flex-direction: column;
}

.brand-name {
  font-size: 14px;
  font-weight: 700;
  color: #f8fafc;
  letter-spacing: 0.5px;
}

.brand-role {
  font-size: 10px;
  font-weight: 600;
  color: #64748b;
  letter-spacing: 1px;
}

/* 侧边栏导航按钮 */
.sidebar-menu {
  flex: 1;
  padding: 16px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.menu-item {
  width: 100%;
  height: 38px;
  padding: 0 12px;
  border-radius: 6px;
  background: transparent;
  border: none;
  display: flex;
  align-items: center;
  gap: 12px;
  color: #94a3b8;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
  text-align: left;
}

.menu-item:hover {
  background: rgba(255, 255, 255, 0.05);
  color: #f1f5f9;
}

.menu-item.active {
  background: #1e293b;
  color: #38bdf8;
  font-weight: 600;
}

.menu-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

/* 底部状态心跳 */
.sidebar-footer {
  padding: 14px;
  border-top: 1px solid #1e293b;
  background: rgba(15, 23, 42, 0.6);
}

.daemon-panel {
  background: #1e293b;
  border-radius: 6px;
  padding: 10px 12px;
  border: 1px solid #334155;
}

.daemon-indicator-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.pulse-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #64748b;
}

.pulse-dot.pulse-active {
  background: #10b981;
  box-shadow: 0 0 8px #10b981;
}

.daemon-status-text {
  font-size: 12px;
  font-weight: 600;
  color: #e2e8f0;
}

.daemon-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 11px;
  color: #94a3b8;
  font-family: monospace;
}

.version-badge {
  background: #0f172a;
  padding: 1px 5px;
  border-radius: 4px;
  color: #38bdf8;
}

/* 右侧工作区 */
.ops-main-wrapper {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: #f8fafc;
}

.ops-topbar {
  height: 60px;
  padding: 0 24px;
  background: #ffffff;
  border-bottom: 1px solid #e2e8f0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
}

.topbar-title-group {
  display: flex;
  flex-direction: column;
}

.view-main-title {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: #0f172a;
}

.view-sub-desc {
  font-size: 12px;
  color: #64748b;
}

.topbar-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.topbar-node-tag {
  font-family: monospace;
  font-size: 12px;
  background: #f1f5f9;
  color: #475569;
}

.ops-sync-btn {
  font-weight: 600;
}

/* 视图容器 */
.ops-content-container {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  position: relative;
}
</style>
