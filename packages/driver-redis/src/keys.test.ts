import { describe, expect, it } from 'vitest';
import {
  contentPrimaryKey,
  cursorOf,
  decodeCursor,
  encodeRedisValue,
  isGlobPattern,
  keyContentColumns,
  patternColumns,
  groupKeysByType,
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
    // M7 收尾：stream 内容展示（一行 = 一个条目，fields 为 json 对象列）
    expect(keyContentColumns('stream')!.map((c) => c.name)).toEqual(['entry', 'fields']);
    expect(contentPrimaryKey('stream')).toEqual(['entry']);
  });

  it('redisTypeOf：TYPE 回复归一（none 表示不存在）', () => {
    expect(redisTypeOf('hash')).toBe('hash');
    expect(redisTypeOf('zset')).toBe('zset');
    expect(redisTypeOf('stream')).toBe('stream');
    expect(redisTypeOf('weird')).toBeUndefined();
    expect(redisTypeOf('none')).toBeUndefined();
  });
});

describe('groupKeysByType：按数据类型分组目录（概要 §5.1.3 数据驱动）', () => {
  it('每个键一条 ObjectMeta，schema = 所属类型目录标签；按标签定义顺序输出', () => {
    const types = new Map([
      ['k:str', 'string'],
      ['k:h', 'hash'],
      ['k:z', 'zset'],
      ['k:l', 'list'],
      ['k:s', 'set'],
    ]);
    const objs = groupKeysByType([...types.keys()], types);
    expect(objs.filter((o) => o.name !== '*').map((o) => [o.name, o.schema])).toEqual([
      ['k:str', '字符串'],
      ['k:h', '哈希'],
      ['k:l', '列表'],
      ['k:s', '集合'],
      ['k:z', '有序集合'],
    ]);
    for (const o of objs) {
      expect(o.kind).toBe('collection');
    }
  });

  it('未知类型兜底「其他」，TYPE=none（已删除）跳过', () => {
    const types = new Map([
      ['k:weird', 'module'],
      ['k:gone', 'none'],
      ['k:str', 'string'],
    ]);
    const objs = groupKeysByType([...types.keys()], types);
    expect(objs.filter((o) => o.name !== '*').map((o) => [o.name, o.schema])).toEqual([
      ['k:str', '字符串'],
      ['k:weird', '其他'],
    ]);
  });

  it('末尾附加 * 模式浏览节点（无 schema → 树的 Keys 默认组）', () => {
    const objs = groupKeysByType(['a'], new Map([['a', 'string']]));
    const star = objs[objs.length - 1];
    expect(star.name).toBe('*');
    expect(star.schema).toBeUndefined();
    expect(star.comment).toContain('模式浏览');
  });
});
