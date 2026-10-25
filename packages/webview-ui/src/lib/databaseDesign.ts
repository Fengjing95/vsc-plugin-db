import type { DatabaseSpecPayload, FormFieldPayload } from '@db-explorer/protocol';
import { formText, t } from './i18n';

/**
 * 库级 DDL 弹窗纯函数（M8-DBDDL，概要 D-19 / 交互稿 §8.3）：
 * 动态表单校验与 DatabaseSpec 收集。字段渲染子集：string/number/boolean/select
 * （password/file/textarea 为连接表单场景字段，建库表单不涉及——驱动自定义 schema 仍可下发，
 * 未支持的类型按 string 输入框兜底渲染）。
 */

/** 表单默认值（default 字段 → 初始 values；未设 default 的 required 字段为空串） */
export function initialFieldValues(fields: FormFieldPayload[]): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const f of fields) {
    values[f.key] = f.default ?? (f.type === 'boolean' ? false : '');
  }
  return values;
}

/** 逐字段校验（required → number → regex validator）；返回 key → 错误文案（空对象 = 通过）。
 *  label 经 formText 解析（驱动下发域键 → 翻译；自由文本/单测桩原文 → 原样） */
export function validateFieldValues(
  fields: FormFieldPayload[],
  values: Record<string, unknown>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const label = formText(f.label);
    const raw = values[f.key];
    const text = raw === null || raw === undefined ? '' : String(raw);
    if (f.required && text.trim() === '') {
      errors[f.key] = t('dbddl.errRequired', [label]);
      continue;
    }
    if (text === '') {
      continue; // 非必填留空合法
    }
    if (f.type === 'number' && !Number.isFinite(Number(text))) {
      errors[f.key] = t('dbddl.errNumber', [label]);
      continue;
    }
    if (f.validator === 'regex' && f.validationRegex) {
      try {
        if (!new RegExp(f.validationRegex).test(text)) {
          errors[f.key] = t('dbddl.errFormat', [label]);
        }
      } catch {
        // 驱动下发的 regex 非法：跳过该校验（不阻塞用户）
      }
    }
  }
  return errors;
}

/** values → DatabaseSpec（name/charset/collation/collection 之外的字段为驱动私有展示项，不进 spec） */
export function specOf(values: Record<string, unknown>): DatabaseSpecPayload {
  const pick = (key: string): string | undefined => {
    const v = values[key];
    const text = v === null || v === undefined ? '' : String(v).trim();
    return text === '' ? undefined : text;
  };
  return {
    name: pick('name') ?? '',
    charset: pick('charset'),
    collation: pick('collation'),
    collection: pick('collection'),
  };
}
