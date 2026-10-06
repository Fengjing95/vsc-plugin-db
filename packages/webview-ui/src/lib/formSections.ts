import type { FormFieldPayload } from '@db-explorer/protocol';

/**
 * 连接表单高级组分区推导（M8 表单方案 A 修订，交互稿 §3.1）：
 * - 同 `section` 的字段归为一个小节（保持 schema 首现顺序）
 * - 小节内被其它字段 `toggle` 引用的布尔字段 = 小节开关，渲染为标题行复选框，
 *   依赖字段仅在开关开启时显示（§3.2 行为不变：值仍随表单保存，只是隐藏不渲染）
 * - 无 section 的字段归入默认桶；仅一个默认桶时不渲染小节标题
 * 纯函数，有单测。
 */

export interface AdvancedSection {
  /** 小节标题；undefined = 默认桶（仅此一节时不显示标题文字） */
  title: string | undefined;
  /** 小节开关（布尔字段）：存在时渲染为标题行复选框，依赖字段随之显隐 */
  header?: FormFieldPayload;
  /** 非开关字段（渲染时按 isFieldVisible 过滤显隐） */
  fields: FormFieldPayload[];
}

export function groupAdvancedFields(fields: FormFieldPayload[]): AdvancedSection[] {
  const order: string[] = [];
  const buckets = new Map<string, FormFieldPayload[]>();
  for (const f of fields) {
    const key = f.section ?? '';
    if (!buckets.has(key)) {
      buckets.set(key, []);
      order.push(key);
    }
    buckets.get(key)!.push(f);
  }
  return order.map((key) => {
    const list = buckets.get(key)!;
    const toggleKeys = new Set(list.map((f) => f.toggle).filter((t): t is string => Boolean(t)));
    const header = list.find((f) => f.type === 'boolean' && toggleKeys.has(f.key));
    return {
      title: key || undefined,
      header,
      fields: list.filter((f) => f !== header),
    };
  });
}

/** 字段当前是否可见：无 toggle 恒可见；有 toggle 时依赖的布尔开关开启才可见 */
export function isFieldVisible(field: FormFieldPayload, options: Record<string, unknown>): boolean {
  if (!field.toggle) {
    return true;
  }
  return options[field.toggle] === true;
}
