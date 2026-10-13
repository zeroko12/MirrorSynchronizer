<script setup lang="ts">
/**
 * App.vue - 自动更新工具主界面
 *
 * 核心功能:
 * 1. 左侧导航栏: 顶天立地固定一整列 (高度 100vh), 绝对不随内容变长变短
 * 2. 顶部状态栏: 固定高度 56px, 水平线与侧栏 Logo 严格齐平
 * 3. 黑白主题切换: 支持深浅色模式即时无缝切换, 状态持久化到本地存储
 * 4. 右侧主视口: 统一版心宽度, 切换 Tab 绝无任何布局跳动与变形
 */

import { ref, computed, onMounted } from 'vue';
import {
  NConfigProvider,
  NMessageProvider,
  NButton,
  NTag,
  darkTheme,
  zhCN,
  dateZhCN,
} from 'naive-ui';
import DashboardView from './views/DashboardView.vue';
import SettingsView from './views/SettingsView.vue';
import RemoteView from './views/RemoteView.vue';
import BackupsView from './views/BackupsView.vue';
import HistoryView from './views/HistoryView.vue';
import MappingsView from './views/MappingsView.vue';
import UpdateDialog from './views/UpdateDialog.vue';
import { getApi, type StatusInfo } from './api';
import { usePolling } from './composables/usePolling';
import { UI_STATUS_POLL_MS } from '@core/constants';
import { tryLog } from './utils/try-log';

const tab = ref<'dashboard' | 'settings' | 'remote' | 'mappings' | 'backups' | 'history'>('dashboard');
const updateDialogRef = ref<InstanceType<typeof UpdateDialog> | null>(null);
const status = ref<StatusInfo | null>(null);
const syncing = ref(false);

// 黑白主题模式状态管理
const isDark = ref(localStorage.getItem('mirror_sync_theme') === 'dark');

function toggleTheme() {
  isDark.value = !isDark.value;
  localStorage.setItem('mirror_sync_theme', isDark.value ? 'dark' : 'light');
  applyThemeClass();
}

function applyThemeClass() {
  if (isDark.value) {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
  // 通知 Electron 原生窗口同步主题模式(切换 Windows 标题栏底色及原生边框)
  window.api?.$invoke?.('theme:set', isDark.value ? 'dark' : 'light').catch(() => {});
}

async function refreshStatus() {
  const s = await tryLog('getStatus', () => getApi().getStatus());
  if (s) status.value = s;
}

usePolling(refreshStatus, UI_STATUS_POLL_MS, { immediate: true });

onMounted(() => {
  applyThemeClass();
  refreshStatus();
  window.api?.onUpdatePrompt?.((payload) => {
    updateDialogRef.value?.showPrompt(payload);
  });
});

const viewTitles: Record<string, { title: string; subtitle: string }> = {
  dashboard: { title: '状态看板', subtitle: '查看当前更新状态与快捷操作' },
  settings: { title: '常规设置', subtitle: '配置更新来源、目标目录及同步方式' },
  remote: { title: '局域网管理', subtitle: '局域网网页协同、多网卡地址与访问安全设置' },
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

function handleNavigate(targetTab: 'dashboard' | 'settings' | 'remote' | 'backups' | 'history' | 'mappings') {
  tab.value = targetTab;
}
</script>

<template>
  <n-config-provider
    :theme="isDark ? darkTheme : null"
    :locale="zhCN"
    :date-locale="dateZhCN"
    style="width: 100%; height: 100%; display: flex;"
  >
    <n-message-provider>
      <div class="user-workbench" :class="{ 'theme-dark': isDark }">
        <!-- 1. 左侧功能导航 (贯穿全屏高度一列到底) -->
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

          <!-- 菜单按钮纵向一列排布 -->
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
              :class="{ active: tab === 'remote' }"
              @click="tab = 'remote'"
            >
              <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M5 12.55a11 11 0 0 1 14.08 0" />
                <path d="M1.42 9a16 16 0 0 1 21.16 0" />
                <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
                <line x1="12" y1="20" x2="12.01" y2="20" stroke-width="2.5" />
              </svg>
              <span>局域网管理</span>
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

          <!-- 底部常驻运行状态 -->
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

        <!-- 2. 右侧主工作区 (顶天立地, 高度绝对锁定) -->
        <div class="workbench-main">
          <!-- 顶栏 (高度固定 56px, 与侧边栏 Logo 严格平齐) -->
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

              <!-- 黑白主题切换按钮 -->
              <button
                class="theme-toggle-btn"
                :title="isDark ? '切换至明亮模式' : '切换至暗黑模式'"
                @click="toggleTheme"
              >
                <!-- 太阳图标 (暗黑模式下显示，点击切明亮) -->
                <svg v-if="isDark" viewBox="0 0 24 24" class="theme-icon" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="5" />
                  <line x1="12" y1="1" x2="12" y2="3" />
                  <line x1="12" y1="21" x2="12" y2="23" />
                  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                  <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                  <line x1="1" y1="12" x2="3" y2="12" />
                  <line x1="21" y1="12" x2="23" y2="12" />
                  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                  <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                </svg>
                <!-- 月亮图标 (明亮模式下显示，点击切暗黑) -->
                <svg v-else viewBox="0 0 24 24" class="theme-icon" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                </svg>
              </button>

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

          <!-- 视图内容承载区 (占满剩余高度, 内部子页面各自自适应滚动) -->
          <main class="main-content">
            <DashboardView v-if="tab === 'dashboard'" @navigate="handleNavigate" />
            <SettingsView v-if="tab === 'settings'" @navigate="handleNavigate" />
            <RemoteView v-if="tab === 'remote'" />
            <MappingsView v-if="tab === 'mappings'" />
            <BackupsView v-if="tab === 'backups'" />
            <HistoryView v-if="tab === 'history'" />
          </main>
        </div>

        <UpdateDialog ref="updateDialogRef" />
      </div>
    </n-message-provider>
  </n-config-provider>
</template>

<style>
/* 全局视口严密锁定 */
html,
body {
  margin: 0;
  padding: 0;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  background: var(--bg-page);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  color: var(--text-main);
  user-select: none;
}

#app {
  width: 100vw;
  height: 100vh;
  display: flex;
  overflow: hidden;
}

.user-workbench {
  display: flex;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
}

/* 侧边栏: 顶天立地, 占满 100vh */
.workbench-sidebar {
  width: 200px;
  height: 100vh;
  background: var(--sidebar-bg);
  border-right: 1px solid var(--sidebar-border);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  box-sizing: border-box;
  transition: background-color 0.2s ease, border-color 0.2s ease;
}

.sidebar-brand {
  height: 56px;
  padding: 0 16px;
  display: flex;
  align-items: center;
  gap: 10px;
  border-bottom: 1px solid var(--sidebar-border);
  flex-shrink: 0;
  box-sizing: border-box;
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
  color: var(--sidebar-brand-title);
  transition: color 0.2s ease;
}

.brand-tag {
  font-size: 11px;
  color: var(--sidebar-brand-tag);
  transition: color 0.2s ease;
}

/* 菜单项竖直一列排布 */
.sidebar-menu {
  flex: 1;
  padding: 14px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow-x: hidden !important;
  overflow-y: auto;
}

.nav-item {
  width: 100%;
  height: 40px;
  padding: 0 12px;
  border-radius: 6px;
  background: transparent;
  border: none;
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--sidebar-nav-color);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
  text-align: left;
  box-sizing: border-box;
}

.nav-item:hover {
  background: var(--sidebar-nav-hover-bg);
  color: var(--sidebar-nav-hover-color);
}

.nav-item.active {
  background: var(--sidebar-nav-active-bg);
  color: var(--sidebar-nav-active-color);
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
  background: var(--sidebar-status-bg);
  border-radius: 6px;
  border: 1px solid var(--sidebar-status-border);
  flex-shrink: 0;
  box-sizing: border-box;
  transition: all 0.2s ease;
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
  color: var(--sidebar-status-text);
  transition: color 0.2s ease;
}

.status-desc {
  font-size: 11px;
  color: var(--sidebar-status-desc);
  transition: color 0.2s ease;
}

/* 右侧工作区 */
.workbench-main {
  flex: 1;
  height: 100vh;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--bg-page);
  overflow: hidden;
  box-sizing: border-box;
  transition: background-color 0.2s ease;
}

.main-topbar {
  height: 56px;
  padding: 0 24px;
  background: var(--topbar-bg);
  border-bottom: 1px solid var(--topbar-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
  box-sizing: border-box;
  transition: background-color 0.2s ease, border-color 0.2s ease;
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
  color: var(--text-main);
}

.heading-desc {
  font-size: 12px;
  color: var(--text-muted);
}

.topbar-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.state-pill {
  font-size: 12px;
}

/* 主题切换按钮 */
.theme-toggle-btn {
  width: 32px;
  height: 32px;
  border-radius: 6px;
  border: 1px solid var(--border-color);
  background: var(--bg-card);
  color: var(--text-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.2s ease;
}

.theme-toggle-btn:hover {
  background: var(--bg-subtle);
  color: var(--text-main);
  border-color: var(--text-muted);
}

.theme-icon {
  width: 16px;
  height: 16px;
}

.sync-primary-btn {
  font-weight: 600;
}

.main-content {
  flex: 1;
  height: calc(100vh - 56px);
  min-height: 0;
  overflow: hidden !important;
  position: relative;
  box-sizing: border-box;
}
</style>
