import { dismissOverlays, findWebviewFrame, waitTreeRow, expandRow } from '../cdp';
import type { JourneyFn } from './j1';

/**
 * 旅程④（J-ER，ER P2 / ADR D-28）：表节点「以该表为中心展开 ER 图」→ 邻接图渲染。
 * 断言面：① ER webview（page=erDiagram）画布渲染中心表与被引用父表两节点；② 中心表带
 * data-focus 恒亮标识（邻接 scope）；③ 边 tooltip 携带 FK 动作原文 ON DELETE CASCADE
 * （fixture 建表子句 → sqlite PRAGMA → KeyMeta → ErEdge 全链路）。
 * 入口经 bridge 直呼 `dbExplorer.erFocusTable`（无参回退树选中节点——命令面板语义）：
 * CDP 合成右键在本宿主不渲染树 context menu（Queries 对照组同样不出，两个 VSCode 版本一致，
 * P-82 注记）——右键菜单的 when 显隐面由 extension 侧 treeWhenClauses 单测锁定匹配矩阵。
 * 依赖 j1 已建的 e2e-sqlite 连接（journeys 有序全跑）。
 */
export const journey4: JourneyFn = async (ctx) => {
  const { page, bridge } = ctx;
  await dismissOverlays(page, 1000);

  // 1. 展开到表节点（j1 收尾后树已建连接；逐层展开幂等）
  await expandRow(await waitTreeRow(page, 'e2e-sqlite'));
  await expandRow(await waitTreeRow(page, 'main'));
  const zh = ctx.locale.startsWith('zh');
  await expandRow(await waitTreeRow(page, zh ? '表' : 'Tables'));
  const childRow = await waitTreeRow(page, 'e2e_fk_child');

  // 2. 左键选中（TreeItem.command 顺带打开该表表格页，无害）→ bridge 直呼命令（取树选中节点）
  await childRow.click();
  const executed = await bridge.execute('dbExplorer.erFocusTable');
  if (!executed.ok) {
    throw new Error(`erFocusTable 执行失败: ${executed.error}`);
  }

  // 3. ER 图 webview：邻接图两节点（中心表 + 被引用父表）
  const er = await findWebviewFrame(page, (b) => b.page === 'erDiagram');
  await er.locator('[role="group"][aria-label="e2e_fk_child"]').waitFor({ state: 'visible', timeout: 30_000 });
  await er.locator('[role="group"][aria-label="dbkit_e2e"]').waitFor({ state: 'visible', timeout: 15_000 });

  // 4. 中心表恒亮标识（邻接 scope focus）
  await er.locator('[role="group"][aria-label="e2e_fk_child"][data-focus="true"]').waitFor({
    state: 'visible',
    timeout: 10_000,
  });

  // 5. 边 tooltip 动作原文：边命中区是零高度水平线（SVG path 几何 bbox 不含 stroke，
  //    playwright 判 hidden 不可 waitFor visible/hover）——按 boundingBox 坐标直接 mouse.move
  //    （两段移动模拟真实指针进入，触发 pointerenter/pointermove）
  const edgeHit = er.locator('svg path[stroke="transparent"]').first();
  await edgeHit.waitFor({ state: 'attached', timeout: 10_000 });
  const box = await edgeHit.boundingBox();
  if (!box || box.width < 4) {
    throw new Error(`边命中区无几何: ${JSON.stringify(box)}`);
  }
  const cx = box.x + box.width / 2;
  const cy = box.y + Math.max(box.height / 2, 1);
  await page.mouse.move(cx - 8, cy + 8);
  await page.mouse.move(cx, cy);
  await er.getByText('ON DELETE CASCADE').first().waitFor({ state: 'visible', timeout: 10_000 });
};
