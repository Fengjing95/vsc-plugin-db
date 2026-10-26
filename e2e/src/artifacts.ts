import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright-core';

/** 失败工件：截图 + 各 webview 帧的 bootstrap/正文摘要，落在 runDir/screenshots 下 */
export async function dumpArtifacts(runDir: string, page: Page, tag: string): Promise<void> {
  const dir = join(runDir, 'artifacts', tag);
  mkdirSync(dir, { recursive: true });
  try {
    await page.screenshot({ path: join(dir, 'workbench.png'), fullPage: false });
  } catch {
    // 截图失败不掩盖原始错误
  }
  let i = 0;
  for (const frame of page.frames()) {
    if (!frame.url().startsWith('vscode-webview://')) continue;
    try {
      const boot = await frame.evaluate(() => (window as { __BOOTSTRAP__?: unknown }).__BOOTSTRAP__ ?? null);
      const bodyText = await frame.evaluate(() => document.body.innerText.slice(0, 4000));
      writeFileSync(join(dir, `webview-${i}.json`), JSON.stringify({ url: frame.url(), boot, bodyText }, null, 2));
      i += 1;
    } catch {
      // 帧已销毁
    }
  }
}
