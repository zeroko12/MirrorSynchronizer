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
  NEmpty,
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
  <div class="page">
    <header class="hero">
      <h1>文件映射规则</h1>
      <p class="subtitle">
        每次同步完成后追加执行:把本地指定文件拷到目标目录固定位置
      </p>
    </header>

    <div class="toolbar">
      <span class="hint">
        共 {{ (config.fileMappings ?? []).length }} 条规则 ·
        启用的会在每次同步后追加执行
      </span>
      <n-button type="primary" size="small" @click="openAdd">+ 添加规则</n-button>
    </div>

    <n-empty
      v-if="(config.fileMappings ?? []).length === 0"
      description="还没有映射规则,点上方 + 添加"
      style="margin-top: 60px"
    />

    <div v-else class="table-wrap">
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

    <n-modal
      v-model:show="showModal"
      preset="card"
      :title="editing ? '编辑映射规则' : '添加映射规则'"
      style="max-width: 580px"
    >
      <n-form label-placement="top">
        <n-form-item label="名称(便于识别)">
          <n-input v-model:value="form.name" placeholder="例:本地配置覆盖" />
        </n-form-item>
        <n-form-item label="源文件(本地 / SMB / HTTP / WebDAV)">
          <n-space :wrap="false" :size="8" style="width: 100%">
            <n-input
              v-model:value="form.sourcePath"
              :placeholder="sourcePathPlaceholder"
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
            >测试</n-button>
          </n-space>
        </n-form-item>
        <n-form-item
          label="目标(相对目标目录,例:config/app.ini)"
          :feedback="form.targetRelpath.includes('..')
            ? '不能包含 ..'
            : (config.targetDir
              ? (form.targetRelpath ? '' : '空 = 拷到目标根目录,文件名沿用源文件名')
              : '提示:请先在设置里配置目标目录')"
          :validation-status="form.targetRelpath.includes('..') ? 'error' : undefined"
        >
          <n-space :wrap="false">
            <n-input
              v-model:value="form.targetRelpath"
              placeholder="config/app.ini"
              style="width: 360px"
            />
            <n-button @click="pickTargetFolder" :disabled="!config.targetDir">
              浏览目标…
            </n-button>
          </n-space>
        </n-form-item>
        <n-form-item label="覆盖模式">
          <n-radio-group
            :value="form.overwrite"
            @update:value="(v: boolean) => (form.overwrite = v)"
          >
            <n-radio :value="false">仅目标缺失时补回(推荐)</n-radio>
            <n-radio :value="true">每次强制覆盖目标</n-radio>
          </n-radio-group>
          <template #feedback>
            <span style="font-size: 12px; color: #6b7785">
              仅缺失补:用户编辑过的不会被覆盖;强制覆盖:每次都用模板覆盖
            </span>
          </template>
        </n-form-item>
        <n-form-item label="源文件不存在时">
          <n-radio-group
            :value="form.ifSourceMissing"
            @update:value="(v: 'skip' | 'keep' | 'delete') => (form.ifSourceMissing = v)"
          >
            <n-radio value="skip">跳过(不动目标)</n-radio>
            <n-radio value="keep">保留(目标不动)</n-radio>
            <n-radio value="delete">从目标删除</n-radio>
          </n-radio-group>
        </n-form-item>
        <n-form-item label="启用">
          <n-switch v-model:value="form.enabled" />
        </n-form-item>
      </n-form>
      <template #footer>
        <n-space justify="end">
          <n-button @click="showModal = false">取消</n-button>
          <n-button type="primary" :loading="formLoading" @click="onSaveMapping">保存</n-button>
        </n-space>
      </template>
    </n-modal>

    <!-- 源文件测试结果 modal -->
    <n-modal
      v-model:show="sourceTestState.show"
      preset="card"
      style="width: 560px; max-width: 90vw"
      :title="sourceTestState.result?.ok ? '✓ 源文件可达' : '✗ 源文件不可达'"
      :bordered="false"
      size="huge"
    >
      <n-spin :show="sourceTestState.loading">
        <div v-if="!sourceTestState.loading && sourceTestState.result">
          <template v-if="sourceTestState.result.ok">
            <n-space vertical :size="8">
              <n-text>源文件可访问 · 耗时 {{ sourceTestState.result.durationMs }}ms</n-text>
              <n-text depth="3" style="font-size: 12px">
                单文件映射,无需文件数 / 总大小。
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
                  <n-text>
                    <b>{{ labelOf(sourceTestState.result.fatalReason as any) }}</b>
                  </n-text>
                  <n-text depth="3" style="font-size: 12px">{{ sourceTestState.result.error }}</n-text>
                </n-space>
              </n-alert>
              <n-text depth="3" style="font-size: 12px">
                建议:{{ adviceOf(sourceTestState.result.fatalReason as any) }}
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
  width: 100%;
  box-sizing: border-box;
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

.hero h1 {
  margin: 0 0 4px;
  font-size: 24px;
}

.subtitle {
  margin: 0 0 16px;
  color: #6b7785;
  font-size: 13px;
}

.table-wrap {
  flex: 1 1 0;
  min-height: 300px;
  background: #fff;
  border: 1px solid #e4e7eb;
  border-radius: 8px;
  padding: 12px;
  display: flex;
  flex-direction: column;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.hint {
  font-size: 13px;
  color: #6b7785;
}
</style>
