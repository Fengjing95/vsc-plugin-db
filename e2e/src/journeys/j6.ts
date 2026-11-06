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
 * ③ apply null 清除 → 计数从 description 消失（行文本回到筛选前快照）、main 恢复显示。
 * 依赖 j1 已建的 e2e-sqlite 连接（journeys 有序全跑）。
 */
export const journey6: JourneyFn = async (ctx) => {
  const { page, bridge, labels } = ctx;
  await dismissOverlays(page, 1000);

  // 1. 展开连接（预热库列表缓存——description 计数走 peekDatabases，缓存未命中不显示计数），
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
  await waitRowText(page, 'e2e-sqlite', (t) => t.includes(labels.dbFiltered(1, 1)));
  await waitTreeRow(page, 'main');

  // 3. 失效收敛：混入幽灵库 → 命令层收敛回执 ['main']（连接态），树上 main 仍在、计数不变
  const converge = await bridge.execute('dbExplorer.filterDatabases', 'e2e-sqlite', ['main', 'ghost-db']);
  if (!converge.ok) {
    throw new Error(`filterDatabases(收敛) 执行失败: ${converge.error}`);
  }
  if (JSON.stringify(converge.result) !== JSON.stringify(['main'])) {
    throw new Error(`失效项未收敛: ${JSON.stringify(converge.result)}`);
  }
  await waitRowText(page, 'e2e-sqlite', (t) => t.includes(labels.dbFiltered(1, 1)));
  await waitTreeRow(page, 'main');

  // 4. 清除筛选（null）→ 计数消失（行文本与筛选前快照一致），main 恢复显示
  const clear = await bridge.execute('dbExplorer.filterDatabases', 'e2e-sqlite', null);
  if (!clear.ok) {
    throw new Error(`filterDatabases(清除) 执行失败: ${clear.error}`);
  }
  await waitRowText(page, 'e2e-sqlite', (t) => t === beforeText);
  await waitTreeRow(page, 'main');
};
