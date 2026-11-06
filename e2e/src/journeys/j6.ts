import type { Page } from 'playwright-core';
import { dismissOverlays, expandRow, treeRow, waitTreeRow } from '../cdp';
import type { JourneyFn } from './j1';

/** 轮询树行文本直到条件成立（计数上树/消失都是异步刷新，positive/negative 断言共用）；超时抛错 */
async function waitRowText(
  page: Page,
  rowText: string,
  predicate: (text: string) => boolean,
  timeoutMs = 15_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = (await treeRow(page, rowText).textContent().catch(() => '')) ?? '';
    if (predicate(last)) {
      return last;
    }
    await page.waitForTimeout(300);
  }
  throw new Error(`树行文本未达预期："${rowText}" 当前="${last}"`);
}

/**
 * 旅程⑥（J6，数据库列表筛选 / ADR D-33）：bridge 直呼 `dbExplorer.filterDatabases`
 * （第二参传 apply 数组/null 直存——P-82 口子：QuickPick 是原生控件 CDP 不可自动化，
 * 命令带 apply 参数是自动化专用通道，回执实际存储值）。断言面：
 * ① apply ['main'] → 连接节点 description 出现裸计数「1/1」（peekDatabases 缓存只读）；
 * ② apply 混入幽灵库 ['main','ghost-db'] → 命令层按服务端库列表收敛回执 ['main']（失效项不落存）；
 * ③ 全局刷新（清空元数据缓存）→ 根先于库列表重绘（计数暂缺）→ 列表拉回后元素级补刷带出「1/1」
 *    ——「连接之后再更新」缺口的回归锁（不补刷则计数缺席到下一次无关刷新）；
 * ④ 断开 → 计数消失（未连接不显示）；重连展开 → 计数回来；
 * ⑤ apply null 清除 → 计数从 description 消失（行文本回到筛选前快照）、main 恢复显示。
 * 依赖 j1 已建的 e2e-sqlite 连接（journeys 有序全跑）。
 */
export const journey6: JourneyFn = async (ctx) => {
  const { page, bridge, labels } = ctx;
  await dismissOverlays(page, 1000);
  const counter = labels.dbFiltered(1, 1);

  // 1. 展开连接（预热库列表缓存——description 计数走 peekDatabases，未拉回不显示计数），
  //    快照筛选前描述（清除后断言恢复一致）
  await expandRow(await waitTreeRow(page, 'e2e-sqlite'));
  await waitTreeRow(page, 'main');
  const beforeText = (await treeRow(page, 'e2e-sqlite').textContent().catch(() => '')) ?? '';

  // 2. 置筛选 ['main'] → 回执实际存储值 + description 裸计数上树 + main 仍可见
  const apply = await bridge.execute('dbExplorer.filterDatabases', 'e2e-sqlite', ['main']);
  if (!apply.ok) {
    throw new Error(`filterDatabases 执行失败: ${apply.error}`);
  }
  if (JSON.stringify(apply.result) !== JSON.stringify(['main'])) {
    throw new Error(`filterDatabases 回执异常: ${JSON.stringify(apply.result)}`);
  }
  await waitRowText(page, 'e2e-sqlite', (t) => t.includes(counter));
  await waitTreeRow(page, 'main');

  // 3. 失效收敛：混入幽灵库 → 命令层收敛回执 ['main']（连接态），树上 main 仍在、计数不变
  const converge = await bridge.execute('dbExplorer.filterDatabases', 'e2e-sqlite', ['main', 'ghost-db']);
  if (!converge.ok) {
    throw new Error(`filterDatabases(收敛) 执行失败: ${converge.error}`);
  }
  if (JSON.stringify(converge.result) !== JSON.stringify(['main'])) {
    throw new Error(`失效项未收敛: ${JSON.stringify(converge.result)}`);
  }
  await waitRowText(page, 'e2e-sqlite', (t) => t.includes(counter));
  await waitTreeRow(page, 'main');

  // 4. 收起连接 → 全局刷新（clearCacheAndRefresh：库列表缓存清空）→ 已连接但库列表未拉回：
  //    计数缺席（确定性——收起态不拉子级；先断言「消失」= 等刷新真正落地，正向断言直接轮询
  //    会被刷新前的旧 DOM 满足而假绿）→ 展开 → 库列表拉回后元素级补刷带出计数
  //   （「连接之后再更新」缺口的回归锁：不补刷则计数缺席到下一次无关刷新）
  const connRow = await waitTreeRow(page, 'e2e-sqlite');
  if ((await connRow.getAttribute('aria-expanded')) === 'true') {
    await connRow.locator('.monaco-tl-twistie').click();
  }
  const refreshed = await bridge.execute('dbExplorer.refresh');
  if (!refreshed.ok) {
    throw new Error(`refresh 执行失败: ${refreshed.error}`);
  }
  await waitRowText(page, 'e2e-sqlite', (t) => !t.includes(counter));
  await expandRow(await waitTreeRow(page, 'e2e-sqlite'));
  await waitTreeRow(page, 'main');
  await waitRowText(page, 'e2e-sqlite', (t) => t.includes(counter));

  // 5. 断开（选中连接行 → 命令无参回退树选中，P-82 口子）→ 计数消失；等过断开保护窗口
  //    （P-33，800ms 内展开不建连）→ 重连展开 → 计数回来
  await treeRow(page, 'e2e-sqlite').click();
  const disconnected = await bridge.execute('dbExplorer.disconnectConnection');
  if (!disconnected.ok) {
    throw new Error(`disconnectConnection 执行失败: ${disconnected.error}`);
  }
  await waitRowText(page, 'e2e-sqlite', (t) => !t.includes(counter));
  await page.waitForTimeout(1200);
  await expandRow(await waitTreeRow(page, 'e2e-sqlite'));
  await waitTreeRow(page, 'main');
  await waitRowText(page, 'e2e-sqlite', (t) => t.includes(counter));

  // 6. 清除筛选（null）→ 计数消失（行文本与筛选前快照一致），main 恢复显示
  const clear = await bridge.execute('dbExplorer.filterDatabases', 'e2e-sqlite', null);
  if (!clear.ok) {
    throw new Error(`filterDatabases(清除) 执行失败: ${clear.error}`);
  }
  await waitRowText(page, 'e2e-sqlite', (t) => t === beforeText);
  await waitTreeRow(page, 'main');
};
