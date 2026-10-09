/**
 * mongosh 命令域切分与白名单（M8-Mongo，驱动规范 §5.5；与 redisCommands.ts 同构）。
 * 纯函数、零依赖。行切分与 SqlStatement 形状兼容，可复用 statementAtOffset 定位「当前行命令」。
 * 危险判定不走 SQL AST：mongosh 命令形状（db.<coll>.<method>(args) / db.getCollection('<c>').<m>(…)
 * / db.runCommand({…}) / db.getSiblingDB('<db>').… / use <db> / show <target>）→ 读方法白名单
 * provablyRead fail-closed + 危险方法表。consoleService / editGuard 按 driverId 选择
 * redis / mongo 两套白名单。aggregate 带 $out/$merge、runCommand 非白名单命令一律不证明为读。
 */

export interface MongoCommandRange {
  text: string;
  start: number;
  end: number;
}

/** 语句切分（每行一条，与 redis splitCommandLines 同语义）：空行与 //、块注释行跳过；
 *  行尾分号（字符串外）剥离；字符串内 // 与 ; 不受影响。偏移量引用原文（statementAtOffset 复用）。 */
export function splitMongoCommandLines(script: string): MongoCommandRange[] {
  const lines: MongoCommandRange[] = [];
  let stmtStart = -1;
  let stmtEnd = -1;
  let quote: string | null = null;
  let inBlockComment = false;

  const pushIfAny = (): void => {
    if (stmtStart >= 0 && stmtEnd > stmtStart) {
      lines.push({ text: script.slice(stmtStart, stmtEnd), start: stmtStart, end: stmtEnd });
    }
    stmtStart = -1;
    stmtEnd = -1;
  };

  for (let i = 0; i < script.length; i++) {
    const ch = script[i]!;
    if (inBlockComment) {
      if (ch === '*' && script[i + 1] === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      if (stmtStart < 0) stmtStart = i;
      quote = ch;
      continue;
    }
    if (ch === '/' && script[i + 1] === '/') {
      // 行注释：跳过至行尾
      while (i < script.length && script[i] !== '\n') i++;
      i--;
      continue;
    }
    if (ch === '/' && script[i + 1] === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    if (ch === '\n') {
      pushIfAny();
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      continue;
    }
    if (stmtStart < 0) {
      stmtStart = i;
    }
    if (ch !== ';') {
      stmtEnd = i + 1; // 字符串外的 ';' 不入语句文本（行尾分隔符）；行中 ';' 保留给解析层 fail-closed
    }
  }
  pushIfAny();
  return lines;
}

/** `use <db>` → 目标库名；`use` 无目标 → null（不可解析）；非 use 语句 → undefined */
export function parseMongoUse(text: string): string | null | undefined {
  const m = /^\s*use(?:\s+(\S+))?\s*$/.exec(text);
  if (!m) {
    return undefined;
  }
  const target = m[1];
  return target ? target : null;
}

export interface MongoChain {
  /** collection 名（`.coll` 段或 getCollection('<c>')）；db 级方法缺省 */
  coll?: string;
  /** getSiblingDB('<db>') 的目标库（执行时覆盖请求 db） */
  dbTarget?: string;
  method: string;
  /** 方法调用括号内参数源文本（不含括号） */
  argsSrc: string;
  /** 调用结束位置（原文偏移） */
  end: number;
}

function skipWs(text: string, i: number): number {
  while (i < text.length && /\s/.test(text[i]!)) i++;
  return i;
}

function readIdent(text: string, i: number): { name: string; end: number } | undefined {
  const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(text.slice(i));
  if (!m) {
    return undefined;
  }
  return { name: m[0], end: i + m[0].length };
}

/** 括号平衡读取（字符串/行注释感知）：i 指向 '('，返回括号内文本与结束位置；不平衡 → undefined */
function readBalanced(text: string, i: number): { inner: string; after: number } | undefined {
  if (text[i] !== '(') {
    return undefined;
  }
  let depth = 0;
  let quote: string | null = null;
  const start = i + 1;
  for (let j = i; j < text.length; j++) {
    const ch = text[j]!;
    if (quote) {
      if (ch === '\\') {
        j++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '/' && text[j + 1] === '/') {
      while (j < text.length && text[j] !== '\n') j++;
      continue;
    }
    if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) {
        return { inner: text.slice(start, j), after: j + 1 };
      }
    }
  }
  return undefined;
}

/** 单字符串字面量参数（getCollection('users') / getSiblingDB('db')） */
function parseSingleStringArg(src: string): string | undefined {
  const m = /^(['"`])([\s\S]*)\1$/.exec(src.trim());
  if (!m) {
    return undefined;
  }
  return m[2]!.replace(/\\(['"`\\])/g, '$1');
}

/** 解析 db 链式调用：db[.<coll>|.getCollection('<c>')|.getSiblingDB('<db>')]*.<method>(args)。
 *  游标链式调用（.limit() 等尾随内容）、多条语句、非 db 开头 → undefined（fail-closed）。 */
export function parseMongoChain(text: string): MongoChain | undefined {
  let i = skipWs(text, 0);
  if (!text.startsWith('db', i)) {
    return undefined;
  }
  const afterDb = i + 2;
  if (afterDb < text.length && /[A-Za-z0-9_$]/.test(text[afterDb]!)) {
    return undefined; // 不是 db 标识符（如 dbx）
  }
  i = skipWs(text, afterDb);
  let coll: string | undefined;
  let dbTarget: string | undefined;
  for (;;) {
    if (text[i] !== '.') {
      return undefined;
    }
    i = skipWs(text, i + 1);
    const seg = readIdent(text, i);
    if (!seg) {
      return undefined;
    }
    i = skipWs(text, seg.end);
    if (seg.name === 'getCollection' || seg.name === 'getSiblingDB') {
      const call = readBalanced(text, i);
      if (!call) {
        return undefined;
      }
      const arg = parseSingleStringArg(call.inner);
      if (arg === undefined) {
        return undefined;
      }
      if (seg.name === 'getSiblingDB') {
        dbTarget = arg;
      } else {
        coll = arg;
      }
      i = skipWs(text, call.after);
      continue;
    }
    if (text[i] === '(') {
      const call = readBalanced(text, i);
      if (!call) {
        return undefined;
      }
      let j = skipWs(text, call.after);
      if (text[j] === ';') {
        j = skipWs(text, j + 1);
      }
      if (j < text.length) {
        return undefined; // 游标链式调用 / 同行第二语句 → fail-closed
      }
      return { coll, dbTarget, method: seg.name, argsSrc: call.inner, end: j };
    }
    if (text[i] === '.') {
      coll = seg.name; // 中间属性段（后段覆盖，点号 collection 名走 getCollection）；i 停在 '.'，循环头消费
      continue;
    }
    return undefined;
  }
}

/** 读方法白名单（method 全集，undefined 语义经 aggregate/runCommand 特判） */
const READ_METHODS: ReadonlySet<string> = new Set([
  'find', 'findOne', 'count', 'countDocuments', 'estimatedDocumentCount', 'distinct',
  'getIndexes', 'getIndexSpecs', 'getCollectionNames', 'getCollectionInfos', 'getDBNames',
  'getDB', 'getSiblingDB', 'stats', 'explain', 'exists', 'isCapped', 'getFullName', 'getName',
]);

/** 危险方法 → 横幅原因（首批只读：驱动侧一律 E_UNSUPPORTED，此处供危险判定/文案） */
const DANGEROUS_METHODS: Readonly<Record<string, string>> = {
  insertOne: '写入文档',
  insertMany: '批量写入文档',
  updateOne: '修改文档',
  updateMany: '批量修改文档',
  replaceOne: '整文档替换文档',
  deleteOne: '删除文档',
  deleteMany: '批量删除文档',
  bulkWrite: '批量写入/修改/删除文档',
  findOneAndUpdate: '查找并修改文档',
  findOneAndReplace: '查找并替换文档',
  findOneAndDelete: '查找并删除文档',
  findAndModify: '查找并修改文档',
  findAndRemove: '查找并删除文档',
  mapReduce: '服务端 JS 执行并写出结果集',
  drop: '删除整个 collection',
  dropDatabase: '删除整个数据库',
  createCollection: '创建 collection',
  renameCollection: '重命名 collection',
  createIndex: '创建索引',
  dropIndex: '删除索引',
  dropIndexes: '删除索引',
  eval: '服务端执行任意 JS',
  shutdown: '关闭数据库服务',
  adminCommand: '管理命令（可能变更配置/拓扑）',
};

/** aggregate 管道写出阶段（服务端写回） */
const AGGREGATE_WRITE_RE = /\$(out|merge)\b/;

/** runCommand 白名单：仅明确只读的命令（小写） */
const RUNCOMMAND_READ: ReadonlySet<string> = new Set([
  'ping', 'hello', 'buildinfo', 'listdatabases', 'listcollections', 'listindexes',
  'find', 'count', 'distinct', 'dbstats', 'collstats', 'explain', 'whatsmyuri', 'connectionstatus',
]);

/** runCommand 危险命令 → 横幅原因 */
const RUNCOMMAND_DANGEROUS: Readonly<Record<string, string>> = {
  dropdatabase: '删除整个数据库',
  drop: '删除 collection',
  shutdown: '关闭数据库服务',
  create: '创建 collection',
  createindexes: '创建索引',
  dropindexes: '删除索引',
  insert: '写入文档',
  update: '修改文档',
  delete: '删除文档',
  findandmodify: '查找并修改文档',
  aggregate: 'runCommand aggregate 可能携带 $out/$merge 写出结果集',
  replsetstepdown: '副本集主节点降级',
  fsync: 'fsync/锁控制',
  fsyncunlock: '解锁实例',
};

/** 提取 runCommand 首个对象参数的首键（命令名）；无对象参数 → undefined */
function readFirstObjectKey(src: string): string | undefined {
  const brace = src.indexOf('{');
  if (brace < 0) {
    return undefined;
  }
  let j = brace + 1;
  while (j < src.length && /\s/.test(src[j]!)) j++;
  const ch = src[j];
  if (ch === "'" || ch === '"' || ch === '`') {
    const end = src.indexOf(ch, j + 1);
    return end < 0 ? undefined : src.slice(j + 1, end);
  }
  return readIdent(src, j)?.name;
}

export interface MongoCommandAssessment {
  dangerous: boolean;
  reasons: string[];
  known: boolean;
  /** 只读连接 fail-closed（概要 §5.8）的唯一放行条件 */
  provablyRead: boolean;
  unparseable: boolean;
}

/** 单条 mongosh 命令危险判定（与 assessRedisCommand 同构；空命令按读放行） */
export function assessMongoCommand(text: string): MongoCommandAssessment {
  const t = text.trim();
  if (t === '') {
    return { dangerous: false, reasons: [], known: true, provablyRead: true, unparseable: false };
  }
  // use <db>：Host 拦截改 Console 绑定（不下发，P-36 同构）；仅改本地状态，按读放行
  if (/^use\b/.test(t)) {
    const target = parseMongoUse(t);
    return {
      dangerous: false,
      reasons: [],
      known: true,
      provablyRead: target !== null,
      unparseable: target === null,
    };
  }
  const show = /^show\s+(\S+)\s*$/i.exec(t);
  if (show) {
    const ok = /^(dbs|databases|collections|tables)$/i.test(show[1]!);
    return { dangerous: false, reasons: [], known: ok, provablyRead: ok, unparseable: false };
  }
  const chain = parseMongoChain(t);
  if (!chain) {
    return { dangerous: false, reasons: [], known: false, provablyRead: false, unparseable: true };
  }
  const { method, argsSrc } = chain;
  const dangerousReason = DANGEROUS_METHODS[method];
  if (dangerousReason) {
    return { dangerous: true, reasons: [dangerousReason], known: true, provablyRead: false, unparseable: false };
  }
  if (method === 'aggregate') {
    if (AGGREGATE_WRITE_RE.test(argsSrc)) {
      return {
        dangerous: true,
        reasons: ['aggregate 管道含 $out/$merge 会写出结果集'],
        known: true,
        provablyRead: false,
        unparseable: false,
      };
    }
    return { dangerous: false, reasons: [], known: true, provablyRead: true, unparseable: false };
  }
  if (method === 'runCommand') {
    const key = readFirstObjectKey(argsSrc)?.toLowerCase();
    if (key !== undefined && RUNCOMMAND_READ.has(key)) {
      return { dangerous: false, reasons: [], known: true, provablyRead: true, unparseable: false };
    }
    if (key !== undefined && RUNCOMMAND_DANGEROUS[key]) {
      return {
        dangerous: true,
        reasons: [RUNCOMMAND_DANGEROUS[key]!],
        known: true,
        provablyRead: false,
        unparseable: false,
      };
    }
    // 非白名单命令：不证明为读（fail-closed），也不误报危险
    return { dangerous: false, reasons: [], known: false, provablyRead: false, unparseable: false };
  }
  if (READ_METHODS.has(method)) {
    return { dangerous: false, reasons: [], known: true, provablyRead: true, unparseable: false };
  }
  return { dangerous: false, reasons: [], known: false, provablyRead: false, unparseable: false };
}

/** 只读连接 fail-closed（概要 §5.8）：不可证明为读 → false */
export function isProvablyReadMongoCommand(text: string): boolean {
  return assessMongoCommand(text).provablyRead;
}
