import { dismissOverlays, findWebviewFrame, waitTreeRow, expandRow } from '../cdp';
import type { JourneyFn } from './j1';

/**
 * 旅程④（J-ER，ER P2 / ADR D-28）：表节点右键「以该表为中心展开 ER 图」→ 邻接图渲染。
 * 断言面：① 树右键菜单按 er 能力令牌出现；② ER webview（page=erDiagram）画布渲染中心表
 * 与被引用父表两节点；③ 中心表带 data-focus 恒亮标识（邻接 scope）；④ 边 tooltip 携带
 * FK 动作原文 ON DELETE CASCADE（fixture 建表子句 → sqlite PRAGMA → KeyMeta → ErEdge 全链路）。
 * 依赖 j1 已建的 e2e-sqlite 连接（journeys 有序全跑）。
 */
export const journey4: JourneyFn = async (ctx) => {
  const { page, labels } = ctx;
  await dismissOverlays(page, 1000);

  // 1. 展开到表节点（j1 收尾后树已建连接；逐层展开幂等）
  await expandRow(await waitTreeRow(page, 'e2e-sqlite'));
  await expandRow(await waitTreeRow(page, 'main'));
  await expandRow(await waitTreeRow(page, labels.tables));
  const childRow = await waitTreeRow(page, 'e2e_fk_child');

  // 2. 右键表节点 → 上下文菜单「以该表为中心展开 ER 图」（er 令牌 + P-40 正则扩展的显隐面）
  await childRow.click({ button: 'right' });
  const menuItem = page
    .locator('.monaco-context-menu [role="menuitem"], .context-view .monaco-menu .action-label')
    .filter({ hasText: labels.erFocusTable })
    .first();
  await menuItem.waitFor({ state: 'visible', timeout: 15_000 });
  await menuItem.click();

  // 3. ER 图 webview：邻接图两节点（中心表 + 被引用父表）
  const er = await findWebviewFrame(page, (b) => b.page === 'erDiagram');
  await er.locator('[role="group"][aria-label="e2e_fk_child"]').waitFor({ state: 'visible', timeout: 30_000 });
  await er.locator('[role="group"][aria-label="dbkit_e2e"]').waitFor({ state: 'visible', timeout: 15_000 });

  // 4. 中心表恒亮标识（邻接 scope focus）
  await er.locator('[role="group"][aria-label="e2e_fk_child"][data-focus="true"]').waitFor({
    state: 'visible',
    timeout: 10_000,
  });

  // 5. 边 tooltip 动作原文：悬停边命中区（透明宽描边 path）→ tooltip 出现 ON DELETE CASCADE
  const edgeHit = er.locator('svg path[stroke="transparent"]').first();
  await edgeHit.waitFor({ state: 'visible', timeout: 10_000 });
  await edgeHit.hover();
  await er.getByText('ON DELETE CASCADE').first().waitFor({ state: 'visible', timeout: 10_000 });
};
