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
import { usePolling } from '../composables/usePolling';
import {
  NAlert,
  NButton,
  NCard,
  NDataTable,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NModal,
  NSpace,
  NSpin,
  NText,
  NDivider,
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

/** 忽略项(从 config.ignoreItems 同步)— 编辑时直接改 config.value,保存走 useConfig.save */
const newIgnoreItem = ref('');

/**
 * 校验 ignoreItem 条目合法性(跟后端 ConfigManager.validate 一致)
 * 返回 null = 合法,返回 string = 错误信息
 */
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

function removeIgnoreItem(idx: number) {
  const next = (config.value?.ignoreItems ?? []).filter((_, i) => i !== idx);
  config.value = { ...config.value, ignoreItems: next };
}

/**
 * 把对话返回的绝对路径转成相对 targetDir 的路径。
 * - Windows 路径分隔符统一为 `/`
 * - 大小写不敏感比较(Windows / macOS HFS+ 默认)
 * - 不在 targetDir 内 → 返回 null(UI 报错)
 */
function absToRelPath(absPath: string, baseDir: string): string | null {
  const norm = (p: string) => p.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  const a = norm(absPath);
  const b = norm(baseDir);
  if (!a || !b) return null;
  const aL = a.toLowerCase();
  const bL = b.toLowerCase();
  if (aL === bL) return ''; // 选了 targetDir 自身
  if (!aL.startsWith(bL + '/')) return null; // 不在 targetDir 内
  return a.substring(b.length + 1);
}

/** 打开 file/folder 选择对话框,选完自动加入 ignoreItems */
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
    message.warning('选了目标目录自身,无意义');
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

/**
 * "高级模式"开关 — 默认 false
 * 唤出方式:点版本号 5 下(3 秒内) 或 Shift+Ctrl+L
 * 关闭方式:同样手势
 * 状态不持久化(每次启动需重新唤出)
 */
const advancedMode = ref(false);
let versionClickCount = 0;
let versionClickTimer: number | null = null;

function onVersionClick() {
  versionClickCount += 1;
  if (versionClickTimer) {
    clearTimeout(versionClickTimer);
  }
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
    message.info('已开启高级模式');
    // 进入高级模式时主动拉一次
    void loadNetworkIPs();
  } else {
    message.info('已关闭高级模式');
  }
}

function onGlobalKeydown(e: KeyboardEvent) {
  // Shift+Ctrl+L 切换高级模式
  if (e.shiftKey && e.ctrlKey && (e.key === 'L' || e.key === 'l')) {
    e.preventDefault();
    toggleAdvanced();
  }
}

async function loadNetworkIPs() {
  const ips = await tryLog('listNetworkIPs', () => getApi().listNetworkIPs());
  if (ips) networkIPs.value = ips;
}

/** 推导出当前 server 实际绑定的主机(host 部分) */
const currentRemoteHost = computed(() => {
  if (!remoteInfo.value?.url) return null;
  try {
    return new URL(remoteInfo.value.url).hostname;
  } catch {
    return null;
  }
});

function buildRemoteUrl(host: string): string {
  const port = remoteInfo.value?.port ?? 9527;
  return `http://${host}:${port}`;
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
      message.success(enabled ? '已启用远程访问' : '已停用远程访问');
    } else {
      message.error(result.error ?? '操作失败');
    }
  } finally {
    togglingRemote.value = false;
  }
}

async function onResetPassword() {
  if (!confirm('重置密码会断开所有远程客户端连接,确定吗?')) return;
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
    // 复制后 5 秒自动清掉显示(防呆)
    setTimeout(() => { newlyResetPassword.value = null; }, 5000);
  });
}

/** 距下次同步的剩余秒数(用于倒计时显示) */
const retryCountdown = ref(0);
let countdownTimer: number | null = null;

/** 源测试状态 */
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

/** 友好的错误原因显示 */
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
          // 到点触发一次刷新,等主进程发新 status
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

/** 识别当前 source 类型(用于 UI 标识) */
const sourceType = computed(() => {
  const s = config.value?.sourceDir ?? '';
  if (/^webdav:\/\//i.test(s)) {
    return { kind: 'webdav', label: 'WebDAV 源' };
  }
  if (/^https?:\/\//i.test(s)) {
    return { kind: 'http', label: 'HTTP 源', scheme: s.match(/^https?:\/\//i)?.[0] ?? 'http://' };
  }
  if (/^[\\/]{2}[^\\/]/.test(s)) return { kind: 'unc', label: 'SMB (UNC)' };
  if (/^[A-Z]:[\\/]/i.test(s)) return { kind: 'drive', label: 'SMB (挂载盘符)' };
  return { kind: 'local', label: '本地路径' };
});

/** 占位符按当前 source 类型给示例 */
const sourcePlaceholder = computed(() => {
  switch (sourceType.value.kind) {
    case 'webdav':
      return '例如 webdav://user:pass@server/webdav/';
    case 'http':
      return '例如 https://cdn.example.com/build/';
    case 'unc':
      return '例如 \\\\server\\share 或 \\\\192.168.1.10\\data';
    case 'drive':
      return '例如 Z:\\updates 或 D:\\app\\data';
    default:
      return '例如 D:\\app\\data 或 /home/user/updates';
  }
});

const networkAlert = computed(() => {
  const s = status.value;
  if (!s) return null;
  if ((s.consecutiveNetworkFailures ?? 0) > 0) {
    return {
      type: 'warning' as const,
      title: '网络不可达,已暂停同步',
      message: `连续 ${s.consecutiveNetworkFailures} 次失败,源路径网络可能已断开(SMB 共享未挂载或断网)`,
      retry: retryCountdown.value,
    };
  }
  // 非网络 fatal:短暂显示(仅在刚失败时)
  if (s.lastFatalReason && s.lastResult && !s.lastResult.ok && s.lastFatalReason !== 'unknown') {
    const labels: Record<string, string> = {
      'not-found': '源或目标路径不存在',
      'permission-denied': '权限不足',
      'disk-full': '磁盘空间不足',
      'busy': '文件被占用',
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

const message = useMessage();

onMounted(async () => {
  await load();
  await refreshStatus();
  // 加载 P4 弹窗开关
  const state = await getApi().stateGet();
  if (state) popupEnabled.value = state.popupEnabled;
  // 加载 P5 开机自启动状态(失败用 false,UI 上是关闭,用户重试时再次拉)
  const as = await tryLog('autostartGet', () => getApi().autostartGet());
  autostartEnabled.value = as?.openAtLogin ?? false;
  // 订阅同步结果事件(从 preload 的 onSyncResult 转发)
  window.api.onSyncResult?.(() => {
    refreshStatus();
  });
  // 5 秒轮询由下面的 usePolling 在 onMounted 自动启动
  // 全局键盘监听(高级模式切换)
  window.addEventListener('keydown', onGlobalKeydown);
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
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  if (versionClickTimer) {
    clearTimeout(versionClickTimer);
    versionClickTimer = null;
  }
  window.removeEventListener('keydown', onGlobalKeydown);
});

/** 5 秒轮询状态(usePolling 内部自动管理 onMounted/onUnmounted) */
usePolling(() => {
  refreshStatus();
}, UI_STATUS_POLL_MS, { immediate: false });

/** 10 秒轮询远程访问信息 */
usePolling(() => {
  void tryLog('getRemoteInfo', () => getApi().getRemoteInfo()).then((info) => {
    remoteInfo.value = info ?? null;
  });
}, 10_000, { immediate: false });

/* ============================ 远程访问操作 ============================ */

async function copyInitialPassword() {
  if (!remoteInfo.value?.initialPassword) return;
  try {
    await navigator.clipboard.writeText(remoteInfo.value.initialPassword);
    message.success('已复制初始密码(请妥善保存)');
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
    // "保存并立即同步" 是用户主动行为,即便弹窗模式也要真同步
    // (跟远程"立即同步"和本地弹窗"应用"按钮语义一致)
    const res = await getApi().runSyncNowForce();
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
        <!-- 网络错误 / 致命错误提示(实时) -->
        <n-alert
          v-if="networkAlert"
          :type="networkAlert.type"
          :title="networkAlert.title"
          :show-icon="true"
          closable
          style="margin-bottom: 12px"
        >
          {{ networkAlert.message }}
          <span v-if="networkAlert.retry > 0" style="margin-left: 8px">
            · {{ networkAlert.retry }}s 后重试
          </span>
        </n-alert>

        <!-- 调度器状态 + 上次同步摘要 + 源/目标文件数 -->
        <div class="status-bar">
          <n-space align="center" :wrap="false">
            <n-tag :type="status?.running ? 'success' : 'default'" size="small">
              {{ status?.running ? '调度器运行中' : '调度器未运行' }}
            </n-tag>
            <n-tag
              :type="sourceType.kind === 'http' ? 'info' : 'default'"
              size="small"
              :title="`当前源类型:${sourceType.label}`"
            >
              {{ sourceType.label }}
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
              <n-text depth="3" style="font-size: 13px">等待首次同步</n-text>
            </template>
            <n-button text type="primary" size="tiny" @click="refreshStatus" style="margin-left: auto">
              刷新
            </n-button>
          </n-space>
        </div>

        <n-divider style="margin: 16px 0 20px" />

        <n-form label-placement="top" :show-feedback="true">
          <n-form-item label="源路径(本地 / SMB / HTTP / WebDAV)">
            <n-space :wrap="false">
              <n-input
                v-model:value="config.sourceDir"
                :placeholder="sourcePlaceholder"
                clearable
                style="width: 520px"
              />
              <n-button
                v-if="sourceType.kind !== 'http'"
                @click="pickFolder('sourceDir')"
              >浏览…</n-button>
              <n-button
                type="primary"
                ghost
                :loading="testState.loading"
                :disabled="!config.sourceDir"
                @click="onTestSource"
              >测试</n-button>
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

          <n-form-item label="忽略项(同步时跳过这些文件或目录)">
            <n-space vertical style="width: 100%">
              <!-- 已添加的列表 -->
              <n-space v-if="(config.ignoreItems ?? []).length > 0" :wrap="true" size="small">
                <n-tag
                  v-for="(item, idx) in config.ignoreItems"
                  :key="item"
                  type="default"
                  size="small"
                  closable
                  @close="removeIgnoreItem(idx)"
                  style="font-family: monospace; cursor: default"
                >
                  {{ item }}
                </n-tag>
              </n-space>
              <n-text v-else depth="3" style="font-size: 12px">
                (无 — 所有文件都会参与同步)
              </n-text>

              <!-- 添加:文本输入 + 浏览按钮(支持文件/目录) -->
              <n-space :wrap="true">
                <n-input
                  v-model:value="newIgnoreItem"
                  placeholder="相对目标根的路径,例如 cache 或 config/local.ini"
                  style="width: 320px"
                  @keydown.enter="addIgnoreItemFromInput"
                />
                <n-button :disabled="!newIgnoreItem.trim()" @click="addIgnoreItemFromInput">
                  添加
                </n-button>
                <n-divider vertical />
                <n-button :disabled="!config.targetDir" @click="pickIgnoreItem('folder')">
                  选目录…
                </n-button>
                <n-button :disabled="!config.targetDir" @click="pickIgnoreItem('file')">
                  选文件…
                </n-button>
              </n-space>

              <n-text depth="3" style="font-size: 12px; line-height: 1.7">
                <div>
                  路径相对目标根。<b>目录项</b>(如 <code>cache</code>、<code>build/cache</code>)会忽略整个子树(任意深度);<b>文件项</b>(如 <code>config/local.ini</code>)只忽略这一个文件。
                </div>
                <div>
                  选目录/选文件按钮以目标目录为根打开选择器,自动算出相对路径。
                </div>
                <div>
                  这些项不参与 diff、不拷贝、不删除、映射规则也不会写入。备份仍包含,rollback 时可恢复。
                </div>
              </n-text>
            </n-space>
          </n-form-item>

          <n-divider />

          <n-form-item :label="`检查间隔(秒, ${MIN_INTERVAL_SEC} - ${MAX_INTERVAL_SEC} 即 7 天)`">
            <n-input-number
              v-model:value="config.intervalSec"
              :min="MIN_INTERVAL_SEC"
              :max="MAX_INTERVAL_SEC"
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

          <n-form-item :label="`保留备份数(${MIN_BACKUP_COUNT} - ${MAX_BACKUP_COUNT})`">
            <n-input-number
              v-model:value="config.backupCount"
              :min="MIN_BACKUP_COUNT"
              :max="MAX_BACKUP_COUNT"
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

        <!-- 远程访问(高级模式,默认隐藏 — 点版本号 5 下 或 Shift+Ctrl+L 唤出) -->
        <n-form-item
          v-if="advancedMode"
          label="远程访问(同 LAN 浏览器)"
        >
          <n-card size="small" :bordered="true" style="max-width: 720px">
            <n-space vertical :size="10">
              <!-- 开关 -->
              <n-space align="center" justify="space-between">
                <n-space align="center">
                  <span>启用远程访问</span>
                  <n-tag
                    v-if="remoteInfo"
                    :type="remoteInfo.running ? 'success' : 'default'"
                    size="small"
                  >
                    {{ remoteInfo.running ? `运行中 · ${remoteInfo.clientCount} 个客户端` : '已停止' }}
                  </n-tag>
                </n-space>
                <n-switch
                  :value="remoteInfo?.enabled ?? false"
                  :loading="togglingRemote"
                  @update:value="onToggleRemote"
                />
              </n-space>

              <template v-if="remoteInfo?.enabled">
                <n-divider style="margin: 4px 0" />

                <!-- 多 IP 列表 -->
                <n-text depth="2" style="font-size: 12px">访问 URL(多网卡时选合适的):</n-text>
                <n-space vertical :size="4">
                  <div
                    v-for="ip in networkIPs"
                    :key="ip.address"
                    style="display: flex; align-items: center; gap: 8px; padding: 4px 0;"
                  >
                    <n-tag size="small" :type="ip.address === currentRemoteHost ? 'success' : 'default'">
                      {{ ip.name }}
                    </n-tag>
                    <span
                      v-if="ip.address === currentRemoteHost"
                      style="font-size: 11px; color: var(--primary);"
                    >[当前]</span>
                    <code style="font-size: 12px;">{{ buildRemoteUrl(ip.address) }}</code>
                    <n-button
                      size="tiny"
                      ghost
                      @click="copyUrl(buildRemoteUrl(ip.address))"
                    >复制</n-button>
                    <n-button
                      v-if="ip.address !== currentRemoteHost"
                      size="tiny"
                      @click="openExternal(buildRemoteUrl(ip.address))"
                    >打开</n-button>
                  </div>
                </n-space>
                <n-text depth="3" style="font-size: 12px">
                  💡 多网卡时选物理网卡(以太网 / Wi-Fi)而非虚拟网卡(VMWare / Hyper-V / VPN)。
                </n-text>

                <!-- 当前密码(常驻显示,有就显示;重置中隐藏避免两个框) -->
                <n-alert
                  v-if="remoteInfo.initialPassword && !newlyResetPassword"
                  type="info"
                  :show-icon="true"
                >
                  <template #header>当前密码(浏览器登录用)</template>
                  <n-space align="center">
                    <n-text code style="font-size: 13px">{{ remoteInfo.initialPassword }}</n-text>
                    <n-button size="tiny" @click="copyInitialPassword">复制</n-button>
                  </n-space>
                  <n-text depth="3" style="font-size: 12px; display: block; margin-top: 6px">
                    在同 LAN 设备的浏览器打开上面任一 URL,粘贴此密码登录。
                  </n-text>
                </n-alert>

                <!-- 刚重置的新密码(临时高亮展示,5 秒后自动隐藏,初始密码框恢复) -->
                <n-alert
                  v-if="newlyResetPassword"
                  type="success"
                  :show-icon="true"
                >
                  <template #header>✓ 密码已重置(5 秒后自动隐藏,请立即复制)</template>
                  <n-space align="center">
                    <n-text code style="font-size: 14px; font-weight: 600">{{ newlyResetPassword }}</n-text>
                    <n-button size="tiny" type="primary" @click="copyNewPassword">复制新密码</n-button>
                  </n-space>
                </n-alert>

                <!-- 操作:重置密码 -->
                <n-space align="center" justify="space-between">
                  <n-text depth="3" style="font-size: 12px">
                    忘记密码?重置会断开所有客户端。
                  </n-text>
                  <n-button
                    size="small"
                    :loading="resettingPassword"
                    @click="onResetPassword"
                  >重置密码</n-button>
                </n-space>
              </template>

              <n-text v-else depth="3" style="font-size: 12px">
                远程访问未启用。打开后,同 LAN 设备可通过浏览器访问并管理本机。
              </n-text>
            </n-space>
          </n-card>
        </n-form-item>

        <n-divider />

        <!-- 支持的源类型(显式列出,免得用户不知道 WebDAV 也能用) -->
        <n-form-item label="支持的源类型">
          <n-space vertical :size="6" style="font-size: 12px; line-height: 1.8">
            <div>
              <n-tag size="small" type="default">本地</n-tag>
              <span style="margin-left: 8px; color: #6b7785">
                <code>D:\app\data</code> · <code>/home/user/updates</code>
              </span>
            </div>
            <div>
              <n-tag size="small" type="default">SMB (UNC)</n-tag>
              <span style="margin-left: 8px; color: #6b7785">
                <code>\\server\share</code> · <code>\\192.168.1.10\data</code>
              </span>
            </div>
            <div>
              <n-tag size="small" type="default">SMB (挂载盘符)</n-tag>
              <span style="margin-left: 8px; color: #6b7785">
                <code>Z:\updates</code> · 需先把 SMB 共享映射到盘符
              </span>
            </div>
            <div>
              <n-tag size="small" type="info">HTTP</n-tag>
              <span style="margin-left: 8px; color: #6b7785">
                <code>https://cdn.example.com/build/</code> · 需要源提供
                <code>.manifest.json</code> 或 autoindex 目录列表
              </span>
            </div>
            <div>
              <n-tag size="small" type="info">WebDAV</n-tag>
              <span style="margin-left: 8px; color: #6b7785">
                <code>webdav://user:pass@server/webdav/</code> · 走 PROPFIND,
                支持 Basic Auth(URL 嵌密码)
              </span>
            </div>
            <n-text depth="3" style="font-size: 12px; margin-top: 4px">
              文件映射规则的"源路径"同样支持以上所有类型(可以从 HTTP / WebDAV 单文件映射到本地)
            </n-text>
          </n-space>
        </n-form-item>

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
      <n-text
        depth="3"
        style="font-size: 12px; cursor: pointer; user-select: none;"
        @click="onVersionClick"
      >
        v0.2.0
        <span v-if="advancedMode" style="color: var(--primary); margin-left: 6px">⚙</span>
      </n-text>
    </footer>

    <!-- 源测试结果 modal -->
    <n-modal
      v-model:show="testState.show"
      preset="card"
      style="width: 720px; max-width: 90vw"
      :title="testState.result?.ok ? '✓ 源路径测试通过' : '✗ 源路径测试失败'"
      :bordered="false"
      size="huge"
    >
      <n-spin :show="testState.loading">
        <div v-if="!testState.loading && testState.result">
          <!-- 成功 -->
          <template v-if="testState.result.ok">
            <n-space vertical :size="12">
              <n-space>
                <n-tag :type="testState.result.adapterKind === 'http' ? 'info' : 'default'">
                  {{ testState.result.adapterKind === 'http' ? 'HTTP 源' : '本地 / SMB' }}
                </n-tag>
                <n-text>共 <b>{{ testState.result.fileCount }}</b> 个文件</n-text>
                <n-text>总大小 <b>{{ formatBytes(testState.result.totalSize ?? 0) }}</b></n-text>
                <n-text depth="3">耗时 {{ testState.result.durationMs }}ms</n-text>
              </n-space>
              <n-alert
                v-if="(testState.result.fileCount ?? 0) === 0"
                type="warning"
                :show-icon="false"
              >
                源目录为空 — 同步不会下载任何文件
              </n-alert>
              <template v-else>
                <n-text depth="2" style="font-size: 13px">
                  前 {{ SOURCE_TEST_SAMPLE_SIZE }} 个文件预览(按路径排序):
                </n-text>
                <n-data-table
                  :columns="testTableColumns"
                  :data="testState.result.sample ?? []"
                  :pagination="false"
                  size="small"
                  :bordered="false"
                  striped
                />
                <n-text
                  v-if="(testState.result.fileCount ?? 0) > SOURCE_TEST_SAMPLE_SIZE"
                  depth="3"
                  style="font-size: 12px"
                >
                  还有 {{ testState.result.fileCount! - SOURCE_TEST_SAMPLE_SIZE }} 个文件未显示
                </n-text>
              </template>
            </n-space>
          </template>
          <!-- 失败 -->
          <template v-else>
            <n-space vertical :size="12">
              <n-alert
                :type="testState.result.fatalReason === 'permission-denied' || testState.result.fatalReason === 'not-found' ? 'error' : 'warning'"
                :show-icon="true"
              >
                <n-space vertical :size="4">
                  <n-text>
                    <b>{{ labelOf(testState.result.fatalReason as any) }}</b>
                  </n-text>
                  <n-text depth="3" style="font-size: 12px">{{ testState.result.error }}</n-text>
                </n-space>
              </n-alert>
              <n-text depth="3" style="font-size: 12px">
                建议:{{ adviceOf(testState.result.fatalReason as any) }}
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
          >重试</n-button>
        </n-space>
      </template>
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
