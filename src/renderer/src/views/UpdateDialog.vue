<script setup lang="ts">
/**
 * UpdateDialog - 更新提示弹窗
 *
 * 当检测到源有变化时,通过 Vue 响应式系统将弹窗展示在前台。
 * 由 App.vue 或 SettingsView 监听到 'update:prompt' 事件后触发本弹窗。
 *
 * 三种按钮:
 *   立即同步(apply) — 关闭干运行模式,跑一次真实同步
 *   稍后(snooze)   — 暂休 5 分钟,不弹
 *   忽略(ignore)   — 标记已读,不弹,不实际同步
 */

import { computed, ref } from 'vue';
import {
  NButton,
  NModal,
  NTag,
  NText,
  useMessage,
} from 'naive-ui';
import { getApi } from '../api';
import { SNOOZE_DURATION_MS } from '@core/constants';

export interface PromptData {
  hash: string;
  addedCount: number;
  modifiedCount: number;
  deletedCount: number;
  isLocked: boolean;
  lockSnapshotTimestamp: string | null;
  /**
   * applyMode='immediate-with-precheck' 时被锁的目标文件 relPath。
   * null = 不是锁定场景(普通新变化 / post-rollback lock)。
   */
  lockedRel: string | null;
  /** 锁定的 OS 错误码(EBUSY/EPERM/EACCES),null 同上 */
  lockedCode: string | null;
}

const snoozeLabel = `${SNOOZE_DURATION_MS / 60_000} 分钟后再问`;

const show = ref(false);
const promptData = ref<PromptData | null>(null);
const deciding = ref(false);
const message = useMessage();

const totalChanges = computed(() => {
  if (!promptData.value) return 0;
  const { addedCount, modifiedCount, deletedCount } = promptData.value;
  return addedCount + modifiedCount + deletedCount;
});

/**
 * 由 App.vue 调用,显示弹窗
 */
function showPrompt(data: PromptData): void {
  promptData.value = data;
  show.value = true;
}

async function onApply() {
  if (!promptData.value) return;
  deciding.value = true;
  // ★ 立刻关弹窗(乐观):不等 IPC 响应。sync 在后台跑,完成后用 toast 通知。
  //   否则 IPC 慢/挂会卡转圈,用户没法关闭。
  show.value = false;
  try {
    const res = await getApi().$invoke('user:decide', 'apply', promptData.value.hash);
    if (res.ok) {
      message.success(promptData.value!.isLocked ? '已应用新变更并解锁' : '已同步');
    } else {
      message.error(res.error ?? '操作失败');
    }
  } catch (err) {
    // IPC 抛错(scheduler 卡住、网络断开、超时)— 用户至少要看到"失败"提示
    message.error('同步请求失败: ' + ((err as Error)?.message ?? String(err)));
  } finally {
    deciding.value = false;
  }
}

async function onSnooze() {
  if (!promptData.value) return;
  deciding.value = true;
  show.value = false; // 立即关
  try {
    await getApi().$invoke('user:decide', 'snooze', promptData.value.hash);
    message.info(snoozeLabel);
  } catch (err) {
    message.error('暂休请求失败: ' + ((err as Error)?.message ?? String(err)));
  } finally {
    deciding.value = false;
  }
}

async function onIgnore() {
  if (!promptData.value) return;
  deciding.value = true;
  show.value = false; // 立即关
  try {
    await getApi().$invoke('user:decide', 'ignore', promptData.value.hash);
    message.info('已忽略,下次有新变化再提醒');
  } catch (err) {
    message.error('忽略请求失败: ' + ((err as Error)?.message ?? String(err)));
  } finally {
    deciding.value = false;
  }
}

defineExpose({ showPrompt });
</script>

<template>
  <n-modal
    v-model:show="show"
    preset="card"
    title="自动更新检测"
    style="max-width: 480px"
    :closable="false"
    :mask-closable="false"
  >
    <template v-if="promptData">
      <div v-if="promptData.isLocked" class="lock-warning">
        <span class="lock-icon">🔒</span>
        已回退到 <b>{{ promptData.lockSnapshotTimestamp }}</b>,目标处于"回退锁"状态
      </div>
      <!--
        applyMode='immediate-with-precheck' 时:目标被锁定
        (注意:与 isLocked(回退锁)不同 — 这不是回退场景,只是被其他程序占着文件)
      -->
      <div v-else-if="promptData.lockedRel" class="lock-warning" data-testid="preflight-locked-warning">
        <span class="lock-icon">⛔</span>
        目标文件 <code>{{ promptData.lockedRel }}</code> 被占用
        <n-text v-if="promptData.lockedCode" depth="3" style="margin-left: 8px; font-size: 12px">
          ({{ promptData.lockedCode }})
        </n-text>
      </div>
      <n-text depth="3">源目录检测到以下变更:</n-text>

      <div class="changes">
        <n-tag v-if="promptData.addedCount > 0" type="info" size="large" round>
          +{{ promptData.addedCount }} 新增
        </n-tag>
        <n-tag v-if="promptData.modifiedCount > 0" type="warning" size="large" round>
          ~{{ promptData.modifiedCount }} 修改
        </n-tag>
        <n-tag v-if="promptData.deletedCount > 0" type="error" size="large" round>
          −{{ promptData.deletedCount }} 删除
        </n-tag>
        <n-tag v-if="totalChanges === 0" type="default" size="large" round>
          无变更
        </n-tag>
      </div>

      <n-text v-if="promptData.isLocked" depth="3" style="font-size: 13px">
        已回退锁开启。应用新变更后,锁自动解除,目标内容将被覆盖为最新状态。
      </n-text>
      <n-text v-else-if="promptData.lockedRel" depth="3" style="display: block; margin-top: 8px; font-size: 13px; color: #d03050">
        请先<strong>关闭占用该文件的程序</strong>(<code>{{ promptData.lockedRel }}</code>),
        然后点击下方"重试同步"再次发起同步。
      </n-text>

      <div class="actions">
        <n-button
          type="primary"
          :loading="deciding"
          @click="onApply"
        >
          {{ promptData.isLocked
              ? '应用新变更(解锁)'
              : promptData.lockedRel ? '重试同步' : '立即同步' }}
        </n-button>
        <n-button
          v-if="!promptData.lockedRel"
          :loading="deciding"
          @click="onSnooze"
        >
          {{ snoozeLabel }}
        </n-button>
        <n-button
          v-if="!promptData.lockedRel"
          :loading="deciding"
          @click="onIgnore"
        >
          忽略本次
        </n-button>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.lock-warning {
  background: #fff3e0;
  border: 1px solid #ffcc80;
  border-radius: 6px;
  padding: 8px 12px;
  margin-bottom: 12px;
  font-size: 13px;
  color: #bf7410;
}

.lock-icon {
  margin-right: 6px;
}

.changes {
  margin: 12px 0;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.actions {
  margin-top: 20px;
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
</style>