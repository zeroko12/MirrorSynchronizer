<script setup lang="ts">
/**
 * RemoteView.vue - 局域网网页管理 (远程协同控制台)
 *
 * 核心功能:
 * 1. 局域网管理服务总开关 (即时启停、端口显示)
 * 2. 多网卡访问地址列表 (以太网、WLAN等，支持一键复制与浏览器直达)
 * 3. 访问密码管理 (明密文切换、一键复制、自定义修改、随机重置)
 * 4. 远程设备协同使用指引与网络排查提示
 */

import { ref, onMounted, computed } from 'vue';
import {
  NSwitch,
  NButton,
  NModal,
  NFormItem,
  NInput,
  NPopconfirm,
  NSpin,
  useMessage,
} from 'naive-ui';
import { getApi, type RemoteAccessInfo } from '../api';
import { usePolling } from '../composables/usePolling';
import { copyText } from '../utils/clipboard';
import { tryLog } from '../utils/try-log';

const message = useMessage();

const remoteInfo = ref<RemoteAccessInfo | null>(null);
const networkIPs = ref<Array<{ name: string; address: string; family: string; internal: boolean; mac: string }>>([]);
const togglingRemote = ref(false);
const resettingPassword = ref(false);
const newlyResetPassword = ref<string | null>(null);
const showPasswordPlain = ref(false);

// 自定义修改密码状态
const showChangePasswordModal = ref(false);
const customPasswordInput = ref('');
const savingCustomPassword = ref(false);

async function loadRemoteInfo() {
  const info = await tryLog('getRemoteInfo', () => getApi().getRemoteInfo());
  if (info) remoteInfo.value = info;
}

async function loadNetworkIPs() {
  const ips = await tryLog('listNetworkIPs', () => getApi().listNetworkIPs());
  if (ips) networkIPs.value = ips;
}

onMounted(async () => {
  await Promise.all([loadRemoteInfo(), loadNetworkIPs()]);
});

usePolling(async () => {
  await loadRemoteInfo();
  if (remoteInfo.value?.enabled && networkIPs.value.length === 0) {
    await loadNetworkIPs();
  }
}, 5_000, { immediate: false });

async function onToggleRemote(enabled: boolean) {
  togglingRemote.value = true;
  try {
    const result = await getApi().setRemoteEnabled(enabled);
    if (result.ok && result.info) {
      remoteInfo.value = result.info;
      if (enabled) {
        await loadNetworkIPs();
      }
      message.success(enabled ? '已启用局域网管理服务' : '已关闭局域网管理服务');
    } else {
      message.error(result.error ?? '操作失败');
    }
  } catch (err) {
    message.error((err as Error).message || '操作失败');
  } finally {
    togglingRemote.value = false;
  }
}

async function copyTargetUrl(url: string) {
  const ok = await copyText(url);
  if (ok) {
    message.success(`已复制访问网址: ${url}`);
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
      message.success('密码已重新随机生成');
    } else {
      message.error(result.error ?? '重置失败');
    }
  } catch (err) {
    message.error((err as Error).message || '重置失败');
  } finally {
    resettingPassword.value = false;
  }
}

const isEnabled = computed(() => remoteInfo.value?.enabled ?? false);
</script>

<template>
  <div class="ops-view-container">
    <div class="view-unified-wrap">
      <!-- 1. 服务运行状态卡片 -->
      <div class="remote-card">
        <div class="remote-card-header">
          <div class="header-left">
            <div class="status-title-row">
              <span class="status-beacon" :class="{ online: isEnabled }" />
              <h3 class="card-title">局域网网页协同服务</h3>
              <span class="service-badge" :class="isEnabled ? 'badge-online' : 'badge-offline'">
                {{ isEnabled ? '运行中' : '已停止' }}
              </span>
            </div>
            <p class="card-subtitle">
              开启后，同一 Wi-Fi 或局域网下的手机、平板或其他电脑无需安装客户端，通过浏览器即可查看更新状态与触发同步。
            </p>
          </div>
          <div class="header-right">
            <n-switch
              :value="isEnabled"
              :loading="togglingRemote"
              size="large"
              @update:value="onToggleRemote"
            >
              <template #checked>已开启</template>
              <template #unchecked>已关闭</template>
            </n-switch>
          </div>
        </div>

        <div v-if="isEnabled" class="status-bar-info">
          <div class="stat-pill">
            <span class="pill-label">监听端口:</span>
            <span class="pill-val">{{ remoteInfo?.port || 52331 }}</span>
          </div>
          <div class="stat-pill">
            <span class="pill-label">可用网络接口:</span>
            <span class="pill-val">{{ networkIPs.length }} 个</span>
          </div>
          <div class="stat-pill">
            <span class="pill-label">权限验证:</span>
            <span class="pill-val highlight">密码保护已启用</span>
          </div>
        </div>
      </div>

      <!-- 2. 访问网址与网卡列表 (服务开启时常驻展示) -->
      <div v-if="isEnabled" class="remote-card">
        <div class="remote-card-header">
          <div class="header-left">
            <h3 class="card-title">局域网访问地址</h3>
            <p class="card-subtitle">
              检测到本机如下网络接口，请在同一局域网的设备浏览器中打开任意对应地址：
            </p>
          </div>
          <div class="header-right">
            <n-button size="small" secondary @click="loadNetworkIPs">
              刷新网卡
            </n-button>
          </div>
        </div>

        <div class="nic-cards-grid">
          <template v-if="networkIPs.length > 0">
            <div
              v-for="nic in networkIPs"
              :key="nic.address"
              class="nic-item-card"
            >
              <div class="nic-top">
                <span class="nic-type-tag">{{ nic.name || '网络适配器' }}</span>
                <span class="nic-ip-text">{{ nic.address }}</span>
              </div>
              <div class="nic-url-box">
                <span
                  class="nic-full-url"
                  :title="'点击在默认浏览器打开 http://' + nic.address + ':' + (remoteInfo?.port || 52331)"
                  @click="openExternal('http://' + nic.address + ':' + (remoteInfo?.port || 52331))"
                >
                  http://{{ nic.address }}:{{ remoteInfo?.port || 52331 }}
                </span>
              </div>
              <div class="nic-actions-row">
                <n-button
                  size="small"
                  type="primary"
                  secondary
                  @click="copyTargetUrl('http://' + nic.address + ':' + (remoteInfo?.port || 52331))"
                >
                  <template #icon>
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                    </svg>
                  </template>
                  复制网址
                </n-button>
                <n-button
                  size="small"
                  quaternary
                  @click="openExternal('http://' + nic.address + ':' + (remoteInfo?.port || 52331))"
                >
                  <template #icon>
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                      <polyline points="15 3 21 3 21 9"></polyline>
                      <line x1="10" y1="14" x2="21" y2="3"></line>
                    </svg>
                  </template>
                  在浏览器打开
                </n-button>
              </div>
            </div>
          </template>

          <template v-else-if="remoteInfo?.url">
            <div class="nic-item-card">
              <div class="nic-top">
                <span class="nic-type-tag">默认地址</span>
                <span class="nic-ip-text">{{ remoteInfo.url }}</span>
              </div>
              <div class="nic-url-box">
                <span class="nic-full-url" @click="openExternal(remoteInfo.url)">
                  {{ remoteInfo.url }}
                </span>
              </div>
              <div class="nic-actions-row">
                <n-button size="small" type="primary" secondary @click="copyTargetUrl(remoteInfo.url)">
                  复制网址
                </n-button>
                <n-button size="small" quaternary @click="openExternal(remoteInfo.url)">
                  在浏览器打开
                </n-button>
              </div>
            </div>
          </template>

          <template v-else>
            <div class="empty-nic-tip">
              <n-spin size="small" />
              <span>正在获取本机网络接口地址列表...</span>
            </div>
          </template>
        </div>
      </div>

      <!-- 3. 访问密码安全管理 (服务开启时展示) -->
      <div v-if="isEnabled" class="remote-card">
        <div class="remote-card-header">
          <div class="header-left">
            <h3 class="card-title">访问身份验证与密码</h3>
            <p class="card-subtitle">
              其他设备在浏览器打开管理页面时，需输入此访问密码方可操作，保障运维安全。
            </p>
          </div>
        </div>

        <div class="password-mgmt-box">
          <div class="password-display-row">
            <span class="pw-label">当前访问密码:</span>
            <div class="pw-tag">
              <span class="pw-text">
                <template v-if="showPasswordPlain">
                  {{ remoteInfo?.initialPassword || '(未记录明文)' }}
                </template>
                <template v-else>
                  ••••••••
                </template>
              </span>
              <button
                class="pw-eye-btn"
                :title="showPasswordPlain ? '隐藏密码' : '显示明文'"
                @click="showPasswordPlain = !showPasswordPlain"
              >
                <svg v-if="!showPasswordPlain" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
                <svg v-else viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                  <line x1="1" y1="1" x2="23" y2="23" />
                </svg>
              </button>
            </div>

            <div class="pw-actions">
              <n-button
                v-if="remoteInfo?.initialPassword"
                size="small"
                secondary
                @click="copyPasswordText(remoteInfo.initialPassword)"
              >
                复制密码
              </n-button>
              <n-button
                size="small"
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
                  <n-button size="small" :loading="resettingPassword">
                    随机生成
                  </n-button>
                </template>
                重置密码将重新生成随机口令并断开已有连接，确认继续吗？
              </n-popconfirm>
            </div>
          </div>

          <div v-if="newlyResetPassword" class="new-pw-alert">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span>最新修改/重置密码为: <b>{{ newlyResetPassword }}</b>（已保存并生效）</span>
            <n-button size="tiny" type="primary" @click="copyPasswordText(newlyResetPassword)">复制</n-button>
          </div>
        </div>
      </div>

      <!-- 4. 未开启状态时的空态引导 -->
      <div v-if="!isEnabled" class="remote-card placeholder-card">
        <div class="placeholder-content">
          <svg viewBox="0 0 24 24" class="placeholder-icon" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M5 12.55a11 11 0 0 1 14.08 0" />
            <path d="M1.42 9a16 16 0 0 1 21.16 0" />
            <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
            <line x1="12" y1="20" x2="12.01" y2="20" stroke-width="2.5" />
          </svg>
          <h4 class="placeholder-title">局域网协同服务处于关闭状态</h4>
          <p class="placeholder-desc">
            开启后，本工具将在后台监听端口，并自动列出本机在当前 Wi-Fi/以太网下的所有 IP 访问地址。
          </p>
          <n-button type="primary" size="large" :loading="togglingRemote" @click="onToggleRemote(true)">
            立即开启局域网服务
          </n-button>
        </div>
      </div>

      <!-- 5. 快速连接指南卡片 -->
      <div class="remote-card guide-card">
        <div class="remote-card-header">
          <div class="header-left">
            <h3 class="card-title">快速使用指南与连接提示</h3>
            <p class="card-subtitle">手机、平板与其他电脑访问使用步骤</p>
          </div>
        </div>

        <div class="guide-steps">
          <div class="step-item">
            <div class="step-num">1</div>
            <div class="step-detail">
              <span class="step-title">接入同一网络</span>
              <span class="step-desc">确保访问设备（如手机、笔记本）与运行本工具的电脑连接在同一个 Wi-Fi 或企业内网。</span>
            </div>
          </div>

          <div class="step-item">
            <div class="step-num">2</div>
            <div class="step-detail">
              <span class="step-title">浏览器输入地址</span>
              <span class="step-desc">在手机或电脑的 Safari、Chrome、Edge 浏览器中，输入上方卡片列出的完整网址。</span>
            </div>
          </div>

          <div class="step-item">
            <div class="step-num">3</div>
            <div class="step-detail">
              <span class="step-title">验证安全密码</span>
              <span class="step-desc">在网页登录页输入上方设置的访问密码，即可进入免安装网页控制台发起同步或查看备份。</span>
            </div>
          </div>
        </div>

        <div class="faq-box">
          <span class="faq-title">💡 常见问题排查：</span>
          <p class="faq-text">
            • 如果手机输入网址后提示无法访问或连接超时，请检查 Windows Defender 防火墙是否允许本工具访问专用网络。<br />
            • 若电脑开启了热点，连接此热点的手机可直接访问热点分配网段对应 IP。
          </p>
        </div>
      </div>
    </div>

    <!-- 自定义修改密码 Modal -->
    <n-modal
      v-model:show="showChangePasswordModal"
      preset="card"
      title="修改局域网访问密码"
      style="max-width: 440px"
    >
      <div class="change-pw-form">
        <p class="change-pw-tip">
          设置新密码后立即生效，同一局域网设备通过网页访问本工具时需输入此密码进行身份验证。
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
        <div style="display: flex; justify-content: flex-end; gap: 8px">
          <n-button @click="showChangePasswordModal = false">取消</n-button>
          <n-button
            type="primary"
            :loading="savingCustomPassword"
            :disabled="!customPasswordInput.trim()"
            @click="handleSaveCustomPassword"
          >
            保存密码
          </n-button>
        </div>
      </template>
    </n-modal>
  </div>
</template>

<style scoped>
.ops-view-container {
  padding: 24px;
  width: 100%;
  box-sizing: border-box;
  overflow-y: auto;
  overflow-x: hidden;
  height: 100%;
}

.view-unified-wrap {
  max-width: 1100px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.remote-card {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  padding: 20px 24px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
}

.remote-card-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
}

.header-left {
  flex: 1;
  min-width: 0;
}

.status-title-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
}

.status-beacon {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #94a3b8;
  display: inline-block;
  flex-shrink: 0;
}

.status-beacon.online {
  background: #10b981;
  box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.2);
  animation: pulse-beacon 2s infinite;
}

@keyframes pulse-beacon {
  0% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.4); }
  70% { box-shadow: 0 0 0 6px rgba(16, 185, 129, 0); }
  100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
}

.card-title {
  font-size: 16px;
  font-weight: 700;
  color: var(--text-main);
  margin: 0;
}

.service-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 12px;
}

.badge-online {
  background: rgba(16, 185, 129, 0.12);
  color: #10b981;
  border: 1px solid rgba(16, 185, 129, 0.3);
}

.badge-offline {
  background: var(--panel-tag-bg);
  color: var(--text-muted);
  border: 1px solid var(--border-color);
}

.card-subtitle {
  font-size: 13px;
  color: var(--text-muted);
  margin: 0;
  line-height: 1.5;
}

.header-right {
  flex-shrink: 0;
}

.status-bar-info {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--border-color);
  flex-wrap: wrap;
}

.stat-pill {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-muted);
  background: var(--bg-hover);
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid var(--border-color);
}

.pill-val {
  font-weight: 600;
  color: var(--text-main);
  font-family: monospace;
}

.pill-val.highlight {
  color: #10b981;
  font-family: inherit;
}

/* 网卡列表 */
.nic-cards-grid {
  margin-top: 16px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 14px;
}

.nic-item-card {
  background: var(--bg-hover);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.nic-item-card:hover {
  border-color: #3b82f6;
  box-shadow: 0 2px 8px rgba(59, 130, 246, 0.1);
}

.nic-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.nic-type-tag {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--panel-tag-bg);
  border: 1px solid var(--panel-tag-border);
  color: var(--panel-tag-color);
}

.nic-ip-text {
  font-family: monospace;
  font-size: 12px;
  color: var(--text-muted);
}

.nic-url-box {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 8px 10px;
  display: flex;
  align-items: center;
}

.nic-full-url {
  font-family: monospace;
  font-size: 13px;
  font-weight: 600;
  color: #2563eb;
  cursor: pointer;
  text-decoration: underline;
  word-break: break-all;
}

.nic-full-url:hover {
  color: #1d4ed8;
}

.nic-actions-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 2px;
}

.empty-nic-tip {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px;
  color: var(--text-muted);
  font-size: 13px;
}

/* 密码区域 */
.password-mgmt-box {
  margin-top: 14px;
  background: var(--bg-hover);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.password-display-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.pw-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-main);
  flex-shrink: 0;
}

.pw-tag {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  padding: 4px 10px;
  border-radius: 6px;
}

.pw-text {
  font-family: monospace;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-main);
  min-width: 80px;
}

.pw-eye-btn {
  background: none;
  border: none;
  padding: 2px;
  color: var(--text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
}

.pw-eye-btn:hover {
  color: var(--text-main);
}

.pw-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.new-pw-alert {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 6px;
  background: rgba(16, 185, 129, 0.1);
  border: 1px solid rgba(16, 185, 129, 0.25);
  color: #065f46;
  font-size: 12px;
}

:global(.dark) .new-pw-alert {
  color: #34d399;
}

/* 空态引导 */
.placeholder-card {
  text-align: center;
  padding: 40px 24px;
}

.placeholder-content {
  max-width: 420px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}

.placeholder-icon {
  width: 48px;
  height: 48px;
  color: var(--text-dim);
}

.placeholder-title {
  font-size: 16px;
  font-weight: 700;
  color: var(--text-main);
  margin: 0;
}

.placeholder-desc {
  font-size: 13px;
  color: var(--text-muted);
  margin: 0 0 8px;
  line-height: 1.5;
}

/* 指南卡片 */
.guide-steps {
  margin-top: 16px;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 14px;
}

.step-item {
  display: flex;
  gap: 12px;
  padding: 12px;
  background: var(--bg-hover);
  border: 1px solid var(--border-color);
  border-radius: 8px;
}

.step-num {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: #3b82f6;
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.step-detail {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.step-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-main);
}

.step-desc {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.45;
}

.faq-box {
  margin-top: 14px;
  padding: 12px 14px;
  background: var(--bg-hover);
  border: 1px dashed var(--border-color);
  border-radius: 8px;
}

.faq-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-main);
  display: block;
  margin-bottom: 4px;
}

.faq-text {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.6;
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
</style>
