import { describe, expect, it } from 'vitest';
import {
  assessRedisCommand,
  isProvablyReadRedisCommand,
  splitCommandLines,
  tokenizeRedisCommand,
} from './redisCommands';
import { statementAtOffset } from './sqlScript';

describe('tokenizeRedisCommand', () => {
  it('按空白切分命令名与参数', () => {
    expect(tokenizeRedisCommand('GET user:1')).toEqual(['GET', 'user:1']);
    expect(tokenizeRedisCommand('  SET   k   v  ')).toEqual(['SET', 'k', 'v']);
  });

  it('引号内的空白不切分（redis-cli 风格）', () => {
    expect(tokenizeRedisCommand('SET k "hello world"')).toEqual(['SET', 'k', 'hello world']);
    expect(tokenizeRedisCommand(`SET k 'a,b'`)).toEqual(['SET', 'k', 'a,b']);
  });

  it('引号转义', () => {
    expect(tokenizeRedisCommand('SET k "say \\"hi\\""')).toEqual(['SET', 'k', 'say "hi"']);
    expect(tokenizeRedisCommand(`SET k 'it\\'s'`)).toEqual(['SET', 'k', "it's"]);
  });

  it('未闭合引号不可解析（调用方表达 E_SYNTAX）', () => {
    expect(tokenizeRedisCommand('SET k "unterminated')).toBeUndefined();
  });

  it('空文本返回空数组', () => {
    expect(tokenizeRedisCommand('')).toEqual([]);
    expect(tokenizeRedisCommand('   ')).toEqual([]);
  });
});

describe('assessRedisCommand 白名单判定（驱动规范 §5.3 / 概要 §5.8）', () => {
  it('读命令：GET/HGETALL/SCAN/INFO 可证明为读', () => {
    for (const cmd of ['GET k', 'HGETALL h', 'SCAN 0', 'INFO memory', 'ZRANGE z 0 -1']) {
      const a = assessRedisCommand(cmd);
      expect(a.provablyRead, cmd).toBe(true);
      expect(a.known, cmd).toBe(true);
      expect(a.dangerous, cmd).toBe(false);
    }
  });

  it('普通写命令：known 且非读、不触发危险横幅', () => {
    for (const cmd of ['SET k v', 'DEL k', 'HSET h f v', 'EXPIRE k 60']) {
      const a = assessRedisCommand(cmd);
      expect(a.known, cmd).toBe(true);
      expect(a.provablyRead, cmd).toBe(false);
      expect(a.dangerous, cmd).toBe(false);
    }
  });

  it('大范围破坏命令触发危险横幅（附原因）', () => {
    for (const cmd of ['FLUSHALL', 'FLUSHDB ASYNC', 'SHUTDOWN NOSAVE']) {
      const a = assessRedisCommand(cmd);
      expect(a.dangerous, cmd).toBe(true);
      expect(a.reasons.length, cmd).toBeGreaterThan(0);
    }
    expect(assessRedisCommand('SLAVEOF no one').dangerous).toBe(true);
    expect(assessRedisCommand('DEBUG SLEEP 10').dangerous).toBe(true);
    expect(assessRedisCommand('EVAL "return 1" 0').dangerous).toBe(true);
  });

  it('子命令感知：CONFIG GET 是读，CONFIG SET 危险', () => {
    expect(assessRedisCommand('CONFIG GET maxmemory').provablyRead).toBe(true);
    const set = assessRedisCommand('CONFIG SET maxmemory 1gb');
    expect(set.provablyRead).toBe(false);
    expect(set.dangerous).toBe(true);
    expect(assessRedisCommand('CLIENT LIST').provablyRead).toBe(true);
    expect(assessRedisCommand('CLIENT KILL id 3').dangerous).toBe(true);
  });

  it('SORT 默认读，带 STORE 视为写', () => {
    expect(assessRedisCommand('SORT mylist ALPHA').provablyRead).toBe(true);
    const stored = assessRedisCommand('SORT mylist STORE dst');
    expect(stored.provablyRead).toBe(false);
  });

  it('未知命令：不可证明为读（fail-closed）、不虚报危险', () => {
    const a = assessRedisCommand('NOSUCHCMD x y');
    expect(a.known).toBe(false);
    expect(a.provablyRead).toBe(false);
    expect(a.dangerous).toBe(false);
  });

  it('命令名大小写不敏感', () => {
    expect(assessRedisCommand('get k').provablyRead).toBe(true);
    expect(assessRedisCommand('flushall').dangerous).toBe(true);
  });

  it('不可解析（引号未闭合）→ known=false 且不可证明为读', () => {
    const a = assessRedisCommand('SET k "unterminated');
    expect(a.known).toBe(false);
    expect(a.provablyRead).toBe(false);
  });
});

describe('isProvablyReadRedisCommand（只读连接 fail-closed 放行条件）', () => {
  it('读命令放行，写/未知命令拒绝', () => {
    expect(isProvablyReadRedisCommand('GET k')).toBe(true);
    expect(isProvablyReadRedisCommand('DEL k')).toBe(false);
    expect(isProvablyReadRedisCommand('NOSUCHCMD')).toBe(false);
  });
});

describe('splitCommandLines（命令模式按行切分，空行与 # 注释跳过）', () => {
  it('切分为带原文偏移的命令行', () => {
    const src = '# 注释\nGET a\n\nSET b 1';
    const lines = splitCommandLines(src);
    expect(lines.map((l) => l.text)).toEqual(['GET a', 'SET b 1']);
    expect(src.slice(lines[0].start, lines[0].end)).toBe('GET a');
    expect(src.slice(lines[1].start, lines[1].end)).toBe('SET b 1');
  });

  it('首行无注释时 start 对齐首个非空白字符', () => {
    const src = '  GET a';
    const [line] = splitCommandLines(src);
    expect(line.start).toBe(2);
    expect(line.text).toBe('GET a');
  });

  it('与 statementAtOffset 配合定位「当前行命令」', () => {
    const src = '# c\nGET a\nSET b 1';
    const lines = splitCommandLines(src);
    const offset = src.indexOf('SET');
    expect(statementAtOffset(lines, offset)?.text).toBe('SET b 1');
    // 光标停在第一行行尾 → 命中第一行
    expect(statementAtOffset(lines, src.indexOf('GET a') + 5)?.text).toBe('GET a');
  });
});
