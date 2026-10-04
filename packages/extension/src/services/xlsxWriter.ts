import * as fs from 'node:fs';
import ExcelJS from 'exceljs';

/**
 * xlsx 流式写出（概要设计 §5.7 / D-14 选型 exceljs）：逐批写入 WorkbookWriter，
 * 大结果集内存有界。与导出管线解耦（纯模块，无 vscode 依赖，可单测），
 * 后续如需替换 xlsx 实现不动 ResultExporter。
 */

export interface XlsxColumn {
  name: string;
  width?: number;
}

/**
 * 逐批写 xlsx 文件。header 为列定义；batches 依次喂行数据（每批 = 一次 fetchRows 的页）。
 * 单元格值映射：null/undefined → 空串（Excel 无独立 NULL 语义）；其余原样（number/boolean/string；
 * 对象（json 列）JSON.stringify，与 CSV/JSON 导出的展示口径一致）。
 */
export async function writeXlsxFile(
  target: string,
  columns: XlsxColumn[],
  batches: AsyncIterable<unknown[][]> | Iterable<unknown[][]>,
): Promise<{ rows: number; bytes: number }> {
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: target });
  const sheet = workbook.addWorksheet('data', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  sheet.columns = columns.map((c) => ({
    header: c.name,
    key: c.name,
    width: c.width ?? Math.min(Math.max(c.name.length + 4, 10), 40),
  }));

  let rows = 0;
  const feed = async (row: unknown[]): Promise<void> => {
    sheet.addRow(row.map(toCell)).commit();
    rows++;
  };

  for await (const batch of batches) {
    for (const row of batch) {
      await feed(row);
    }
  }
  sheet.commit();
  await workbook.commit();

  const bytes = await fs.promises
    .stat(target)
    .then((s) => s.size)
    .catch(() => 0);
  return { rows, bytes };
}

function toCell(v: unknown): string | number | boolean {
  if (v === null || v === undefined) {
    return '';
  }
  if (typeof v === 'number' || typeof v === 'boolean') {
    return v;
  }
  if (typeof v === 'object') {
    return JSON.stringify(v); // json 类型列（契约 §4.4：已解析对象）→ JSON 文本
  }
  return String(v);
}
