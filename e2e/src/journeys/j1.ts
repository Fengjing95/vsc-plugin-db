import type { BridgeClient } from '../bridgeClient';
import { findWebviewFrame, expandRow, waitTreeRow, type Workbench } from '../cdp';
import type { Fixture } from '../fixture';
import { commitCountLabel, uiLabels } from '../labels';

export interface JourneyCtx {
  page: Workbench['page'];
  bridge: BridgeClient;
  fixture: Fixture;
  locale: string;
  runDir: string;
  labels: ReturnType<typeof uiLabels>;
}

export type JourneyFn = (ctx: JourneyCtx) => Promise<void>;

/**
 * 旅程①：新建连接（sqlite）→ 资源树浏览 → 打开表格视图
 * 编辑/预览/提交段（提交后工具栏计数归零）在表格页打开后继续（B1 收口）。
 */
export const journey1: JourneyFn = async (ctx) => {
  const { page, bridge, fixture, labels } = ctx;

  // 0. 首启 onboarding 模态兜底（settings.json 已关，但实验浮层可能仍现）：Esc / 主按钮关掉
  const overlay = page.locator('.onboarding-a-overlay');
  if ((await overlay.count()) > 0) {
    await page.keyboard.press('Escape').catch(() => undefined);
    await overlay.locator('button').last().click().catch(() => undefined);
  }

  // 1. 打开资源树视图（命令 = workbench.view.extension.<containerId>，与语言无关）
  const opened = await bridge.execute('workbench.view.extension.dbExplorer-container');
  if (!opened.ok) throw new Error(`打开资源树视图失败: ${opened.error}`);

  // 2. 视图标题栏「新建连接」→ 连接表单 webview（VSCode 1.14x 的 action-label 走 aria-label，无 title 属性）
  await ctx.page.locator(`.action-label[aria-label="${labels.newConnection}"]`).first().click();
  const form = await findWebviewFrame(page, (b) => b.page === 'connectionForm');

  // 3. 填表：驱动卡片（role=radio + displayName）→ 名称 → sqlite path（type=file 控件手输口径）
  await form.getByRole('radio', { name: 'SQLite' }).click();
  await form.locator('#conn-name').fill('e2e-sqlite');
  await form.locator('#conn-field-path').fill(fixture.dbPath);
  await form.getByRole('button', { name: labels.save }).click();

  // 4. 保存成功 → 表单面板自关 + 树出现连接节点
  await waitTreeRow(page, 'e2e-sqlite', 30_000);

  // 5. 展开 e2e-sqlite → main（sqlite 单节点库）→ 「表」目录 → dbkit_e2e
  await expandRow(await waitTreeRow(page, 'e2e-sqlite'));
  await expandRow(await waitTreeRow(page, 'main'));
  await expandRow(await waitTreeRow(page, labels.tables));
  const tableRow = await waitTreeRow(page, 'dbkit_e2e');

  // 6. 单击表节点（TreeItem.command = openTable）→ 表格页 webview 渲染出 fixture 数据。
  //    数据可见即证明：sql.js wasm 在真实宿主按 media/ 路径加载成功 + 驱动全链路 + webview RPC 渲染
  await tableRow.click();
  const table = await findWebviewFrame(page, (b) => b.page === 'table' && b.params.obj === 'dbkit_e2e');
  await table.getByText('e2e-alice').first().waitFor({ timeout: 30_000 });

  // 7. 编辑单元格：e2e-bob 行的 city 列（双击进入编辑，输入即受控 input；Enter 确认并下移一行，
  //    下移产生的编辑态 Esc 取消——避免引入第二条变更）。列索引 +1：首个 gridcell 是行号列
  const row = table.locator('[role="row"]').filter({ hasText: 'e2e-bob' }).first();
  const cityCell = row.locator('[role="gridcell"]').nth(3);
  await cityCell.dblclick();
  const editInput = cityCell.locator('input');
  await editInput.fill('e2e-edited');
  await editInput.press('Enter');
  await page.keyboard.press('Escape');

  // 8. 工具栏提交按钮计数 = 1（aria-label = table.toolbar.commitCount）
  const commitOne = table.getByRole('button', { name: commitCountLabel(ctx.locale, 1) });
  await commitOne.waitFor({ state: 'visible', timeout: 15_000 });

  // 9. 预览 → 确认提交（预览即执行，交互稿 §5 / 概要 §5.4.3）。
  //    确认按钮必须在 dialog 内 + exact 匹配：子串匹配会命中工具栏「提交变更（1）」（在遮罩后面，点了必超时）
  await table.getByRole('button', { name: labels.previewSql }).click();
  const dialog = table.locator('[role="dialog"]');
  const confirmBtn = dialog.getByRole('button', { name: labels.previewConfirm, exact: true });
  await confirmBtn.waitFor({ state: 'visible', timeout: 15_000 });
  await confirmBtn.click();

  // 10. 提交成功：计数归零（aria-label → （0））+ 网格渲染新值（乐观锁写库 + 刷新当前页）
  await table.getByRole('button', { name: commitCountLabel(ctx.locale, 0) }).waitFor({ state: 'visible', timeout: 20_000 });
  await table.getByText('e2e-edited').first().waitFor({ state: 'visible', timeout: 15_000 });
};
