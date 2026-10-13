<script setup lang="ts">
/**
 * App.vue - 软件更新中心应用外壳
 *
 * 现代化布局:
 * - 默认概览页 (DashboardView)
 * - 顶部品牌区与精致 Tab 导航
 * - 响应式微交互
 */

import { ref, onErrorCaptured, onMounted } from 'vue';
import {
  NConfigProvider,
  NMessageProvider,
  NTabs,
  NTabPane,
  zhCN,
  dateZhCN,
} from 'naive-ui';
import DashboardView from './views/DashboardView.vue';
import SettingsView from './views/SettingsView.vue';
import BackupsView from './views/BackupsView.vue';
import HistoryView from './views/HistoryView.vue';
import MappingsView from './views/MappingsView.vue';
import UpdateDialog from './views/UpdateDialog.vue';

const tab = ref<'dashboard' | 'settings' | 'backups' | 'history' | 'mappings'>('dashboard');
const errors = ref<Array<{ message: string; stack?: string }>>([]);
const updateDialogRef = ref<InstanceType<typeof UpdateDialog> | null>(null);

onErrorCaptured((err) => {
  const e = err as Error;
  errors.value.push({ message: e.message, stack: e.stack });
  return false;
});

onMounted(() => {
  // 监听主进程推送的"需要弹窗确认"事件
  window.api.onUpdatePrompt?.((payload) => {
    updateDialogRef.value?.showPrompt(payload);
  });
});

function handleNavigate(targetTab: 'dashboard' | 'settings' | 'backups' | 'history' | 'mappings') {
  tab.value = targetTab;
}
</script>

<template>
  <n-config-provider :locale="zhCN" :date-locale="dateZhCN">
    <n-message-provider>
      <div class="app-shell">
        <header class="app-header">
          <div class="brand-area" @click="tab = 'dashboard'">
            <span class="brand-icon">🚀</span>
            <div class="brand-text">
              <span class="app-title">软件更新与同步中心</span>
              <span class="app-subtitle">MirrorSynchronizer v0.3.4</span>
            </div>
          </div>

          <n-tabs
            v-model:value="tab"
            type="line"
            size="medium"
            class="app-tabs"
            animated
          >
            <n-tab-pane name="dashboard" tab="🏠 概览" />
            <n-tab-pane name="settings" tab="⚙️ 设置" />
            <n-tab-pane name="mappings" tab="🛡️ 保护规则" />
            <n-tab-pane name="backups" tab="📦 备份快照" />
            <n-tab-pane name="history" tab="📜 日志" />
          </n-tabs>
        </header>

        <main class="app-main">
          <DashboardView v-show="tab === 'dashboard'" @navigate="handleNavigate" />
          <SettingsView v-show="tab === 'settings'" />
          <MappingsView v-show="tab === 'mappings'" />
          <BackupsView v-show="tab === 'backups'" />
          <HistoryView v-show="tab === 'history'" />
        </main>

        <UpdateDialog ref="updateDialogRef" />

        <div v-if="errors.length > 0" class="error-bar">
          <strong>页面错误(已捕获):</strong>
          <ul>
            <li v-for="(e, i) in errors" :key="i">
              {{ e.message }}
              <details v-if="e.stack">
                <summary>stack</summary>
                <pre>{{ e.stack }}</pre>
              </details>
            </li>
          </ul>
        </div>
      </div>
    </n-message-provider>
  </n-config-provider>
</template>

<style>
html,
body {
  margin: 0;
  padding: 0;
  height: 100%;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}

#app {
  height: 100vh;
  display: flex;
  flex-direction: column;
}

.app-shell {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.app-header {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 0 20px;
  border-bottom: 1px solid #e2e8f0;
  background: #ffffff;
  flex-shrink: 0;
  flex-wrap: nowrap;
  min-width: 0;
  height: 58px;
}

.brand-area {
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  user-select: none;
  flex-shrink: 0;
}

.brand-icon {
  font-size: 22px;
}

.brand-text {
  display: flex;
  flex-direction: column;
}

.app-title {
  font-size: 15px;
  font-weight: 700;
  color: #0f172a;
  white-space: nowrap;
  line-height: 1.2;
}

.app-subtitle {
  font-size: 11px;
  color: #64748b;
  font-family: monospace;
}

.app-tabs {
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
}

.app-tabs :deep(.n-tabs-nav) {
  border-bottom: none;
}

.app-tabs :deep(.n-tabs-nav-scroll-content) {
  white-space: nowrap;
}

.app-tabs :deep(.n-tabs-tab) {
  font-size: 14px;
  font-weight: 500;
  padding: 18px 14px !important;
}

.app-tabs :deep(.n-tabs-tab--active) {
  font-weight: 600;
}

@media (min-width: 900px) {
  .app-header {
    padding: 0 32px;
    gap: 36px;
  }
}

.app-main {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #f8fafc;
}

.error-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: #fff3f3;
  border-top: 2px solid #f5c6cb;
  padding: 8px 16px;
  font-size: 12px;
  color: #a02d3a;
  z-index: 9999;
  max-height: 200px;
  overflow: auto;
}

.error-bar pre {
  font-size: 10px;
  white-space: pre-wrap;
  margin: 4px 0;
}
</style>
