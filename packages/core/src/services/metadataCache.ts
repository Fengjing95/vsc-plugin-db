import type { ColumnMeta, DatabaseMeta, IndexMeta, KeyMeta, ObjectMeta } from '../model/meta';

/**
 * 元数据层次缓存（概要设计 7.5）：
 *   connection → databases(60s) → objects(手动失效) → columns/keys/indexes(5min)
 * - in-flight 去重：同 key 并发加载合并为一次触达
 * - 失效粒度：连接 / 库 / 单对象；clear() 供全局刷新
 * - 时钟可注入，TTL 行为可测
 */
interface Entry<T> {
  value: T;
  expiresAt: number;
}

export interface CacheTtls {
  /** database 列表，默认 60s */
  databases: number;
  /** 表/视图列表，默认常驻（手动刷新才失效） */
  objects: number;
  /** 列/键/索引，默认 5min */
  columns: number;
}

const DEFAULT_TTLS: CacheTtls = {
  databases: 60_000,
  objects: Number.POSITIVE_INFINITY,
  columns: 300_000,
};

export class MetadataCache {
  private readonly databases = new Map<string, Entry<DatabaseMeta[]>>();
  private readonly objects = new Map<string, Entry<ObjectMeta[]>>();
  private readonly columns = new Map<string, Entry<ColumnMeta[]>>();
  private readonly indexes = new Map<string, Entry<IndexMeta[]>>();
  private readonly keys = new Map<string, Entry<KeyMeta[]>>();
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly ttls: CacheTtls = DEFAULT_TTLS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async getDatabases(connId: string, load: () => Promise<DatabaseMeta[]>): Promise<DatabaseMeta[]> {
    return this.get(this.databases, `db:${connId}`, this.ttls.databases, load);
  }

  async getObjects(connId: string, db: string, load: () => Promise<ObjectMeta[]>): Promise<ObjectMeta[]> {
    return this.get(this.objects, `obj:${connId}/${db}`, this.ttls.objects, load);
  }

  async getColumns(connId: string, db: string, obj: string, load: () => Promise<ColumnMeta[]>): Promise<ColumnMeta[]> {
    return this.get(this.columns, `col:${connId}/${db}/${obj}`, this.ttls.columns, load);
  }

  async getIndexes(connId: string, db: string, obj: string, load: () => Promise<IndexMeta[]>): Promise<IndexMeta[]> {
    return this.get(this.indexes, `idx:${connId}/${db}/${obj}`, this.ttls.columns, load);
  }

  async getKeys(connId: string, db: string, obj: string, load: () => Promise<KeyMeta[]>): Promise<KeyMeta[]> {
    return this.get(this.keys, `key:${connId}/${db}/${obj}`, this.ttls.columns, load);
  }

  /** 连接级失效：连接被删除/编辑后调用 */
  invalidateConnection(connId: string): void {
    this.dropByPrefixes([`db:${connId}`, `obj:${connId}/`, `col:${connId}/`, `idx:${connId}/`, `key:${connId}/`]);
  }

  /** 库级失效：DDL 变更（M5 Console 联动）或手动刷新该库 */
  invalidateDb(connId: string, db: string): void {
    this.databases.delete(`db:${connId}`); // 库列表本身也可能增减
    this.dropByPrefixes([`obj:${connId}/${db}`, `col:${connId}/${db}/`, `idx:${connId}/${db}/`, `key:${connId}/${db}/`]);
  }

  /** 单对象失效：该表结构变更（M4 applyChanges 后仅失效行估算，此处为完整失效入口） */
  invalidateObject(connId: string, db: string, obj: string): void {
    this.columns.delete(`col:${connId}/${db}/${obj}`);
    this.indexes.delete(`idx:${connId}/${db}/${obj}`);
    this.keys.delete(`key:${connId}/${db}/${obj}`);
  }

  clear(): void {
    for (const map of [this.databases, this.objects, this.columns, this.indexes, this.keys]) {
      map.clear();
    }
    this.inflight.clear();
  }

  /** 测试/诊断用：缓存条目数 */
  get size(): number {
    return (
      this.databases.size + this.objects.size + this.columns.size + this.indexes.size + this.keys.size
    );
  }

  private async get<T>(
    map: Map<string, Entry<T>>,
    key: string,
    ttlMs: number,
    load: () => Promise<T>,
  ): Promise<T> {
    const hit = map.get(key);
    if (hit && hit.expiresAt > this.now()) {
      return hit.value;
    }

    // in-flight 去重：同一 key 的并发加载只触达一次
    const pending = this.inflight.get(key);
    if (pending) {
      return pending as Promise<T>;
    }

    const task = load()
      .then((value) => {
        map.set(key, { value, expiresAt: this.now() + ttlMs });
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, task);
    return task as Promise<T>;
  }

  private dropByPrefixes(prefixes: string[]): void {
    for (const map of [this.databases, this.objects, this.columns, this.indexes, this.keys]) {
      for (const key of [...map.keys()]) {
        if (prefixes.some((p) => key === p || key.startsWith(p))) {
          map.delete(key);
        }
      }
    }
    for (const key of [...this.inflight.keys()]) {
      if (prefixes.some((p) => key === p || key.startsWith(p))) {
        this.inflight.delete(key);
      }
    }
  }
}
