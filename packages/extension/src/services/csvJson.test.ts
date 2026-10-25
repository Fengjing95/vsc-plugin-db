import { describe, expect, it } from 'vitest';
import {
  csvEscapeField,
  csvRow,
  insertStatement,
  markdownHeader,
  markdownRow,
  ndjsonRow,
  safeFileName,
  sqlLiteral,
  toJsonObject,
} from './csvJson';

describe('csvEscapeField（RFC 4180）', () => {
  it('普通值原样输出', () => {
    expect(csvEscapeField('abc')).toBe('abc');
    expect(csvEscapeField(42)).toBe('42');
    expect(csvEscapeField(true)).toBe('true');
  });

  it('NULL → 空串（与空串在 CSV 中不可区分，属格式固有限制）', () => {
    expect(csvEscapeField(null)).toBe('');
    expect(csvEscapeField(undefined)).toBe('');
  });

  it('含逗号/引号/换行加引号，引号翻倍', () => {
    expect(csvEscapeField('a,b')).toBe('"a,b"');
    expect(csvEscapeField('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscapeField('line1\nline2')).toBe('"line1\nline2"');
  });

  it('JSON 对象序列化为原文（含引号时按 RFC 4180 转义）', () => {
    expect(csvEscapeField({ a: 1 })).toBe('"{""a"":1}"');
  });
});

describe('csvRow', () => {
  it('行以 CRLF 结尾', () => {
    expect(csvRow([1, 'a', null])).toBe('1,a,\r\n');
  });
});

describe('toJsonObject', () => {
  it('行式数组映射为列名对象', () => {
    expect(toJsonObject(['id', 'name'], [1, '张三'])).toEqual({ id: 1, name: '张三' });
    expect(toJsonObject(['id'], [undefined])).toEqual({ id: null });
  });
});

describe('safeFileName', () => {
  it('替换文件系统非法字符', () => {
    expect(safeFileName('a/b<c>d')).toBe('a_b_c_d');
    expect(safeFileName('users')).toBe('users');
  });
});

describe('ndjsonRow（NDJSON：每行一个独立 JSON 对象，任意前缀均合法）', () => {
  it('单行 JSON + LF 结尾', () => {
    expect(ndjsonRow(['id', 'name'], [1, '张三'])).toBe('{"id":1,"name":"张三"}\n');
  });
  it('json 列解析对象原样保留；缺列归一 null（C-7）', () => {
    expect(ndjsonRow(['id', 'info'], [1, { k: 1 }])).toBe('{"id":1,"info":{"k":1}}\n');
    expect(ndjsonRow(['id'], [undefined])).toBe('{"id":null}\n');
  });
});

describe('markdownHeader / markdownRow（Markdown 表格）', () => {
  it('表头 + 分隔行一次成文', () => {
    expect(markdownHeader(['id', 'name'])).toBe('| id | name |\n| --- | --- |\n');
  });
  it('NULL 显式标注；管道与换行转义', () => {
    expect(markdownRow([1, 'a|b'])).toBe('| 1 | a\\|b |\n');
    expect(markdownRow([null, 'x\ny'])).toBe('| NULL | x y |\n');
  });
  it('JSON 对象序列化为原文（不是 [object Object]，P-53 同族）', () => {
    expect(markdownRow([{ k: 1 }])).toBe('| {"k":1} |\n');
  });
});

describe('sqlLiteral（INSERT 导出值字面量，MySQL 方言）', () => {
  it('NULL / 数字 / 布尔 / 字符串（单引号翻倍）/ 空串严格区分', () => {
    expect(sqlLiteral(null)).toBe('NULL');
    expect(sqlLiteral(undefined)).toBe('NULL');
    expect(sqlLiteral(42)).toBe('42');
    expect(sqlLiteral(true)).toBe('TRUE');
    expect(sqlLiteral(false)).toBe('FALSE');
    expect(sqlLiteral("it's")).toBe(`'it''s'`);
    expect(sqlLiteral('')).toBe(`''`);
  });
  it('JSON 对象 → JSON 文本字面量（对象不落 [object Object]，P-53 同族）', () => {
    expect(sqlLiteral({ k: 1, s: "x'y" })).toBe(`'{"k":1,"s":"x''y"}'`);
    expect(sqlLiteral([1, 2])).toBe(`'[1,2]'`);
  });
});

describe('insertStatement（SQL INSERT 导出：批一条完整语句）', () => {
  it('限定库名表名 + 列反引号 + 值字面量 + 分号结尾', () => {
    expect(insertStatement('mydb', 'users', ['id', 'name'], [[1, "it's"]])).toBe(
      'INSERT INTO `mydb`.`users` (`id`, `name`) VALUES\n  (1, \'it\'\'s\');\n',
    );
  });
  it('多行为一条多值语句', () => {
    expect(insertStatement('d', 't', ['a'], [[1], [2]])).toBe(
      'INSERT INTO `d`.`t` (`a`) VALUES\n  (1),\n  (2);\n',
    );
  });
  it('标识符反引号翻倍转义', () => {
    expect(insertStatement('d`x', 't`y', ['c`1'], [[1]])).toBe(
      'INSERT INTO `d``x`.`t``y` (`c``1`) VALUES\n  (1);\n',
    );
  });
  it('空批返回空串（不写语句头）', () => {
    expect(insertStatement('d', 't', ['a'], [])).toBe('');
  });
});
