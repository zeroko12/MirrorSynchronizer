<script setup lang="ts">
/**
 * App.vue - 应用根
 *
 * P3 引入 tab 切换:设置 / 备份 / 历史
 * P4 接 update:prompt 事件 → 触发 UpdateDialog
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
import SettingsView from './views/SettingsView.vue';
import BackupsView from './views/BackupsView.vue';
import HistoryView from './views/HistoryView.vue';
import MappingsView from './views/MappingsView.vue';
import UpdateDialog from './views/UpdateDialog.vue';

const tab = ref<'settings' | 'backups' | 'history' | 'mappings'>('settings');
const errors = ref<Array<{ message: string; stack?: string }>>([]);
const updateDialogRef = ref<InstanceType<typeof UpdateDialog> | null>(null);

onErrorCaptured((err) => {
  const e = err as Error;
  errors.value.push({ message: e.message, stack: e.stack });
  return false;
});

onMounted(() => {
  // P4: 监听主进程推送的"需要弹窗确认"事件
  window.api.onUpdatePrompt?.((payload) => {
    updateDialogRef.value?.showPrompt(payload);
  });
});
</script>

<template>
  <n-config-provider :locale="zhCN" :date-locale="dateZhCN">
    <n-message-provider>
      <div class="app-shell">
        <header class="app-header">
          <div class="app-title">自动更新检测</div>
          <n-tabs
            v-model:value="tab"
            type="line"
            size="medium"
            class="app-tabs"
            animated
          >
            <n-tab-pane name="settings" tab="设置" />
            <n-tab-pane name="mappings" tab="映射" />
            <n-tab-pane name="backups" tab="备份" />
            <n-tab-pane name="history" tab="历史" />
          </n-tabs>
        </header>

        <main class="app-main">
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
  gap: 16px;
  padding: 0 16px;
  border-bottom: 1px solid #e4e7eb;
  background: #fff;
  flex-shrink: 0;
  flex-wrap: nowrap;
  min-width: 0; /* 让内部 n-tabs 可以收缩 */
}

.app-title {
  font-size: 16px;
  font-weight: 600;
  color: #1f2933;
  white-space: nowrap;
  flex-shrink: 0;
}

.app-tabs {
  flex: 1;
  min-width: 0; /* 关键:允许 flex 子项收缩到内容以下 */
  overflow-x: auto; /* tab 太多时横向滚 */
  overflow-y: hidden;
}

.app-tabs :deep(.n-tabs-nav) {
  border-bottom: none;
}

.app-tabs :deep(.n-tabs-nav-scroll-content) {
  /* 让 tab 列表能横向滚 */
  white-space: nowrap;
}

/* 大屏(>= 900px)给点呼吸空间 */
@media (min-width: 900px) {
  .app-header {
    padding: 0 32px;
    gap: 32px;
  }
}

.app-main {
  flex: 1;
  min-height: 0; /* 关键:让 flex 子项能收缩 */
  display: flex;
  flex-direction: column;
  overflow: hidden; /* 不在这里滚,让各 view 的 .page 自己决定 */
  background: #f5f7fa;
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
