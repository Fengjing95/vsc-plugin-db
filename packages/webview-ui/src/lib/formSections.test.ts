import { describe, expect, it } from 'vitest';
import type { FormFieldPayload } from '@db-explorer/protocol';
import { groupAdvancedFields, isFieldVisible } from './formSections';

function field(key: string, overrides: Partial<FormFieldPayload> = {}): FormFieldPayload {
  return { key, label: key, type: 'string', ...overrides };
}

describe('groupAdvancedFields（M8 表单高级分组）', () => {
  it('同 section 归一节，保持首现顺序；被 toggle 引用的布尔字段成为小节开关', () => {
    const sections = groupAdvancedFields([
      field('sshEnabled', { type: 'boolean', section: 'SSH 隧道' }),
      field('sshHost', { section: 'SSH 隧道', toggle: 'sshEnabled' }),
      field('sshPort', { type: 'number', section: 'SSH 隧道', toggle: 'sshEnabled' }),
      field('connectTimeout', { type: 'number', section: '超时' }),
    ]);
    expect(sections).toHaveLength(2);
    expect(sections[0].title).toBe('SSH 隧道');
    expect(sections[0].header?.key).toBe('sshEnabled');
    expect(sections[0].fields.map((f) => f.key)).toEqual(['sshHost', 'sshPort']);
    expect(sections[1]).toEqual({ title: '超时', header: undefined, fields: [expect.objectContaining({ key: 'connectTimeout' })] });
  });

  it('无 section 字段进默认桶（title undefined）', () => {
    const sections = groupAdvancedFields([field('readonly', { type: 'boolean' })]);
    expect(sections).toEqual([
      { title: undefined, header: undefined, fields: [expect.objectContaining({ key: 'readonly' })] },
    ]);
  });

  it('独立布尔小节（无依赖字段）不是 header，作为普通字段渲染', () => {
    const sections = groupAdvancedFields([field('ssl', { type: 'boolean', section: 'SSL' })]);
    expect(sections[0].header).toBeUndefined();
    expect(sections[0].fields).toHaveLength(1);
  });
});

describe('isFieldVisible', () => {
  it('无 toggle 恒可见；toggle 指向的开关开启才可见', () => {
    const options = { sshEnabled: true, ssl: false };
    expect(isFieldVisible(field('sshHost', { toggle: 'sshEnabled' }), options)).toBe(true);
    expect(isFieldVisible(field('sslInsecure', { toggle: 'ssl' }), options)).toBe(false);
    expect(isFieldVisible(field('connectTimeout'), options)).toBe(true);
  });
});
