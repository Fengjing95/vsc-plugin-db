import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * package.json contributes 文案守卫（C-17 / D-25）：
 * ① 每个 %key% 占位必须在 package.nls.json（zh 默认）有对应词条；
 * ② package.nls.en.json 与 zh 键集完全一致（en 缺键 = en 用户看到中文）；
 * ③ 两份词典值均非空。
 */
const pkgRoot = path.resolve(__dirname, '..');

describe('package.nls 双语守卫', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')) as {
    contributes: unknown;
  };
  const zh = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.nls.json'), 'utf8')) as Record<string, string>;
  const en = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.nls.en.json'), 'utf8')) as Record<string, string>;

  it('package.json 中的每个 %key% 都在 zh 词典中', () => {
    const used = JSON.stringify(pkg.contributes).match(/%([^%]+)%/g) ?? [];
    expect(used.length).toBeGreaterThan(0);
    const missing = [...new Set(used.map((s) => s.slice(1, -1)))].filter((k) => !(k in zh));
    expect(missing).toEqual([]);
  });

  it('zh 词典无未消费的孤儿键（防漂移）', () => {
    const used = new Set((JSON.stringify(pkg.contributes).match(/%([^%]+)%/g) ?? []).map((s) => s.slice(1, -1)));
    const orphan = Object.keys(zh).filter((k) => !used.has(k));
    expect(orphan).toEqual([]);
  });

  it('en 词典与 zh 键集完全一致且值非空', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
    for (const [k, v] of Object.entries(en)) {
      expect(v.length, `en[${k}] 为空`).toBeGreaterThan(0);
    }
  });
});
