import type { ResultSet } from '../model/rows';

/**
 * 单元格传输截断（ADR D-30，概要设计 §4.4 / 驱动规范 §5）：
 * fetchRows 回包在 Host 传输层按 `dbExplorer.edit.cellMaxChars` 对**字符串形态**
 * 单元格（text + binary base64）做前缀截断，被截断单元格的坐标以
 * `ResultSet.truncatedCells` 旁路承载——C-7 值形状保持纯净（带内包装会与
 * JSON 已解析对象同形，且导出/乐观锁等「真实值」消费方都必须拆包）。
 * 驱动永不产生截断标记；JSON/对象单元格不截断（不可前缀切分，见 D-30 岔口 2）。
 */

/** §13 设计默认值（262144 = 256K 字符） */
export const DEFAULT_CELL_MAX_CHARS = 262144;

/** 二进制 base64 前缀按 4 字符对齐（base64 编码单元），保持可解码形态 */
function cutBinaryPrefix(value: string, maxChars: number): string {
  const aligned = maxChars - (maxChars % 4);
  return value.slice(0, aligned);
}

/** 文本前缀切分；避免切在代理对中间产生孤立代理项 */
function cutTextPrefix(value: string, maxChars: number): string {
  const cut = value.slice(0, maxChars);
  const last = cut.charCodeAt(cut.length - 1);
  if (cut.length > 0 && last >= 0xd800 && last <= 0xdbff) {
    return cut.slice(0, -1);
  }
  return cut;
}

export interface TruncateCellsResult {
  /** 无截断时原样返回入参 rs（零拷贝） */
  rs: ResultSet;
  /** 被截断单元格坐标 [rowIndex, colIndex]；无截断 = 空数组 */
  truncatedCells: Array<[number, number]>;
}

/** 对结果集做单元格截断。maxChars 非正/非法时视为配置异常，跳过截断（fail-safe，
 *  防御 0/负值把整页截成空前缀）；调用方（rpcHost）另有 contributes minimum 兜底。 */
export function truncateResultSetCells(rs: ResultSet, maxChars: number): TruncateCellsResult {
  if (!Number.isFinite(maxChars) || maxChars <= 0) {
    return { rs, truncatedCells: [] };
  }
  const truncatedCells: Array<[number, number]> = [];
  const rows = rs.rows.map((row, r) => {
    let rowChanged = false;
    const nextRow = row.map((value, c) => {
      if (typeof value !== 'string' || value.length <= maxChars) {
        return value;
      }
      const isBinary = rs.columns[c]?.type === 'binary';
      const prefix = isBinary ? cutBinaryPrefix(value, maxChars) : cutTextPrefix(value, maxChars);
      truncatedCells.push([r, c]);
      rowChanged = true;
      return prefix;
    });
    return rowChanged ? nextRow : row;
  });
  if (truncatedCells.length === 0) {
    return { rs, truncatedCells };
  }
  return { rs: { ...rs, rows, truncatedCells }, truncatedCells };
}
