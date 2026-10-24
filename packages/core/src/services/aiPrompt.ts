/**
 * AI 辅助 prompt 组装（概要 §5.12 / D-24 / 交互稿 §15.6）：
 * C-10 延伸审计点——prompt 只由本模块的白名单形状（表 / 列 / 注释 + 任务参数）构成，
 * 密钥 / 密码 / 连接串 / 主机信息在类型上就进不来；单测断言输出不含此类内容。
 * 纯函数，无 I/O，方便单测与后续 provider 无关复用。
 */

export interface AiPromptTable {
  name: string;
  comment?: string;
}

export interface AiPromptColumn {
  table: string;
  name: string;
  comment?: string;
}

export interface AiPromptContext {
  /** 绑定驱动的 id（mysql/postgresql/…；缺省 = 未绑定，生成通用 SQL） */
  dialectId?: string;
  tables: AiPromptTable[];
  columns: AiPromptColumn[];
}

/** 绑定库表数超过该值时先让用户圈选上下文表（交互稿 §15.2） */
export const AI_CONTEXT_TABLE_LIMIT = 50;

const DIALECT_NAMES: Record<string, string> = {
  mysql: 'MySQL',
  postgresql: 'PostgreSQL',
  postgres: 'PostgreSQL',
  mssql: 'SQL Server',
  oracle: 'Oracle Database',
  sqlite: 'SQLite',
};

export function dialectDisplayName(driverId?: string): string | undefined {
  return driverId ? DIALECT_NAMES[driverId] : undefined;
}

/** schema 摘要文本：表（含注释）+ 列清单；selectedTables 提供时按表过滤（列随表走） */
export function renderSchemaContext(ctx: AiPromptContext, selectedTables?: string[]): string {
  const tables = selectedTables ? ctx.tables.filter((t) => selectedTables.includes(t.name)) : ctx.tables;
  if (tables.length === 0) {
    return '（未提供表结构）';
  }
  const allowed = new Set(tables.map((t) => t.name));
  const byTable = new Map<string, AiPromptColumn[]>();
  for (const col of ctx.columns) {
    if (!allowed.has(col.table)) {
      continue;
    }
    const list = byTable.get(col.table) ?? [];
    list.push(col);
    byTable.set(col.table, list);
  }
  const lines: string[] = [];
  for (const t of tables) {
    lines.push(`表 ${t.name}${t.comment ? `：${t.comment}` : ''}`);
    for (const c of byTable.get(t.name) ?? []) {
      lines.push(`  - ${c.name}${c.comment ? `：${c.comment}` : ''}`);
    }
  }
  return lines.join('\n');
}

function systemRule(task: 'generate' | 'explain' | 'fix', dialectId?: string): string {
  const dialect = dialectDisplayName(dialectId);
  const dialectLine = dialect ? `目标数据库方言：${dialect}（只使用该方言支持的语法与函数）。` : '';
  if (task === 'explain') {
    return [
      '你是资深数据库工程师，负责向开发者解释 SQL。',
      dialectLine,
      '用中文输出 Markdown：先一句话说明语句意图，再逐子句解释，最后给出注意事项（索引、全表扫描、隐式转换等风险）。',
      '不要执行任何 SQL；表结构仅供参考。',
    ]
      .filter(Boolean)
      .join('\n');
  }
  if (task === 'fix') {
    return [
      '你是资深数据库工程师，负责修复报错的 SQL。',
      dialectLine,
      '只输出修复后的一条 SQL 语句本身：不要任何解释、注释或 Markdown 代码围栏。',
      '保持用户原有意图，只做让语句正确执行所需的最小修改。',
    ]
      .filter(Boolean)
      .join('\n');
  }
  return [
    '你是 SQL 生成助手。',
    dialectLine,
    '只输出一条 SQL 语句本身：不要任何解释、注释或 Markdown 代码围栏。',
    '只使用提供的表结构中存在的表与列；信息不足以生成时，输出对信息需求最少的合理语句。',
  ]
    .filter(Boolean)
    .join('\n');
}

function contextBlock(ctx: AiPromptContext, selectedTables?: string[]): string {
  return `### 可用表结构\n${renderSchemaContext(ctx, selectedTables)}`;
}

export function buildGeneratePrompt(input: {
  nl: string;
  context: AiPromptContext;
  selectedTables?: string[];
}): { system: string; user: string } {
  return {
    system: systemRule('generate', input.context.dialectId),
    user: `${contextBlock(input.context, input.selectedTables)}\n\n### 需求（自然语言）\n${input.nl}`,
  };
}

export function buildExplainPrompt(input: {
  sql: string;
  context: AiPromptContext;
  selectedTables?: string[];
}): { system: string; user: string } {
  return {
    system: systemRule('explain', input.context.dialectId),
    user: `${contextBlock(input.context, input.selectedTables)}\n\n### 待解释的 SQL\n${input.sql}`,
  };
}

export function buildFixPrompt(input: {
  sql: string;
  code: string;
  message: string;
  context: AiPromptContext;
  selectedTables?: string[];
}): { system: string; user: string } {
  return {
    system: systemRule('fix', input.context.dialectId),
    user: `${contextBlock(input.context, input.selectedTables)}\n\n### 报错的 SQL\n${input.sql}\n\n### 数据库返回的错误\n错误码：${input.code}\n错误消息：${input.message}`,
  };
}

/** 模型响应 → 纯 SQL：剥 Markdown 代码围栏（取第一个围栏体），无围栏返回原文 trim */
export function extractSqlFromResponse(text: string): string {
  const fenced = /```[a-zA-Z]*\s*\n([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1] : text;
  return body.trim();
}
