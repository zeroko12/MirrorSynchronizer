<script setup lang="ts">
/**
 * SettingsView - 主设置页
 *
 * 假设 NConfigProvider / NMessageProvider 已在父组件 App.vue 注册
 * 这里只放表单本身
 *
 * 字段: 源目录 / 目标目录 / 备份目录 / 检查间隔 / 保留备份数
 * 操作: 浏览(原生文件夹选择器) / 保存 / 立即同步一次
 * 反馈: 顶部消息条(成功/失败) + 表单校验提示
 */

import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
  NButton,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NSpace,
  NSpin,
  NText,
  NDivider,
  NSwitch,
  NTag,
  useMessage,
} from 'naive-ui';
import type { StatusInfo } from '../api';
import { getApi } from '../api';
import { useConfig } from '../composables/useConfig';

const { config, loading, saving, error, load, save } = useConfig();
const status = ref<StatusInfo | null>(null);
const popupEnabled = ref(true);
const autostartEnabled = ref(false);
const autostartLoading = ref(false);

const formReady = computed(() => !loading.value);
const canSave = computed(() => {
  if (saving.value) return false;
  if (!config.value.sourceDir || !config.value.targetDir) return false;
  if (config.value.intervalSec < 60 || config.value.intervalSec > 604800) return false;
  if (config.value.backupCount < 1 || config.value.backupCount > 20) return false;
  if (config.value.backupDir && config.value.backupDir === config.value.targetDir) return false;
  return true;
});

const savingRef = ref(false);
const lastError = ref<string | null>(null);
const lastSuccessAt = ref<number | null>(null);
const fileCount = ref<{ source: number; target: number; sourcePath: string; targetPath: string } | null>(null);

const message = useMessage();

onMounted(async () => {
  await load();
  await refreshStatus();
  // 加载 P4 弹窗开关
  const state = await getApi().stateGet();
  if (state) popupEnabled.value = state.popupEnabled;
  // 加载 P5 开机自启动状态(失败用 false,UI 上是关闭,用户重试时再次拉)
  try {
    const as = await getApi().autostartGet();
    autostartEnabled.value = as.openAtLogin;
  } catch {
    autostartEnabled.value = false;
  }
  // 订阅同步结果事件(从 preload 的 onSyncResult 转发)
  window.api.onSyncResult?.(() => {
    refreshStatus();
  });
  // 5 秒轮询刷新,即使没有同步事件也能看到调度器状态变化
  refreshTimer = window.setInterval(() => {
    refreshStatus();
  }, 5000);
});

async function onTogglePopup(enabled: boolean) {
  popupEnabled.value = enabled;
  const res = await getApi().stateSetPopupEnabled(enabled);
  if (res.ok) {
    message.success(enabled ? '已开启弹窗询问' : '已关闭弹窗,恢复静默同步');
  } else {
    message.error(res.error ?? '操作失败');
  }
}

async function onToggleAutostart(enabled: boolean) {
  autostartLoading.value = true;
  try {
    const res = await getApi().autostartSet(enabled);
    if (res.ok) {
      autostartEnabled.value = res.openAtLogin ?? enabled;
      message.success(enabled ? '已设置开机自启动' : '已关闭开机自启动');
    } else {
      message.error(res.error ?? '设置失败');
    }
  } finally {
    autostartLoading.value = false;
  }
}

async function onToggleApplyMappingsImmediately(enabled: boolean) {
  // 直接改本地 config,然后让 useConfig 触发 save
  config.value = { ...config.value, applyMappingsImmediately: enabled };
  const ok = await save();
  if (ok) {
    message.success(enabled ? '已开启:配置映射后立即拉过来' : '已关闭:等下次同步周期');
  } else {
    message.error('保存失败');
  }
}

onUnmounted(() => {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
});

let refreshTimer: number | null = null;

async function refreshStatus() {
  try {
    status.value = await getApi().getStatus();
  } catch {
    // ignore
  }
  try {
    fileCount.value = await getApi().countFiles();
  } catch {
    // ignore
  }
}

async function pickFolder(field: 'sourceDir' | 'targetDir' | 'backupDir') {
  const cur = config.value[field];
  const res = await getApi().selectFolder(cur || undefined);
  if (!res.canceled && res.path) {
    // 重新赋值整个对象,触发 shallowRef 响应式
    config.value = { ...config.value, [field]: res.path };
  }
}

async function onSave() {
  savingRef.value = true;
  lastError.value = null;
  const ok = await save();
  savingRef.value = false;
  if (ok) {
    lastSuccessAt.value = Date.now();
    message.success('配置已保存,后台调度器已热更新');
    await refreshStatus();
  } else {
    lastError.value = error.value;
    message.error(error.value || '保存失败');
  }
}

async function onSaveAndSync() {
  await onSave();
  if (canSave.value) {
    const res = await getApi().runSyncNow();
    if (res.ok) {
      message.success('立即同步已触发');
      await refreshStatus();
    } else {
      message.warning(res.error || '同步未执行');
    }
  }
}

function formatTime(ts: number | null): string {
  if (!ts) return '-';
  return new Date(ts).toLocaleString('zh-CN');
}
</script>

<template>
  <div class="page">
    <n-spin :show="loading">
      <div v-if="formReady" class="card">
        <!-- 调度器状态 + 上次同步摘要 + 源/目标文件数 -->
        <div class="status-bar">
          <n-space align="center" :wrap="false">
            <n-tag :type="status?.running ? 'success' : 'default'" size="small">
              {{ status?.running ? '调度器运行中' : '调度器未运行' }}
            </n-tag>
            <n-text depth="3" style="font-size: 13px">
              间隔 {{ status?.intervalSec ?? config.intervalSec }} 秒
            </n-text>
            <n-divider vertical />
            <template v-if="fileCount">
              <n-text style="font-size: 13px">
                源 <b>{{ fileCount.source }}</b> 文件 · 目标 <b>{{ fileCount.target }}</b> 文件
              </n-text>
            </template>
            <n-divider vertical />
            <template v-if="status?.lastResult">
              <n-text style="font-size: 13px">
                上次同步:
                <n-tag
                  v-if="status.lastResult.added > 0"
                  type="info"
                  size="small"
                  style="margin: 0 2px"
                >+{{ status.lastResult.added }}</n-tag>
                <n-tag
                  v-if="status.lastResult.modified > 0"
                  type="warning"
                  size="small"
                  style="margin: 0 2px"
                >~{{ status.lastResult.modified }}</n-tag>
                <n-tag
                  v-if="status.lastResult.deleted > 0"
                  type="error"
                  size="small"
                  style="margin: 0 2px"
                >−{{ status.lastResult.deleted }}</n-tag>
                <n-text v-if="status.lastResult.added === 0 && status.lastResult.modified === 0 && status.lastResult.deleted === 0" depth="3" style="font-size: 13px">
                  无变化
                </n-text>
                <span style="margin-left: 8px">· {{ status.lastResult.durationMs }}ms</span>
              </n-text>
            </template>
            <template v-else>
              <n-text depth="3" style="font-size: 13px">尚未同步</n-text>
            </template>
            <n-button text type="primary" size="tiny" @click="refreshStatus" style="margin-left: auto">
              刷新
            </n-button>
          </n-space>
        </div>

        <n-divider style="margin: 16px 0 20px" />

        <n-form label-placement="top" :show-feedback="true">
          <n-form-item label="源目录(SMB 挂载或本地路径)">
            <n-space :wrap="false">
              <n-input
                v-model:value="config.sourceDir"
                placeholder="例如 Z:\\updates 或 /mnt/smb/updates"
                clearable
                style="width: 460px"
              />
              <n-button @click="pickFolder('sourceDir')">浏览…</n-button>
            </n-space>
          </n-form-item>

          <n-form-item label="目标目录(镜像同步到此处)">
            <n-space :wrap="false">
              <n-input
                v-model:value="config.targetDir"
                placeholder="例如 D:\\app\\data"
                clearable
                style="width: 460px"
              />
              <n-button @click="pickFolder('targetDir')">浏览…</n-button>
            </n-space>
          </n-form-item>

          <n-form-item
            label="备份目录(留空 = 派生自目标目录的兄弟位置)"
            :feedback="config.backupDir === config.targetDir ? '备份目录不能等于目标目录,否则镜像同步会误删备份' : ''"
            :validation-status="config.backupDir === config.targetDir ? 'error' : undefined"
          >
            <n-space :wrap="false">
              <n-input
                v-model:value="config.backupDir"
                placeholder="例如 D:\\app\\data-backups(留空将自动派生)"
                clearable
                style="width: 460px"
              />
              <n-button @click="pickFolder('backupDir')">浏览…</n-button>
            </n-space>
          </n-form-item>

          <n-divider />

          <n-form-item label="检查间隔(秒, 60 - 604800 即 7 天)">
            <n-input-number
              v-model:value="config.intervalSec"
              :min="60"
              :max="604800"
              :step="60"
              placeholder="秒"
              style="width: 220px"
            />
            <n-text depth="3" style="margin-left: 12px">
              = {{ Math.floor(config.intervalSec / 60) }} 分
              <template v-if="config.intervalSec >= 3600">
                / {{ (config.intervalSec / 3600).toFixed(1) }} 小时
              </template>
            </n-text>
          </n-form-item>

          <n-form-item label="保留备份数(1 - 20)">
            <n-input-number
              v-model:value="config.backupCount"
              :min="1"
              :max="20"
              :step="1"
              style="width: 220px"
            />
          </n-form-item>
        </n-form>

        <n-divider style="margin: 20px 0" />

        <n-form-item label="检测到变化时">
          <n-space align="center">
            <n-switch
              :value="popupEnabled"
              @update:value="onTogglePopup"
            />
            <n-text depth="3" style="font-size: 13px">
              {{ popupEnabled ? '弹窗询问' : '自动同步(静默)' }}
            </n-text>
          </n-space>
          <template #feedback>
            <span style="font-size: 12px; color: #6b7785">
              弹窗模式:有变化时弹"立即同步 / 稍后 / 忽略"对话框,系统会保留在托盘后台运行
            </span>
          </template>
        </n-form-item>

        <n-form-item label="开机自启动">
          <n-space align="center">
            <n-switch
              :value="autostartEnabled"
              :loading="autostartLoading"
              @update:value="onToggleAutostart"
            />
            <n-text depth="3" style="font-size: 13px">
              {{ autostartEnabled ? '已启用(随系统启动)' : '未启用' }}
            </n-text>
          </n-space>
          <template #feedback>
            <span style="font-size: 12px; color: #6b7785">
              启动时静默到托盘(不弹主窗),需要查看时点托盘图标
            </span>
          </template>
        </n-form-item>

        <n-form-item label="保存映射后立即应用">
          <n-space align="center">
            <n-switch
              :value="config.applyMappingsImmediately"
              @update:value="onToggleApplyMappingsImmediately"
            />
            <n-text depth="3" style="font-size: 13px">
              {{ config.applyMappingsImmediately ? '已启用(配置完立即拉过来)' : '关闭(等下次同步周期)' }}
            </n-text>
          </n-space>
          <template #feedback>
            <span style="font-size: 12px; color: #6b7785">
              开启时:添加/编辑/启用映射 → 立刻拉过来,不用等 60s 同步周期;关闭时:等下次源变化时一起同步
            </span>
          </template>
        </n-form-item>

        <n-divider />

        <n-space>
          <n-button
            type="primary"
            :loading="savingRef"
            :disabled="!canSave"
            @click="onSave"
          >
            保存
          </n-button>
          <n-button
            :loading="savingRef"
            :disabled="!canSave"
            @click="onSaveAndSync"
          >
            保存并立即同步
          </n-button>
        </n-space>

        <div v-if="lastError" class="status-msg error">
          保存失败:{{ lastError }}
        </div>
        <div v-else-if="lastSuccessAt" class="status-msg success">
          已保存于 {{ formatTime(lastSuccessAt) }}
        </div>
      </div>
    </n-spin>

    <footer class="footer">
      <n-text depth="3" style="font-size: 12px">
        阶段:P2(设置 UI 已可读写,文件映射 UI 在 P5)
      </n-text>
    </footer>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  padding: 16px;
  max-width: 760px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
  overflow-y: auto;
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

.card {
  background: #fff;
  border: 1px solid #e4e7eb;
  border-radius: 8px;
  padding: 16px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
}

@media (min-width: 768px) {
  .card {
    padding: 24px;
  }
}

.status-bar {
  background: #f8f9fa;
  border: 1px solid #e9ecef;
  border-radius: 6px;
  padding: 10px 14px;
}

.status-msg {
  margin-top: 12px;
  padding: 8px 12px;
  border-radius: 4px;
  font-size: 13px;
}

.status-msg.error {
  color: #a02d3a;
  background: #fdf2f3;
  border: 1px solid #f5c6cb;
}

.status-msg.success {
  color: #2f9e44;
  background: #ebfbee;
  border: 1px solid #b2f2bb;
}

.footer {
  margin-top: auto;
  padding-top: 24px;
  text-align: center;
}
</style>
