import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 树菜单 when 子句 × contextValue 令牌匹配矩阵守卫（P-40 红线的程序化锁定）：
 * 树节点 contextValue 是多令牌空格串（如 `table ddl er`），任何「给既有令牌串追加后缀令牌」
 * 的改动都会让锚定 `==`/`=~` 失配（P-40 实机事故两轮）。本测试从 package.json 实况提取
 * view/item/context 的 when 子句，按 VSCode contextkey 的最小语义（`==` 精确相等、`=~ /…/`
 * JS 正则、`||` 或）对令牌形状矩阵断言——新增节点令牌或菜单时在此补矩阵行。
 *
 * 注：本求值器只覆盖本仓库 when 的语法子集（无 && / 比较 / config.* 等）——遇到未识别子句
 * 直接抛错（新语法必须先扩展求值器，防止静默假绿）。
 */

const pkgRoot = path.resolve(__dirname, '..');

interface MenuEntry {
  command: string;
  when?: string;
}

function loadMenus(): Record<string, MenuEntry[]> {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')) as {
    contributes: { menus: Record<string, MenuEntry[]> };
  };
  return pkg.contributes.menus;
}

function evalViewItemWhen(when: string, contextValue: string): boolean {
  return when.split(' || ').some((clause) => {
    const eq = clause.match(/^viewItem == (\S+)$/);
    if (eq) {
      return contextValue === eq[1];
    }
    const re = clause.match(/^viewItem =~ \/(.*)\/$/);
    if (re) {
      return new RegExp(re[1]).test(contextValue);
    }
    throw new Error(`when 子句语法超出求值器覆盖面，请先扩展求值器: "${clause}"（完整 when: ${when}）`);
  });
}

/** 每命令只取第一条 when（同命令多条 when 在 VSCode 语义为 OR——矩阵按各条独立断言时再拆行） */
function whenOf(menus: Record<string, MenuEntry[]>, command: string): string {
  const entries = (menus['view/item/context'] ?? []).filter((e) => e.command === command && e.when);
  expect(entries.length, `${command} 应有 when 子句`).toBeGreaterThan(0);
  return entries[0].when!;
}

describe('树菜单 when × contextValue 匹配矩阵（P-40 守卫）', () => {
  const menus = loadMenus();

  it('求值器覆盖面：全部 view/item/context when 都可解析', () => {
    for (const e of menus['view/item/context'] ?? []) {
      if (!e.when) continue;
      for (const clause of e.when.split(' || ')) {
        expect(
          /^viewItem == \S+$/.test(clause) || /^viewItem =~ \/.+\/$/.test(clause),
          `未识别子句: "${clause}"（命令 ${e.command}）`,
        ).toBe(true);
      }
    }
  });

  const matrix: Array<{ command: string; match: string[]; noMatch: string[] }> = [
    {
      // table/view/collection 通用打开入口（inline + 组内各一条，同 when）
      command: 'dbExplorer.openTable',
      match: ['table', 'table ddl', 'table er', 'table ddl er', 'view', 'view ddl', 'collection'],
      noMatch: ['database er', 'database ddl er', 'column ddl', 'folder-columns ddl', 'query', 'index'],
    },
    {
      command: 'dbExplorer.viewDdl',
      match: ['table', 'table ddl', 'table er', 'table ddl er', 'view', 'view ddl'],
      noMatch: ['collection', 'database ddl er'],
    },
    {
      command: 'dbExplorer.generateCode',
      match: ['table', 'table ddl', 'table er', 'table ddl er', 'view', 'view ddl'],
      noMatch: ['collection'],
    },
    {
      command: 'dbExplorer.generateSelect',
      match: ['table', 'table ddl', 'table er', 'table ddl er', 'view', 'view ddl'],
      noMatch: ['collection'],
    },
    {
      // 结构编辑只对具备 ddl 能力的 table（er 令牌追加不得破坏）
      command: 'dbExplorer.alterTable',
      match: ['table ddl', 'table ddl er'],
      noMatch: ['table', 'table er', 'view', 'view ddl'],
    },
    {
      command: 'dbExplorer.dropTable',
      match: ['table ddl', 'table ddl er'],
      noMatch: ['table', 'table er'],
    },
    {
      // D-28：邻接入口只在带 er 令牌的 table 节点（table/view 无 er 令牌不得出现）
      command: 'dbExplorer.erFocusTable',
      match: ['table er', 'table ddl er'],
      noMatch: ['table', 'table ddl', 'view', 'view ddl', 'collection', 'database er', 'database ddl er'],
    },
    {
      // D-22：database 节点 ER 图（令牌序 database [ddl] [dbddl] [dbddl-alter] [er] [cmp]）
      command: 'dbExplorer.showErDiagram',
      match: ['database er', 'database ddl er', 'database dbddl er', 'database ddl dbddl er', 'database ddl dbddl dbddl-alter er', 'database er cmp', 'database ddl dbddl dbddl-alter er cmp'],
      noMatch: ['database', 'database ddl', 'table er'],
    },
    {
      // D-29：表结构对比——只挂带 cmp 令牌的 database 节点（前缀+尾锚，redis/mongo 无入口）
      command: 'dbExplorer.compareSchemas',
      match: ['database cmp', 'database ddl cmp', 'database ddl dbddl dbddl-alter er cmp'],
      noMatch: ['database', 'database er', 'database ddl er', 'table er', 'table ddl er', 'collection', 'query'],
    },
    {
      // P-40 原始事故区：「编辑库」令牌串中间夹 dbddl 段
      command: 'dbExplorer.alterDatabase',
      match: ['database dbddl-alter er', 'database ddl dbddl-alter er', 'database ddl dbddl dbddl-alter er', 'database ddl dbddl dbddl-alter er cmp'],
      noMatch: ['database er', 'database ddl er', 'database dbddl er', 'table ddl er'],
    },
    {
      command: 'dbExplorer.createTable',
      match: ['database ddl er', 'database ddl dbddl er', 'database ddl dbddl dbddl-alter er', 'database ddl dbddl dbddl-alter er cmp', 'folder-table ddl'],
      noMatch: ['database', 'database er', 'table ddl er'],
    },
    {
      command: 'dbExplorer.dropDatabase',
      match: ['database ddl dbddl', 'database dbddl dbddl-alter er', 'database ddl dbddl er'],
      noMatch: ['database', 'database er', 'database ddl er'],
    },
    {
      command: 'dbExplorer.refreshNode',
      match: ['connection connected', 'connection connected readonly', 'database', 'database er', 'database ddl dbddl dbddl-alter er', 'database er cmp'],
      noMatch: ['connection disconnected'],
    },
  ];

  for (const { command, match, noMatch } of matrix) {
    it(`${command} 的 when 与令牌矩阵一致`, () => {
      const when = whenOf(menus, command);
      for (const cv of match) {
        expect(evalViewItemWhen(when, cv), `${command} when "${when}" 应匹配 "${cv}"`).toBe(true);
      }
      for (const cv of noMatch) {
        expect(evalViewItemWhen(when, cv), `${command} when "${when}" 不应匹配 "${cv}"`).toBe(false);
      }
    });
  }
});
