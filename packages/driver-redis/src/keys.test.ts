import { describe, expect, it } from 'vitest';
import {
  cursorOf,
  decodeCursor,
  encodeRedisValue,
  isGlobPattern,
  keyContentColumns,
  patternColumns,
  groupKeysToObjects,
  redisTypeOf,
} from './keys';

describe('encodeRedisValue 值编码契约（驱动规范 §5.3）', () => {
  it('二进制（无效 UTF-8）→ binary base64', () => {
    const bin = Buffer.from([0xff, 0xfe, 0x00, 0x01]);
    expect(encodeRedisValue(bin)).toBe(bin.toString('base64'));
  });

  it('有效 UTF-8 的 Buffer 按文本嗅探', () => {
    expect(encodeRedisValue(Buffer.from('hello'))).toBe('hello');
    expect(encodeRedisValue(Buffer.from('42'))).toBe(42);
    expect(encodeRedisValue(Buffer.from('{"a":1}'))).toEqual({ a: 1 });
  });

  it('简单字符串 → string', () => {
    expect(encodeRedisValue('hello world')).toBe('hello world');
    expect(encodeRedisValue('')).toBe('');
    expect(encodeRedisValue('007')).toBe('007'); // 前导零不丢
    expect(encodeRedisValue('3.14')).toBe('3.14'); // 非整数不嗅探为 number
  });

  it('整数字符串 → integer（超 MAX_SAFE_INTEGER 除外）', () => {
    expect(encodeRedisValue('42')).toBe(42);
    expect(encodeRedisValue('-7')).toBe(-7);
    expect(encodeRedisValue('0')).toBe(0);
    expect(encodeRedisValue('9007199254740993')).toBe('9007199254740993'); // 2^53+1 保精度
  });

  it('JSON 数组/对象字符串 → 已解析 json（Hash/List/Set/ZSet 值统一）', () => {
    expect(encodeRedisValue('[1,2,3]')).toEqual([1, 2, 3]);
    expect(encodeRedisValue('{"a":1}')).toEqual({ a: 1 });
    expect(encodeRedisValue('[not json')).toBe('[not json'); // 解析失败回退原文
    expect(encodeRedisValue('"quoted"')).toBe('"quoted"'); // 标量 JSON 不包装
    expect(encodeRedisValue('123')).toBe(123); // 整数走 integer 通道
  });

  it('null 原样', () => {
    expect(encodeRedisValue(null)).toBeNull();
  });

  it('number/boolean 原样透传', () => {
    expect(encodeRedisValue(1.5)).toBe(1.5);
    expect(encodeRedisValue(true)).toBe(true);
  });
});

describe('游标编码', () => {
  it('encode → decode 往返（含批内 pending 位置，base64 保真）', () => {
    const c = cursorOf('17');
    expect(typeof c).toBe('string');
    expect(decodeCursor(c)).toEqual({ scan: '17', pending: [] });
    const bin = Buffer.from([0xff, 0xfe, 0x01]);
    const c2 = cursorOf('42', [Buffer.from('k1'), bin]);
    const decoded = decodeCursor(c2);
    expect(decoded!.scan).toBe('42');
    expect(decoded!.pending[0].toString('utf8')).toBe('k1');
    expect(decoded!.pending[1].equals(bin)).toBe(true);
  });

  it('无效游标返回 undefined（调用方报 E_VALIDATION）', () => {
    expect(decodeCursor('not-base64-json!')).toBeUndefined();
    expect(decodeCursor('')).toBeUndefined();
  });

  it('游标不泄漏明文', () => {
    expect(cursorOf('17')).not.toContain('17');
  });
});

describe('glob 模式识别（pattern 浏览 vs 单键内容）', () => {
  it('含 * ? [ 为模式', () => {
    expect(isGlobPattern('user:*')).toBe(true);
    expect(isGlobPattern('h[ae]llo')).toBe(true);
    expect(isGlobPattern('key?')).toBe(true);
  });

  it('普通键名不是模式', () => {
    expect(isGlobPattern('user:1')).toBe(false);
    expect(isGlobPattern('plain')).toBe(false);
  });
});

describe('列元数据虚拟化（驱动规范 §5.3）', () => {
  it('模式浏览列：key / type / __ttl（primaryKey 恒为 key）', () => {
    const cols = patternColumns();
    expect(cols.map((c) => c.name)).toEqual(['key', 'type', '__ttl']);
    expect(cols.map((c) => c.normalizedType)).toEqual(['string', 'string', 'integer']);
  });

  it('类型化内容列', () => {
    expect(keyContentColumns('hash')!.map((c) => c.name)).toEqual(['field', 'value']);
    expect(keyContentColumns('list')!.map((c) => c.name)).toEqual(['index', 'value']);
    expect(keyContentColumns('set')!.map((c) => c.name)).toEqual(['member']);
    expect(keyContentColumns('zset')!.map((c) => c.name)).toEqual(['member', 'score']);
    expect(keyContentColumns('string')!.map((c) => c.name)).toEqual(['value']);
    expect(keyContentColumns('stream')).toBeUndefined();
  });

  it('redisTypeOf：TYPE 回复归一（none 表示不存在）', () => {
    expect(redisTypeOf('hash')).toBe('hash');
    expect(redisTypeOf('zset')).toBe('zset');
    expect(redisTypeOf('stream')).toBe('stream');
    expect(redisTypeOf('weird')).toBeUndefined();
    expect(redisTypeOf('none')).toBeUndefined();
  });
});

describe('groupKeysToObjects：Keys 目录前缀分组（概要 §5.1.3 三级）', () => {
  const noTypes = new Map<string, string>();

  it('≥3 个同前缀键合并为模式节点，其余键逐一列出', () => {
    const keys = ['user:1', 'user:2', 'user:3', 'user:4', 'standalone', 'cf:x'];
    const objs = groupKeysToObjects(keys, noTypes, { groupMin: 3, cap: 100 });
    const pattern = objs.find((o) => o.name === 'user:*');
    expect(pattern).toBeDefined();
    expect(pattern!.kind).toBe('collection');
    expect(objs.some((o) => o.name === 'standalone')).toBe(true);
    expect(objs.some((o) => o.name === 'user:1')).toBe(false); // 已并入模式组
  });

  it('cap 截断：超出上限追加「其余键」模式节点', () => {
    const keys = Array.from({ length: 30 }, (_, i) => `k${i}`);
    const objs = groupKeysToObjects(keys, noTypes, { groupMin: 3, cap: 10 });
    expect(objs.some((o) => o.name === '*')).toBe(true);
    // 未分组的键仍逐条在前 cap 内
    expect(objs.some((o) => o.name === 'k0')).toBe(true);
  });

  it('二前缀不分组（低于 groupMin）', () => {
    const objs = groupKeysToObjects(['a:1', 'a:2', 'b'], noTypes, { groupMin: 3, cap: 100 });
    expect(objs.some((o) => o.name === 'a:*')).toBe(false);
    expect(objs.some((o) => o.name === 'a:1')).toBe(true);
  });
});
