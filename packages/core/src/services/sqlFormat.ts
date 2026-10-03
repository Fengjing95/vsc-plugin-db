import { format as formatWithSqlFormatter, type FormatOptionsWithLanguage } from 'sql-formatter';

/**
 * SQL 格式化（概要设计 §5.5.2 P1「格式化：调用方言格式化」；选型 T-10/D-12：sql-formatter）。
 * 方言 id 来自 IConnection.dialect（驱动规范 §3 DialectInfo），未提供时退回标准 SQL。
 */

/** core/驱动方言 id → sql-formatter 语言；未知方言按标准 SQL 处理 */
const DIALECT_LANGUAGES: Record<string, FormatOptionsWithLanguage['language']> = {
  mysql: 'mysql',
  postgresql: 'postgresql',
  postgres: 'postgresql',
  transactsql: 'transactsql',
  mssql: 'transactsql',
  sqlite: 'sqlite',
  mariadb: 'mariadb',
  bigquery: 'bigquery',
};

export function formatSql(text: string, dialectId?: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return text;
  }
  const language = (dialectId && DIALECT_LANGUAGES[dialectId]) || 'sql';
  try {
    // keywordCase 显式大写（15.x 选项名，旧版为 keywordCasing）：Console 场景统一规范更可读；
    // identifierCase 保持默认 preserve，不改动用户标识符大小写
    return formatWithSqlFormatter(trimmed, { language, keywordCase: 'upper' });
  } catch {
    // 格式化是尽力而为的展示优化：解析失败（方言特性/未闭合字符串等）原样返回
    return text;
  }
}
