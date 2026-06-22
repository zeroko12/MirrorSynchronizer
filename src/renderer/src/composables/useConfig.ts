/**
 * useConfig - 配置加载/保存的 composable
 *
 * 用 ref + toRaw 配合:
 * - ref 提供深响应(v-model 改内层字段也能触发更新)
 * - 跨 IPC 时必须 toRaw(),否则 Vue Proxy 会被 structured clone 拒绝("An object could not be cloned")
 */

import { ref, toRaw } from 'vue';
import type { AppConfig } from '@core/types';
import { getApi } from '../api';

const emptyConfig = (): AppConfig => ({
  sourceDir: '',
  targetDir: '',
  backupDir: '',
  intervalSec: 300,
  backupCount: 3,
  autostart: false,
  fileMappings: [],
  ignoreItems: [],
});

export function useConfig() {
  const config = ref<AppConfig>(emptyConfig());
  const loading = ref(false);
  const saving = ref(false);
  const error = ref<string | null>(null);
  const lastSavedAt = ref<number | null>(null);

  async function load(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const cfg = await getApi().loadConfig();
      config.value = cfg;
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      loading.value = false;
    }
  }

  async function save(next?: AppConfig): Promise<boolean> {
    saving.value = true;
    error.value = null;
    try {
      // 关键:Vue 的 ref 包装的是 Proxy,IPC 序列化会失败
      // 用 JSON.parse(JSON.stringify(...)) 拿一份纯对象,或者用 toRaw
      const raw = toRaw(next ?? config.value);
      const cfg: AppConfig = JSON.parse(JSON.stringify(raw));
      const res = await getApi().saveConfig(cfg);
      if (!res.ok) {
        error.value = res.error ?? '保存失败';
        return false;
      }
      config.value = cfg;
      lastSavedAt.value = Date.now();
      return true;
    } catch (e) {
      error.value = (e as Error).message;
      return false;
    } finally {
      saving.value = false;
    }
  }

  return { config, loading, saving, error, lastSavedAt, load, save };
}
