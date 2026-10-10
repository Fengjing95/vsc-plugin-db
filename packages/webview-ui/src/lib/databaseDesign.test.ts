import { describe, expect, it } from 'vitest';
import type { FormFieldPayload } from '@db-explorer/protocol';
import { initialFieldValues, specOf, validateFieldValues } from './databaseDesign';

/** 库级 DDL 弹窗纯函数（M8-DBDDL / D-19）：动态表单校验与 DatabaseSpec 收集 */

const fields: FormFieldPayload[] = [
  { key: 'name', label: '库名', type: 'string', required: true },
  {
    key: 'charset',
    label: '字符集',
    type: 'select',
    default: 'utf8mb4',
    options: [
      { label: 'utf8mb4', value: 'utf8mb4' },
      { label: 'utf8', value: 'utf8' },
    ],
  },
  { key: 'collation', label: '排序规则', type: 'select' },
  { key: 'port', label: '端口', type: 'number', validator: 'regex', validationRegex: '^\\d{4}$' },
];

describe('initialFieldValues', () => {
  it('default 字段取默认值，未设 default 的文本字段为空串', () => {
    const values = initialFieldValues(fields);
    expect(values.name).toBe('');
    expect(values.charset).toBe('utf8mb4');
    expect(values.collation).toBe('');
  });
});

describe('validateFieldValues', () => {
  it('required 缺失报错；number 非数字报错；regex 不匹配报错', () => {
    const errors = validateFieldValues(fields, { name: '', port: 'abc' });
    expect(errors.name).toContain('必填');
    expect(errors.port).toContain('需为数字');
  });

  it('全部合法 → 空错误', () => {
    const errors = validateFieldValues(fields, { name: 'mydb', port: '3306' });
    expect(Object.keys(errors)).toHaveLength(0);
  });

  it('非必填留空合法（跳过 number/regex 校验）', () => {
    const errors = validateFieldValues(fields, { name: 'mydb', port: '' });
    expect(Object.keys(errors)).toHaveLength(0);
  });

  it('驱动下发的非法 regex 不阻塞用户（跳过校验）', () => {
    const bad: FormFieldPayload[] = [
      { key: 'x', label: 'X', type: 'string', validator: 'regex', validationRegex: '(' },
    ];
    expect(Object.keys(validateFieldValues(bad, { x: 'anything' }))).toHaveLength(0);
  });
});

describe('specOf', () => {
  it('收集 name/charset/collation（空串归一为 undefined）；其余字段不进 spec', () => {
    const spec = specOf({ name: ' mydb ', charset: 'utf8', collation: '', port: '3306' });
    expect(spec).toEqual({ name: 'mydb', charset: 'utf8', collation: undefined });
  });

  it('name 缺失 → 空串（由校验层拦截，spec 收集不抛错）', () => {
    expect(specOf({}).name).toBe('');
  });
});
