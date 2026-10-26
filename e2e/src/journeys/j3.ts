import { findWebviewFrame } from '../cdp';
import type { JourneyFn } from './j1';

/**
 * 旅程③：双语冒烟——按当前 locale 断言 manifest 层（%key% nls）与 webview 层（bootstrap 词典注入）
 * 双层一致，守 P-72 回归（英文显示语言下 VSCode 不加载 l10n bundle 的宿主行为差）。
 * zh 基线依赖语言包预装（P-77：无包时 --locale=zh-cn 被回落为 en，env.language 会直接露馅）。
 * runner 对每个 locale 各跑一轮（en/zh-cn），J1/J2 在两种语言下全量执行即是旅程级双语覆盖。
 */
export const journey3: JourneyFn = async (ctx) => {
  const { page, bridge, labels, requestedLocale } = ctx;
  const state = await bridge.state();
  const expectZh = requestedLocale.startsWith('zh');
  if (expectZh && !state.language.startsWith('zh')) {
    const packLoaded = state.extensions.some((e) => e.includes('language-pack'));
    throw new Error(
      `zh 基线失效：env.language=${state.language}（语言包未生效或 --locale 被回落，见 P-77；` +
        `语言包装载=${packLoaded ? '是' : '否'}，已装扩展=${state.extensions.join(', ') || '仅内置'}）`,
    );
  }
  if (!expectZh && state.language !== 'en') {
    throw new Error(`en 基线失效：env.language=${state.language}`);
  }

  // manifest 层：%key% 按显示语言解析（en → package.nls.en.json / zh → 默认 nls.json）
  await bridge.execute('workbench.view.extension.dbExplorer-container');
  await page.locator(`.action-label[aria-label="${labels.newConnection}"]`).first().waitFor({ state: 'visible', timeout: 20_000 });

  // webview 层：连接表单按钮（词典经 __BOOTSTRAP__.messages 注入——P-72 修复的回归哨兵）
  await page.locator(`.action-label[aria-label="${labels.newConnection}"]`).first().click();
  const form = await findWebviewFrame(page, (b) => b.page === 'connectionForm');
  await form.getByRole('button', { name: labels.save, exact: true }).waitFor({ state: 'visible', timeout: 20_000 });

  // 收尾：关掉表单面板（后续 locale 轮次重新建连）
  await bridge.execute('workbench.action.closeActiveEditor');
};
