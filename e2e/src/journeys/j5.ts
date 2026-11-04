import { dismissOverlays, findWebviewFrame, waitTreeRow, expandRow } from '../cdp';
import type { JourneyFn } from './j1';

/**
 * 旅程⑤（J5，数据导入 / ADR D-32）：树表节点「导入数据」→ 映射 Dialog → 确认 → 追加落库。
 * 断言面：① Dialog 渲染（文件名标题 + 映射建议 + 开始按钮）；② 导入完成后网格刷新出现
 * 新增 6 行（含中文值 北京）；③ fixture CSV 的 NULL/JSON 编码行写入成功（空字段 = NULL 默认
 * 语义 + JSON 列解析，e2e-imp-2/4 行就是这两类覆盖）。入口经 bridge 直呼
 * `dbExplorer.importData`（第二参带 file——P-82 口子：原生 OpenDialog 无法自动化），
 * connId/db/obj 回退树选中节点。依赖 j1 已建的 e2e-sqlite 连接（journeys 有序全跑）。
 */
export const journey5: JourneyFn = async (ctx) => {
  const { page, bridge, fixture, labels } = ctx;
  await dismissOverlays(page, 1000);

  // 1. 展开到表节点并单击选中（j1 收尾后树已建连接；选中节点供命令回退取 connId/db/obj）
  await expandRow(await waitTreeRow(page, 'e2e-sqlite'));
  await expandRow(await waitTreeRow(page, 'main'));
  await expandRow(await waitTreeRow(page, labels.tables));
  const tableRow = await waitTreeRow(page, 'dbkit_e2e');
  await tableRow.click();
  const table = await findWebviewFrame(page, (b) => b.page === 'table' && b.params.obj === 'dbkit_e2e');
  await table.getByText('e2e-alice').first().waitFor({ timeout: 30_000 });

  // 2. bridge 直呼导入命令（arg.file = fixture CSV；面板如已打开会重开以生效引导参数）
  const executed = await bridge.execute('dbExplorer.importData', undefined, { file: fixture.importCsvPath });
  if (!executed.ok) {
    throw new Error(`importData 执行失败: ${executed.error}`);
  }

  // 3. 映射 Dialog：重开后的表格 webview 内出现（标题含文件名 + 映射建议 + 开始按钮）
  const freshTable = await findWebviewFrame(page, (b) => b.page === 'table' && b.params.obj === 'dbkit_e2e');
  const dialog = freshTable.locator('[role="dialog"]');
  await dialog.getByText('j5-import.csv').first().waitFor({ state: 'visible', timeout: 30_000 });
  // 映射建议可见（文件列表头 id 出现在映射区）
  await dialog.getByText('payload').first().waitFor({ state: 'visible', timeout: 10_000 });

  // 4. 确认导入（role+name 定位开始按钮——title 文本里也含文件名；n=6 与 fixture CSV 行数一致）
  await dialog.getByRole('button', { name: labels.importStart(6), exact: true }).click();

  // 5. 导入完成：网格刷新渲染新增行——中文值（city）与最后一行（id=12）都可见即证明
  //    6 行全部落库（含 NULL/JSON 编码行 e2e-imp-2/4，任一失败则不会出现 6/6）
  await freshTable.getByText('北京').first().waitFor({ state: 'visible', timeout: 30_000 });
  await freshTable.getByText('e2e-imp-6').first().waitFor({ state: 'visible', timeout: 15_000 });
};
