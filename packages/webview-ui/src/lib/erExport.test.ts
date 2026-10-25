import { describe, expect, it } from 'vitest';
import type { ErGraphResult } from '@db-explorer/protocol';
import { edgeGeometry } from './erCanvas';
import { buildErSvg, utf8ToBase64, type ErPalette } from './erExport';

const palette: ErPalette = {
  background: '#fafafa',
  panel: '#ffffff',
  border: '#e5e5e5',
  mutedBg: '#f0f0f0',
  foreground: '#1f1f1f',
  mutedForeground: '#888888',
  warning: '#ccaa00',
  link: '#2b7fff',
};

function graphFixture(): ErGraphResult {
  return {
    tables: [
      {
        name: 'users',
        columns: [
          { name: 'id', dataType: 'bigint', isPrimaryKey: true },
          { name: 'room_id', dataType: 'bigint', isPrimaryKey: false },
        ],
      },
      {
        name: 't<特殊>&表',
        columns: [{ name: 'id', dataType: 'int', isPrimaryKey: true }],
      },
    ],
    edges: [
      {
        sourceTable: 'users',
        sourceColumns: ['room_id'],
        targetTable: 't<特殊>&表',
        targetColumns: ['id'],
      },
    ],
    layout: {
      nodes: [
        { table: 'users', x: 0, y: 0, width: 200, height: 74 },
        { table: 't<特殊>&表', x: 280, y: 0, width: 200, height: 52 },
      ],
      width: 480,
      height: 74,
      nodeWidth: 200,
      headerHeight: 30,
      rowHeight: 22,
      padBottom: 6,
      layerGapX: 80,
      nodeGapY: 24,
    },
    tableCount: 2,
    hiddenEdges: 0,
  };
}

const baseInput = {
  graph: graphFixture(),
  positions: {},
  expanded: {},
  displayMode: 'full' as const,
  palette,
};

describe('buildErSvg（ER 导出，交互稿 §13.9）', () => {
  it('根节点：40px 留白 + 背景色（布局宽高 + 80）', () => {
    const svg = buildErSvg(baseInput);
    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('width="560"');
    expect(svg).toContain('height="154"');
    expect(svg).toContain('viewBox="-40 -40 560 154"');
    expect(svg).toContain(`fill="${palette.background}"`);
  });

  it('节点：标题/列名/类型文本 + PK/FK 标记 + 面板描边', () => {
    const svg = buildErSvg(baseInput);
    expect(svg).toContain('users');
    expect(svg).toContain('room_id');
    expect(svg).toContain('bigint');
    expect(svg).toContain('class="er-pk"');
    // room_id 被 FK 边引用 → FK 标记
    expect(svg).toContain('class="er-fk"');
    expect(svg).toContain(`fill="${palette.panel}"`);
    expect(svg).toContain(`stroke="${palette.border}"`);
  });

  it('文本 XML 转义（表名含 < > & 不破坏结构）', () => {
    const svg = buildErSvg(baseInput);
    expect(svg).toContain('t&lt;特殊&gt;&amp;表');
    expect(svg).not.toContain('t<特殊>');
  });

  it('边：复用 edgeGeometry 几何（与画布同源，高度按展开行数重算）', () => {
    const svg = buildErSvg(baseInput);
    // 与画布 edgeGeomOf 同口径：高度 = header 30 + rows×22 + padBottom 6
    const g = edgeGeometry(
      { x: 0, y: 0, width: 200, height: 30 + 2 * 22 + 6 },
      { x: 280, y: 0, width: 200, height: 30 + 1 * 22 + 6 },
    );
    expect(svg).toContain(`<path d="${g.d}"`);
  });

  it('紧凑档：不渲染列行，标题栏计数显示', () => {
    const svg = buildErSvg({ ...baseInput, displayMode: 'compact' });
    expect(svg).not.toContain('>bigint<');
    expect(svg).toContain('2 列');
  });

  it('截断尾行：+N 列…（link 色）', () => {
    const g = graphFixture();
    g.tables[0].columnsTruncated = 5;
    const svg = buildErSvg({ ...baseInput, graph: g });
    expect(svg).toContain('+5 列…');
    expect(svg).toContain(`fill="${palette.link}"`);
  });

  it('拖拽位置覆盖 layout 基准位', () => {
    const svg = buildErSvg({
      ...baseInput,
      positions: { users: { x: 111, y: 222 } },
    });
    expect(svg).toContain('translate(111 222)');
  });
});

describe('utf8ToBase64', () => {
  it('CJK 与拉丁安全（可解码还原）', () => {
    const b64 = utf8ToBase64('用户 users<>&');
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe('用户 users<>&');
  });
});
