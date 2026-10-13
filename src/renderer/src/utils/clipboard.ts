import { getApi } from '../api';

/**
 * 稳健剪贴板写入助手
 * 优先调用 Electron 原生 clipboard 接口，杜绝浏览器焦点丢失导致的复制失败
 */
export async function copyText(text: string): Promise<boolean> {
  if (text == null || text === '') return false;

  // 1. Electron IPC 原生接口 (最可靠，无权限或焦点限制)
  try {
    const api = getApi();
    if (api?.$invoke) {
      const res = await api.$invoke('clipboard:writeText', String(text));
      if (res && (res as any).ok !== false) return true;
    }
  } catch {}

  // 2. 现代 Navigator Clipboard
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(String(text));
      return true;
    }
  } catch {}

  // 3. 经典 input execCommand 降级
  try {
    const ta = document.createElement('textarea');
    ta.value = String(text);
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '-9999px';
    ta.setAttribute('readonly', '');
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (ok) return true;
  } catch {}

  return false;
}
