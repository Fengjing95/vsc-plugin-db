import { describe, expect, it } from 'vitest';
import { confirmTreeDdlInput } from './ddlText';

/** §6 确认规则（纯函数）：输入与表名完全匹配（trim 后）才放行 */
describe('confirmTreeDdlInput（M8-B2 删表/清空表确认）', () => {
  it('完全匹配（含 trim）放行', () => {
    expect(confirmTreeDdlInput('删除表', 'users', 'users')).toBe(true);
    expect(confirmTreeDdlInput('清空表', 'users', '  users  ')).toBe(true);
  });

  it('不匹配/取消（undefined）拒绝', () => {
    expect(confirmTreeDdlInput('删除表', 'users', 'users ')).toBe(true);
    expect(confirmTreeDdlInput('删除表', 'users', 'user')).toBe(false);
    expect(confirmTreeDdlInput('删除表', 'users', '')).toBe(false);
    expect(confirmTreeDdlInput('删除表', 'users', undefined)).toBe(false);
    expect(confirmTreeDdlInput('删除表', 'users', ' users; DROP TABLE t')).toBe(false);
  });

  it('仅接受合法动作名（防御性）', () => {
    expect(confirmTreeDdlInput('删除表' as const, 'users', 'users')).toBe(true);
    expect(confirmTreeDdlInput('清空表' as const, 'users', 'users')).toBe(true);
  });
});
