import { chromium, type Browser, type Frame, type Locator, type Page } from 'playwright-core';

export interface Workbench {
  browser: Browser;
  page: Page;
  close(): Promise<void>;
}

export interface WebviewBoot {
  page: string;
  viewId: string;
  params: Record<string, string>;
  lang?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** CDP 连接并等待 workbench 就绪（首启可能有欢迎页/初始化延迟） */
export async function connectWorkbench(cdpPort: number, timeoutMs = 90_000): Promise<Workbench> {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  const context = browser.contexts()[0];
  if (!context) {
    await browser.close();
    throw new Error('CDP 无 browser context');
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const page of context.pages()) {
      try {
        if ((await page.locator('.monaco-workbench').count()) > 0) {
          return {
            browser,
            page,
            close: () => browser.close(),
          };
        }
      } catch {
        // 页面可能正在跳转，重试
      }
    }
    await sleep(500);
  }
  await browser.close();
  throw new Error('workbench 未出现（.monaco-workbench 超时）');
}

/** 按 __BOOTSTRAP__ 定位 webview iframe 帧（OOPIF；VSCode 桌面 webview = vscode-webview:// iframe） */
export async function findWebviewFrame(
  page: Page,
  want: (boot: WebviewBoot) => boolean,
  timeoutMs = 30_000,
): Promise<Frame> {
  const deadline = Date.now() + timeoutMs;
  const lastSeen: string[] = [];
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (!frame.url().startsWith('vscode-webview://')) continue;
      try {
        const boot = (await frame.evaluate(() => (window as { __BOOTSTRAP__?: WebviewBoot }).__BOOTSTRAP__ ?? null)) as
          | WebviewBoot
          | null;
        if (boot) {
          lastSeen.push(boot.page);
          if (want(boot)) return frame;
        }
      } catch {
        // 帧执行上下文尚未建立（导航中），下一轮重试
      }
    }
    await sleep(300);
  }
  throw new Error(`webview 帧未找到（条件未命中；期间出现的页面: ${[...new Set(lastSeen)].join(', ') || '无'}）`);
}

/** dbExplorer 侧栏视图容器（DOM id 由 viewContainer id 派生，与语言无关） */
export function explorerPane(page: Page): Locator {
  return page.locator('[id="workbench.view.extension.dbExplorer-container"]');
}

/** 树行定位（role=treeitem，按可见文本匹配；限缩在 dbExplorer 视图内防跨树误中） */
export function treeRow(page: Page, text: string): Locator {
  return explorerPane(page).locator(`[role="treeitem"]:has-text("${text}")`).first();
}

/** 展开树节点（点 twistie；已展开/叶子节点幂等跳过） */
export async function expandRow(row: Locator): Promise<void> {
  const expanded = await row.getAttribute('aria-expanded');
  if (expanded !== 'false') return;
  await row.locator('.monaco-tl-twistie').click();
}

/** 等待树行出现 */
export async function waitTreeRow(page: Page, text: string, timeoutMs = 20_000): Promise<Locator> {
  const row = treeRow(page, text);
  await row.waitFor({ state: 'visible', timeout: timeoutMs });
  return row;
}
