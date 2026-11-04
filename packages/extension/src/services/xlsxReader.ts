import ExcelJS from 'exceljs';

/**
 * xlsx 读侧（概要设计 §5.13 / ADR D-32）：首 sheet 表头行 + 数据行原值矩阵。
 * exceljs 读侧三坑（P-35）规避：不用 `Row.values`（稀疏数组 + 联合类型，逐格 getCell
 * 天然绕开 `Array.isArray` 收窄与 `Array.from` 补洞）；readFile 自带路径解析（P-48 同族，
 * 无 wasm 那类 CWD 兜底问题）。内存口径：readFile 整簿载入（Host 侧，C-13 满足），
 * 行数上限由调用方按 maxDataRows 截停物化。
 */

export interface XlsxSheetData {
  headers: string[];
  /** 数据行原值（string/number/boolean/Date/null），列序对齐 headers */
  rows: unknown[][];
}

export class XlsxEmptyError extends Error {
  constructor() {
    super('xlsx 文件没有工作表');
    this.name = 'XlsxEmptyError';
  }
}

/** 读取首 sheet：第 1 行 = 表头；空行跳过；物化到 maxDataRows 即停（上限判定在调用方） */
export async function readXlsxSheet(filePath: string, maxDataRows: number): Promise<XlsxSheetData> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    throw new XlsxEmptyError();
  }

  const headerRow = sheet.getRow(1);
  const headers: string[] = [];
  for (let c = 1; c <= headerRow.cellCount; c++) {
    const v = cellValue(headerRow.getCell(c));
    headers.push(v === null ? '' : String(v));
  }
  while (headers.length > 0 && headers[headers.length - 1] === '') {
    headers.pop();
  }
  const width = headers.length;
  if (width === 0) {
    return { headers: [], rows: [] };
  }

  const rows: unknown[][] = [];
  const lastRow = Math.min(sheet.rowCount, 1 + maxDataRows + 1);
  for (let r = 2; r <= lastRow; r++) {
    const row = sheet.getRow(r);
    const cells: unknown[] = [];
    let empty = true;
    for (let c = 1; c <= width; c++) {
      const v = cellValue(row.getCell(c));
      if (v !== null && v !== '') {
        empty = false;
      }
      cells.push(v);
    }
    if (empty) {
      continue;
    }
    rows.push(cells);
    if (rows.length >= maxDataRows + 1) {
      break; // 多读一行供调用方判定「超限」，物化到此为止
    }
  }
  return { headers, rows };
}

/** exceljs 单元格值归一：公式取结果、富文本/超链接取文本、错误取原文；Date 原样（转换层按列类型格式化） */
function cellValue(cell: ExcelJS.Cell): unknown {
  const v = cell.value;
  if (v === null || v === undefined) {
    return null;
  }
  if (typeof v !== 'object') {
    return v; // string / number / boolean
  }
  if (v instanceof Date) {
    return v;
  }
  const obj = v as unknown as Record<string, unknown>;
  if ('result' in obj && obj.result !== undefined) {
    return cellValue2(obj.result);
  }
  if ('error' in obj && obj.error !== undefined) {
    return String(obj.error);
  }
  if ('richText' in obj && Array.isArray(obj.richText)) {
    return (obj.richText as Array<{ text?: string }>).map((rt) => rt.text ?? '').join('');
  }
  if ('text' in obj) {
    return String(obj.text);
  }
  return String(v);
}

/** 公式结果的递归归一（结果本身也可能是富文本/对象） */
function cellValue2(v: unknown): unknown {
  if (v === null || v === undefined) {
    return null;
  }
  if (typeof v !== 'object') {
    return v;
  }
  if (v instanceof Date) {
    return v;
  }
  return String(v);
}
