import { useSyncExternalStore } from 'react';

/**
 * 官网语言状态（D-25 客户端切换 → v0.11.0 双构建演进）：
 * - PROD 双构建：语言 = 构建期常量（zh 站 `/` 恒 zh、en 站 `/en/` 恒 en，静态 SEO 落死，
 *   vite.config.ts define VITE_SITE_LANG）——跨语言切换 = 构建产物互链重定向
 *   （zh 站「English」→ `/en/`，en 站「中文」→ `/`）；localStorage/navigator 探测退役
 * - dev 模式：单构建无 /en/ 产物，保留 B4 客户端切换（localStorage 持久化 + navigator 探测）
 * 词表：site.ts zh/en 双词典（B4）；本模块只管语言状态。
 */
export type SiteLang = 'zh' | 'en';

const STORAGE_KEY = 'dbkit-lang';
/** vite define 注入（vite.config.ts）；dev 下缺省 zh */
const BUILD_LANG: SiteLang = import.meta.env.VITE_SITE_LANG === 'en' ? 'en' : 'zh';
/** PROD = 双构建产物（静态语言）；DEV = 单构建客户端切换 */
const STATIC_LANG: boolean = import.meta.env.PROD;

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

let current: SiteLang = STATIC_LANG ? BUILD_LANG : detectLang();
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
  if (STATIC_LANG) {
    // 双构建互链：跨语言 = 跳转到对侧构建产物（静态 SEO 语义，无 state 切换）
    window.location.href = lang === 'en' ? '/en/' : '/';
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
