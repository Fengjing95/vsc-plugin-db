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

/** VSCode QuickPick 选择：过滤输入 + 点选目标行（连接选择/库选择等原生 quick input） */
export async function pickQuickOption(page: Page, optionText: string, timeoutMs = 20_000): Promise<void> {
  const widget = page.locator('.quick-input-widget');
  await widget.waitFor({ state: 'visible', timeout: timeoutMs });
  const input = widget.locator('.quick-input-box input');
  await input.fill(optionText);
  const row = widget.locator(`.monaco-list-row:has-text("${optionText}")`).first();
  await row.waitFor({ state: 'visible', timeout: 10_000 });
  await row.click();
  await widget.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
}

/** 关闭右下角通知气泡（profile 已设 notifications.showToast=false，此为兜底——
 *  settings 预置先于首启读取，仍防宿主版本差异/新通知形态遮挡点击） */
export async function dismissNotifications(page: Page): Promise<void> {
  const toasts = page.locator('.notifications-toasts .notification-list-item .clear-notification-action');
  const count = await toasts.count();
  for (let i = 0; i < Math.min(count, 5); i++) {
    await toasts.first().click().catch(() => undefined);
  }
}

/** 关闭首启 onboarding 模态（`.onboarding-a-overlay`，aria-modal，拦截一切点击）。
 *  模态可能晚于旅程开头渲染（Linux zh 轮实测：旅程开头检测为空、点击时已在）——先给它 settleMs
 *  出现窗口，再按 Esc / 点关闭类按钮，循环直至消失；每次关键 workbench 点击前调用。 */
export async function dismissOverlays(page: Page, settleMs = 2500): Promise<void> {
  const overlay = page.locator('.onboarding-a-overlay.visible, .onboarding-a-overlay[aria-modal="true"]');
  await overlay.first().waitFor({ state: 'visible', timeout: settleMs }).catch(() => undefined);
  for (let i = 0; i < 4; i++) {
    if ((await overlay.count()) === 0) break;
    await page.keyboard.press('Escape').catch(() => undefined);
    // 关闭/跳过类按钮（zh/en）优先，退而点最后一个按钮（主操作通常也会关掉模态）
    const closeBtn = overlay
      .locator('button, a[role="button"]')
      .filter({ hasText: /skip|close|dismiss|跳过|关闭|稍后|later|got it|开始|get started|不再显示|don't show/i })
      .first();
    if ((await closeBtn.count()) > 0) {
      await closeBtn.click({ timeout: 2000 }).catch(() => undefined);
    } else {
      await overlay.locator('button').last().click({ timeout: 2000 }).catch(() => undefined);
    }
    await overlay.first().waitFor({ state: 'hidden', timeout: 2000 }).catch(() => undefined);
  }
  await dismissNotifications(page);
}
