import { Binary, Code, Decimal128, Long, ObjectId, UUID } from 'mongodb';
import { DriverError } from '@db-explorer/core';

/**
 * mongosh 参数字面量受限解析器（驱动规范 §5.5：禁 eval——mongosh 参数是 JS 字面量，
 * 自建递归下降解析覆盖：对象/数组/字符串/数字/布尔/null + 构造器包装
 * （ObjectId/ISODate/Date/NumberLong/NumberInt/NumberDecimal/BinData/UUID）+
 * function 表达式（源码按 BSON Code 透传，服务端执行，如 $where）。
 * 解析失败一律 E_SYNTAX（fail-closed）；命令切分与白名单判定在 core mongoCommands。
 */

class ArgParser {
  private pos = 0;

  constructor(private readonly src: string) {}

  private fail(reason: string): never {
    throw new DriverError('E_SYNTAX', `无法解析命令参数：${reason}（位置 ${this.pos}）`);
  }

  private get eof(): boolean {
    return this.pos >= this.src.length;
  }

  private peek(): string {
    return this.eof ? '' : this.src[this.pos]!;
  }

  private eat(ch: string): boolean {
    this.ws();
    if (this.peek() === ch) {
      this.pos++;
      return true;
    }
    return false;
  }

  private expect(ch: string): void {
    if (!this.eat(ch)) {
      this.fail(`期望 "${ch}"`);
    }
  }

  private ws(): void {
    while (!this.eof && /\s/.test(this.src[this.pos]!)) {
      this.pos++;
    }
  }

  parseArguments(): unknown[] {
    this.ws();
    if (this.eof) {
      return [];
    }
    const out = [this.parseValue()];
    for (;;) {
      this.ws();
      if (this.eof) {
        return out;
      }
      if (this.eat(',')) {
        this.ws();
        if (this.eat('}')) {
          this.fail('数组参数中混入 "}"');
        }
        if (this.eof) {
          return out; // 尾逗号容忍
        }
        out.push(this.parseValue());
        continue;
      }
      this.fail('存在无法解析的尾随内容');
    }
  }

  private parseValue(): unknown {
    this.ws();
    const c = this.peek();
    if (c === '{') {
      return this.parseObject();
    }
    if (c === '[') {
      return this.parseArray();
    }
    if (c === "'" || c === '"' || c === '`') {
      return this.parseString(c);
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      return this.parseNumber();
    }
    return this.parseIdentValue();
  }

  private parseString(quote: string): string {
    this.pos++; // 开引号
    let out = '';
    for (;;) {
      if (this.eof) {
        this.fail('字符串未闭合');
      }
      const ch = this.src[this.pos]!;
      if (ch === quote) {
        this.pos++;
        return out;
      }
      if (ch === '\\') {
        this.pos++;
        const esc = this.src[this.pos];
        if (esc === undefined) {
          this.fail('字符串未闭合');
        }
        const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '0': '\0', b: '\b', f: '\f', v: '\v' };
        out += esc in map ? map[esc]! : esc; // \' \" \\ \` 原样还原
        this.pos++;
        continue;
      }
      if (ch === '\n' && quote !== '`') {
        this.fail('字符串未闭合（换行）');
      }
      if (quote === '`' && ch === '$' && this.src[this.pos + 1] === '{') {
        this.fail('不支持模板字符串插值');
      }
      out += ch;
      this.pos++;
    }
  }

  private parseNumber(): number {
    const m = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(this.src.slice(this.pos));
    if (!m) {
      this.fail('非法数字');
    }
    this.pos += m[0].length;
    return Number(m[0]);
  }

  private readIdent(): string {
    const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(this.src.slice(this.pos));
    if (!m) {
      this.fail('无法识别的语法');
    }
    this.pos += m[0].length;
    return m[0];
  }

  private parseObject(): Record<string, unknown> {
    this.expect('{');
    const out: Record<string, unknown> = {};
    this.ws();
    if (this.eat('}')) {
      return out;
    }
    for (;;) {
      this.ws();
      const c = this.peek();
      const key =
        c === "'" || c === '"' || c === '`' ? this.parseString(c) : this.readIdent();
      this.expect(':');
      out[key] = this.parseValue();
      this.ws();
      if (this.eat('}')) {
        return out;
      }
      if (this.eat(',') && (this.eat('}') || this.eof)) {
        return out; // 尾逗号容忍
      }
      if (this.eof) {
        this.fail('对象未闭合');
      }
    }
  }

  private parseArray(): unknown[] {
    this.expect('[');
    const out: unknown[] = [];
    this.ws();
    if (this.eat(']')) {
      return out;
    }
    for (;;) {
      out.push(this.parseValue());
      this.ws();
      if (this.eat(']')) {
        return out;
      }
      if (this.eat(',') && (this.eat(']') || this.eof)) {
        return out; // 尾逗号容忍
      }
      if (this.eof) {
        this.fail('数组未闭合');
      }
    }
  }

  private parseIdentValue(): unknown {
    const ident = this.readIdent();
    switch (ident) {
      case 'true':
        return true;
      case 'false':
        return false;
      case 'null':
      case 'undefined':
        return null;
      case 'function':
        return this.parseFunction();
      case 'new': {
        this.ws();
        return this.parseCtor(this.readIdent());
      }
      default:
        return this.parseCtor(ident);
    }
  }

  private parseCallArgs(): unknown[] {
    this.expect('(');
    const args: unknown[] = [];
    this.ws();
    if (this.eat(')')) {
      return args;
    }
    for (;;) {
      args.push(this.parseValue());
      this.ws();
      if (this.eat(')')) {
        return args;
      }
      this.expect(',');
    }
  }

  private parseCtor(name: string): unknown {
    this.ws();
    if (this.peek() !== '(') {
      this.fail(`不支持的标识符 "${name}"（仅支持构造器包装与字面量）`);
    }
    const args = this.parseCallArgs();
    const a0 = args[0];
    switch (name) {
      case 'ObjectId':
        return args.length === 0 ? new ObjectId() : new ObjectId(String(a0));
      case 'ISODate':
      case 'Date':
        return args.length === 0 ? new Date() : new Date(String(a0));
      case 'NumberLong':
        return Long.fromString(String(a0));
      case 'NumberInt':
        return Number.parseInt(String(a0), 10);
      case 'NumberDecimal':
        return Decimal128.fromString(String(a0));
      case 'BinData':
        return new Binary(Buffer.from(String(args[1] ?? ''), 'base64'), Number(a0 ?? 0));
      case 'UUID':
        return new UUID(String(a0));
      default:
        this.fail(`不支持的函数/标识符 "${name}"`);
    }
  }

  /** function 表达式：参数列表与函数体按括号/花括号平衡捕获源码 → Code（服务端执行） */
  private parseFunction(): Code {
    const start = this.pos - 'function'.length;
    this.ws();
    if (this.peek() !== '(') {
      this.readIdent(); // 具名函数
    }
    this.expect('(');
    let depth = 1;
    while (!this.eof && depth > 0) {
      const ch = this.peek();
      if (ch === "'" || ch === '"' || ch === '`') {
        this.parseString(ch);
        continue;
      }
      if (ch === '(') {
        depth++;
      } else if (ch === ')') {
        depth--;
      }
      this.pos++;
    }
    if (depth !== 0) {
      this.fail('函数参数括号不平衡');
    }
    this.ws();
    if (this.peek() !== '{') {
      this.fail('函数体缺失（仅支持 function 表达式，不支持箭头函数）');
    }
    while (!this.eof) {
      const ch = this.peek();
      if (ch === "'" || ch === '"' || ch === '`') {
        this.parseString(ch);
        continue;
      }
      if (ch === '{') {
        depth++;
        this.pos++;
        continue;
      }
      if (ch === '}') {
        depth--;
        this.pos++;
        if (depth === 0) {
          return new Code(this.src.slice(start, this.pos));
        }
        continue;
      }
      this.pos++;
    }
    this.fail('函数体未闭合');
  }
}

/** 解析方法调用括号内的参数源文本 → 参数值数组（空串 → []） */
export function parseMongoArgs(src: string): unknown[] {
  return new ArgParser(src).parseArguments();
}
