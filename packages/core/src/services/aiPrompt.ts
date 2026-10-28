/**
 * AI 辅助 prompt 组装（概要 §5.12 / D-24 / 交互稿 §15.6）：
 * C-10 延伸审计点——prompt 只由本模块的白名单形状（表 / 列 / 注释 + 任务参数）构成，
 * 密钥 / 密码 / 连接串 / 主机信息在类型上就进不来；单测断言输出不含此类内容。
 * 纯函数，无 I/O，方便单测与后续 provider 无关复用。
 */
import { DriverError } from '../driver/errors';

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

function systemRule(task: 'generate' | 'explain' | 'fix' | 'filter' | 'explainPlan', dialectId?: string): string {
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
  if (task === 'explainPlan') {
    return [
      '你是资深数据库工程师，负责解读数据库执行计划。',
      dialectLine,
      '用中文输出 Markdown：先一句话概括执行策略，再按计划步骤说明访问路径与连接顺序，指出潜在瓶颈（全表扫描、缺索引、排序/临时表溢出、行数估算偏差），最后给出可执行的优化建议（索引、语句改写）。',
      '计划文本按其原始形态解读，不臆造字段含义；不要执行任何 SQL。',
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
  if (task === 'filter') {
    return [
      '你是 SQL 条件构造助手，负责把自然语言筛选需求转成 WHERE 条件。',
      dialectLine,
      '只输出 WHERE 条件表达式本身：不要 WHERE 关键字、不要分号、不要注释、不要解释或 Markdown 代码围栏。',
      '只使用给定表的列；字符串值用单引号；NULL 比较用 IS NULL / IS NOT NULL；信息不足时输出对信息需求最少的合理条件。',
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

/** 自然语言筛选（AI P2A 批次 A1，交互稿 §15.7 转正）：单表列结构 + 需求 → WHERE 片段。
 *  只携带该表结构（§15.6 隐私边界：仅表结构、无数据行）；片段经 sanitizeWhereFragment 消毒后回填。 */
export function buildFilterWherePrompt(input: {
  nl: string;
  context: AiPromptContext;
}): { system: string; user: string } {
  return {
    system: systemRule('filter', input.context.dialectId),
    user: `${contextBlock(input.context)}\n\n### 筛选需求（自然语言）\n${input.nl}`,
  };
}

/** 执行计划解读（AI P2A 批次 A2，交互稿 §15.7 转正）：SQL + 计划文本 → 解读。
 *  计划为查询计划文本（非数据行，§15.6 不破）；schema 上下文同解释口径。 */
export function buildExplainPlanPrompt(input: {
  sql: string;
  plan: string;
  context: AiPromptContext;
  selectedTables?: string[];
}): { system: string; user: string } {
  return {
    system: systemRule('explainPlan', input.context.dialectId),
    user: `${contextBlock(input.context, input.selectedTables)}\n\n### 待解读的 SQL\n${input.sql}\n\n### 执行计划\n${input.plan}`,
  };
}

/** EXPLAIN 结果集 → 计划文本（AI P2A）：管道分隔表；行/单元格/总长三重截断防 prompt 失控。
 *  计划是元信息不是数据行（§15.6 隐私边界不破）。 */
export function renderResultSetAsText(input: {
  columns: Array<{ name: string }>;
  rows: unknown[][];
}): string {
  const MAX_ROWS = 200;
  const MAX_CELL = 120;
  const MAX_TOTAL = 8000;
  const cell = (v: unknown): string => {
    const s = v === null || v === undefined ? 'NULL' : String(v).replace(/\s+/g, ' ').trim();
    return s.length > MAX_CELL ? `${s.slice(0, MAX_CELL)}…` : s;
  };
  const header = input.columns.map((c) => cell(c.name)).join(' | ');
  const lines: string[] = [header];
  let dropped = 0;
  for (const row of input.rows) {
    if (lines.length > MAX_ROWS) {
      dropped += 1;
      continue;
    }
    lines.push(row.map((v) => cell(v)).join(' | '));
  }
  if (dropped > 0) {
    lines.push(`…（其余 ${dropped} 行省略）`);
  }
  const text = lines.join('\n');
  return text.length > MAX_TOTAL ? `${text.slice(0, MAX_TOTAL)}\n…（截断）` : text;
}

/** WHERE 片段消毒（AI P2A 批次 A1）：AI 产物进筛选栏前的 fail-closed 检查——
 *  禁分号/多语句、禁注释（行注释 `--` 与块注释定界符）、禁超长；剥掉模型多带头的 WHERE 关键字。
 *  合法性交给用户过目 + 驱动参数化下推（whereSql 为 C-10 例外通道，驱动规范 §4）。 */
export function sanitizeWhereFragment(fragment: string): string {
  let s = fragment.trim();
  const leadingWhere = /^where(?:\s+|$)/i.exec(s);
  if (leadingWhere) {
    s = s.slice(leadingWhere[0].length).trim();
  }
  if (!s) {
    throw new DriverError('E_VALIDATION', 'AI 未返回有效的筛选条件');
  }
  if (s.includes(';')) {
    throw new DriverError('E_VALIDATION', '筛选条件含分号（疑似多语句），已拒绝');
  }
  if (s.includes('--') || s.includes('/*') || s.includes('*/')) {
    throw new DriverError('E_VALIDATION', '筛选条件含注释，已拒绝');
  }
  if (s.length > 2000) {
    throw new DriverError('E_VALIDATION', '筛选条件超长（>2000 字符），已拒绝');
  }
  return s;
}

/** 模型响应 → 纯 SQL：剥 Markdown 代码围栏（取第一个围栏体），无围栏返回原文 trim */
export function extractSqlFromResponse(text: string): string {
  const fenced = /```[a-zA-Z]*\s*\n([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1] : text;
  return body.trim();
}
