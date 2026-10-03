import type { ColumnMeta } from '@db-explorer/core';

/**
 * 由表结构生成代码（概要设计 §6 #7 P1）：TS interface / Java POJO / Go struct / Prisma schema。
 * 纯函数层（列元数据 → 代码文本），VSCode 交互（QuickPick / 打开文档）在 commands.ts。
 */

export type CodegenLanguage = 'ts' | 'java' | 'go' | 'prisma';

export const CODEGEN_LANGUAGES: Array<{ label: string; value: CodegenLanguage; description: string }> = [
  { label: 'TypeScript interface', value: 'ts', description: '字段类型按值编码契约映射（DECIMAL=string）' },
  { label: 'Java POJO', value: 'java', description: '私有字段 + getter/setter' },
  { label: 'Go struct', value: 'go', description: 'json tag + 可空指针' },
  { label: 'Prisma schema', value: 'prisma', description: 'model 定义，PK/自增映射 @id' },
];

// ── 标识符处理 ────────────────────────────────────────────────

/** snake_case / kebab-case / 空分 → camelCase（Java 字段、TS 无操作保持原列名亦可读） */
function camelCase(name: string): string {
  const parts = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (parts.length === 0) {
    return name;
  }
  return parts
    .map((p, i) => (i === 0 ? p.toLowerCase() : p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()))
    .join('');
}

/** snake_case → PascalCase（Java 类名、Go 字段、Prisma model 名） */
function pascalCase(name: string): string {
  const parts = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join('');
}

/** Go 惯用 initialism：id→ID / url→URL 等（仅 genGo 使用） */
const GO_INITIALISMS = new Set(['id', 'url', 'api', 'http', 'https', 'ip', 'sql', 'uuid', 'json']);

function goFieldName(name: string): string {
  const pascal = pascalCase(name);
  const first = pascal.split(/(?=[A-Z])/)[0]?.toLowerCase() ?? '';
  return GO_INITIALISMS.has(first) ? first.toUpperCase() + pascal.slice(first.length) : pascal;
}

// ── 类型映射（normalizedType → 各语言；DECIMAL 语义按值编码契约 C-7）─────────

function tsTypeOf(c: ColumnMeta): string {
  switch (c.normalizedType) {
    case 'integer':
    case 'float':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'json':
      return 'unknown';
    default:
      // string / decimal（契约：字符串承载）/ date/time/datetime / binary(base64) / uuid / unknown
      return 'string';
  }
}

function javaTypeOf(c: ColumnMeta): string {
  switch (c.normalizedType) {
    case 'integer':
      return c.autoIncrement || /bigint|int8/i.test(c.dataType) ? 'Long' : 'Integer';
    case 'float':
      return /double/i.test(c.dataType) ? 'Double' : 'Float';
    case 'decimal':
      return 'BigDecimal';
    case 'boolean':
      return 'Boolean';
    case 'datetime':
    case 'date':
      return 'LocalDateTime';
    case 'time':
      return 'LocalTime';
    case 'json':
      return 'String'; // JSON 字符串承载，业务侧自行反序列化
    case 'binary':
      return 'byte[]';
    default:
      return 'String';
  }
}

function goTypeOf(c: ColumnMeta): string {
  const ptr = (t: string) => (c.nullable ? `*${t}` : t);
  switch (c.normalizedType) {
    case 'integer':
      return ptr(/bigint|int8/i.test(c.dataType) ? 'int64' : 'int32');
    case 'float':
      return ptr('float64');
    case 'decimal':
      return c.nullable ? '*string' : 'string'; // DECIMAL 按契约以字符串承载
    case 'boolean':
      return ptr('bool');
    case 'datetime':
    case 'date':
    case 'time':
      return ptr('time.Time');
    case 'json':
      return c.nullable ? 'map[string]any' : 'map[string]any'; // 对象承载（契约：json=已解析对象）
    case 'binary':
      return '[]byte';
    default:
      return ptr('string');
  }
}

function prismaTypeOf(c: ColumnMeta): string {
  switch (c.normalizedType) {
    case 'integer':
      return /bigint|int8/i.test(c.dataType) ? 'BigInt' : 'Int';
    case 'float':
      return 'Float';
    case 'decimal':
      return 'Decimal';
    case 'boolean':
      return 'Boolean';
    case 'datetime':
    case 'date':
    case 'time':
      return 'DateTime';
    case 'json':
      return 'Json';
    case 'binary':
      return 'Bytes';
    default:
      return 'String';
  }
}

// ── 各语言生成 ────────────────────────────────────────────────

function comment(prefix: string, c: ColumnMeta): string {
  const parts = [c.dataType];
  if (c.comment) {
    parts.push(c.comment);
  }
  return `${prefix} ${parts.join(' · ')}`;
}

function genTs(tableName: string, cols: ColumnMeta[]): string {
  const fields = cols
    .map((c) => {
      const doc = `  /** ${comment('', c).trim()} */`;
      return `${doc}\n  ${camelCase(c.name) || c.name}: ${tsTypeOf(c)};`;
    })
    .join('\n');
  return `interface ${pascalCase(tableName)} {\n${fields}\n}`;
}

function genJava(tableName: string, cols: ColumnMeta[]): string {
  const className = pascalCase(tableName);
  const fields = cols
    .map((c) => {
      const doc = c.comment ? `    /** ${c.comment} */\n` : '';
      return `${doc}    private ${javaTypeOf(c)} ${camelCase(c.name) || c.name}; // ${c.dataType}`;
    })
    .join('\n');
  const accessors = cols
    .map((c) => {
      const field = camelCase(c.name) || c.name;
      const Type = javaTypeOf(c);
      const cap = field.charAt(0).toUpperCase() + field.slice(1);
      return [
        `    public ${Type} get${cap}() { return ${field}; }`,
        `    public void set${cap}(${Type} ${field}) { this.${field} = ${field}; }`,
      ].join('\n');
    })
    .join('\n');
  return `public class ${className} {\n${fields}\n\n${accessors}\n}`;
}

function genGo(tableName: string, cols: ColumnMeta[]): string {
  const fields = cols
    .map((c) => {
      const doc = c.comment ? `\t// ${c.comment}\n` : '';
      return `${doc}\t${goFieldName(c.name)} ${goTypeOf(c)} \`json:"${c.name}${c.nullable ? ',omitempty' : ''}"\` // ${c.dataType}`;
    })
    .join('\n');
  return `type ${pascalCase(tableName)} struct {\n${fields}\n}`;
}

function genPrisma(tableName: string, cols: ColumnMeta[]): string {
  const fields = cols
    .map((c) => {
      const attrs: string[] = [];
      if (c.isPrimaryKey) {
        attrs.push('@id');
        if (c.autoIncrement) {
          attrs.push('@default(autoincrement())');
        }
      }
      if (!c.nullable && !c.isPrimaryKey) {
        attrs.push('');
      }
      const attr = attrs.filter(Boolean).length > 0 ? ` ${attrs.filter(Boolean).join(' ')}` : '';
      const q = c.nullable ? '?' : '';
      const cm = c.comment ? ` // ${c.comment}` : '';
      return `  ${camelCase(c.name) || c.name} ${prismaTypeOf(c)}${q}${attr} @map("${c.name}")${cm}`;
    })
    .join('\n');
  return `model ${pascalCase(tableName)} {\n${fields}\n}`;
}

export function generateCode(
  language: CodegenLanguage,
  tableName: string,
  columns: ColumnMeta[],
): string {
  switch (language) {
    case 'ts':
      return genTs(tableName, columns);
    case 'java':
      return genJava(tableName, columns);
    case 'go':
      return genGo(tableName, columns);
    case 'prisma':
      return genPrisma(tableName, columns);
  }
}

/** 语言 → 打开文档的 languageId */
export function codegenLanguageId(language: CodegenLanguage): string {
  switch (language) {
    case 'ts':
      return 'typescript';
    case 'java':
      return 'java';
    case 'go':
      return 'go';
    case 'prisma':
      return 'prisma'; // 未装 Prisma 扩展时退纯文本
  }
}
