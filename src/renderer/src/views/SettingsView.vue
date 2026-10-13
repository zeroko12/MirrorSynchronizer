<script setup lang="ts">
/**
 * SettingsView.vue - 常规设置 (面向用户版)
 *
 * 核心目标:
 * 1. 彻底去除开发术语与技术堆叠，文案通俗易懂
 * 2. 界面分类明确 (目录设置、同步方式、忽略文件、系统设置)
 * 3. 布局简洁清晰，方便快捷操作
 */

import { computed, onMounted, onUnmounted, ref } from 'vue';
import { usePolling } from '../composables/usePolling';
import {
  NAlert,
  NButton,
  NDataTable,
  NInput,
  NInputNumber,
  NModal,
  NRadio,
  NRadioGroup,
  NRadioButton,
  NSpace,
  NSpin,
  NText,
  NSwitch,
  NTag,
  useMessage,
} from 'naive-ui';
import type { RemoteAccessInfo, SourceTestResult, StatusInfo, SourceAuth } from '../api';
import { getApi } from '../api';
import { useConfig } from '../composables/useConfig';
import { labelOf, adviceOf } from '@core/labels';
import * as formatUtil from '../utils/format';
import { tryLog } from '../utils/try-log';
import { copyText } from '../utils/clipboard';
import {
  MAX_BACKUP_COUNT,
  MAX_INTERVAL_SEC,
  MIN_BACKUP_COUNT,
  MIN_INTERVAL_SEC,
  SOURCE_TEST_SAMPLE_SIZE,
  UI_STATUS_POLL_MS,
} from '@core/constants';

const { config, loading, saving, error, load, save } = useConfig();
const status = ref<StatusInfo | null>(null);
const popupEnabled = ref(true);
const autostartEnabled = ref(false);
const autostartLoading = ref(false);

const newIgnoreItem = ref('');

function validateIgnoreItem(raw: string, existing: readonly string[]): string | null {
  if (!raw || !raw.trim()) return '不能为空';
  const normalized = raw.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!normalized || normalized === '.') return '不能为 "." 或空';
  if (normalized.includes('..')) return '不能包含 ".."';
  if (normalized.includes(':')) return '不能是绝对路径(不能含 ":")';
  if (existing.includes(normalized)) return '已存在';
  return null;
}

function addIgnoreItemFromInput() {
  const err = validateIgnoreItem(newIgnoreItem.value, config.value?.ignoreItems ?? []);
  if (err) {
    message.error(`规则不合法: ${err}`);
    return;
  }
  const normalized = newIgnoreItem.value.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  const next = [...(config.value?.ignoreItems ?? []), normalized];
  config.value = { ...config.value, ignoreItems: next };
  newIgnoreItem.value = '';
}

function addIgnorePreset(preset: string) {
  const existing = config.value?.ignoreItems ?? [];
  if (existing.includes(preset)) {
    message.info(`已存在该项: ${preset}`);
    return;
  }
  config.value = { ...config.value, ignoreItems: [...existing, preset] };
  message.success(`已添加忽略项: ${preset}`);
}

function removeIgnoreItem(idx: number) {
  const next = (config.value?.ignoreItems ?? []).filter((_, i) => i !== idx);
  config.value = { ...config.value, ignoreItems: next };
}

const pendingApplyCount = ref(0);
const applying = ref(false);

function onSyncModeChange(v: 'mirror' | 'bidirectional') {
  config.value = { ...config.value, syncMode: v };
}

function onConflictPolicyChange(v: 'rename-target' | 'source-wins' | 'target-wins' | 'manual') {
  config.value = { ...config.value, conflictPolicy: v };
}

function onApplyModeChange(v: 'immediate' | 'staging' | 'immediate-with-precheck') {
  config.value = { ...config.value, applyMode: v };
}

const preflightLocked = ref(false);
const preflightRelPath = ref('');
const executableUpdateBlocked = ref(false);

function clearExecutablePath() {
  config.value = { ...config.value, executablePath: '' };
}

async function pickExecutable() {
  if (!config.value?.targetDir) {
    message.warning('请先选择本机目录');
    return;
  }
  const result = await getApi().selectPath({
    defaultPath: config.value.targetDir,
    mode: 'file',
  });
  if (result.canceled || !result.path) return;
  const rel = absToRelPath(result.path, config.value.targetDir);
  if (rel === null) {
    message.error(`所选文件必须在本机目录内:\n${result.path}`);
    return;
  }
  if (rel === '') {
    message.warning('不能选目录本身');
    return;
  }
  config.value = { ...config.value, executablePath: rel };
}

async function refreshPendingApplyCount() {
  if (config.value?.applyMode !== 'staging') {
    pendingApplyCount.value = 0;
    return;
  }
  try {
    pendingApplyCount.value = await getApi().syncPendingApplyCount();
  } catch {
    pendingApplyCount.value = 0;
  }
}

async function applyPendingNow() {
  applying.value = true;
  try {
    const r = await getApi().syncApplyNow();
    if (r.ok) {
      message.success(`更新成功: ${r.applied} 个文件已替换生效`);
      await refreshStatus();
    } else {
      message.error(r.error ?? '更新失败');
    }
    await refreshPendingApplyCount();
  } finally {
    applying.value = false;
  }
}

async function clearPendingStaging() {
  if (!confirm('确认放弃当前待更新的新文件吗?')) return;
  try {
    const r = await getApi().syncClearStaging();
    if (r.ok) {
      message.success('已清空待更新文件');
      await refreshPendingApplyCount();
    } else {
      message.error(r.error ?? '操作失败');
    }
  } catch (err) {
    message.error((err as Error).message ?? '操作失败');
  }
}

function absToRelPath(absPath: string, baseDir: string): string | null {
  const norm = (p: string) => p.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  const a = norm(absPath);
  const b = norm(baseDir);
  if (!a || !b) return null;
  const aL = a.toLowerCase();
  const bL = b.toLowerCase();
  if (aL === bL) return '';
  if (!aL.startsWith(bL + '/')) return null;
  return a.substring(b.length + 1);
}

async function pickIgnoreItem(mode: 'file' | 'folder' | 'both') {
  if (!config.value?.targetDir) {
    message.warning('请先设置本机目录');
    return;
  }
  const result = await getApi().selectPath({
    defaultPath: config.value.targetDir,
    mode,
  });
  if (result.canceled || !result.path) return;
  const rel = absToRelPath(result.path, config.value.targetDir);
  if (rel === null) {
    message.error(`所选路径必须在本机目录内:\n${result.path}`);
    return;
  }
  if (rel === '') return;
  const existing = config.value?.ignoreItems ?? [];
  if (existing.includes(rel)) {
    message.warning(`已存在: ${rel}`);
    return;
  }
  config.value = { ...config.value, ignoreItems: [...existing, rel] };
}

const formReady = computed(() => !loading.value);
const canSave = computed(() => {
  if (saving.value) return false;
  if (!config.value.sourceDir || !config.value.targetDir) return false;
  if (config.value.intervalSec < MIN_INTERVAL_SEC || config.value.intervalSec > MAX_INTERVAL_SEC) return false;
  if (config.value.backupCount < MIN_BACKUP_COUNT || config.value.backupCount > MAX_BACKUP_COUNT) return false;
  if (config.value.backupDir && config.value.backupDir === config.value.targetDir) return false;
  return true;
});

const savingRef = ref(false);
const lastError = ref<string | null>(null);
const lastSuccessAt = ref<number | null>(null);
const fileCount = ref<{ source: number; target: number; sourcePath: string; targetPath: string } | null>(null);
const remoteInfo = ref<RemoteAccessInfo | null>(null);
const networkIPs = ref<Array<{ name: string; address: string; family: string; internal: boolean; mac: string }>>([]);
const togglingRemote = ref(false);
const resettingPassword = ref(false);
const newlyResetPassword = ref<string | null>(null);

async function loadRemoteInfo() {
  const info = await tryLog('getRemoteInfo', () => getApi().getRemoteInfo());
  if (info) remoteInfo.value = info;
}

async function loadNetworkIPs() {
  const ips = await tryLog('listNetworkIPs', () => getApi().listNetworkIPs());
  if (ips) networkIPs.value = ips;
}

async function copyTargetUrl(url: string) {
  const ok = await copyText(url);
  if (ok) {
    message.success(`已复制访问地址: ${url}`);
  } else {
    message.error('复制失败，请手动选取复制');
  }
}

async function copyPasswordText(pwd: string) {
  const ok = await copyText(pwd);
  if (ok) {
    message.success('访问密码已复制到剪贴板');
  } else {
    message.error('复制失败，请手动选取复制');
  }
}

async function openExternal(url: string) {
  await getApi().openExternal(url);
}

async function onToggleRemote(enabled: boolean) {
  togglingRemote.value = true;
  try {
    const result = await getApi().setRemoteEnabled(enabled);
    if (result.ok && result.info) {
      remoteInfo.value = result.info;
      if (enabled) {
        await loadNetworkIPs();
      }
      message.success(enabled ? '已启用局域网管理' : '已关闭局域网管理');
    } else {
      message.error(result.error ?? '操作失败');
    }
  } finally {
    togglingRemote.value = false;
  }
}


// 自定义修改密码状态
const showChangePasswordModal = ref(false);
const customPasswordInput = ref('');
const savingCustomPassword = ref(false);

function openChangePasswordModal() {
  customPasswordInput.value = '';
  showChangePasswordModal.value = true;
}

async function handleSaveCustomPassword() {
  const pwd = customPasswordInput.value.trim();
  if (!pwd) {
    message.warning('请输入新密码');
    return;
  }
  savingCustomPassword.value = true;
  try {
    const res = await getApi().setRemotePassword(pwd);
    if (res.ok) {
      if (res.info) remoteInfo.value = res.info;
      newlyResetPassword.value = pwd;
      message.success('密码已成功修改并生效');
      showChangePasswordModal.value = false;
      customPasswordInput.value = '';
    } else {
      message.error(res.error || '修改密码失败');
    }
  } catch (err) {
    message.error((err as Error).message || '修改密码失败');
  } finally {
    savingCustomPassword.value = false;
  }
}

async function onResetPassword() {
  resettingPassword.value = true;
  try {
    const result = await getApi().resetRemotePassword();
    if (result.ok && result.newPassword) {
      newlyResetPassword.value = result.newPassword;
      if (result.info) remoteInfo.value = result.info;
      message.success('密码已重新生成');
    } else {
      message.error(result.error ?? '重置失败');
    }
  } finally {
    resettingPassword.value = false;
  }
}

async function copyNewPassword() {
  if (!newlyResetPassword.value) return;
  const ok = await copyText(newlyResetPassword.value);
  if (ok) {
    message.success('新密码已复制到剪贴板');
  } else {
    message.error('复制失败');
  }
}

const retryCountdown = ref(0);
let countdownTimer: number | null = null;

// 远程源安全访问认证状态
const authEnabled = ref(false);
const authKind = ref<'basic' | 'cf-access'>('basic');
const authBasicUser = ref('');
const authBasicPass = ref('');
const authCfClientId = ref('');
const authCfClientSecret = ref('');
const authSecretEnv = ref('');

function syncAuthFromConfig() {
  if (config.value?.sourceAuth) {
    authEnabled.value = true;
    authKind.value = config.value.sourceAuth.kind;
    if (config.value.sourceAuth.kind === 'basic') {
      authBasicUser.value = config.value.sourceAuth.username || '';
      authBasicPass.value = config.value.sourceAuth.password || '';
    } else if (config.value.sourceAuth.kind === 'cf-access') {
      authCfClientId.value = config.value.sourceAuth.clientId || '';
      authCfClientSecret.value = config.value.sourceAuth.clientSecret || '';
    }
  } else {
    authEnabled.value = false;
  }
  authSecretEnv.value = config.value?.sourceAuthSecretEnv || '';
}

function buildCurrentAuth(): SourceAuth | undefined {
  if (!authEnabled.value) return undefined;
  if (authKind.value === 'basic') {
    return {
      kind: 'basic',
      username: authBasicUser.value.trim(),
      password: authBasicPass.value || undefined,
    };
  }
  if (authKind.value === 'cf-access') {
    return {
      kind: 'cf-access',
      clientId: authCfClientId.value.trim(),
      clientSecret: authCfClientSecret.value || undefined,
    };
  }
  return undefined;
}

function applyAuthToConfig() {
  if (authEnabled.value) {
    const auth = buildCurrentAuth();
    const env = authSecretEnv.value.trim();
    if (env && auth) {
      if (auth.kind === 'basic') delete auth.password;
      if (auth.kind === 'cf-access') delete auth.clientSecret;
    }
    config.value = {
      ...config.value,
      sourceAuth: auth,
      sourceAuthSecretEnv: env || undefined,
    };
  } else {
    config.value = {
      ...config.value,
      sourceAuth: undefined,
      sourceAuthSecretEnv: undefined,
    };
  }
}

function onToggleAuth(enabled: boolean) {
  authEnabled.value = enabled;
  if (enabled && !authBasicUser.value && !authCfClientId.value) {
    authBasicUser.value = '';
  }
}

const testState = ref<{
  show: boolean;
  loading: boolean;
  result: SourceTestResult | null;
}>({
  show: false,
  loading: false,
  result: null,
});

const testTableColumns = [
  { title: '文件名称', key: 'relPath', ellipsis: { tooltip: true } },
  {
    title: '大小',
    key: 'size',
    width: 100,
    render: (row: { size: number }) => formatBytes(row.size),
  },
  {
    title: '修改时间',
    key: 'mtimeMs',
    width: 170,
    render: (row: { mtimeMs: number }) => new Date(row.mtimeMs).toLocaleString('zh-CN'),
  },
];

function formatBytes(n: number): string {
  return formatUtil.formatBytes(n);
}

async function onTestSource() {
  const source = (config.value?.sourceDir ?? '').trim();
  if (!source) {
    message.warning('请先填写更新源路径');
    return;
  }
  testState.value = { show: true, loading: true, result: null };
  try {
    const auth = buildCurrentAuth();
    const env = authSecretEnv.value.trim() || undefined;
    const result = await getApi().sourceTest(source, auth, env);
    testState.value = { show: true, loading: false, result };
  } catch (err) {
    testState.value = {
      show: true,
      loading: false,
      result: {
        ok: false,
        error: (err as Error).message ?? '测试失败',
        fatalReason: 'unknown',
        durationMs: 0,
      },
    };
  }
}

function startCountdownIfNeeded() {
  const nextRun = status.value?.nextRunDelayMs;
  const isNetwork = (status.value?.consecutiveNetworkFailures ?? 0) > 0;
  if (isNetwork && nextRun && nextRun > 0) {
    retryCountdown.value = Math.ceil(nextRun / 1000);
    if (!countdownTimer) {
      countdownTimer = window.setInterval(() => {
        if (retryCountdown.value > 0) {
          retryCountdown.value--;
        } else {
          refreshStatus();
        }
      }, 1000);
    }
  } else {
    retryCountdown.value = 0;
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }
}

const networkAlert = computed(() => {
  const s = status.value;
  if (!s) return null;
  if ((s.consecutiveNetworkFailures ?? 0) > 0) {
    return {
      type: 'warning' as const,
      title: '暂时无法连接到更新源',
      message: '更新源路径可能离线或网络断开，稍后将自动重新尝试',
      retry: retryCountdown.value,
    };
  }
  if (s.lastFatalReason && s.lastResult && !s.lastResult.ok && s.lastFatalReason !== 'unknown') {
    const labels: Record<string, string> = {
      'not-found': '指定的更新源或目标目录不存在',
      'permission-denied': '文件夹权限不足，请以管理员身份运行',
      'disk-full': '磁盘空间不足',
      'busy': '程序正在运行中，部分文件被占用',
    };
    return {
      type: 'error' as const,
      title: '同步失败',
      message: labels[s.lastFatalReason] ?? s.lastFatalReason,
      retry: 0,
    };
  }
  return null;
});

const emit = defineEmits<{
  (e: 'navigate', tab: 'remote'): void;
}>();

const message = useMessage();

onMounted(async () => {
  await load();
  syncAuthFromConfig();
  await refreshStatus();
  await refreshPendingApplyCount();
  const state = await getApi().stateGet();
  if (state) popupEnabled.value = state.popupEnabled;
  const as = await tryLog('autostartGet', () => getApi().autostartGet());
  autostartEnabled.value = as?.openAtLogin ?? false;
  window.api.onSyncResult?.((result: any) => {
    refreshStatus();
    if (result?.executableUpdate === 'success' && result?.launchedPid) {
      message.success('更新已完成并已自动启动程序');
    } else if (result?.executableUpdate === 'blocked') {
      message.warning('目标程序正在运行，待其关闭后将自动更新');
      executableUpdateBlocked.value = true;
    }
  });
  window.api.onSyncPreflight?.((info) => {
    if (info.executableLocked) {
      preflightLocked.value = true;
      preflightRelPath.value = info.relPath;
    }
  });
  await loadRemoteInfo();
  await loadNetworkIPs();
});

async function onTogglePopup(enabled: boolean) {
  popupEnabled.value = enabled;
  const res = await getApi().stateSetPopupEnabled(enabled);
  if (res.ok) {
    message.success(enabled ? '已开启桌面更新提示' : '已设置为静默在后台同步');
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
      message.success(enabled ? '已设置开机自动启动' : '已关闭开机启动');
    } else {
      message.error(res.error ?? '设置失败');
    }
  } finally {
    autostartLoading.value = false;
  }
}

async function onToggleApplyMappingsImmediately(enabled: boolean) {
  config.value = { ...config.value, applyMappingsImmediately: enabled };
  const ok = await save();
  if (ok) {
    message.success(enabled ? '已开启即时生效' : '已设置为下次同步生效');
  } else {
    message.error('保存失败');
  }
}

onUnmounted(() => {
  if (countdownTimer) clearInterval(countdownTimer);
});

usePolling(refreshStatus, UI_STATUS_POLL_MS, { immediate: false });
usePolling(async () => {
  await loadRemoteInfo();
  if (remoteInfo.value?.enabled && networkIPs.value.length === 0) {
    await loadNetworkIPs();
  }
}, 5_000, { immediate: false });



async function refreshStatus() {
  const s = await tryLog('getStatus', () => getApi().getStatus());
  if (s) status.value = s;
  const fc = await tryLog('countFiles', () => getApi().countFiles());
  if (fc) fileCount.value = fc;
  startCountdownIfNeeded();
  await refreshPendingApplyCount();
}

async function pickFolder(field: 'sourceDir' | 'targetDir' | 'backupDir' | 'stagingDir') {
  const cur = config.value[field];
  const res = await getApi().selectFolder(cur || undefined);
  if (!res.canceled && res.path) {
    config.value = { ...config.value, [field]: res.path };
  }
}

async function onSave() {
  applyAuthToConfig();
  savingRef.value = true;
  lastError.value = null;
  const ok = await save();
  savingRef.value = false;
  if (ok) {
    lastSuccessAt.value = Date.now();
    message.success('设置已成功保存');
    await refreshStatus();
  } else {
    lastError.value = error.value;
    message.error(error.value || '保存失败');
  }
}

async function onSaveAndSync() {
  await onSave();
  if (canSave.value) {
    const res = await getApi().runSyncNowForce();
    if (res.ok) {
      message.success('已开始检查更新');
      await refreshStatus();
    } else {
      message.warning(res.error || '同步未执行');
    }
  }
}

function formatTime(ts: number | null): string {
  if (!ts) return '-';
  return new Date(ts).toLocaleTimeString('zh-CN');
}
</script>

<template>
  <div class="user-settings-view">
    <n-spin :show="loading">
      <div v-if="formReady" class="settings-wrap">
        <!-- 实时告警栏 -->
        <n-alert
          v-if="networkAlert"
          :type="networkAlert.type"
          :title="networkAlert.title"
          :show-icon="true"
          closable
          class="alert-banner"
        >
          {{ networkAlert.message }}
          <span v-if="networkAlert.retry > 0">
            (将在 {{ networkAlert.retry }} 秒后自动重试)
          </span>
        </n-alert>

        <!-- 顶部操作条 -->
        <div class="sticky-action-bar">
          <div class="action-info">
            <span class="save-status-text">
              <span v-if="lastSuccessAt" class="text-saved">✓ 已于 {{ formatTime(lastSuccessAt) }} 保存</span>
              <span v-else class="text-normal">配置就绪</span>
            </span>
            <span v-if="lastError" class="text-error">保存失败: {{ lastError }}</span>
          </div>

          <div class="action-btns">
            <n-button
              type="primary"
              size="medium"
              :loading="savingRef"
              :disabled="!canSave"
              @click="onSave"
            >
              保存设置
            </n-button>
            <n-button
              type="info"
              size="medium"
              :loading="savingRef"
              :disabled="!canSave"
              @click="onSaveAndSync"
            >
              保存并立即同步
            </n-button>
          </div>
        </div>

        <!-- 卡片 1: 目录设置 -->
        <div class="setting-card">
          <div class="card-title-group">
            <h3 class="card-title">目录设置</h3>
            <span class="card-subtitle">设置文件从哪里更新、更新到哪里</span>
          </div>

          <div class="card-fields">
            <!-- 更新源路径 -->
            <div class="setting-row">
              <div class="field-label-box">
                <span class="field-label">更新源路径</span>
                <span class="field-tip">从这个文件夹或服务器下载最新文件</span>
              </div>
              <div class="field-input-box">
                <div class="input-action-row">
                  <n-input
                    v-model:value="config.sourceDir"
                    placeholder="本地目录、局域网共享 \\server\share、或 http(s):// 地址"
                  />
                  <n-button @click="pickFolder('sourceDir')">选择文件夹</n-button>
                  <n-button :loading="testState.loading" @click="onTestSource">
                    测试连接
                  </n-button>
                </div>

                <!-- 远程源安全访问认证配置 -->
                <div class="auth-settings-container">
                  <div class="auth-toggle-row">
                    <div class="auth-text">
                      <span class="auth-title">安全访问认证 (HTTP / WebDAV 远程源)</span>
                      <span class="auth-desc">若更新源服务器设置了访问保护，可配置 Basic Auth 或 Cloudflare Access 凭据</span>
                    </div>
                    <n-switch
                      :value="authEnabled"
                      @update:value="onToggleAuth"
                    >
                      <template #checked>已启用</template>
                      <template #unchecked>未启用</template>
                    </n-switch>
                  </div>

                  <!-- 认证表单展开 -->
                  <div v-if="authEnabled" class="auth-form-card">
                    <div class="auth-kind-row">
                      <span class="auth-form-label">认证类型:</span>
                      <n-radio-group v-model:value="authKind" size="small">
                        <n-radio-button value="basic">Basic Auth (用户名 / 密码)</n-radio-button>
                        <n-radio-button value="cf-access">Cloudflare Access (Service Token)</n-radio-button>
                      </n-radio-group>
                    </div>

                    <!-- Basic Auth 输入项 -->
                    <template v-if="authKind === 'basic'">
                      <div class="auth-input-grid">
                        <div class="auth-field">
                          <span class="auth-field-label">用户名</span>
                          <n-input
                            v-model:value="authBasicUser"
                            placeholder="请输入 Basic Auth 用户名"
                          />
                        </div>
                        <div class="auth-field">
                          <span class="auth-field-label">访问密码</span>
                          <n-input
                            v-model:value="authBasicPass"
                            type="password"
                            show-password-on="click"
                            placeholder="请输入密码 (如从环境变量读取可留空)"
                          />
                        </div>
                      </div>
                    </template>

                    <!-- Cloudflare Access 输入项 -->
                    <template v-else-if="authKind === 'cf-access'">
                      <div class="auth-input-grid">
                        <div class="auth-field">
                          <span class="auth-field-label">Client ID</span>
                          <n-input
                            v-model:value="authCfClientId"
                            placeholder="例如: xxxxxx.access"
                          />
                        </div>
                        <div class="auth-field">
                          <span class="auth-field-label">Client Secret</span>
                          <n-input
                            v-model:value="authCfClientSecret"
                            type="password"
                            show-password-on="click"
                            placeholder="请输入 Service Token Secret"
                          />
                        </div>
                      </div>
                    </template>

                    <!-- 环境变量读取安全选项 -->
                    <div class="auth-env-section">
                      <div class="auth-env-header">
                        <span class="auth-field-label">从系统环境变量读取密钥 (推荐高级做法)</span>
                      </div>
                      <n-input
                        v-model:value="authSecretEnv"
                        placeholder="环境变量名，如: SYNC_SOURCE_SECRET (留空则使用上方输入的密码)"
                      />
                      <span class="auth-env-tip">
                        💡 填写环境变量名后，程序运行时将优先从该环境变量读取密码，配置文件中不会持久化保存密码明文。
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- 本机程序路径 -->
            <div class="setting-row">
              <div class="field-label-box">
                <span class="field-label">本机程序路径</span>
                <span class="field-tip">文件将被同步或更新到此目录</span>
              </div>
              <div class="field-input-box">
                <div class="input-action-row">
                  <n-input
                    v-model:value="config.targetDir"
                    placeholder="您本机待更新的软件所在目录"
                  />
                  <n-button @click="pickFolder('targetDir')">选择文件夹</n-button>
                </div>
              </div>
            </div>

            <!-- 备份存放路径 -->
            <div class="setting-row">
              <div class="field-label-box">
                <span class="field-label">备份保存路径</span>
                <span class="field-tip">可留空，默认自动保存在本机目录旁</span>
              </div>
              <div class="field-input-box">
                <div class="input-action-row">
                  <n-input
                    v-model:value="config.backupDir"
                    placeholder="留空则自动保存在: [本机目录-backups]"
                  />
                  <n-button @click="pickFolder('backupDir')">选择文件夹</n-button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 卡片 2: 同步方式与规则 -->
        <div class="setting-card">
          <div class="card-title-group">
            <h3 class="card-title">同步方式</h3>
            <span class="card-subtitle">选择同步模式、自动检查频率与更新行为</span>
          </div>

          <div class="card-fields">
            <!-- 模式选择 -->
            <div class="setting-row">
              <div class="field-label-box">
                <span class="field-label">同步模式</span>
                <span class="field-tip">如何处理两端的文件变动</span>
              </div>
              <div class="field-input-box">
                <n-radio-group
                  :value="config.syncMode ?? 'mirror'"
                  name="syncMode"
                  @update:value="onSyncModeChange"
                >
                  <div class="mode-select-grid">
                    <label class="mode-option-card" :class="{ selected: (config.syncMode ?? 'mirror') === 'mirror' }">
                      <n-radio value="mirror" />
                      <div class="mode-text">
                        <span class="mode-name">单向更新 (推荐)</span>
                        <span class="mode-desc">以更新源为准。本机上多余的文件会被清理，保持与源端完全一致。</span>
                      </div>
                    </label>

                    <label class="mode-option-card" :class="{ selected: config.syncMode === 'bidirectional' }">
                      <n-radio value="bidirectional" />
                      <div class="mode-text">
                        <span class="mode-name">双向协同</span>
                        <span class="mode-desc">两端互相同步。本机新加的文件会自动传回源端，互不丢失。</span>
                      </div>
                    </label>
                  </div>
                </n-radio-group>
              </div>
            </div>

            <!-- 双向同步时的冲突处理 -->
            <div class="setting-row" v-if="config.syncMode === 'bidirectional'">
              <div class="field-label-box">
                <span class="field-label">遇到冲突时</span>
                <span class="field-tip">两边同时修改了同一个文件时的处理方式</span>
              </div>
              <div class="field-input-box">
                <n-radio-group
                  :value="config.conflictPolicy ?? 'rename-target'"
                  name="conflictPolicy"
                  @update:value="onConflictPolicyChange"
                >
                  <n-space size="large">
                    <n-radio value="rename-target">自动重命名冲突副本 (推荐，保留双方数据)</n-radio>
                    <n-radio value="source-wins">以更新源为准覆盖</n-radio>
                    <n-radio value="target-wins">以本机修改为准</n-radio>
                  </n-space>
                </n-radio-group>
              </div>
            </div>

            <!-- 检查频率与备份数并排 -->
            <div class="dual-fields-row">
              <div class="field-sub-col">
                <span class="field-label">自动检查频率</span>
                <div class="input-with-unit">
                  <n-input-number
                    v-model:value="config.intervalSec"
                    :min="MIN_INTERVAL_SEC"
                    :max="MAX_INTERVAL_SEC"
                    style="width: 140px"
                  />
                  <span class="unit-text">秒 (约 {{ Math.round((config.intervalSec || 300) / 60) }} 分钟)</span>
                </div>
              </div>

              <div class="field-sub-col">
                <span class="field-label">保留备份数量</span>
                <div class="input-with-unit">
                  <n-input-number
                    v-model:value="config.backupCount"
                    :min="MIN_BACKUP_COUNT"
                    :max="MAX_BACKUP_COUNT"
                    style="width: 140px"
                  />
                  <span class="unit-text">份历史版本 (用于一键还原)</span>
                </div>
              </div>
            </div>

            <!-- 更新应用方式 -->
            <div class="setting-row">
              <div class="field-label-box">
                <span class="field-label">更新应用方式</span>
              </div>
              <div class="field-input-box">
                <n-radio-group
                  :value="config.applyMode ?? 'immediate'"
                  name="applyMode"
                  @update:value="onApplyModeChange"
                >
                  <n-space size="large">
                    <n-radio value="immediate">直接覆盖更新 (发现新文件立即替换)</n-radio>
                    <n-radio value="staging">先暂存 (下载完毕后，由我手动确认再应用)</n-radio>
                  </n-space>
                </n-radio-group>

                <div v-if="config.applyMode === 'staging'" class="staging-banner">
                  <span>当前有 <b>{{ pendingApplyCount }}</b> 个待应用的新文件</span>
                  <n-space size="small">
                    <n-button
                      size="small"
                      type="primary"
                      :disabled="pendingApplyCount === 0"
                      :loading="applying"
                      @click="applyPendingNow"
                    >
                      立即应用
                    </n-button>
                    <n-button
                      size="small"
                      :disabled="pendingApplyCount === 0"
                      @click="clearPendingStaging"
                    >
                      放弃更新
                    </n-button>
                  </n-space>
                </div>
              </div>
            </div>

            <!-- 目标主程序 -->
            <div class="setting-row">
              <div class="field-label-box">
                <span class="field-label">关联主程序</span>
                <span class="field-tip">可留空；指定后若程序运行中会提示避免损坏</span>
              </div>
              <div class="field-input-box">
                <div class="input-action-row">
                  <n-input
                    :value="config.executablePath ?? ''"
                    placeholder="例如: bin\\app.exe (必须在本机目录下)"
                    readonly
                  />
                  <n-button @click="pickExecutable">选择主程序</n-button>
                  <n-button v-if="config.executablePath" @click="clearExecutablePath">清除</n-button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 卡片 3: 排除项 (不更新的文件) -->
        <div class="setting-card">
          <div class="card-title-group">
            <h3 class="card-title">排除文件 (不参与更新)</h3>
            <span class="card-subtitle">添加不需要上传或下载的文件/文件夹名称</span>
          </div>

          <div class="card-fields">
            <div class="ignore-tags-panel">
              <div class="tags-list">
                <span v-if="!config.ignoreItems || config.ignoreItems.length === 0" class="tags-empty">
                  暂无排除项，所有文件均会正常同步
                </span>
                <n-tag
                  v-for="(item, idx) in config.ignoreItems"
                  :key="item"
                  closable
                  size="medium"
                  class="ignore-chip"
                  @close="removeIgnoreItem(idx)"
                >
                  {{ item }}
                </n-tag>
              </div>
            </div>

            <div class="input-action-row">
              <n-input
                v-model:value="newIgnoreItem"
                placeholder="输入文件名或文件夹，例如: logs/ 或 *.tmp"
                @keydown.enter="addIgnoreItemFromInput"
              />
              <n-button type="primary" @click="addIgnoreItemFromInput">添加</n-button>
              <n-button @click="pickIgnoreItem('file')">选择文件</n-button>
              <n-button @click="pickIgnoreItem('folder')">选择文件夹</n-button>
            </div>

            <div class="presets-bar">
              <span class="presets-title">快捷添加常用忽略:</span>
              <div class="preset-links">
                <button class="preset-link-btn" @click="addIgnorePreset('logs')">+ 日志目录 (logs/)</button>
                <button class="preset-link-btn" @click="addIgnorePreset('*.tmp')">+ 临时文件 (*.tmp)</button>
                <button class="preset-link-btn" @click="addIgnorePreset('.git')">+ .git</button>
                <button class="preset-link-btn" @click="addIgnorePreset('node_modules')">+ node_modules</button>
              </div>
            </div>
          </div>
        </div>

        <!-- 卡片 4: 局域网网页管理 (远程协同) -->
        <div class="setting-card">
          <div class="card-title-group">
            <div class="card-title-header-flex">
              <div>
                <h3 class="card-title">局域网网页管理 (远程协同)</h3>
                <span class="card-subtitle">开启后，同一局域网的手机、平板或其他电脑可通过浏览器访问本工具</span>
              </div>
              <n-button size="small" secondary @click="emit('navigate', 'remote')">
                打开独立管理面板 &gt;
              </n-button>
            </div>
          </div>

          <div class="card-fields">
            <div class="remote-access-card">
              <div class="remote-top">
                <div class="remote-text">
                  <span class="remote-title">服务运行状态</span>
                  <span class="remote-desc">通过后台轻量服务提供局域网网页控制台</span>
                </div>
                <n-switch
                  :value="remoteInfo?.enabled ?? false"
                  :loading="togglingRemote"
                  @update:value="onToggleRemote"
                />
              </div>

              <div v-if="remoteInfo?.enabled" class="remote-info-grid">
                <!-- 多网卡全部展示 -->
                <div class="info-item ip-addresses-section">
                  <div class="info-label-group">
                    <span class="info-label">访问网址</span>
                    <span class="info-sublabel">支持多网卡</span>
                  </div>
                  <div class="network-ips-list">
                    <template v-if="networkIPs.length > 0">
                      <div v-for="nic in networkIPs" :key="nic.address" class="ip-row-card">
                        <div class="nic-badge-col">
                          <span class="nic-badge">{{ nic.name || '网络' }}</span>
                        </div>
                        <span
                          class="nic-url link-span"
                          :title="`点击在浏览器打开 http://${nic.address}:${remoteInfo?.port || 52331}`"
                          @click="openExternal(`http://${nic.address}:${remoteInfo?.port || 52331}`)"
                        >
                          http://{{ nic.address }}:{{ remoteInfo?.port || 52331 }}
                        </span>
                        <div class="nic-btn-actions">
                          <n-button
                            size="tiny"
                            type="primary"
                            secondary
                            @click="copyTargetUrl(`http://${nic.address}:${remoteInfo?.port || 52331}`)"
                          >
                            复制
                          </n-button>
                          <n-button
                            size="tiny"
                            quaternary
                            @click="openExternal(`http://${nic.address}:${remoteInfo?.port || 52331}`)"
                          >
                            打开
                          </n-button>
                        </div>
                      </div>
                    </template>
                    <template v-else-if="remoteInfo?.url">
                      <div class="ip-row-card">
                        <span class="nic-url link-span" @click="openExternal(remoteInfo.url)">
                          {{ remoteInfo.url }}
                        </span>
                        <div class="nic-btn-actions">
                          <n-button size="tiny" type="primary" secondary @click="copyTargetUrl(remoteInfo.url)">
                            复制
                          </n-button>
                          <n-button size="tiny" quaternary @click="openExternal(remoteInfo.url)">
                            打开
                          </n-button>
                        </div>
                      </div>
                    </template>
                    <template v-else>
                      <span class="text-dim">正在获取本机 IP 列表...</span>
                    </template>
                  </div>
                </div>

                <!-- 密码管理(支持修改、查看、复制、重置) -->
                <div class="info-item">
                  <span class="info-label">访问密码</span>
                  <div class="info-val-row">
                    <span class="password-display">
                      {{ remoteInfo?.initialPassword ? remoteInfo.initialPassword : '•••••••• (已设置密码)' }}
                    </span>
                    <n-button
                      v-if="remoteInfo?.initialPassword"
                      size="tiny"
                      secondary
                      @click="copyPasswordText(remoteInfo.initialPassword)"
                    >
                      复制密码
                    </n-button>
                    <n-button
                      size="tiny"
                      type="primary"
                      ghost
                      @click="openChangePasswordModal"
                    >
                      修改密码
                    </n-button>
                    <n-popconfirm
                      @positive-click="onResetPassword"
                      positive-text="确认重置"
                      negative-text="取消"
                    >
                      <template #trigger>
                        <n-button size="tiny" :loading="resettingPassword">
                          随机重置
                        </n-button>
                      </template>
                      重置密码将重新生成随机密码，确定重置吗？
                    </n-popconfirm>
                  </div>
                </div>

                <div v-if="newlyResetPassword" class="new-pw-box">
                  <span>当前密码: <b>{{ newlyResetPassword }}</b></span>
                  <n-button size="tiny" type="primary" @click="copyNewPassword">复制</n-button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 卡片 5: 系统与运行选项 -->
        <div class="setting-card">
          <div class="card-title-group">
            <h3 class="card-title">系统与运行选项</h3>
            <span class="card-subtitle">开机自启、新版本桌面提醒与保护规则即时生效</span>
          </div>

          <div class="card-fields">
            <div class="toggle-row">
              <div class="toggle-text">
                <span class="toggle-title">开机自动启动</span>
                <span class="toggle-desc">电脑开机时自动在后台启动本工具，持续保持更新</span>
              </div>
              <n-switch
                :value="autostartEnabled"
                :loading="autostartLoading"
                @update:value="onToggleAutostart"
              />
            </div>

            <div class="toggle-row">
              <div class="toggle-text">
                <span class="toggle-title">发现新版本时弹窗提示</span>
                <span class="toggle-desc">检测到源端有更新时弹出对话框通知您确认</span>
              </div>
              <n-switch
                :value="popupEnabled"
                @update:value="onTogglePopup"
              />
            </div>

            <div class="toggle-row">
              <div class="toggle-text">
                <span class="toggle-title">规则保护即时生效</span>
                <span class="toggle-desc">在文件保护页面添加新规则后，立即自动执行一次</span>
              </div>
              <n-switch
                :value="config.applyMappingsImmediately ?? true"
                @update:value="onToggleApplyMappingsImmediately"
              />
            </div>
          </div>
        </div>

        <div class="footer-note">
          <span>自动更新工具 · 专注可靠安全的文件同步</span>
          <span class="version-hint">v1.2.0</span>
        </div>
      </div>
    </n-spin>

    <!-- 测试源连接结果弹窗 -->
    <n-modal
      v-model:show="testState.show"
      preset="card"
      style="width: 680px; max-width: 90vw"
      :title="testState.result?.ok ? '✓ 更新源连接正常' : '✗ 更新源连接失败'"
      :bordered="false"
      size="huge"
    >
      <n-spin :show="testState.loading">
        <div v-if="!testState.loading && testState.result">
          <template v-if="testState.result.ok">
            <n-space vertical :size="12">
              <n-space>
                <n-tag type="success">连接正常</n-tag>
                <n-text>共有 <b>{{ testState.result.fileCount }}</b> 个文件</n-text>
                <n-text>总大小 <b>{{ formatBytes(testState.result.totalSize ?? 0) }}</b></n-text>
                <n-text depth="3">响应时间 {{ testState.result.durationMs }}ms</n-text>
              </n-space>

              <n-alert v-if="(testState.result.fileCount ?? 0) === 0" type="warning">
                更新源目录目前为空
              </n-alert>

              <template v-else>
                <div style="font-size: 13px; font-weight: 600; margin-top: 8px">
                  文件列表预览 (前 {{ SOURCE_TEST_SAMPLE_SIZE }} 个):
                </div>
                <n-data-table
                  :columns="testTableColumns"
                  :data="testState.result.sample ?? []"
                  :pagination="false"
                  size="small"
                  :bordered="false"
                  striped
                />
              </template>
            </n-space>
          </template>

          <template v-else>
            <n-space vertical :size="12">
              <n-alert type="error" :show-icon="true">
                <n-space vertical :size="4">
                  <n-text><b>{{ labelOf(testState.result.fatalReason as any) }}</b></n-text>
                  <n-text depth="3" style="font-size: 12px">{{ testState.result.error }}</n-text>
                </n-space>
              </n-alert>
              <n-text depth="3" style="font-size: 12px">
                建议: {{ adviceOf(testState.result.fatalReason as any) }}
              </n-text>
            </n-space>
          </template>
        </div>
      </n-spin>

      <template #footer>
        <n-space justify="end">
          <n-button @click="testState.show = false">关闭</n-button>
          <n-button
            v-if="testState.result && !testState.result.ok"
            type="primary"
            @click="onTestSource"
          >
            重新测试
          </n-button>
        </n-space>
      </template>
    </n-modal>
    <!-- 修改局域网访问密码 Modal -->
    <n-modal
      v-model:show="showChangePasswordModal"
      preset="card"
      title="修改局域网访问密码"
      style="max-width: 440px"
    >
      <div class="change-pw-form">
        <p class="change-pw-tip">
          设置自定义密码后，同一局域网设备通过网页访问本工具时需输入此密码进行身份验证。
        </p>
        <n-form-item label="设置新密码">
          <n-input
            v-model:value="customPasswordInput"
            type="password"
            show-password-on="click"
            placeholder="请输入新密码 (例如: admin888)"
            @keyup.enter="handleSaveCustomPassword"
          />
        </n-form-item>
      </div>
      <template #footer>
        <n-space justify="end">
          <n-button @click="showChangePasswordModal = false">取消</n-button>
          <n-button
            type="primary"
            :loading="savingCustomPassword"
            :disabled="!customPasswordInput.trim()"
            @click="handleSaveCustomPassword"
          >
            保存密码
          </n-button>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>

<style scoped>
.user-settings-view {
  height: 100%;
  overflow-x: hidden !important;
  overflow-y: auto;
  padding: 20px 24px 60px;
  box-sizing: border-box;
}

.settings-wrap {
  max-width: 1000px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.alert-banner {
  border-radius: 8px;
}

/* 顶部操作条 */
.sticky-action-bar {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 12px 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.03);
}

.action-info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.text-saved {
  color: #10b981;
  font-size: 13px;
  font-weight: 600;
}

.text-normal {
  color: var(--text-muted);
  font-size: 13px;
}

.text-error {
  color: #ef4444;
  font-size: 12px;
}

.action-btns {
  display: flex;
  gap: 10px;
}

/* 卡片容器 */
.setting-card {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 20px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.02);
}

.card-title-header-flex {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
}

.card-title-group {
  margin-bottom: 16px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border-color);
}

.card-title {
  margin: 0 0 4px;
  font-size: 15px;
  font-weight: 700;
  color: var(--text-main);
}

.card-subtitle {
  font-size: 12px;
  color: var(--text-muted);
}

.card-fields {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* 字段行 */
.setting-row {
  display: grid;
  grid-template-columns: 180px 1fr;
  align-items: start;
  gap: 16px;
}

.field-label-box {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 6px;
}

.field-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-main);
}

.field-tip {
  font-size: 12px;
  color: var(--text-dim);
  line-height: 1.4;
}

.field-input-box {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.input-action-row {
  display: flex;
  gap: 8px;
}

/* 双列并排 */
.dual-fields-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
  padding: 8px 0;
}

.field-sub-col {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.input-with-unit {
  display: flex;
  align-items: center;
  gap: 8px;
}

.unit-text {
  font-size: 12px;
  color: var(--text-muted);
}

/* 模式单选 */
.mode-select-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.mode-option-card {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 14px;
  background: var(--bg-subtle);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.mode-option-card:hover {
  background: var(--bg-hover);
}

.mode-option-card.selected {
  background: var(--card-selected-bg);
  border-color: var(--card-selected-border);
}

.mode-text {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.mode-name {
  font-size: 13px;
  font-weight: 700;
  color: var(--text-main);
}

.mode-desc {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.4;
}

/* 暂存提示 */
.staging-banner {
  margin-top: 8px;
  padding: 8px 12px;
  background: #f0fdf4;
  border: 1px solid #bbf7d0;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: #166534;
}

/* 忽略项列表 */
.ignore-tags-panel {
  background: var(--bg-subtle);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 10px 12px;
}

.tags-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  min-height: 32px;
  align-items: center;
}

.tags-empty {
  font-size: 12px;
  color: #94a3b8;
}

.ignore-chip {
  font-family: monospace;
}

.presets-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
}

.presets-title {
  color: #64748b;
}

.preset-links {
  display: flex;
  gap: 8px;
}

.preset-link-btn {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 3px 8px;
  font-size: 11px;
  color: var(--text-main);
  cursor: pointer;
  transition: all 0.15s ease;
}

.preset-link-btn:hover {
  background: var(--bg-hover);
}

/* 开关行 */
.toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  background: var(--bg-subtle);
  border: 1px solid var(--border-color);
  border-radius: 6px;
}

.toggle-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.toggle-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-main);
}

.toggle-desc {
  font-size: 12px;
  color: var(--text-muted);
}

/* 局域网管理面板 */
.remote-access-card {
  background: var(--bg-subtle);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 12px 14px;
}

.remote-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.remote-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.remote-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-main);
}

.remote-desc {
  font-size: 12px;
  color: var(--text-muted);
}

.remote-info-grid {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.info-item {
  display: flex;
  align-items: center;
  gap: 16px;
  font-size: 12px;
}

.info-label {
  width: 70px;
  color: var(--text-muted);
}

.info-val-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.link-span {
  color: #2563eb;
  cursor: pointer;
  text-decoration: underline;
  font-family: monospace;
}

.new-pw-box {
  padding: 6px 10px;
  background: var(--warn-box-bg);
  border: 1px solid var(--warn-box-border);
  border-radius: 4px;
  font-size: 12px;
  color: var(--warn-box-text);
  display: flex;
  align-items: center;
  gap: 10px;
}

.footer-note {
  text-align: center;
  font-size: 11px;
  color: #94a3b8;
  cursor: pointer;
  user-select: none;
}

.ip-addresses-section {
  align-items: flex-start !important;
}

.info-label-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 70px;
  flex-shrink: 0;
}

.info-sublabel {
  font-size: 11px;
  color: var(--text-dim);
}

.network-ips-list {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ip-row-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  flex-wrap: wrap;
}

.nic-badge-col {
  flex-shrink: 0;
}

.nic-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--panel-tag-bg);
  border: 1px solid var(--panel-tag-border);
  color: var(--panel-tag-color);
  font-family: monospace;
}

.nic-url {
  font-family: monospace;
  font-size: 13px;
  color: #2563eb;
  cursor: pointer;
  text-decoration: underline;
  word-break: break-all;
  flex: 1;
  min-width: 140px;
}

.nic-btn-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.password-display {
  font-family: monospace;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-main);
  padding: 3px 8px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 4px;
}

.change-pw-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.change-pw-tip {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.5;
}


/* 远程源安全认证配置卡片 */
.auth-settings-container {
  margin-top: 10px;
  background: var(--bg-hover);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.auth-toggle-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
}

.auth-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.auth-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-main);
}

.auth-desc {
  font-size: 12px;
  color: var(--text-muted);
}

.auth-form-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 12px;
  border-top: 1px dashed var(--border-color);
}

.auth-kind-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.auth-form-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-main);
  flex-shrink: 0;
}

.auth-input-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 10px;
}

.auth-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.auth-field-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
}

.auth-env-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 10px 12px;
}

.auth-env-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.auth-env-tip {
  font-size: 11px;
  color: var(--text-dim);
  line-height: 1.4;
}

</style>
