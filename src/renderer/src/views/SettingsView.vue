<script setup lang="ts">
/**
 * SettingsView.vue - 专业运维配置控制台 (Ops Configuration Console)
 *
 * 定位: 专业基础设施级同步与更新配置面板
 * 特点:
 * 1. 结构化分区 (Endpoints, Engine Policy, Filter Rules, Services & Remote)
 * 2. 紧凑高信息密度, 清除冗余 demo 遗留
 * 3. 运维常用预设一键注入, 强状态反馈
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
  NSpace,
  NSpin,
  NText,
  NSwitch,
  NTag,
  useMessage,
} from 'naive-ui';
import type { RemoteAccessInfo, SourceTestResult, StatusInfo } from '../api';
import { getApi } from '../api';
import { useConfig } from '../composables/useConfig';
import { labelOf, adviceOf } from '@core/labels';
import * as formatUtil from '../utils/format';
import { tryLog } from '../utils/try-log';
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
    message.error(`忽略项非法: ${err}`);
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
    message.info(`已包含预设项: ${preset}`);
    return;
  }
  config.value = { ...config.value, ignoreItems: [...existing, preset] };
  message.success(`已添加排除项: ${preset}`);
}

function removeIgnoreItem(idx: number) {
  const next = (config.value?.ignoreItems ?? []).filter((_, i) => i !== idx);
  config.value = { ...config.value, ignoreItems: next };
}

const pendingApplyCount = ref(0);
const applying = ref(false);
const effectiveStagingDir = computed(() => {
  const c = config.value;
  if (!c?.targetDir) return '';
  return c.stagingDir || `${c.targetDir.replace(/[\\/]+$/, '')}-staging`;
});

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
    message.warning('请先填写目标目录');
    return;
  }
  const result = await getApi().selectPath({
    defaultPath: config.value.targetDir,
    mode: 'file',
  });
  if (result.canceled || !result.path) return;
  const rel = absToRelPath(result.path, config.value.targetDir);
  if (rel === null) {
    message.error(`所选路径必须在目标目录内:\n${result.path}`);
    return;
  }
  if (rel === '') {
    message.warning('选了目标目录自身, 无意义');
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
      message.success(`应用完成: ${r.applied} 个文件, ${r.blocked} 个被锁跳过`);
      await refreshStatus();
    } else {
      message.error(r.error ?? '应用失败');
    }
    await refreshPendingApplyCount();
  } finally {
    applying.value = false;
  }
}

async function clearPendingStaging() {
  if (!confirm('确认清空 staging 暂存目录? 所有待应用更新将被丢弃。')) return;
  try {
    const r = await getApi().syncClearStaging();
    if (r.ok) {
      message.success(`已清空 ${r.cleared ?? 0} 个暂存文件`);
      await refreshPendingApplyCount();
    } else {
      message.error(r.error ?? '清空失败');
    }
  } catch (err) {
    message.error((err as Error).message ?? '清空失败');
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
    message.warning('请先填写目标目录');
    return;
  }
  const result = await getApi().selectPath({
    defaultPath: config.value.targetDir,
    mode,
  });
  if (result.canceled || !result.path) return;
  const rel = absToRelPath(result.path, config.value.targetDir);
  if (rel === null) {
    message.error(`所选路径必须在目标目录内:\n${result.path}`);
    return;
  }
  if (rel === '') {
    message.warning('选了目标目录自身, 无意义');
    return;
  }
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

const advancedMode = ref(false);
let versionClickCount = 0;
let versionClickTimer: number | null = null;

function onVersionClick() {
  versionClickCount += 1;
  if (versionClickTimer) clearTimeout(versionClickTimer);
  versionClickTimer = window.setTimeout(() => {
    versionClickCount = 0;
    versionClickTimer = null;
  }, 3000);
  if (versionClickCount >= 5) {
    versionClickCount = 0;
    if (versionClickTimer) {
      clearTimeout(versionClickTimer);
      versionClickTimer = null;
    }
    toggleAdvanced();
  }
}

function toggleAdvanced() {
  advancedMode.value = !advancedMode.value;
  if (advancedMode.value) {
    message.info('已开启高级运维模式');
    void loadNetworkIPs();
  } else {
    message.info('已关闭高级运维模式');
  }
}

function onGlobalKeydown(e: KeyboardEvent) {
  if (e.shiftKey && e.ctrlKey && (e.key === 'L' || e.key === 'l')) {
    e.preventDefault();
    toggleAdvanced();
  }
}

async function loadNetworkIPs() {
  const ips = await tryLog('listNetworkIPs', () => getApi().listNetworkIPs());
  if (ips) networkIPs.value = ips;
}

async function copyUrl(url: string) {
  try {
    await navigator.clipboard.writeText(url);
    message.success(`已复制 ${url}`);
  } catch {
    message.error('复制失败');
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
      message.success(enabled ? '已启用远程 Web 控制台' : '已停用远程 Web 控制台');
    } else {
      message.error(result.error ?? '操作失败');
    }
  } finally {
    togglingRemote.value = false;
  }
}

async function onResetPassword() {
  if (!confirm('重置密码会断开所有远程客户端连接, 确定吗?')) return;
  resettingPassword.value = true;
  try {
    const result = await getApi().resetRemotePassword();
    if (result.ok && result.newPassword) {
      newlyResetPassword.value = result.newPassword;
      if (result.info) remoteInfo.value = result.info;
      message.success('密码已重置');
    } else {
      message.error(result.error ?? '重置失败');
    }
  } finally {
    resettingPassword.value = false;
  }
}

function copyNewPassword() {
  if (!newlyResetPassword.value) return;
  void copyUrl(newlyResetPassword.value).then(() => {
    setTimeout(() => { newlyResetPassword.value = null; }, 5000);
  });
}

const retryCountdown = ref(0);
let countdownTimer: number | null = null;

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
  { title: '相对路径', key: 'relPath', ellipsis: { tooltip: true } },
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
    message.warning('请先填写源路径');
    return;
  }
  testState.value = { show: true, loading: true, result: null };
  try {
    const result = await getApi().sourceTest(source);
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

const sourceType = computed(() => {
  const s = config.value?.sourceDir ?? '';
  if (/^webdav:\/\//i.test(s)) return { kind: 'webdav', label: 'WebDAV' };
  if (/^https?:\/\//i.test(s)) return { kind: 'http', label: 'HTTP' };
  if (/^[\\/]{2}[^\\/]/.test(s)) return { kind: 'unc', label: 'SMB UNC' };
  if (/^[A-Z]:[\\/]/i.test(s)) return { kind: 'drive', label: '盘符挂载' };
  return { kind: 'local', label: '本地目录' };
});

const networkAlert = computed(() => {
  const s = status.value;
  if (!s) return null;
  if ((s.consecutiveNetworkFailures ?? 0) > 0) {
    return {
      type: 'warning' as const,
      title: '网络不可达 (已触发重试等待)',
      message: `连续 ${s.consecutiveNetworkFailures} 次连接失败, 远端共享可能离线或网络异常`,
      retry: retryCountdown.value,
    };
  }
  if (s.lastFatalReason && s.lastResult && !s.lastResult.ok && s.lastFatalReason !== 'unknown') {
    const labels: Record<string, string> = {
      'not-found': '源或目标路径不存在',
      'permission-denied': '系统权限受限',
      'disk-full': '磁盘空间不足',
      'busy': '目标文件已被外部程序锁定占用',
    };
    return {
      type: 'error' as const,
      title: '同步异常中断',
      message: labels[s.lastFatalReason] ?? s.lastFatalReason,
      retry: 0,
    };
  }
  return null;
});

const message = useMessage();

onMounted(async () => {
  await load();
  await refreshStatus();
  await refreshPendingApplyCount();
  const state = await getApi().stateGet();
  if (state) popupEnabled.value = state.popupEnabled;
  const as = await tryLog('autostartGet', () => getApi().autostartGet());
  autostartEnabled.value = as?.openAtLogin ?? false;
  window.api.onSyncResult?.((result: any) => {
    refreshStatus();
    if (result?.executableUpdate === 'success' && result?.launchedPid) {
      message.success(`守护程序已安全拉起: ${config.value?.executablePath ?? ''} (PID=${result.launchedPid})`);
    } else if (result?.executableUpdate === 'blocked') {
      message.warning(`目标程序运行中, ${config.value?.executablePath ?? ''} 暂未覆盖`);
      executableUpdateBlocked.value = true;
    }
  });
  window.api.onSyncPreflight?.((info) => {
    if (info.executableLocked) {
      preflightLocked.value = true;
      preflightRelPath.value = info.relPath;
    }
  });
  window.addEventListener('keydown', onGlobalKeydown);
});

async function onTogglePopup(enabled: boolean) {
  popupEnabled.value = enabled;
  const res = await getApi().stateSetPopupEnabled(enabled);
  if (res.ok) {
    message.success(enabled ? '已开启桌面更新提示弹窗' : '已切换为静默后台同步');
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
      message.success(enabled ? '已启用系统开机自启' : '已关闭系统开机自启');
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
    message.success(enabled ? '映射配置即时拉取生效' : '映射配置跟随周期同步');
  } else {
    message.error('保存失败');
  }
}

onUnmounted(() => {
  if (countdownTimer) clearInterval(countdownTimer);
  if (versionClickTimer) clearTimeout(versionClickTimer);
  window.removeEventListener('keydown', onGlobalKeydown);
});

usePolling(refreshStatus, UI_STATUS_POLL_MS, { immediate: false });
usePolling(() => {
  void tryLog('getRemoteInfo', () => getApi().getRemoteInfo()).then((info) => {
    remoteInfo.value = info ?? null;
  });
}, 10_000, { immediate: false });

async function copyInitialPassword() {
  if (!remoteInfo.value?.initialPassword) return;
  try {
    await navigator.clipboard.writeText(remoteInfo.value.initialPassword);
    message.success('已复制访问口令');
  } catch {
    message.error('复制失败');
  }
}

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
  savingRef.value = true;
  lastError.value = null;
  const ok = await save();
  savingRef.value = false;
  if (ok) {
    lastSuccessAt.value = Date.now();
    message.success('配置已保存, 调度引擎热更新生效');
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
      message.success('已立即触发同步流水线');
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
  <div class="ops-settings-view">
    <n-spin :show="loading">
      <div v-if="formReady" class="settings-container">
        <!-- 实时告警栏 -->
        <n-alert
          v-if="networkAlert"
          :type="networkAlert.type"
          :title="networkAlert.title"
          :show-icon="true"
          closable
          class="ops-alert-banner"
        >
          {{ networkAlert.message }}
          <span v-if="networkAlert.retry > 0" class="retry-badge">
            · {{ networkAlert.retry }}s 后自动重试
          </span>
        </n-alert>

        <!-- 顶部操作条与落盘状态 -->
        <div class="ops-sticky-toolbar">
          <div class="toolbar-left">
            <span class="config-status-label">
              状态:
              <span v-if="lastSuccessAt" class="status-clean">已同步最新配置 ({{ formatTime(lastSuccessAt) }})</span>
              <span v-else class="status-ready">当前配置已就绪</span>
            </span>
            <span v-if="lastError" class="status-error-hint">保存失败: {{ lastError }}</span>
          </div>
          <div class="toolbar-actions">
            <n-button
              type="primary"
              size="medium"
              :loading="savingRef"
              :disabled="!canSave"
              @click="onSave"
            >
              保存配置
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

        <!-- 分区 1: 存储端点与链路拓扑 (Endpoints) -->
        <section class="ops-section-card">
          <div class="section-header">
            <div class="header-title-box">
              <svg class="section-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
              <h2 class="section-title">存储节点与路径配置 (Storage Endpoints)</h2>
            </div>
            <span class="section-desc">配置同步源与目标部署节点的物理或网络挂载路径</span>
          </div>

          <div class="card-body-grid">
            <!-- 源路径 -->
            <div class="form-row">
              <div class="row-label-col">
                <span class="field-name">源路径 (Source Path)</span>
                <span class="field-meta">
                  <span class="protocol-tag">{{ sourceType.label }}</span>
                  <span class="required-star">*</span>
                </span>
              </div>
              <div class="row-input-col">
                <div class="input-with-tools">
                  <n-input
                    v-model:value="config.sourceDir"
                    placeholder="本地路径、\\server\share、或 http(s):// / webdav://"
                    class="monospace-input"
                  />
                  <n-button size="medium" @click="pickFolder('sourceDir')">浏览</n-button>
                  <n-button
                    size="medium"
                    :loading="testState.loading"
                    @click="onTestSource"
                  >
                    连通性测试
                  </n-button>
                </div>
                <div class="field-help">
                  支持本地目录、SMB 共享 (UNC/盘符)、HTTP 索引源及 WebDAV 协议。
                </div>
              </div>
            </div>

            <!-- 目标路径 -->
            <div class="form-row">
              <div class="row-label-col">
                <span class="field-name">目标路径 (Target Path)</span>
                <span class="field-meta">
                  <span class="required-star">*</span>
                </span>
              </div>
              <div class="row-input-col">
                <div class="input-with-tools">
                  <n-input
                    v-model:value="config.targetDir"
                    placeholder="本地待部署应用主目录"
                    class="monospace-input"
                  />
                  <n-button size="medium" @click="pickFolder('targetDir')">浏览</n-button>
                </div>
                <div class="field-help">必须为本地磁盘目录，同步流水线将向此目录部署文件。</div>
              </div>
            </div>

            <!-- 备份路径 -->
            <div class="form-row">
              <div class="row-label-col">
                <span class="field-name">快照归档路径 (Backup Path)</span>
              </div>
              <div class="row-input-col">
                <div class="input-with-tools">
                  <n-input
                    v-model:value="config.backupDir"
                    placeholder="留空则默认保存在 [目标目录-backups]"
                    class="monospace-input"
                  />
                  <n-button size="medium" @click="pickFolder('backupDir')">浏览</n-button>
                </div>
                <div class="field-help">历史版本快照归档存储位置，用于秒级回滚。</div>
              </div>
            </div>
          </div>
        </section>

        <!-- 分区 2: 调度引擎与同步策略 (Engine & Sync Policy) -->
        <section class="ops-section-card">
          <div class="section-header">
            <div class="header-title-box">
              <svg class="section-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              <h2 class="section-title">调度引擎与同步策略 (Engine & Sync Policy)</h2>
            </div>
            <span class="section-desc">定义协同机制、冲突仲裁、执行频率与程序热更新策略</span>
          </div>

          <div class="card-body-grid">
            <!-- 同步模式 -->
            <div class="form-row">
              <div class="row-label-col">
                <span class="field-name">同步协同模式</span>
              </div>
              <div class="row-input-col">
                <n-radio-group
                  :value="config.syncMode ?? 'mirror'"
                  name="syncModeGroup"
                  @update:value="onSyncModeChange"
                >
                  <div class="policy-radio-cards">
                    <label class="policy-card" :class="{ selected: (config.syncMode ?? 'mirror') === 'mirror' }">
                      <n-radio value="mirror" />
                      <div class="policy-card-info">
                        <div class="policy-card-title">单向严格镜像 (Mirror · 默认)</div>
                        <div class="policy-card-desc">源端为绝对唯一真理。目标端多余或未追踪的文件将被自动清除，严格保持完全一致。</div>
                      </div>
                    </label>
                    <label class="policy-card" :class="{ selected: config.syncMode === 'bidirectional' }">
                      <n-radio value="bidirectional" />
                      <div class="policy-card-info">
                        <div class="policy-card-title">双向智能协同 (Bidirectional)</div>
                        <div class="policy-card-desc">三方状态协同比对。目标端本地新增文件自动反推至源端，互不覆盖，保障端侧修改不丢失。</div>
                      </div>
                    </label>
                  </div>
                </n-radio-group>
              </div>
            </div>

            <!-- 冲突解决策略 (当双向同步时或冲突时) -->
            <div class="form-row" v-if="config.syncMode === 'bidirectional'">
              <div class="row-label-col">
                <span class="field-name">冲突仲裁策略</span>
              </div>
              <div class="row-input-col">
                <n-radio-group
                  :value="config.conflictPolicy ?? 'rename-target'"
                  name="conflictPolicyGroup"
                  @update:value="onConflictPolicyChange"
                >
                  <n-space size="large">
                    <n-radio value="rename-target">重命名目标冲突副本 (rename-target · 推荐)</n-radio>
                    <n-radio value="source-wins">源端优先覆盖 (source-wins)</n-radio>
                    <n-radio value="target-wins">目标端优先覆盖 (target-wins)</n-radio>
                  </n-space>
                </n-radio-group>
                <div class="field-help">当两端在同一周期内同时修改同一文件时触发的仲裁决策。</div>
              </div>
            </div>

            <!-- 周期与备份数紧凑双列 -->
            <div class="form-row-dual">
              <div class="dual-item">
                <span class="field-name">自动巡检周期 (秒)</span>
                <n-input-number
                  v-model:value="config.intervalSec"
                  :min="MIN_INTERVAL_SEC"
                  :max="MAX_INTERVAL_SEC"
                  class="w-full"
                />
                <div class="field-help">调度器自动探测源变动的轮询时间间隔 (默认 300s)</div>
              </div>
              <div class="dual-item">
                <span class="field-name">最大保留快照数</span>
                <n-input-number
                  v-model:value="config.backupCount"
                  :min="MIN_BACKUP_COUNT"
                  :max="MAX_BACKUP_COUNT"
                  class="w-full"
                />
                <div class="field-help">每次执行全量更新前自动归档的快照保留上限</div>
              </div>
            </div>

            <!-- 应用模式 (Immediate / Staging) -->
            <div class="form-row">
              <div class="row-label-col">
                <span class="field-name">更新应用策略</span>
              </div>
              <div class="row-input-col">
                <n-radio-group
                  :value="config.applyMode ?? 'immediate'"
                  name="applyModeGroup"
                  @update:value="onApplyModeChange"
                >
                  <n-space size="large">
                    <n-radio value="immediate">立即应用 (实时落盘覆盖目标目录)</n-radio>
                    <n-radio value="staging">暂存模式 (先下载至 Staging 暂存区, 待确认后再原子应用)</n-radio>
                  </n-space>
                </n-radio-group>

                <!-- 暂存模式下的控制栏 -->
                <div v-if="config.applyMode === 'staging'" class="staging-sub-panel">
                  <div class="staging-meta-row">
                    <span>暂存目录: <code>{{ effectiveStagingDir }}</code></span>
                    <span v-if="pendingApplyCount > 0" class="pending-count-tag">
                      {{ pendingApplyCount }} 个文件待应用
                    </span>
                  </div>
                  <n-space size="small">
                    <n-button
                      size="small"
                      type="primary"
                      :disabled="pendingApplyCount === 0"
                      :loading="applying"
                      @click="applyPendingNow"
                    >
                      立即应用全部暂存更新
                    </n-button>
                    <n-button
                      size="small"
                      :disabled="pendingApplyCount === 0"
                      @click="clearPendingStaging"
                    >
                      清空暂存
                    </n-button>
                  </n-space>
                </div>
              </div>
            </div>

            <!-- 目标可执行程序 (守护/热启) -->
            <div class="form-row">
              <div class="row-label-col">
                <span class="field-name">目标守护程序</span>
              </div>
              <div class="row-input-col">
                <div class="input-with-tools">
                  <n-input
                    :value="config.executablePath ?? ''"
                    placeholder="相对目标目录的可执行文件，例如: bin\app.exe"
                    class="monospace-input"
                    readonly
                  />
                  <n-button size="medium" @click="pickExecutable">选择文件</n-button>
                  <n-button
                    v-if="config.executablePath"
                    size="medium"
                    @click="clearExecutablePath"
                  >
                    清除
                  </n-button>
                </div>
                <div class="field-help">
                  指定部署目标的程序文件。同步前自动检测文件锁并在更新完成后安全重新拉起。
                </div>
              </div>
            </div>

            <div class="form-row-switch">
              <div class="switch-label-group">
                <span class="switch-title">规则映射即时拉取</span>
                <span class="switch-desc">在保护规则页添加或修改映射项后，立即将源端文件同步至目标端</span>
              </div>
              <n-switch
                :value="config.applyMappingsImmediately ?? true"
                @update:value="onToggleApplyMappingsImmediately"
              />
            </div>
          </div>
        </section>

        <!-- 分区 3: 排除项与过滤规则 (Filter & Exclusions) -->
        <section class="ops-section-card">
          <div class="section-header">
            <div class="header-title-box">
              <svg class="section-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
              <h2 class="section-title">排除过滤与安全规则 (Filter & Exclusions)</h2>
            </div>
            <span class="section-desc">被排除的文件与路径绝不参与镜像清除、差异更新或双向同步</span>
          </div>

          <div class="card-body-grid">
            <!-- 现存排除列表 -->
            <div class="ignore-tags-container">
              <div class="tags-header">
                <span class="tags-title">当前生效的排除项 ({{ config.ignoreItems?.length ?? 0 }})</span>
                <span class="tags-help">点击右侧图标可移除</span>
              </div>
              <div class="tags-cloud">
                <span v-if="!config.ignoreItems || config.ignoreItems.length === 0" class="empty-tags-hint">
                  暂无排除项，目标端所有非映射文件均将严格遵循镜像策略
                </span>
                <n-tag
                  v-for="(item, idx) in config.ignoreItems"
                  :key="item"
                  closable
                  size="medium"
                  type="default"
                  class="monospace-tag"
                  @close="removeIgnoreItem(idx)"
                >
                  {{ item }}
                </n-tag>
              </div>
            </div>

            <!-- 添加新排除项 -->
            <div class="form-row">
              <div class="row-label-col">
                <span class="field-name">手动添加排除</span>
              </div>
              <div class="row-input-col">
                <div class="input-with-tools">
                  <n-input
                    v-model:value="newIgnoreItem"
                    placeholder="相对路径或通配，例如: logs/ 或 *.tmp"
                    class="monospace-input"
                    @keydown.enter="addIgnoreItemFromInput"
                  />
                  <n-button size="medium" type="primary" @click="addIgnoreItemFromInput">添加</n-button>
                  <n-button size="medium" @click="pickIgnoreItem('file')">选文件</n-button>
                  <n-button size="medium" @click="pickIgnoreItem('folder')">选文件夹</n-button>
                </div>
              </div>
            </div>

            <!-- 运维常用预设 -->
            <div class="presets-row">
              <span class="presets-label">常用排除预设:</span>
              <div class="preset-chips">
                <button class="preset-btn" @click="addIgnorePreset('.git')">+ .git</button>
                <button class="preset-btn" @click="addIgnorePreset('node_modules')">+ node_modules</button>
                <button class="preset-btn" @click="addIgnorePreset('logs')">+ logs/</button>
                <button class="preset-btn" @click="addIgnorePreset('*.tmp')">+ *.tmp</button>
                <button class="preset-btn" @click="addIgnorePreset('Thumbs.db')">+ Thumbs.db</button>
              </div>
            </div>
          </div>
        </section>

        <!-- 分区 4: 远程 Web 控制台与系统服务 (Remote & Services) -->
        <section class="ops-section-card">
          <div class="section-header">
            <div class="header-title-box">
              <svg class="section-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="2" y1="12" x2="22" y2="12" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
              <h2 class="section-title">远程 Web 控制台与系统服务 (Remote & Services)</h2>
            </div>
            <span class="section-desc">内网远程访问端点、开机自启守护与桌面通知控制</span>
          </div>

          <div class="card-body-grid">
            <!-- 远程访问卡片 -->
            <div class="remote-service-panel">
              <div class="remote-panel-header">
                <div class="remote-header-info">
                  <span class="remote-title">内网 Web 远程运维控制台</span>
                  <span class="remote-sub">开启后允许同局域网设备通过浏览器访问本看板并执行同步操作</span>
                </div>
                <n-switch
                  :value="remoteInfo?.enabled ?? false"
                  :loading="togglingRemote"
                  @update:value="onToggleRemote"
                />
              </div>

              <!-- 开启状态详情 -->
              <div v-if="remoteInfo?.enabled" class="remote-panel-body">
                <div class="remote-data-grid">
                  <div class="remote-data-item">
                    <span class="remote-field-name">控制台 URL</span>
                    <div class="remote-field-val-row">
                      <span class="monospace-text link-url" @click="remoteInfo?.url && openExternal(remoteInfo.url)">
                        {{ remoteInfo?.url }}
                      </span>
                      <n-button size="tiny" @click="remoteInfo?.url && copyUrl(remoteInfo.url)">复制</n-button>
                    </div>
                  </div>

                  <div class="remote-data-item">
                    <span class="remote-field-name">服务监听端口</span>
                    <span class="monospace-text">{{ remoteInfo?.port }}</span>
                  </div>

                  <div class="remote-data-item">
                    <span class="remote-field-name">初始口令</span>
                    <div class="remote-field-val-row">
                      <span class="monospace-text">{{ remoteInfo?.initialPassword ? '••••••••' : '(已设置)' }}</span>
                      <n-button v-if="remoteInfo?.initialPassword" size="tiny" @click="copyInitialPassword">复制初始密码</n-button>
                      <n-button size="tiny" :loading="resettingPassword" @click="onResetPassword">重置密码</n-button>
                    </div>
                  </div>
                </div>

                <div v-if="newlyResetPassword" class="new-pw-alert">
                  新密码已生成: <code>{{ newlyResetPassword }}</code>
                  <n-button size="tiny" type="primary" @click="copyNewPassword">立即复制</n-button>
                </div>
              </div>
            </div>

            <!-- 系统常驻与弹窗开关 -->
            <div class="form-row-switch">
              <div class="switch-label-group">
                <span class="switch-title">开机自动启动 (Start on Boot)</span>
                <span class="switch-desc">系统开机登录时自动在后台启动守护进程，持续维护同步状态</span>
              </div>
              <n-switch
                :value="autostartEnabled"
                :loading="autostartLoading"
                @update:value="onToggleAutostart"
              />
            </div>

            <div class="form-row-switch">
              <div class="switch-label-group">
                <span class="switch-title">桌面更新确认弹窗 (Desktop Prompt)</span>
                <span class="switch-desc">检测到差异时弹出系统对话框等待管理员确认，关闭则静默后台同步</span>
              </div>
              <n-switch
                :value="popupEnabled"
                @update:value="onTogglePopup"
              />
            </div>
          </div>
        </section>

        <!-- 底部版权与版本号 -->
        <footer class="ops-settings-footer">
          <span class="footer-version-tag" @click="onVersionClick">
            MirrorSync Engine v0.3.4
            <span v-if="advancedMode" class="advanced-flag">[ADVANCED OPS]</span>
          </span>
        </footer>
      </div>
    </n-spin>

    <!-- 源测试结果 Modal -->
    <n-modal
      v-model:show="testState.show"
      preset="card"
      style="width: 720px; max-width: 90vw"
      :title="testState.result?.ok ? '✓ 节点连通性测试通过' : '✗ 节点连通性测试失败'"
      :bordered="false"
      size="huge"
    >
      <n-spin :show="testState.loading">
        <div v-if="!testState.loading && testState.result">
          <template v-if="testState.result.ok">
            <n-space vertical :size="12">
              <n-space>
                <n-tag :type="testState.result.adapterKind === 'http' ? 'info' : 'default'">
                  {{ testState.result.adapterKind === 'http' ? 'HTTP 协议源' : '本地 / SMB' }}
                </n-tag>
                <n-text>节点文件总数: <b>{{ testState.result.fileCount }}</b></n-text>
                <n-text>总容量: <b>{{ formatBytes(testState.result.totalSize ?? 0) }}</b></n-text>
                <n-text depth="3">探测延迟: {{ testState.result.durationMs }}ms</n-text>
              </n-space>

              <n-alert
                v-if="(testState.result.fileCount ?? 0) === 0"
                type="warning"
                :show-icon="false"
              >
                源端目录为空，同步流水线将不会向目标端分发文件
              </n-alert>
              <template v-else>
                <div class="sample-header-text">
                  前 {{ SOURCE_TEST_SAMPLE_SIZE }} 个节点样本文件清单:
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
                运维处理建议: {{ adviceOf(testState.result.fatalReason as any) }}
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
            重试探测
          </n-button>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>

<style scoped>
.ops-settings-view {
  height: 100%;
  overflow-y: auto;
  padding: 20px 24px 60px;
  box-sizing: border-box;
}

.settings-container {
  max-width: 1080px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

/* 顶部告警 */
.ops-alert-banner {
  border-radius: 8px;
}

.retry-badge {
  margin-left: 8px;
  font-weight: 600;
  color: #d97706;
}

/* 粘性保存操作栏 */
.ops-sticky-toolbar {
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 12px 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.config-status-label {
  font-size: 13px;
  color: #64748b;
  font-weight: 500;
}

.status-clean {
  color: #10b981;
  font-weight: 600;
  margin-left: 6px;
}

.status-ready {
  color: #3b82f6;
  font-weight: 600;
  margin-left: 6px;
}

.status-error-hint {
  font-size: 12px;
  color: #ef4444;
  font-weight: 600;
}

.toolbar-actions {
  display: flex;
  gap: 12px;
}

/* 分区卡片 */
.ops-section-card {
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 20px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.03);
}

.section-header {
  border-bottom: 1px solid #f1f5f9;
  padding-bottom: 14px;
  margin-bottom: 18px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.header-title-box {
  display: flex;
  align-items: center;
  gap: 10px;
}

.section-icon {
  width: 18px;
  height: 18px;
  color: #2563eb;
  flex-shrink: 0;
}

.section-title {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  color: #0f172a;
}

.section-desc {
  font-size: 12px;
  color: #64748b;
  margin-left: 28px;
}

.card-body-grid {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

/* 表单行结构 */
.form-row {
  display: grid;
  grid-template-columns: 200px 1fr;
  align-items: start;
  gap: 16px;
}

.row-label-col {
  padding-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.field-name {
  font-size: 13px;
  font-weight: 600;
  color: #1e293b;
}

.field-meta {
  display: flex;
  align-items: center;
  gap: 6px;
}

.protocol-tag {
  font-size: 10px;
  font-weight: 700;
  font-family: monospace;
  background: #eff6ff;
  color: #2563eb;
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid #dbeafe;
}

.required-star {
  color: #ef4444;
  font-weight: 700;
}

.row-input-col {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.input-with-tools {
  display: flex;
  gap: 8px;
}

.monospace-input :deep(input) {
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 13px;
}

.field-help {
  font-size: 12px;
  color: #94a3b8;
  line-height: 1.5;
}

/* 双列网格 */
.form-row-dual {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 24px;
  padding: 12px 0;
  border-top: 1px solid #f8fafc;
  border-bottom: 1px solid #f8fafc;
}

.dual-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.w-full {
  width: 100%;
}

/* 开关行 */
.form-row-switch {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  background: #f8fafc;
  border-radius: 6px;
  border: 1px solid #f1f5f9;
}

.switch-label-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.switch-title {
  font-size: 13px;
  font-weight: 600;
  color: #1e293b;
}

.switch-desc {
  font-size: 12px;
  color: #64748b;
}

/* 协同策略卡片单选 */
.policy-radio-cards {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.policy-card {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 14px;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.policy-card:hover {
  background: #f1f5f9;
  border-color: #cbd5e1;
}

.policy-card.selected {
  background: #eff6ff;
  border-color: #93c5fd;
}

.policy-card-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.policy-card-title {
  font-size: 13px;
  font-weight: 700;
  color: #0f172a;
}

.policy-card-desc {
  font-size: 11px;
  color: #64748b;
  line-height: 1.5;
}

/* 暂存子面板 */
.staging-sub-panel {
  margin-top: 8px;
  padding: 10px 14px;
  background: #f0fdf4;
  border: 1px solid #bbf7d0;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.staging-meta-row {
  font-size: 12px;
  color: #166534;
  display: flex;
  align-items: center;
  gap: 12px;
}

.pending-count-tag {
  background: #16a34a;
  color: #ffffff;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 700;
}

/* 忽略项标签池 */
.ignore-tags-container {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  padding: 12px 14px;
}

.tags-header {
  display: flex;
  justify-content: space-between;
  margin-bottom: 10px;
}

.tags-title {
  font-size: 12px;
  font-weight: 700;
  color: #475569;
}

.tags-help {
  font-size: 11px;
  color: #94a3b8;
}

.tags-cloud {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  min-height: 36px;
  align-items: center;
}

.empty-tags-hint {
  font-size: 12px;
  color: #94a3b8;
}

.monospace-tag {
  font-family: "SFMono-Regular", Consolas, monospace;
}

/* 预设栏 */
.presets-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 0;
}

.presets-label {
  font-size: 12px;
  color: #64748b;
  font-weight: 500;
}

.preset-chips {
  display: flex;
  gap: 8px;
}

.preset-btn {
  background: #f1f5f9;
  border: 1px solid #e2e8f0;
  border-radius: 4px;
  padding: 3px 8px;
  font-size: 11px;
  font-family: monospace;
  color: #334155;
  cursor: pointer;
  transition: all 0.15s ease;
}

.preset-btn:hover {
  background: #e2e8f0;
  color: #0f172a;
}

/* 远程 Web 运维卡片 */
.remote-service-panel {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  padding: 14px;
}

.remote-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.remote-header-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.remote-title {
  font-size: 13px;
  font-weight: 700;
  color: #0f172a;
}

.remote-sub {
  font-size: 12px;
  color: #64748b;
}

.remote-panel-body {
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid #e2e8f0;
}

.remote-data-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 14px;
}

.remote-data-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.remote-field-name {
  font-size: 11px;
  font-weight: 600;
  color: #64748b;
  text-transform: uppercase;
}

.remote-field-val-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.monospace-text {
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 12px;
}

.link-url {
  color: #2563eb;
  cursor: pointer;
  text-decoration: underline;
}

.new-pw-alert {
  margin-top: 10px;
  padding: 8px 12px;
  background: #fef3c7;
  border: 1px solid #fde68a;
  border-radius: 4px;
  font-size: 12px;
  color: #92400e;
  display: flex;
  align-items: center;
  gap: 10px;
}

.ops-settings-footer {
  text-align: center;
  padding-top: 16px;
}

.footer-version-tag {
  font-size: 11px;
  color: #94a3b8;
  font-family: monospace;
  cursor: pointer;
  user-select: none;
}

.advanced-flag {
  color: #2563eb;
  font-weight: 700;
}

.sample-header-text {
  font-size: 12px;
  font-weight: 600;
  color: #475569;
  margin-top: 8px;
}
</style>
