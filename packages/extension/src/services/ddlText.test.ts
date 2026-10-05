import { describe, expect, it } from 'vitest';
import { confirmNameMatch } from './ddlText';

/** §6 确认规则（纯函数）：输入与名称完全匹配（trim 后）才放行 */
describe('confirmNameMatch（M8-B2 删表/删列确认）', () => {
  it('完全匹配（含 trim）放行', () => {
    expect(confirmNameMatch('users', 'users')).toBe(true);
    expect(confirmNameMatch('users', '  users  ')).toBe(true);
    expect(confirmNameMatch('email', 'email')).toBe(true); // 删除列同规则
  });

  it('不匹配/取消（undefined）拒绝', () => {
    expect(confirmNameMatch('users', 'user')).toBe(false);
    expect(confirmNameMatch('users', '')).toBe(false);
    expect(confirmNameMatch('users', undefined)).toBe(false);
    expect(confirmNameMatch('users', 'users; DROP TABLE t')).toBe(false);
  });
});
