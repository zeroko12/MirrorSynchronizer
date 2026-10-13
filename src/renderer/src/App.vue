<script setup lang="ts">
/**
 * App.vue - 软件自动更新与同步工具
 *
 * 定位: 面向用户的简洁、高效更新管理平台
 * 风格: 清爽、直观、低认知负担、操作快捷
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
  dashboard: { title: '状态看板', subtitle: '查看当前更新状态与快捷操作' },
  settings: { title: '常规设置', subtitle: '配置更新来源、目标目录及同步方式' },
  mappings: { title: '文件保护', subtitle: '保护本机私有配置文件，避免被更新覆盖' },
  backups: { title: '历史备份', subtitle: '查看历史版本并可一键还原' },
  history: { title: '同步记录', subtitle: '查看历史同步详情与变动明细' },
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
      <div class="user-workbench">
        <!-- 1. 左侧功能导航 -->
        <aside class="workbench-sidebar">
          <div class="sidebar-brand">
            <div class="brand-badge">
              <svg viewBox="0 0 24 24" class="brand-icon" fill="none" stroke="currentColor" stroke-width="2.2">
                <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                <line x1="12" y1="22.08" x2="12" y2="12" />
              </svg>
            </div>
            <div class="brand-text">
              <span class="brand-title">自动更新工具</span>
              <span class="brand-tag">文件同步</span>
            </div>
          </div>

          <nav class="sidebar-menu">
            <button
              class="nav-item"
              :class="{ active: tab === 'dashboard' }"
              @click="tab = 'dashboard'"
            >
              <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="14" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
              </svg>
              <span>状态看板</span>
            </button>

            <button
              class="nav-item"
              :class="{ active: tab === 'settings' }"
              @click="tab = 'settings'"
            >
              <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              <span>常规设置</span>
            </button>

            <button
              class="nav-item"
              :class="{ active: tab === 'mappings' }"
              @click="tab = 'mappings'"
            >
              <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
              <span>文件保护</span>
            </button>

            <button
              class="nav-item"
              :class="{ active: tab === 'backups' }"
              @click="tab = 'backups'"
            >
              <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="21 8 21 21 3 21 3 8" />
                <rect x="1" y="3" width="22" height="5" />
                <line x1="10" y1="12" x2="14" y2="12" />
              </svg>
              <span>历史备份</span>
            </button>

            <button
              class="nav-item"
              :class="{ active: tab === 'history' }"
              @click="tab = 'history'"
            >
              <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              <span>同步记录</span>
            </button>
          </nav>

          <!-- 底部运行状态 -->
          <div class="sidebar-status-card">
            <div class="status-indicator-line">
              <span class="status-dot" :class="{ active: status?.running }" />
              <span class="status-txt">{{ status?.running ? '自动检查已开启' : '自动检查已暂停' }}</span>
            </div>
            <div class="status-desc">
              {{ status?.running ? `每 ${Math.round((status?.intervalSec ?? 300) / 60)} 分钟检查一次` : '点击右上方手动同步' }}
            </div>
          </div>
        </aside>

        <!-- 2. 右侧主操作区 -->
        <div class="workbench-main">
          <!-- 顶栏 -->
          <header class="main-topbar">
            <div class="topbar-heading">
              <h1 class="heading-title">{{ currentViewMeta.title }}</h1>
              <span class="heading-desc">{{ currentViewMeta.subtitle }}</span>
            </div>

            <div class="topbar-actions">
              <n-tag
                v-if="status?.sourceDir"
                size="small"
                :bordered="false"
                type="success"
                class="state-pill"
              >
                连接正常
              </n-tag>

              <n-button
                type="primary"
                size="medium"
                :loading="syncing"
                class="sync-primary-btn"
                @click="handleHeaderQuickSync"
              >
                <template #icon>
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2">
                    <polyline points="23 4 23 10 17 10" />
                    <polyline points="1 20 1 14 7 14" />
                    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                  </svg>
                </template>
                立即检查并同步
              </n-button>
            </div>
          </header>

          <!-- 视图页面 -->
          <main class="main-content">
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
/* 全局基础设置 */
html,
body {
  margin: 0;
  padding: 0;
  height: 100%;
  background: #f8fafc;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  color: #1e293b;
  overflow: hidden;
  user-select: none;
}

#app {
  height: 100vh;
  display: flex;
}

.user-workbench {
  display: flex;
  width: 100%;
  height: 100%;
}

/* 侧边栏 */
.workbench-sidebar {
  width: 200px;
  background: #0f172a;
  border-right: 1px solid #1e293b;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}

.sidebar-brand {
  height: 56px;
  padding: 0 16px;
  display: flex;
  align-items: center;
  gap: 10px;
  border-bottom: 1px solid #1e293b;
}

.brand-badge {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: #2563eb;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #ffffff;
}

.brand-icon {
  width: 17px;
  height: 17px;
}

.brand-text {
  display: flex;
  flex-direction: column;
}

.brand-title {
  font-size: 14px;
  font-weight: 700;
  color: #f8fafc;
}

.brand-tag {
  font-size: 11px;
  color: #64748b;
}

/* 菜单 */
.sidebar-menu {
  flex: 1;
  padding: 14px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.nav-item {
  width: 100%;
  height: 38px;
  padding: 0 12px;
  border-radius: 6px;
  background: transparent;
  border: none;
  display: flex;
  align-items: center;
  gap: 10px;
  color: #94a3b8;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
  text-align: left;
}

.nav-item:hover {
  background: rgba(255, 255, 255, 0.05);
  color: #f1f5f9;
}

.nav-item.active {
  background: #1e293b;
  color: #38bdf8;
  font-weight: 600;
}

.nav-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

/* 底部状态 */
.sidebar-status-card {
  margin: 12px;
  padding: 10px 12px;
  background: #1e293b;
  border-radius: 6px;
  border: 1px solid #334155;
}

.status-indicator-line {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #64748b;
}

.status-dot.active {
  background: #10b981;
  box-shadow: 0 0 6px #10b981;
}

.status-txt {
  font-size: 12px;
  font-weight: 600;
  color: #e2e8f0;
}

.status-desc {
  font-size: 11px;
  color: #94a3b8;
}

/* 右侧工作区 */
.workbench-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: #f8fafc;
}

.main-topbar {
  height: 56px;
  padding: 0 24px;
  background: #ffffff;
  border-bottom: 1px solid #e2e8f0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
}

.topbar-heading {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.heading-title {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: #0f172a;
}

.heading-desc {
  font-size: 12px;
  color: #64748b;
}

.topbar-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.state-pill {
  font-size: 12px;
}

.sync-primary-btn {
  font-weight: 600;
}

.main-content {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  position: relative;
}
</style>
