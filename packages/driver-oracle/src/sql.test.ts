import { describe, expect, it } from 'vitest';
import {
  buildConnectString,
  buildSelect,
  buildFetchInfo,
  encodeCell,
  formatLocalDateTime,
  formatOracleDataType,
  normalizeOracleType,
  oracleDbTypeToNormalized,
  parseLocalDate,
  quoteOracleIdentifier,
  stripOracleColumnDefault,
  toNativeParam,
} from './sql';

describe('quoteOracleIdentifier（双引号 + "" 翻倍转义）', () => {
  it('普通与内嵌双引号', () => {
    expect(quoteOracleIdentifier('users')).toBe('"users"');
    expect(quoteOracleIdentifier('a"b')).toBe('"a""b"');
  });
});

describe('buildConnectString（描述符组装 + 注入防护，ADR D-23 岔口 2）', () => {
  it('缺省组装完整描述符（CONNECT_TIMEOUT 死线 + SERVICE_NAME）', () => {
    const s = buildConnectString({ host: '10.0.0.1', port: 1521, serviceName: 'orcl', connectTimeoutMs: 15000 });
    expect(s).toContain('(HOST=10.0.0.1)');
    expect(s).toContain('(PORT=1521)');
    expect(s).toContain('(SERVICE_NAME=orcl)');
    expect(s).toContain('(CONNECT_TIMEOUT=15)');
    expect(s).toContain('(RETRY_COUNT=1)');
  });

  it('显式 connectString 原样透传（EZConnect/完整描述符/tnsalias）', () => {
    expect(buildConnectString({ connectString: 'host:1521/ORCLCDB' })).toBe('host:1521/ORCLCDB');
    expect(buildConnectString({ connectString: '(DESCRIPTION=…)' })).toBe('(DESCRIPTION=…)');
  });

  it('描述符参数注入 fail-closed（括号逃逸路径拒绝）', () => {
    // host 带 ")" 可注入额外描述符参数——字符集校验直接 E_VALIDATION
    expect(() => buildConnectString({ host: 'x)(SID=y', port: 1521, serviceName: 's' })).toThrow();
  });

  it('缺主机/服务名/端口非法 → E_VALIDATION', () => {
    expect(() => buildConnectString({ port: 1521, serviceName: 's' })).toThrow();
    expect(() => buildConnectString({ host: 'h', port: 1521 })).toThrow();
    expect(() => buildConnectString({ host: 'h', port: 0, serviceName: 's' })).toThrow();
  });
});

describe('buildSelect（:N 位置占位 + OFFSET/FETCH + 下推，P-9/P-10）', () => {
  const base = { db: 'DBKIT', obj: 'cf_users', searchColumns: [], limit: 10 };

  it('无筛选：ORDER BY 1 + OFFSET 0（FETCH 必须带 ORDER BY）', () => {
    const { sql, params } = buildSelect({ ...base });
    expect(sql).toBe('SELECT * FROM "DBKIT"."cf_users" ORDER BY 1 OFFSET 0 ROWS FETCH NEXT :1 ROWS ONLY');
    expect(params).toEqual([10]);
  });

  it('结构化筛选全操作符参数化（无值拼接）', () => {
    const { sql, params } = buildSelect({
      ...base,
      filters: [
        { column: 'name', op: 'eq', value: 'x' },
        { column: 'age', op: 'gt', value: 18 },
        { column: 'email', op: 'like', value: '%a_b' },
        { column: 'status', op: 'in', values: ['a', 'b'] },
        { column: 'note', op: 'isNull' },
        { column: 'n', op: 'between', values: [1, 9] },
      ],
      sorts: [{ column: 'id', dir: 'desc' }],
      offset: 20,
    });
    expect(sql).toContain('"name" = :1');
    expect(sql).toContain('"age" > :2');
    expect(sql).toContain(`"email" LIKE :3 ESCAPE '\\'`);
    expect(sql).toContain('"status" IN (:4, :5)');
    expect(sql).toContain('"note" IS NULL');
    expect(sql).toContain('"n" BETWEEN :6 AND :7');
    expect(sql).toContain('ORDER BY "id" DESC');
    expect(sql).toContain('OFFSET :8 ROWS FETCH NEXT :9 ROWS ONLY');
    expect(params).toEqual(['x', 18, '%\\%a\\_b%', 'a', 'b', 1, 9, 20, 10]);
  });

  it('eq 传空串按原样绑定（Oracle 引擎把空串折叠为 NULL，驱动不做改写——D-23 岔口 4）', () => {
    const { params } = buildSelect({ ...base, filters: [{ column: 'name', op: 'eq', value: '' }] });
    expect(params[0]).toBe('');
  });

  it('whereSql 括号包裹保持 AND 语义；orderBySql 追加在 sorts 后', () => {
    const { sql } = buildSelect({
      ...base,
      filters: [{ column: 'a', op: 'eq', value: 1 }],
      sorts: [{ column: 'id', dir: 'asc' }],
      whereSql: "b = 'x' OR c = 'y'",
      orderBySql: 'created DESC',
    });
    expect(sql).toContain("AND (b = 'x' OR c = 'y')");
    expect(sql).toContain('ORDER BY "id" ASC, created DESC');
  });

  it('search 走 string 列 LIKE OR 群（大小写敏感子串语义）', () => {
    const { sql, params } = buildSelect({ ...base, search: '50%', searchColumns: ['name', 'email'] });
    expect(sql).toContain(`"name" LIKE :1 ESCAPE '\\' OR "email" LIKE :2 ESCAPE '\\'`);
    expect(params).toEqual(['%50\\%%', '%50\\%%', 10]);
  });

  it('empty IN → 恒假 1=0；notIn 空集不产生条件', () => {
    const a = buildSelect({ ...base, filters: [{ column: 's', op: 'in', values: [] }] });
    expect(a.sql).toContain('1 = 0');
    const b = buildSelect({ ...base, filters: [{ column: 's', op: 'notIn', values: [] }] });
    expect(b.sql).not.toContain('NOT IN');
  });
});

describe('类型归一与元数据整形', () => {
  it('formatOracleDataType：NUMBER/VARCHAR2/TIMESTAMP 族按元数据组装', () => {
    expect(formatOracleDataType({ dataType: 'NUMBER', precision: null, scale: null, charLength: null, charUsed: null })).toBe('NUMBER');
    expect(formatOracleDataType({ dataType: 'NUMBER', precision: 9, scale: 0, charLength: null, charUsed: null })).toBe('NUMBER(9)');
    expect(formatOracleDataType({ dataType: 'NUMBER', precision: 12, scale: 2, charLength: null, charUsed: null })).toBe('NUMBER(12, 2)');
    expect(formatOracleDataType({ dataType: 'VARCHAR2', precision: null, scale: null, charLength: 64, charUsed: 'C' })).toBe('VARCHAR2(64 CHAR)');
    expect(formatOracleDataType({ dataType: 'VARCHAR2', precision: null, scale: null, charLength: 64, charUsed: 'B' })).toBe('VARCHAR2(64)');
    expect(formatOracleDataType({ dataType: 'RAW', precision: null, scale: null, charLength: 16, charUsed: 'B' })).toBe('RAW(16)');
    expect(formatOracleDataType({ dataType: 'TIMESTAMP', precision: null, scale: 3, charLength: null, charUsed: null })).toBe('TIMESTAMP(3)');
    expect(formatOracleDataType({ dataType: 'TIMESTAMP', precision: null, scale: 6, charLength: null, charUsed: null })).toBe('TIMESTAMP');
    expect(formatOracleDataType({ dataType: 'CLOB', precision: null, scale: null, charLength: null, charUsed: null })).toBe('CLOB');
  });

  it('normalizeOracleType：NUMBER(p,0)→integer、NUMBER(p,s)/NUMBER→decimal、日期族→datetime', () => {
    expect(normalizeOracleType('NUMBER(9)')).toBe('integer');
    expect(normalizeOracleType('NUMBER(12, 2)')).toBe('decimal');
    expect(normalizeOracleType('NUMBER')).toBe('decimal');
    expect(normalizeOracleType('BINARY_DOUBLE')).toBe('float');
    expect(normalizeOracleType('DATE')).toBe('datetime');
    expect(normalizeOracleType('TIMESTAMP(3)')).toBe('datetime');
    expect(normalizeOracleType('TIMESTAMP WITH TIME ZONE')).toBe('datetime');
    expect(normalizeOracleType('VARCHAR2(64 CHAR)')).toBe('string');
    expect(normalizeOracleType('CLOB')).toBe('string');
    expect(normalizeOracleType('RAW(16)')).toBe('binary');
    expect(normalizeOracleType('BLOB')).toBe('binary');
    expect(normalizeOracleType('ROWID')).toBe('string');
    expect(normalizeOracleType('XMLTYPE')).toBe('unknown');
  });

  it('oracleDbTypeToNormalized（query 路径 metaData 映射）', () => {
    expect(oracleDbTypeToNormalized('NUMBER')).toBe('integer');
    expect(oracleDbTypeToNormalized('VARCHAR2')).toBe('string');
    expect(oracleDbTypeToNormalized('DATE')).toBe('datetime');
    expect(oracleDbTypeToNormalized('BLOB')).toBe('binary');
    expect(oracleDbTypeToNormalized(undefined)).toBe('unknown');
  });
});

describe('Date ↔ §5 文本（本地组件对称，ADR D-23 时区口径）', () => {
  it('formatLocalDateTime 输出 YYYY-MM-DD HH:mm:ss.SSS', () => {
    const d = parseLocalDate('2024-06-01 08:30:00.123', 'datetime')!;
    expect(formatLocalDateTime(d)).toBe('2024-06-01 08:30:00.123');
  });

  it('parseLocalDate 支持缺省秒/毫秒与 date-only', () => {
    expect(formatLocalDateTime(parseLocalDate('2024-06-01 08:30', 'datetime')!)).toBe('2024-06-01 08:30:00.000');
    expect(parseLocalDate('2024-06-01', 'date')!.getMonth()).toBe(5);
    expect(parseLocalDate('bad', 'datetime')).toBeNull();
  });

  it('encodeCell：Buffer→base64、Date→datetime 文本、整数整形', () => {
    expect(encodeCell(Buffer.from([0xde, 0xad]), 'binary')).toBe('3q0=');
    const d = parseLocalDate('2024-06-01 08:30:00.000', 'datetime')!;
    expect(encodeCell(d, 'datetime')).toBe('2024-06-01 08:30:00.000');
    expect(encodeCell('9007199254740993', 'integer')).toBe('9007199254740993'); // 超限保 string
    expect(encodeCell('42', 'integer')).toBe(42);
    expect(encodeCell('12.34', 'decimal')).toBe('12.34');
    expect(encodeCell(null, 'string')).toBeNull();
  });
});

describe('toNativeParam（§5 编辑回传 → 原生绑定）', () => {
  const types = new Map<string, ReturnType<typeof normalizeOracleType>>([
    ['id', 'integer'],
    ['amount', 'decimal'],
    ['created', 'datetime'],
    ['avatar', 'binary'],
    ['note', 'string'],
  ]);

  it('datetime 文本 → Date（本地组件）；binary base64 → Buffer；整数整形', () => {
    const d = toNativeParam('created', '2024-06-01 08:30:00.123', types) as Date;
    expect(d).toBeInstanceOf(Date);
    expect(formatLocalDateTime(d)).toBe('2024-06-01 08:30:00.123');
    expect((toNativeParam('avatar', 'AAEC/w==', types) as Buffer).toString('base64')).toBe('AAEC/w==');
    expect(toNativeParam('id', '42', types)).toBe(42);
    expect(toNativeParam('amount', '12345.67', types)).toBe('12345.67');
  });

  it('对象/数组 → JSON 文本（P-53 同族收口）；null 透传', () => {
    expect(toNativeParam('note', { k: 1 }, types)).toBe('{"k":1}');
    expect(toNativeParam('note', null, types)).toBeNull();
  });
});

describe('stripOracleColumnDefault（data_default 去引号 roundtrip，P-49 同族）', () => {
  it("字符串去引号（'' 翻倍还原）、数值/函数原样、NULL 缺省", () => {
    expect(stripOracleColumnDefault("'anon'")).toBe('anon');
    expect(stripOracleColumnDefault("'it''s'")).toBe("it's");
    expect(stripOracleColumnDefault('42')).toBe('42');
    expect(stripOracleColumnDefault('SYSDATE')).toBe('SYSDATE');
    expect(stripOracleColumnDefault(null)).toBeUndefined();
    expect(stripOracleColumnDefault(undefined)).toBeUndefined();
  });
});

describe('buildFetchInfo（thin 按列取回整形，ADR D-23 岔口 6）', () => {
  it('NUMBER→STRING、CLOB→STRING、BLOB→BUFFER、其余不进 fetchInfo', () => {
    const info = buildFetchInfo(
      [
        { name: 'ID', dataType: 'NUMBER(9)' },
        { name: 'NOTE', dataType: 'CLOB' },
        { name: 'AVATAR', dataType: 'BLOB' },
        { name: 'NAME', dataType: 'VARCHAR2(64 CHAR)' },
        { name: 'CREATED', dataType: 'DATE' },
      ],
      { STRING: 'S', BUFFER: 'B' },
    );
    expect(info).toEqual({ ID: { type: 'S' }, NOTE: { type: 'S' }, AVATAR: { type: 'B' } });
  });
});

