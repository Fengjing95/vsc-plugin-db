import { describe, expect, it } from 'vitest';
import { MONGO_COMPLETION_SNIPPETS, MONGO_FUNCTIONS, MONGO_KEYWORDS, mongoCompletionSource } from './completion';

/** 命令域全量词表（C-14 / 驱动规范 §3.2：keywords > 50、functions > 20 量级达标） */

describe('mongo 补全词表（C-14 命令域）', () => {
  it('词表规模达标且无重复', () => {
    expect(MONGO_KEYWORDS.length).toBeGreaterThan(50);
    expect(new Set(MONGO_KEYWORDS).size).toBe(MONGO_KEYWORDS.length);
    expect(MONGO_FUNCTIONS.length).toBeGreaterThan(20);
    expect(new Set(MONGO_FUNCTIONS).size).toBe(MONGO_FUNCTIONS.length);
    expect(MONGO_COMPLETION_SNIPPETS.length).toBeGreaterThan(0);
    for (const s of MONGO_COMPLETION_SNIPPETS) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.body.length).toBeGreaterThan(0);
    }
  });

  it('mongosh 特有形状命中：db.<coll>.find / aggregate 阶段 / use-show 帮助命令', () => {
    for (const kw of ['find', 'findOne', 'aggregate', 'countDocuments', 'getCollection', 'use', 'show', 'ObjectId']) {
      expect(MONGO_KEYWORDS, kw).toContain(kw);
    }
    for (const fn of ['$match', '$group', '$lookup', '$out', '$elemMatch', '$dateToString']) {
      expect(MONGO_FUNCTIONS, fn).toContain(fn);
    }
    for (const kw of ['toArray', 'limit', 'sort']) {
      expect(MONGO_KEYWORDS, kw).toContain(kw); // 游标方法归 keywords（redis 先例：functions=次级命令域）
    }
  });

  it('mongoCompletionSource 注入词表与库列表', () => {
    const src = mongoCompletionSource(['cf_mongo', 'admin']);
    expect(src.keywords).toEqual([...MONGO_KEYWORDS]);
    expect(src.functions).toEqual([...MONGO_FUNCTIONS]);
    expect(src.databases).toEqual(['cf_mongo', 'admin']);
    expect(src.tables).toEqual([]);
    expect(src.columns).toEqual([]);
    expect(src.snippets?.length).toBe(MONGO_COMPLETION_SNIPPETS.length);
  });
});
