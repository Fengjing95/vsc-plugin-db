import { describe, expect, it } from 'vitest';
import type { IConnection } from '../driver/types';
import type { ColumnMeta, KeyMeta, ObjectMeta } from '../model/meta';
import { ER_MAX_COLUMNS, collectRelationGraph } from './erModel';

/** 最小 IConnection 桩（只实现 collectRelationGraph 消费的自省面） */
function stubConn(opts: {
  objects: ObjectMeta[];
  columns: Record<string, ColumnMeta[]>;
  keys?: Record<string, KeyMeta[]>;
}): IConnection {
  return {
    connectionId: 'stub',
    dispose: () => undefined,
    ping: () => Promise.resolve(),
    listDatabases: () => Promise.resolve([{ name: 'db' }]),
    listObjects: (db: string) => Promise.resolve(db === 'db' ? opts.objects : []),
    listColumns: (_db: string, obj: string) => {
      const cols = opts.columns[obj];
      if (!cols) {
        throw new Error(`E_NOT_FOUND: ${obj}`);
      }
      return Promise.resolve(cols);
    },
    listKeys: (_db: string, obj: string) => Promise.resolve(opts.keys?.[obj] ?? []),
  } as IConnection;
}

function col(name: string, ordinal: number, isPrimaryKey = false): ColumnMeta {
  return { name, dataType: 'bigint', normalizedType: 'integer', nullable: !isPrimaryKey, isPrimaryKey, ordinal };
}

describe('collectRelationGraph（M8-ER 关系收集，D-22）', () => {
  it('全量 scope：只入 table、列按 ordinal 排序、FK 合并为边', async () => {
    const graph = await collectRelationGraph(
      stubConn({
        objects: [
          { name: 't_view', kind: 'view' },
          { name: 'parent', kind: 'table', comment: '父表' },
          { name: 'child', kind: 'table' },
        ],
        columns: {
          parent: [col('id', 1, true), col('uname', 2)],
          child: [col('id', 1, true), col('parent_id', 2)],
          t_view: [col('x', 1)],
        },
        keys: {
          child: [
            { name: 'PRIMARY', kind: 'PK', columns: ['id'] },
            // MySQL 同族：复合 FK 按列逐行返回（同名多行）
            { name: 'fk_c', kind: 'FK', columns: ['parent_id'], refTable: 'parent', refColumns: ['id'] },
          ],
        },
      }),
      'db',
    );
    expect(graph.tables.map((t) => t.name)).toEqual(['parent', 'child']);
    expect(graph.tables[0]!.comment).toBe('父表');
    expect(graph.tables[0]!.columns.map((c) => c.name)).toEqual(['id', 'uname']);
    expect(graph.edges).toEqual([
      { name: 'fk_c', sourceTable: 'child', sourceColumns: ['parent_id'], targetTable: 'parent', targetColumns: ['id'] },
    ]);
    expect(graph.hiddenEdges).toBe(0);
  });

  it('selection：表集过滤、端点不全的边计入 hiddenEdges', async () => {
    const graph = await collectRelationGraph(
      stubConn({
        objects: [
          { name: 'a', kind: 'table' },
          { name: 'b', kind: 'table' },
          { name: 'self_t', kind: 'table' },
        ],
        columns: {
          a: [col('id', 1, true)],
          b: [col('id', 1, true)],
          self_t: [col('id', 1, true)],
        },
        keys: {
          a: [{ name: 'fk1', kind: 'FK', columns: ['id'], refTable: 'b', refColumns: ['id'] }],
          self_t: [{ name: 'fk2', kind: 'FK', columns: ['id'], refTable: 'self_t', refColumns: ['id'] }],
        },
      }),
      'db',
      { kind: 'selection', tables: ['a', 'self_t'] },
    );
    expect(graph.tables.map((t) => t.name)).toEqual(['a', 'self_t']);
    // a→b 端点不全不绘制；self_t 自引用两端俱在，保留
    expect(graph.edges.map((e) => e.sourceTable)).toEqual(['self_t']);
    expect(graph.hiddenEdges).toBe(1);
  });

  it('listKeys 未实现的驱动：图为无边的表清单（不抛错）', async () => {
    const conn = stubConn({
      objects: [{ name: 't', kind: 'table' }],
      columns: { t: [col('id', 1, true)] },
    });
    delete (conn as Partial<IConnection>).listKeys;
    const graph = await collectRelationGraph(conn, 'db');
    expect(graph.tables.map((t) => t.name)).toEqual(['t']);
    expect(graph.edges).toEqual([]);
  });

  it('列超上限截断计数（ER_MAX_COLUMNS）', async () => {
    const many = Array.from({ length: ER_MAX_COLUMNS + 5 }, (_, i) => col(`c${i}`, i + 1));
    const graph = await collectRelationGraph(
      stubConn({ objects: [{ name: 'wide', kind: 'table' }], columns: { wide: many } }),
      'db',
    );
    expect(graph.tables[0]!.columns).toHaveLength(ER_MAX_COLUMNS);
    expect(graph.tables[0]!.columnsTruncated).toBe(5);
  });

  it('单表元数据读取失败整体失败（不半出图）', async () => {
    const conn = stubConn({
      objects: [
        { name: 'ok', kind: 'table' },
        { name: 'gone', kind: 'table' },
      ],
      columns: { ok: [col('id', 1, true)] },
    });
    await expect(collectRelationGraph(conn, 'db')).rejects.toThrow('E_NOT_FOUND');
  });
});
