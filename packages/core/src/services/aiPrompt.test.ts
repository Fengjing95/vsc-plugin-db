import { describe, expect, it } from 'vitest';
import {
  buildExplainPrompt,
  buildFixPrompt,
  buildGeneratePrompt,
  extractSqlFromResponse,
  renderSchemaContext,
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
