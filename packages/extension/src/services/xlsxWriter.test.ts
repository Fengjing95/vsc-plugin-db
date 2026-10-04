import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { writeXlsxFile } from './xlsxWriter';

/** 读回校验用：用 exceljs 完整读出（小文件，非流式）。row.values 是稀疏数组（空单元格为洞），Array.from 补齐 */
async function readXlsx(file: string): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const sheet = wb.worksheets[0]!;
  const out: string[][] = [];
  for (let r = 1; r <= sheet.rowCount; r++) {
    const values = sheet.getRow(r).values;
    // exceljs 的 Row.values 类型是数组 | 键值对象联合（读回场景恒为数组），收窄后再取洞
    const arr = Array.isArray(values) ? values : [];
    out.push(
      Array.from(arr.slice(1), (v) => (v === undefined || v === null ? '' : String(v))),
    );
  }
  return out;
}

describe('writeXlsxFile（D-14 exceljs 流式写）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbx-xlsx-'));
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('表头 + 多批行写入，读回一致', async () => {
    const target = path.join(dir, 'a.xlsx');
    const result = await writeXlsxFile(target, [{ name: 'id' }, { name: 'name' }, { name: 'amount' }], [
      [[1, '张三', '13.50']],
      [[2, null, '27.00'], [3, "it's", '40.50']],
    ]);
    expect(result.rows).toBe(3);
    expect(result.bytes).toBeGreaterThan(0);
    const grid = await readXlsx(target);
    expect(grid[0]).toEqual(['id', 'name', 'amount']);
    expect(grid[1]).toEqual(['1', '张三', '13.50']);
    expect(grid[2]).toEqual(['2', '', '27.00']); // NULL → 空串
    expect(grid[3]).toEqual(["3", "it's", '40.50']);
  });

  it('数字/布尔保持原生类型、对象列 JSON 文本化', async () => {
    const target = path.join(dir, 'b.xlsx');
    await writeXlsxFile(target, [{ name: 'n' }, { name: 'ok' }, { name: 'meta' }], [
      [[42, true, { a: 1 }]],
    ]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(target);
    const row = wb.worksheets[0].getRow(2);
    expect(row.getCell(1).value).toBe(42);
    expect(row.getCell(2).value).toBe(true);
    expect(row.getCell(3).value).toBe('{"a":1}');
  });

  it('空结果：仅表头，行数 0', async () => {
    const target = path.join(dir, 'c.xlsx');
    const result = await writeXlsxFile(target, [{ name: 'x' }], []);
    expect(result.rows).toBe(0);
    const grid = await readXlsx(target);
    expect(grid).toEqual([['x']]);
  });
});
