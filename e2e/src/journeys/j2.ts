import { dismissOverlays, findWebviewFrame, pickQuickOption } from '../cdp';
import type { JourneyFn } from './j1';

/**
 * 旅程②：SQL Console——执行 → 结果面板 → 无 WHERE UPDATE 危险横幅 → 取消/放行两种语义。
 * 依赖 J1 已建连接（runner 按 j1→j2→j3 顺序执行）。sqlite 同步引擎 supportsCancel=false，
 * 运行中取消不可测（README 已知限制如实声明）；本旅程的「取消语义」= 危险横幅的取消分支。
 */
export const journey2: JourneyFn = async (ctx) => {
  const { page, bridge, fixture, labels } = ctx;
  await dismissOverlays(page, 1000);

  // 1. 打开预置 SELECT 文档（vscode.open 经 bridge，$uri 参数在桥侧还原为 Uri）
  await bridge.execute('vscode.open', { $uri: fixture.selectSqlUri });
  await page.locator('.tab[aria-label*="j2-select"]').first().waitFor({ state: 'visible', timeout: 20_000 });

  // 2. 执行（未绑定文档 → QuickPick 选连接 → 选库 main）
  await bridge.execute('dbExplorer.executeQuery');
  await pickQuickOption(page, 'e2e-sqlite');
  await pickQuickOption(page, 'main');

  // 3. 底部结果面板（consoleResult webview，单例跟随最近执行）出现 SELECT 结果
  const consoleFrame = await findWebviewFrame(page, (b) => b.page === 'console');
  await consoleFrame.getByText('e2e-alice').first().waitFor({ state: 'visible', timeout: 30_000 });

  // 4. 无 WHERE 的 UPDATE → 危险横幅（DangerGuard §5.8：全表语句横幅确认）
  await bridge.execute('vscode.open', { $uri: fixture.updateSqlUri });
  await bridge.execute('dbExplorer.executeQuery');
  await pickQuickOption(page, 'e2e-sqlite');
  await pickQuickOption(page, 'main');
  await consoleFrame.getByText(labels.bannerDetected).first().waitFor({ state: 'visible', timeout: 30_000 });

  // 5. 取消分支：点横幅「取消」→ 语句不落库（重跑 SELECT，轮询期内新值必须持续缺席）
  await consoleFrame.getByRole('button', { name: labels.cancel, exact: true }).first().click();
  await consoleFrame.getByText(labels.bannerDetected).first().waitFor({ state: 'hidden', timeout: 15_000 });
  await bridge.execute('vscode.open', { $uri: fixture.selectSqlUri });
  await bridge.execute('dbExplorer.executeQuery'); // 已绑定 → 不再弹 QuickPick
  await consoleFrame.getByText('e2e-alice').first().waitFor({ state: 'visible', timeout: 30_000 });
  for (let i = 0; i < 10; i++) {
    const leaked = await consoleFrame.getByText('e2e-banner-x').count();
    if (leaked > 0) throw new Error('取消语义失效：横幅取消后 UPDATE 仍然落库（SELECT 结果出现 e2e-banner-x）');
    await new Promise((r) => setTimeout(r, 500));
  }

  // 6. 放行分支：重跑 UPDATE → 横幅「仍要执行」→ 落库；UPDATE 结果集无数据行，重跑 SELECT 验证新值在场
  await bridge.execute('vscode.open', { $uri: fixture.updateSqlUri });
  await bridge.execute('dbExplorer.executeQuery');
  await consoleFrame.getByText(labels.bannerDetected).first().waitFor({ state: 'visible', timeout: 30_000 });
  await consoleFrame.getByRole('button', { name: labels.runAnyway }).first().click();
  await bridge.execute('vscode.open', { $uri: fixture.selectSqlUri });
  await bridge.execute('dbExplorer.executeQuery');
  await consoleFrame.getByText('e2e-banner-x').first().waitFor({ state: 'visible', timeout: 30_000 });
};
