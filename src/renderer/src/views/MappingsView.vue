<script setup lang="ts">
/**
 * MappingsView - 文件映射规则管理
 *
 * 字段: name / sourcePath / targetRelpath / overwrite / ifSourceMissing / enabled
 *
 * 增/改:模态框表单(浏览按钮选源文件)
 * 删:确认
 *
 * 存储:用现有 config.json 的 fileMappings 字段(无需新文件)
 */

import { computed, onMounted, ref, h } from 'vue';
import { tryLog } from '../utils/try-log';
import {
  NButton,
  NDataTable,
  NTag,
  NText,
  NSpace,
  NModal,
  NForm,
  NFormItem,
  NInput,
  NSwitch,
  NRadio,
  NRadioGroup,
  NPopconfirm,
  NAlert,
  NSpin,
  useMessage,
  type DataTableColumns,
} from 'naive-ui';
import { getApi } from '../api';
import { useConfig } from '../composables/useConfig';
import { labelOf, adviceOf } from '@core/labels';
import type { FileMapping } from '@core/types';

const { config, load, save } = useConfig();
const message = useMessage();

const showModal = ref(false);
const editing = ref<FileMapping | null>(null);
const form = ref<{
  name: string;
  sourcePath: string;
  targetRelpath: string;
  overwrite: boolean;
  ifSourceMissing: 'skip' | 'keep' | 'delete';
  enabled: boolean;
}>({
  name: '',
  sourcePath: '',
  targetRelpath: '',
  overwrite: false,
  ifSourceMissing: 'skip',
  enabled: true,
});
const formLoading = ref(false);
const showEmpty = ref(false);
let isFirstLoad = true;

/** 源文件是否远程(HTTP / WebDAV)— 决定是否显示"浏览…"按钮 */
const isRemoteSourcePath = computed(() => {
  const p = form.value?.sourcePath ?? '';
  return /^https?:\/\//i.test(p) || /^webdav:\/\//i.test(p);
});

/** 源文件路径 placeholder(按当前类型给示例) */
const sourcePathPlaceholder = computed(() => {
  const p = form.value?.sourcePath ?? '';
  if (/^webdav:\/\//i.test(p)) return '例如 webdav://user:pass@server/webdav/file.ini';
  if (/^https?:\/\//i.test(p)) return '例如 https://cdn.example.com/build/version.json';
  if (/^[\\/]{2}[^\\/]/.test(p)) return '例如 \\\\server\\share\\my-config.ini';
  return '例如 C:\\local\\my-config.ini';
});

/** 源文件测试(remote 用 sourceTest,local 用 mappingsTestOne 行为) */
const sourceTestState = ref<{
  show: boolean;
  loading: boolean;
  result: {
    ok: boolean;
    fileCount?: number;
    totalSize?: number;
    error?: string;
    fatalReason?: string;
    durationMs: number;
  } | null;
}>({ show: false, loading: false, result: null });

async function onTestSourceMapping() {
  const source = (form.value?.sourcePath ?? '').trim();
  if (!source) {
    message.warning('请先填写源文件路径');
    return;
  }
  sourceTestState.value = { show: true, loading: true, result: null };
  try {
    const result = await getApi().sourceTest(source);
    sourceTestState.value = { show: true, loading: false, result };
  } catch (err) {
    sourceTestState.value = {
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

async function refreshMappings() {
  if (isFirstLoad) showEmpty.value = true;
  // load() 内部已经把 error 状态写到 useConfig,UI 会自动显示;tryLog 只是把异常打到 console
  await tryLog('mappings:load', () => load());
  isFirstLoad = false;
  showEmpty.value = false;
}

onMounted(() => {
  refreshMappings();
  // 配置类,只在切到本 tab 时手动刷新,不开轮询
  window.api.onSyncResult?.(() => {
    refreshMappings();
  });
});

// 拖出用
function openAdd() {
  editing.value = null;
  form.value = {
    name: '',
    sourcePath: '',
    targetRelpath: '',
    overwrite: false,
    ifSourceMissing: 'skip',
    enabled: true,
  };
  showModal.value = true;
}

function openEdit(m: FileMapping) {
  editing.value = m;
  form.value = {
    name: m.name,
    sourcePath: m.sourcePath,
    targetRelpath: m.targetRelpath,
    overwrite: m.overwrite,
    ifSourceMissing: m.ifSourceMissing,
    enabled: m.enabled,
  };
  showModal.value = true;
}

async function pickSource() {
  // 映射的源应该是个文件(可执行/配置/资源等)
  const res = await getApi().selectPath({ mode: 'file' });
  if (!res.canceled && res.path) {
    form.value.sourcePath = res.path;
  }
}

async function pickTargetFolder() {
  // 从 config 拿 targetDir 作为 picker 的起始位置
  const startDir = config.value.targetDir || undefined;
  const res = await getApi().selectFolder(startDir);
  if (res.canceled || !res.path) return;

  // 把绝对路径转成相对 targetDir 的相对路径
  if (startDir) {
    const normStart = startDir.replace(/[\\/]+$/, ''); // 去尾斜杠
    const picked = res.path;
    if (picked.toLowerCase().startsWith(normStart.toLowerCase())) {
      // 在 targetDir 内部 → 算相对
      let rel = picked.slice(normStart.length);
      rel = rel.replace(/^[\\/]+/, ''); // 去头斜杠
      form.value.targetRelpath = rel;
      message.success(rel ? `已选: ${rel}` : '已选根目录(将用源文件名)');
      return;
    }
  }
  // 不在 targetDir 内部(用户从快捷方式跳到了别处),把完整路径填上提示用户
  form.value.targetRelpath = res.path;
  message.warning('所选位置不在 targetDir 内,已填入完整路径,建议改为相对路径');
}

async function onSaveMapping() {
  if (!form.value.name.trim()) {
    message.error('请填写规则名');
    return;
  }
  if (!form.value.sourcePath.trim()) {
    message.error('请选择源文件');
    return;
  }
  // 注意:targetRelpath 允许为空(= 目标目录根)
  if (form.value.targetRelpath.includes('..')) {
    message.error('目标相对路径不能包含 ..');
    return;
  }

  formLoading.value = true;
  try {
    const newMapping: FileMapping = {
      id: editing.value?.id ?? crypto.randomUUID(),
      name: form.value.name.trim(),
      sourcePath: form.value.sourcePath.trim(),
      targetRelpath: form.value.targetRelpath.trim().replace(/^[\\/]+/, ''),
      overwrite: form.value.overwrite,
      ifSourceMissing: form.value.ifSourceMissing,
      enabled: form.value.enabled,
    };

    const current = [...(config.value.fileMappings ?? [])];
    if (editing.value) {
      const idx = current.findIndex((m) => m.id === editing.value!.id);
      if (idx >= 0) current[idx] = newMapping;
      else current.push(newMapping);
    } else {
      current.push(newMapping);
    }

    const ok = await save({ ...config.value, fileMappings: current });
    if (ok) {
      // 配置已存盘:如果开了"立即应用"开关,立刻拉过来
      if (config.value.applyMappingsImmediately) {
        const applyRes = await getApi().mappingsApplyAll();
        if (applyRes.ok) {
          const copied = applyRes.mappingCopied?.length ?? 0;
          const skippedExist = applyRes.mappingSkippedExisting?.length ?? 0;
          const skippedMissing = applyRes.mappingSkipped?.length ?? 0;
          const failed = applyRes.mappingFailed?.length ?? 0;
          const warnings = applyRes.warnings?.length ?? 0;
          // 全维度显示,任何异常都不会被吞
          const parts = [`拷贝 ${copied}`, `目标已存在跳过 ${skippedExist}`, `源缺失跳过 ${skippedMissing}`];
          if (failed > 0) parts.push(`失败 ${failed}`);
          if (warnings > 0) parts.push(`警告 ${warnings}`);
          // ★ 关键:用户配了 executablePath,自动启动后会回传 PID,通知里告诉用户
          // 之前我加了 maybeLaunchAfterMappings 但 renderer 没读 launchedPid,
          // 用户点完"添加映射"看不到程序是否真的启动了。
          if (applyRes.launchedPid) {
            parts.push(`已启动 PID=${applyRes.launchedPid}`);
          }
          message.success(`${editing.value ? '已更新' : '已添加'} · ${parts.join(' · ')}`);
          if (applyRes.warnings && applyRes.warnings.length) {
            for (const w of applyRes.warnings) message.warning(w, { duration: 6000 });
          }
        } else {
          message.warning(`已保存,但应用失败: ${applyRes.error ?? '未知错误'}`);
        }
      } else {
        message.success(editing.value ? '已更新,等下次同步周期生效' : '已添加,等下次同步周期生效');
      }
      showModal.value = false;
    } else {
      message.error('保存失败');
    }
  } finally {
    formLoading.value = false;
  }
}

/**
 * 单条规则的"测试"按钮 — 不保存,临时跑一次应用,显示结果
 * 用来诊断"为啥这条规则没生效"
 */
async function onTestMapping(m: FileMapping) {
  const res = await getApi().mappingsTestOne(m.id);
  const copied = res.mappingCopied?.length ?? 0;
  const skippedExist = res.mappingSkippedExisting?.length ?? 0;
  const skippedMissing = res.mappingSkipped?.length ?? 0;
  const parts = [`拷贝 ${copied}`, `目标已存在跳过 ${skippedExist}`, `源缺失跳过 ${skippedMissing}`];

  if (res.ok && copied > 0) {
    message.success(`✓ ${m.name} · ${parts.join(' · ')}`, { duration: 5000 });
  } else if (res.ok && copied === 0) {
    message.warning(`${m.name} 没有拷贝: ${parts.join(' · ')}`, { duration: 6000 });
  } else {
    message.error(`${m.name} 测试失败: ${res.error ?? '未知错误'}`);
  }
  // 警告都打出来,方便定位
  if (res.warnings && res.warnings.length) {
    for (const w of res.warnings) message.warning(w, { duration: 6000 });
  }
}

async function onDelete(m: FileMapping) {
  const current = (config.value.fileMappings ?? []).filter((x) => x.id !== m.id);
  const ok = await save({ ...config.value, fileMappings: current });
  if (ok) {
    message.success('已删除');
    // 立即应用:再次跑全部启用规则(剩下的规则)让 target 与 config 一致
    if (config.value.applyMappingsImmediately) {
      const applyRes = await getApi().mappingsApplyAll();
      if (applyRes.ok) {
        const copied = applyRes.mappingCopied?.length ?? 0;
        const skipped = applyRes.mappingSkippedExisting?.length ?? 0;
        message.success(`删除后重新应用:拷贝 ${copied},跳过 ${skipped}`);
      }
    }
  } else {
    message.error('删除失败');
  }
}

async function onToggleEnabled(m: FileMapping) {
  const current = (config.value.fileMappings ?? []).map((x) =>
    x.id === m.id ? { ...x, enabled: !x.enabled } : x,
  );
  const ok = await save({ ...config.value, fileMappings: current });
  if (ok) {
    message.success(m.enabled ? '已禁用' : '已启用');
    // 启用了新规则:立刻拉过来;禁用了:理论上不需要再跑
    if (config.value.applyMappingsImmediately && !m.enabled) {
      // 从禁用 → 启用
      const applyRes = await getApi().mappingsApplyAll();
      if (applyRes.ok) {
        const copied = applyRes.mappingCopied?.length ?? 0;
        message.success(`已拉过来: ${copied} 个`);
      }
    }
  }
}

const columns: DataTableColumns<FileMapping> = [
  { title: '名称', key: 'name', width: 140, fixed: 'left' },
  { title: '源', key: 'sourcePath', minWidth: 200, ellipsis: { tooltip: true } },
  { title: '目标(相对)', key: 'targetRelpath', minWidth: 160, ellipsis: { tooltip: true } },
  {
    title: '覆盖模式',
    key: 'overwrite',
    width: 110,
    render: (r) => h(NTag, { size: 'small', type: r.overwrite ? 'warning' : 'info' }, () => r.overwrite ? '总是覆盖' : '仅缺失补'),
  },
  {
    title: '源不存在',
    key: 'ifSourceMissing',
    width: 110,
    render: (r) => {
      const map = { skip: '跳过', keep: '保留', delete: '删除目标' };
      return h(NTag, { size: 'small' }, () => map[r.ifSourceMissing] ?? r.ifSourceMissing);
    },
  },
  {
    title: '启用',
    key: 'enabled',
    width: 80,
    render: (r) => h(NSwitch, { value: r.enabled, size: 'small', onUpdateValue: () => onToggleEnabled(r) }),
  },
  {
    title: '操作',
    key: 'actions',
    width: 240,
    fixed: 'right',
    render: (r) =>
      h(NSpace, { size: 8 }, () => [
        h(NButton, { size: 'small', onClick: () => onTestMapping(r) }, () => '测试'),
        h(NButton, { size: 'small', onClick: () => openEdit(r) }, () => '编辑'),
        h(
          NPopconfirm,
          { onPositiveClick: () => onDelete(r), positiveText: '确认删除', negativeText: '取消' },
          {
            trigger: () => h(NButton, { size: 'small', type: 'error' }, () => '删除'),
            default: () => h('span', null, `确认删除规则"${r.name}"?`),
          },
        ),
      ]),
  },
];

</script>

<template>
  <div class="ops-view-container">
    <div class="view-unified-wrap">
      <div class="ops-panel-card">
      <!-- 面板运维头部 -->
      <div class="panel-header">
        <div class="header-left">
          <div class="header-title-row">
            
            <span class="panel-title">本地文件保护</span>
          </div>
          <span class="panel-subtitle">
            共 {{ (config.fileMappings ?? []).length }} 个保护文件 · 此处添加的文件在软件更新时会自动保留，不会被覆盖
          </span>
        </div>
        <div class="header-actions">
          <n-button type="primary" size="medium" @click="openAdd">
            <template #icon>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </template>
            添加保护文件
          </n-button>
        </div>
      </div>

      <!-- 面板主体表格 -->
      <div class="panel-body">
        <div v-if="(config.fileMappings ?? []).length === 0" class="empty-state-box">
          <svg class="empty-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
          <span class="empty-title">暂无需要保护的文件</span>
          <span class="empty-desc">
            如果您本地有独特的配置文件（如用户设置、本地数据库或个性化配置）不希望在更新时被覆盖，可在此添加。
          </span>
          <n-button type="primary" size="small" @click="openAdd" style="margin-top: 8px">
            添加保护文件
          </n-button>
        </div>

        <div v-else class="table-container">
          <n-data-table
            :columns="columns"
            :data="config.fileMappings ?? []"
            :row-key="(r: FileMapping) => r.id"
            :pagination="false"
            size="small"
            :bordered="false"
            table-layout="fixed"
            flex-height
            style="width: 100%; min-width: 0; height: 100%"
          />
        </div>
      </div>

      <!-- 面板底部状态栏 -->
      <div class="panel-footer">
        <span class="footer-tip">
          💡 提示: 已启用的文件在更新后会自动保留本地修改，确保您的个性化配置不丢失。
        </span>
      </div>
      </div>
    </div>

    <!-- 添加/编辑规则 Modal -->
    <n-modal
      v-model:show="showModal"
      preset="card"
      :title="editing ? '编辑保护映射规则' : '新建保护映射规则'"
      style="max-width: 620px"
    >
      <n-form label-placement="top" class="ops-modal-form">
        <n-form-item label="规则标识名称">
          <n-input v-model:value="form.name" placeholder="例如: 本地数据库连接配置保护 (app.json)" />
        </n-form-item>
        <n-form-item label="源文件路径 (本地 / SMB / HTTP / WebDAV)">
          <div class="modal-input-row">
            <n-input
              v-model:value="form.sourcePath"
              :placeholder="sourcePathPlaceholder"
              class="monospace-text"
              style="flex: 1; min-width: 0"
            />
            <n-button
              v-if="!isRemoteSourcePath"
              :focusable="false"
              @click="pickSource"
            >浏览…</n-button>
            <n-button
              type="primary"
              ghost
              :focusable="false"
              :loading="sourceTestState.loading"
              @click="onTestSourceMapping"
            >探测</n-button>
          </div>
        </n-form-item>
        <n-form-item
          label="目标相对路径 (相对于 Target 部署目录)"
          :feedback="form.targetRelpath.includes('..')
            ? '安全限制: 路径不能包含 ..'
            : (config.targetDir
              ? (form.targetRelpath ? '' : '留空则默认部署到目标根目录并沿用源文件名')
              : '提示: 请先在配置页设置目标部署目录')"
          :validation-status="form.targetRelpath.includes('..') ? 'error' : undefined"
        >
          <div class="modal-input-row">
            <n-input
              v-model:value="form.targetRelpath"
              placeholder="config/app.ini"
              class="monospace-text"
              style="flex: 1"
            />
            <n-button @click="pickTargetFolder" :disabled="!config.targetDir">
              选择目标子目录…
            </n-button>
          </div>
        </n-form-item>
        <n-form-item label="写入覆盖策略">
          <n-radio-group
            :value="form.overwrite"
            @update:value="(v: boolean) => (form.overwrite = v)"
          >
            <n-space size="large">
              <n-radio :value="false">仅目标缺失时自动补回 (保护本地修改 · 推荐)</n-radio>
              <n-radio :value="true">每次强制覆盖 (模板强制重置)</n-radio>
            </n-space>
          </n-radio-group>
        </n-form-item>
        <n-form-item label="当源端文件不存在或离线时">
          <n-radio-group
            :value="form.ifSourceMissing"
            @update:value="(v: 'skip' | 'keep' | 'delete') => (form.ifSourceMissing = v)"
          >
            <n-space size="large">
              <n-radio value="skip">跳过并告警 (目标不动)</n-radio>
              <n-radio value="keep">静默保留 (目标不动)</n-radio>
              <n-radio value="delete">同步删除目标</n-radio>
            </n-space>
          </n-radio-group>
        </n-form-item>
        <n-form-item label="规则启用状态">
          <n-switch v-model:value="form.enabled" />
        </n-form-item>
      </n-form>
      <template #footer>
        <n-space justify="end">
          <n-button @click="showModal = false">取消</n-button>
          <n-button type="primary" :loading="formLoading" @click="onSaveMapping">保存规则</n-button>
        </n-space>
      </template>
    </n-modal>

    <!-- 源文件测试结果 Modal -->
    <n-modal
      v-model:show="sourceTestState.show"
      preset="card"
      style="width: 560px; max-width: 90vw"
      :title="sourceTestState.result?.ok ? '✓ 源文件可正常读取' : '✗ 源文件探测失败'"
      :bordered="false"
      size="huge"
    >
      <n-spin :show="sourceTestState.loading">
        <div v-if="!sourceTestState.loading && sourceTestState.result">
          <template v-if="sourceTestState.result.ok">
            <n-space vertical :size="8">
              <n-text>源端文件连通性正常 · 探测响应耗时 {{ sourceTestState.result.durationMs }}ms</n-text>
              <n-text depth="3" style="font-size: 12px">
                单文件映射通道就绪，同步调度器可正常拉取此文件。
              </n-text>
            </n-space>
          </template>
          <template v-else>
            <n-space vertical :size="8">
              <n-alert
                :type="sourceTestState.result.fatalReason === 'permission-denied' || sourceTestState.result.fatalReason === 'not-found' ? 'error' : 'warning'"
                :show-icon="true"
              >
                <n-space vertical :size="4">
                  <n-text><b>{{ labelOf(sourceTestState.result.fatalReason as any) }}</b></n-text>
                  <n-text depth="3" style="font-size: 12px">{{ sourceTestState.result.error }}</n-text>
                </n-space>
              </n-alert>
              <n-text depth="3" style="font-size: 12px">
                运维排查建议: {{ adviceOf(sourceTestState.result.fatalReason as any) }}
              </n-text>
            </n-space>
          </template>
        </div>
      </n-spin>
      <template #footer>
        <n-space justify="end">
          <n-button @click="sourceTestState.show = false">关闭</n-button>
          <n-button
            v-if="sourceTestState.result && !sourceTestState.result.ok"
            type="primary"
            @click="onTestSourceMapping"
          >重试探测</n-button>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>

<style scoped>
.ops-view-container {
  height: 100%;
  overflow-y: auto;
  padding: 20px 24px;
  box-sizing: border-box;
  scrollbar-gutter: stable;
}

.view-unified-wrap {
  max-width: 1000px;
  margin: 0 auto;
  height: 100%;
  display: flex;
  flex-direction: column;
}

.ops-panel-card {
  flex: 1;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
}

.panel-header {
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color);
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-shrink: 0;
}

.header-left {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.header-title-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.panel-tag {
  font-size: 10px;
  font-weight: 700;
  color: #2563eb;
  background: #eff6ff;
  border: 1px solid #dbeafe;
  padding: 1px 6px;
  border-radius: 4px;
  font-family: monospace;
}

.panel-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--text-main);
}

.panel-subtitle {
  font-size: 12px;
  color: var(--text-muted);
}

.panel-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
}

.table-container {
  flex: 1;
  height: 100%;
  min-height: 0;
}

.empty-state-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 20px;
  text-align: center;
}

.empty-svg {
  width: 48px;
  height: 48px;
  color: #cbd5e1;
  margin-bottom: 12px;
}

.empty-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-main);
  margin-bottom: 6px;
}

.empty-desc {
  font-size: 12px;
  color: #64748b;
  max-width: 460px;
  line-height: 1.6;
  margin-bottom: 12px;
}

.panel-footer {
  padding: 12px 20px;
  border-top: 1px solid var(--border-color);
  background: var(--bg-subtle);
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: #64748b;
  flex-shrink: 0;
}

.footer-tip {
  color: #64748b;
}

.modal-input-row {
  display: flex;
  gap: 8px;
  width: 100%;
}

.monospace-text {
  font-family: "SFMono-Regular", Consolas, monospace;
}
</style>
