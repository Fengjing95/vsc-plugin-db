import { describe, expect, it } from 'vitest';
import {
  buildExplainPlanPrompt,
  buildExplainPrompt,
  buildFilterWherePrompt,
  buildFixPrompt,
  buildGeneratePrompt,
  extractSqlFromResponse,
  renderResultSetAsText,
  renderSchemaContext,
  sanitizeWhereFragment,
  type AiPromptContext,
} from './aiPrompt';

const ctx: AiPromptContext = {
  dialectId: 'mysql',
  tables: [
    { name: 'users', comment: '用户表' },
    { name: 'orders', comment: '订单表' },
  ],
  columns: [
    { table: 'users', name: 'id', comment: '主键' },
    { table: 'users', name: 'created_at' },
    { table: 'orders', name: 'user_id', comment: '下单用户' },
    { table: 'orders', name: 'amount' },
  ],
};

describe('renderSchemaContext', () => {
  it('渲染全部表与列（含注释）', () => {
    const text = renderSchemaContext(ctx);
    expect(text).toContain('users');
    expect(text).toContain('用户表');
    expect(text).toContain('created_at');
    expect(text).toContain('orders');
    expect(text).toContain('下单用户');
  });

  it('selectedTables 过滤：未选中表整体（含其列）不出现', () => {
    const text = renderSchemaContext(ctx, ['users']);
    expect(text).toContain('users');
    expect(text).toContain('主键');
    expect(text).not.toContain('orders');
    expect(text).not.toContain('下单用户');
  });

  it('选中不存在的表名按空表集处理', () => {
    const text = renderSchemaContext(ctx, ['nope']);
    expect(text).not.toContain('users');
  });

  it('空上下文给占位文案', () => {
    expect(renderSchemaContext({ tables: [], columns: [] })).toContain('未提供');
  });
});

describe('buildGeneratePrompt', () => {
  it('user 携带自然语言与表结构，system 注明方言与只输出 SQL', () => {
    const { system, user } = buildGeneratePrompt({ nl: '查询最近 30 天下单超过 3 次的用户', context: ctx });
    expect(system).toContain('MySQL');
    expect(system).toContain('只输出');
    expect(user).toContain('查询最近 30 天下单超过 3 次的用户');
    expect(user).toContain('users');
  });

  it('未绑定方言时 system 不含数据库名（生成通用 SQL）', () => {
    const { system } = buildGeneratePrompt({ nl: 'x', context: { tables: [], columns: [] } });
    expect(system).not.toContain('MySQL');
  });

  it('prompt 不含密钥/连接信息（结构性脱敏：输入形状只接受表结构）', () => {
    const { system, user } = buildGeneratePrompt({ nl: 'x', context: ctx });
    for (const text of [system, user]) {
      expect(text).not.toContain('password=');
      expect(text).not.toContain('sk-');
    }
  });
});

describe('buildExplainPrompt', () => {
  it('user 携带 SQL 全文与表结构，system 要求中文解释', () => {
    const { system, user } = buildExplainPrompt({ sql: 'SELECT * FROM users', context: ctx });
    expect(user).toContain('SELECT * FROM users');
    expect(user).toContain('users');
    expect(system).toContain('中文');
  });
});

// ── AI P2A 批次 A（交互稿 §15.7 转正）：筛选 / 计划解读 / 消毒 / 计划渲染 ──

describe('buildFilterWherePrompt（A1 自然语言筛选）', () => {
  it('system 只要 WHERE 表达式本身（无 WHERE 关键字/分号/围栏），user 携带单表结构与需求', () => {
    const single: AiPromptContext = { dialectId: 'mysql', tables: [ctx.tables[0]], columns: ctx.columns.filter((c) => c.table === 'users') };
    const { system, user } = buildFilterWherePrompt({ nl: '最近 7 天注册的用户', context: single });
    expect(system).toContain('WHERE 条件表达式本身');
    expect(system).toContain('不要 WHERE 关键字');
    expect(system).toContain('MySQL');
    expect(user).toContain('最近 7 天注册的用户');
    expect(user).toContain('users');
    expect(user).toContain('created_at');
    expect(user).not.toContain('orders'); // 单表上下文：不泄漏其他表结构
  });

  it('C-10 审计：prompt 不含密钥/连接信息', () => {
    const { system, user } = buildFilterWherePrompt({ nl: 'x', context: ctx });
    for (const text of [system, user]) {
      expect(text).not.toContain('password=');
      expect(text).not.toContain('sk-');
    }
  });
});

describe('buildExplainPlanPrompt（A2 执行计划解读）', () => {
  it('user 携带 SQL 与计划文本，system 要求解读访问路径与优化建议', () => {
    const { system, user } = buildExplainPlanPrompt({
      sql: 'EXPLAIN SELECT * FROM users',
      plan: 'id | select_type | table\n1 | SIMPLE | users',
      context: ctx,
    });
    expect(system).toContain('执行计划');
    expect(system).toContain('优化建议');
    expect(user).toContain('EXPLAIN SELECT * FROM users');
    expect(user).toContain('### 执行计划');
    expect(user).toContain('1 | SIMPLE | users');
  });

  it('C-10 审计：prompt 不含密钥/连接信息', () => {
    const { system, user } = buildExplainPlanPrompt({ sql: 'x', plan: 'y', context: ctx });
    for (const text of [system, user]) {
      expect(text).not.toContain('password=');
      expect(text).not.toContain('sk-');
    }
  });
});

describe('renderResultSetAsText（EXPLAIN 结果集 → 计划文本）', () => {
  it('管道分隔表：表头 + 行；NULL 显式标注', () => {
    const text = renderResultSetAsText({
      columns: [{ name: 'id' }, { name: 'key' }],
      rows: [
        [1, 'PRIMARY'],
        [2, null],
      ],
    });
    expect(text).toBe('id | key\n1 | PRIMARY\n2 | NULL');
  });

  it('行数 >200 截断并标注省略行数', () => {
    const rows = Array.from({ length: 250 }, (_, i) => [i]);
    const text = renderResultSetAsText({ columns: [{ name: 'n' }], rows });
    expect(text).toContain('其余 50 行省略');
    expect(text.split('\n').length).toBeLessThanOrEqual(203);
  });

  it('单元格 >120 字符截断；多空白折叠', () => {
    const long = 'x'.repeat(200);
    const text = renderResultSetAsText({ columns: [{ name: 'c' }], rows: [[long], ['a  \n b']] });
    expect(text).toContain(`${'x'.repeat(120)}…`);
    expect(text).toContain('a b');
  });
});

describe('sanitizeWhereFragment（A1 片段消毒，fail-closed）', () => {
  it('合法片段原样返回（trim）', () => {
    expect(sanitizeWhereFragment("  status = 'paid' AND amount > 100  ")).toBe("status = 'paid' AND amount > 100");
  });

  it('剥掉模型多带头的 WHERE 关键字（大小写不敏感）', () => {
    expect(sanitizeWhereFragment('WHERE id > 1')).toBe('id > 1');
    expect(sanitizeWhereFragment('where id > 1')).toBe('id > 1');
  });

  it('换行折叠为单空格（单行输入框契约，多行 AI 输出折行展示）', () => {
    expect(sanitizeWhereFragment("status = 'paid'\nAND amount > 100")).toBe("status = 'paid' AND amount > 100");
    expect(sanitizeWhereFragment("a = 1\r\n  AND b = 2\n  AND c = 3")).toBe('a = 1 AND b = 2 AND c = 3');
    expect(sanitizeWhereFragment('WHERE\n  id > 1')).toBe('id > 1');
  });

  it('分号（多语句注入面）→ E_VALIDATION', () => {
    expect(() => sanitizeWhereFragment('1=1; DROP TABLE users')).toThrowError(/分号/);
  });

  it('注释定界符 → E_VALIDATION', () => {
    expect(() => sanitizeWhereFragment('id > 1 -- x')).toThrowError(/注释/);
    expect(() => sanitizeWhereFragment('id > 1 /* x */')).toThrowError(/注释/);
  });

  it('空片段 → E_VALIDATION', () => {
    expect(() => sanitizeWhereFragment('   ')).toThrowError(/有效/);
    expect(() => sanitizeWhereFragment('WHERE ')).toThrowError(/有效/);
  });

  it('超长（>2000）→ E_VALIDATION', () => {
    expect(() => sanitizeWhereFragment(`id IN (${'1,'.repeat(1200)}1)`)).toThrowError(/超长/);
  });

  it('错误码为 E_VALIDATION（C-6 按 code 映射）', () => {
    try {
      sanitizeWhereFragment('a;b');
      expect.unreachable();
    } catch (err) {
      expect((err as { code?: string }).code).toBe('E_VALIDATION');
    }
  });
});

describe('buildFixPrompt', () => {
  it('user 携带原 SQL、错误码与消息', () => {
    const { user } = buildFixPrompt({
      sql: 'UPDATE users SET n = 1',
      code: 'E_SYNTAX',
      message: "Unknown column 'n'",
      context: ctx,
    });
    expect(user).toContain('UPDATE users SET n = 1');
    expect(user).toContain('E_SYNTAX');
    expect(user).toContain("Unknown column 'n'");
  });
});

describe('extractSqlFromResponse', () => {
  it('剥离 ```sql 围栏', () => {
    expect(extractSqlFromResponse('```sql\nSELECT 1\n```')).toBe('SELECT 1');
  });

  it('剥离无语言标注的围栏', () => {
    expect(extractSqlFromResponse('```\nSELECT 1;\n```')).toBe('SELECT 1;');
  });

  it('无围栏返回原文 trim', () => {
    expect(extractSqlFromResponse('  SELECT 1;  ')).toBe('SELECT 1;');
  });

  it('围栏外有说明文字时取第一个围栏', () => {
    expect(extractSqlFromResponse('好的：\n```sql\nSELECT 1\n```\n以上。')).toBe('SELECT 1');
  });

  it('空响应返回空串', () => {
    expect(extractSqlFromResponse('')).toBe('');
  });
});
