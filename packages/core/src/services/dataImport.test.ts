import { describe, expect, it } from 'vitest';
import {
  convertCell,
  convertRecord,
  type ColumnMapping,
  detectImportFormat,
  parseCsv,
  parseJsonRecords,
  sniffDelimiter,
  stripBom,
  suggestMapping,
  normalizeHeaders,
  ImportRowCountError,
  MAX_IMPORT_ROWS,
} from './dataImport';

describe('stripBom', () => {
  it('剥离 UTF-8 BOM', () => {
    expect(stripBom('\uFEFFid,name')).toBe('id,name');
  });
  it('无 BOM 原样', () => {
    expect(stripBom('id,name')).toBe('id,name');
  });
});

describe('sniffDelimiter', () => {
  it('逗号', () => {
    expect(sniffDelimiter('id,name,city\n1,a,b\n')).toBe(',');
  });
  it('分号', () => {
    expect(sniffDelimiter('id;name;city\n1;a;b\n')).toBe(';');
  });
  it('制表符', () => {
    expect(sniffDelimiter('id\tname\tcity\n1\ta\tb\n')).toBe('\t');
  });
  it('无分隔符回落逗号', () => {
    expect(sniffDelimiter('hello world\n')).toBe(',');
  });
});

describe('parseCsv（RFC 4180）', () => {
  it('基本解析 + 表头行', () => {
    expect(parseCsv('id,name\n1,alice\n2,bob\n')).toEqual([
      ['id', 'name'],
      ['1', 'alice'],
      ['2', 'bob'],
    ]);
  });
  it('CRLF 与 LF 行尾', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
  it('引号字段：含逗号/引号/换行', () => {
    const text = 'name,note\n"x, y","含""引号""文本"\n"多\n行",plain\n';
    expect(parseCsv(text)).toEqual([
      ['name', 'note'],
      ['x, y', '含"引号"文本'],
      ['多\n行', 'plain'],
    ]);
  });
  it('BOM 剥离', () => {
    expect(parseCsv('\uFEFFid\n1\n')[0]).toEqual(['id']);
  });
  it('尾部换行不产生空行；中间空行跳过', () => {
    expect(parseCsv('a,b\n1,2\n\n\n3,4\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
    ]);
  });
  it('短行保留空字段', () => {
    expect(parseCsv('a,b,c\n1,2\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', ''],
    ]);
  });
  it('字段值原样保留空串（NULL 语义由转换层决定）', () => {
    expect(parseCsv('a,b\n1,\n')).toEqual([
      ['a', 'b'],
      ['1', ''],
    ]);
  });
  it('未闭合引号抛结构错误（含行号）', () => {
    expect(() => parseCsv('a,b\n"未闭合\n')).toThrow();
    try {
      parseCsv('a,b\n1,2\n"未闭合\n');
    } catch (err) {
      expect((err as { row?: number }).row).toBe(3);
    }
  });
});

describe('detectImportFormat', () => {
  it('按扩展名', () => {
    expect(detectImportFormat('data.csv', '')).toBe('csv');
    expect(detectImportFormat('data.xlsx', '')).toBe('xlsx');
    expect(detectImportFormat('data.json', '[{"a":1}]')).toBe('json');
    expect(detectImportFormat('data.ndjson', '{"a":1}\n')).toBe('ndjson');
  });
  it('未知扩展名按内容判定', () => {
    expect(detectImportFormat('data.txt', '[{"a":1}]')).toBe('json');
    expect(detectImportFormat('data.txt', '{"a":1}\n{"b":2}\n')).toBe('ndjson');
    expect(detectImportFormat('data.txt', 'a,b\n1,2\n')).toBe('csv');
  });
});

describe('parseJsonRecords', () => {
  it('数组形态', () => {
    const r = parseJsonRecords('[{"id":1},{"id":2}]');
    expect(r.format).toBe('json');
    expect(r.records).toEqual([{ id: 1 }, { id: 2 }]);
    expect(r.rowErrors).toEqual([]);
  });
  it('NDJSON 形态（跳过空行）', () => {
    const r = parseJsonRecords('{"id":1}\n\n{"id":2}\n');
    expect(r.format).toBe('ndjson');
    expect(r.records).toEqual([{ id: 1 }, { id: 2 }]);
    expect(r.rowErrors).toEqual([]);
  });
  it('NDJSON 坏行进错行报告', () => {
    const r = parseJsonRecords('{"id":1}\nnot-json\n');
    expect(r.records).toEqual([{ id: 1 }]);
    expect(r.rowErrors).toHaveLength(1);
    expect(r.rowErrors[0].row).toBe(2);
  });
  it('数组形态整体非法抛错', () => {
    expect(() => parseJsonRecords('[{"a":1}')).toThrow();
  });
  it('数组元素非对象进错行报告', () => {
    const r = parseJsonRecords('[{"id":1}, 42]');
    expect(r.records).toEqual([{ id: 1 }]);
    expect(r.rowErrors).toHaveLength(1);
  });
});

describe('convertCell（C-7 值编码）', () => {
  const opts = { emptyAsNull: true };

  it('空字段默认 NULL', () => {
    expect(convertCell('', 'string', opts)).toEqual({ ok: true, value: null });
    expect(convertCell('', 'integer', opts)).toEqual({ ok: true, value: null });
  });
  it('开关关闭时空 = 空串（string 列）', () => {
    expect(convertCell('', 'string', { emptyAsNull: false })).toEqual({ ok: true, value: '' });
  });
  it('JSON null 恒为 NULL', () => {
    expect(convertCell(null, 'string', { emptyAsNull: false })).toEqual({ ok: true, value: null });
    expect(convertCell(undefined, 'string', opts)).toEqual({ ok: true, value: null });
  });
  it('integer：数字/数字串接受、非整 数拒绝', () => {
    expect(convertCell('42', 'integer', opts)).toEqual({ ok: true, value: 42 });
    expect(convertCell(42, 'integer', opts)).toEqual({ ok: true, value: 42 });
    expect(convertCell(3.5, 'integer', opts).ok).toBe(false);
    expect(convertCell('abc', 'integer', opts).ok).toBe(false);
    expect(convertCell(true, 'integer', opts)).toEqual({ ok: true, value: 1 });
  });
  it('decimal：字符串透传（C-7）、数字转字符串', () => {
    expect(convertCell('42.42', 'decimal', opts)).toEqual({ ok: true, value: '42.42' });
    expect(convertCell(42.42, 'decimal', opts)).toEqual({ ok: true, value: '42.42' });
    expect(convertCell('abc', 'decimal', opts).ok).toBe(false);
  });
  it('float：数字串转数字', () => {
    expect(convertCell('1.5', 'float', opts)).toEqual({ ok: true, value: 1.5 });
    expect(convertCell(2, 'float', opts)).toEqual({ ok: true, value: 2 });
    expect(convertCell('x', 'float', opts).ok).toBe(false);
  });
  it('boolean：true/false/1/0', () => {
    expect(convertCell('true', 'boolean', opts)).toEqual({ ok: true, value: true });
    expect(convertCell('FALSE', 'boolean', opts)).toEqual({ ok: true, value: false });
    expect(convertCell('1', 'boolean', opts)).toEqual({ ok: true, value: true });
    expect(convertCell(0, 'boolean', opts)).toEqual({ ok: true, value: false });
    expect(convertCell('yes', 'boolean', opts).ok).toBe(false);
  });
  it('date/time/datetime：文本透传', () => {
    expect(convertCell('2026-01-01', 'date', opts)).toEqual({ ok: true, value: '2026-01-01' });
    expect(convertCell('2026-01-01 00:00:00.000', 'datetime', opts)).toEqual({
      ok: true,
      value: '2026-01-01 00:00:00.000',
    });
    expect(convertCell('12:30:00', 'time', opts)).toEqual({ ok: true, value: '12:30:00' });
  });
  it('Date 对象（xlsx）按列类型格式化', () => {
    const d = new Date(2026, 0, 2, 3, 4, 5, 6);
    expect(convertCell(d, 'date', opts)).toEqual({ ok: true, value: '2026-01-02' });
    expect(convertCell(d, 'datetime', opts)).toEqual({ ok: true, value: '2026-01-02 03:04:05.006' });
    expect(convertCell(d, 'time', opts)).toEqual({ ok: true, value: '03:04:05' });
    expect(convertCell(d, 'string', opts).ok).toBe(false);
  });
  it('json：字符串尝试解析、对象透传、解析失败拒绝', () => {
    expect(convertCell('{"a":1}', 'json', opts)).toEqual({ ok: true, value: { a: 1 } });
    expect(convertCell({ a: 1 }, 'json', opts)).toEqual({ ok: true, value: { a: 1 } });
    expect(convertCell('[1,2]', 'json', opts)).toEqual({ ok: true, value: [1, 2] });
    expect(convertCell('not-json', 'json', opts).ok).toBe(false);
  });
  it('binary：base64 字符串透传、非字符串拒绝', () => {
    expect(convertCell('aGVsbG8=', 'binary', opts)).toEqual({ ok: true, value: 'aGVsbG8=' });
    expect(convertCell(123, 'binary', opts).ok).toBe(false);
  });
  it('uuid/string：透传', () => {
    expect(convertCell('abc', 'uuid', opts)).toEqual({ ok: true, value: 'abc' });
    expect(convertCell('文本', 'string', opts)).toEqual({ ok: true, value: '文本' });
  });
  it('unknown：原样透传', () => {
    expect(convertCell('raw', 'unknown', opts)).toEqual({ ok: true, value: 'raw' });
  });
});

describe('suggestMapping', () => {
  const tableColumns = [
    { name: 'id', type: 'integer' as const, isPrimaryKey: true, autoIncrement: true, nullable: false },
    { name: 'name', type: 'string' as const, isPrimaryKey: false, autoIncrement: false, nullable: false },
    { name: 'City', type: 'string' as const, isPrimaryKey: false, autoIncrement: false, nullable: true },
  ];

  it('按名精确对齐；autoIncrement 列忽略；大小写不敏感兜底', () => {
    const mapping = suggestMapping(['name', 'city', 'extra'], tableColumns);
    expect(mapping).toEqual([
      { fileColumn: 'name', tableColumn: 'name', type: 'string' },
      { fileColumn: 'city', tableColumn: 'City', type: 'string' },
      { fileColumn: 'extra', tableColumn: null, type: 'unknown' },
    ]);
  });
  it('文件列缺失表列不产生映射（表列留在未映射侧）', () => {
    const mapping = suggestMapping(['name'], tableColumns);
    expect(mapping).toHaveLength(1);
    expect(mapping[0].tableColumn).toBe('name');
  });
});

describe('convertRecord', () => {
  const mapping: ColumnMapping[] = [
    { fileColumn: 'id', tableColumn: 'id', type: 'integer' },
    { fileColumn: 'name', tableColumn: 'name', type: 'string' },
    { fileColumn: 'note', tableColumn: null, type: 'string' },
  ];

  it('按映射转换并忽略忽略列', () => {
    const r = convertRecord({ id: '1', name: 'alice', note: 'ignored' }, mapping, { emptyAsNull: true });
    expect(r).toEqual({ ok: true, values: { id: 1, name: 'alice' } });
  });
  it('类型不符行拒绝并给出列名与原因', () => {
    const r = convertRecord({ id: 'abc', name: 'alice' }, mapping, { emptyAsNull: true });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('id');
    }
  });
  it('JSON 记录缺键 → NULL', () => {
    const r = convertRecord({ id: '1' }, mapping, { emptyAsNull: true });
    expect(r).toEqual({ ok: true, values: { id: 1, name: null } });
  });
});

describe('normalizeHeaders', () => {
  it('空表头按序号兜底', () => {
    expect(normalizeHeaders(['id', '', 'note'])).toEqual(['id', 'col2', 'note']);
    expect(normalizeHeaders(['  ', 'x'])).toEqual(['col1', 'x']);
  });
  it('重名追加序号后缀', () => {
    expect(normalizeHeaders(['a', 'a', 'a'])).toEqual(['a', 'a.2', 'a.3']);
  });
  it('表头 trim', () => {
    expect(normalizeHeaders([' id ', 'name'])).toEqual(['id', 'name']);
  });
});

describe('MAX_IMPORT_ROWS', () => {
  it('上限为 5 万行（ADR D-32 定值）', () => {
    expect(MAX_IMPORT_ROWS).toBe(50_000);
  });
  it('ImportRowCountError 携带上限', () => {
    const err = new ImportRowCountError(MAX_IMPORT_ROWS, MAX_IMPORT_ROWS + 1);
    expect(err.limit).toBe(MAX_IMPORT_ROWS);
    expect(err.code).toBe('E_VALIDATION');
  });
});
