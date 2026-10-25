import { useSyncExternalStore } from 'react';

/**
 * 官网语言状态（D-25）：客户端切换（单份构建，无路由）——
 * localStorage 持久化 → 首访按 navigator.language（zh* → zh、其余 en）；
 * <html lang> 随语言更新。切换器在导航/页脚各一处（B4 落地）。
 * 词表：site.ts zh/en 双词典（B4）；本模块只管语言状态。
 */
export type SiteLang = 'zh' | 'en';

const STORAGE_KEY = 'dbkit-lang';

function detectLang(): SiteLang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'zh' || saved === 'en') {
      return saved;
    }
  } catch {
    // 隐私模式等 storage 不可用场景：回落 navigator.language
  }
  return /^zh\b/i.test(navigator.language || '') ? 'zh' : 'en';
}

let current: SiteLang = detectLang();
const listeners = new Set<() => void>();

function applyDocumentLang(lang: SiteLang): void {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  }
}

applyDocumentLang(current);

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getSiteLang(): SiteLang {
  return current;
}

export function setSiteLang(lang: SiteLang): void {
  if (lang === current) {
    return;
  }
  current = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // storage 不可用：语言仅在当前会话生效
  }
  applyDocumentLang(lang);
  listeners.forEach((fn) => fn());
}

export function useSiteLang(): SiteLang {
  return useSyncExternalStore(subscribe, getSiteLang);
}
