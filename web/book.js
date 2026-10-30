// 出表：跟电脑版 RecordBook（刀单，长得跟公司那本 TOOL BROKEN RECORD 一样）和 TableBook（自建类别）一格不差
import { FIELDS, NOTE_HEAD, copyValue } from './core.js';
import { loadScript } from './image.js';

const EXCELJS = new URL('./vendor/exceljs.min.js', import.meta.url).href;
const MONTH_TAB = ['', 'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const WIDTHS = [6, 9, 10, 22, 11, 9, 7, 13, 7, 16, 9, 9, 7, 28, 40];
const LEFT_FIELDS = new Set(['part_number', 'mo', 'opr_no', 'setter']);

const solid = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const thin = { style: 'thin', color: { argb: '00808080' } };
const BOX = { top: thin, left: thin, bottom: thin, right: thin };
const HEAD_FILL = solid('00DDEBF7'), YELLOW = solid('00FFE699'), RED_FILL = solid('00FFC7CE');
const GREY_FILL = solid('00EDEDED'), ORANGE_FILL = solid('00FCE4D6');
const BASE_FONT = { name: 'Calibri', size: 11 }, BOLD = { name: 'Calibri', size: 11, bold: true };
const RED_FONT = { name: 'Calibri', size: 11, color: { argb: '009C0006' } };
const ORANGE_FONT = { name: 'Calibri', size: 11, color: { argb: '00833C0B' } };
const GREY_SMALL = { name: 'Calibri', size: 10, color: { argb: '00808080' } };
const CENTER = { horizontal: 'center', vertical: 'middle', wrapText: true };
const LEFT = { horizontal: 'left', vertical: 'middle' };
const ILLEGAL = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;   // Excel 不认的控制字符

export function colLetter(n) {
  let s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function cellValue(v) {
  if (v === '' || v === null || v === undefined) return null;
  if (typeof v === 'object' && 'm' in v) return new Date(Date.UTC(v.y, v.m - 1, v.d));   // 日期：Excel 认得出的真日期
  if (typeof v === 'string') return v.replace(ILLEGAL, '');
  return v;
}

function put(ws, r, c, v) {
  const cell = ws.getCell(r, c);
  cell.value = cellValue(v);
  return cell;
}

function landscape(ws, titles) {
  ws.pageSetup.orientation = 'landscape';      // 打印：横向、一页宽
  ws.pageSetup.fitToPage = true;
  ws.pageSetup.fitToWidth = 1;
  ws.pageSetup.fitToHeight = 0;
  ws.pageSetup.printTitlesRow = titles;
}

export function sheetName(run) {
  if (run.cat !== '刀单') return (String(run.cat).replace(/[\\/*?:[\]]/g, '') || 'RECORD').slice(0, 31);
  for (const r of run.rows) {
    const d = r.kind === 'rec' && r.values.date;
    if (d && typeof d === 'object' && d.m) return MONTH_TAB[d.m];
  }
  return 'RECORD';
}

function recordBook(ExcelJS, run) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName(run), { views: [{ state: 'frozen', xSplit: 1, ySplit: 3 }] });
  ws.mergeCells(1, 1, 1, 14);
  const t = put(ws, 1, 1, 'TOOL BROKEN RECORD');
  t.font = { name: 'Calibri', size: 26 };
  t.alignment = CENTER;
  ws.getRow(1).height = 40;
  const single = [[1, 'No.'], [2, 'DATE'], [3, 'MACHINE'], [4, 'PART NUMBER'], [5, 'MO'], [6, 'OPR NO.'],
    [9, 'BTMP'], [13, 'SHIFT'], [14, 'SETTER'], [15, '核对提示（不用贴进公司表）']];
  for (const [c, name] of single) { ws.mergeCells(2, c, 3, c); put(ws, 2, c, name); }
  ws.mergeCells(2, 7, 2, 8);
  put(ws, 2, 7, 'TOOL'); put(ws, 3, 7, 'T NO.'); put(ws, 3, 8, 'DESCRIPTION');
  ws.mergeCells(2, 10, 2, 12);
  put(ws, 2, 10, 'CONTAINMENT/SCREENING DETAIL');
  put(ws, 3, 10, 'TOTAL SCREENED'); put(ws, 3, 11, 'PASSED'); put(ws, 3, 12, 'FAILED');
  for (const r of [1, 2, 3]) {
    for (let c = 1; c <= 14; c++) {
      const cell = ws.getCell(r, c);
      cell.fill = HEAD_FILL;
      if (r > 1) { cell.font = BOLD; cell.alignment = CENTER; cell.border = BOX; }
    }
  }
  for (const r of [2, 3]) { const n = ws.getCell(r, 15); n.font = GREY_SMALL; n.alignment = CENTER; }
  // ExcelJS 把宽 9 当成「默认」不写进文件，Excel 就按 8.43 显示：差一丁点它才老实写
  WIDTHS.forEach((w, i) => { ws.getColumn(i + 1).width = w === 9 ? 9.000001 : w; });
  let r = 3;
  for (const row of run.rows) {
    r++;
    const no = put(ws, r, 1, row.no);
    no.alignment = CENTER; no.border = BOX; no.font = BOLD;
    if (row.kind === 'blank') {
      const fill = row.fill === 'grey' ? GREY_FILL : RED_FILL;
      for (let c = 2; c <= 14; c++) { const cell = ws.getCell(r, c); cell.fill = fill; cell.border = BOX; }
      const n = put(ws, r, 15, row.note);
      n.font = row.fill === 'grey' ? BASE_FONT : RED_FONT;
      n.alignment = LEFT;
      continue;
    }
    const red = new Set(row.red), orange = new Set(row.orange);
    FIELDS.forEach((f, i) => {
      const cell = put(ws, r, 2 + i, row.values[f]);
      cell.border = BOX;
      cell.font = BASE_FONT;
      cell.alignment = LEFT_FIELDS.has(f) ? LEFT : CENTER;
      if (f === 'date' && cell.value instanceof Date) cell.numFmt = 'd-mmm';
      if (f === 'btmp') cell.fill = YELLOW;
      if (orange.has(f)) { cell.fill = ORANGE_FILL; cell.font = ORANGE_FONT; }
      if (red.has(f)) { cell.fill = RED_FILL; cell.font = RED_FONT; }
    });
    if (row.notes) {
      const n = put(ws, r, 15, row.notes);
      n.font = red.size ? RED_FONT : ORANGE_FONT;
      n.alignment = LEFT;
    }
  }
  const last = Math.max(r, 4);
  ws.autoFilter = `A3:N${last}`;
  landscape(ws, '1:3');
  ws.pageSetup.printArea = `A1:N${last}`;
  return wb;
}

function tableBook(ExcelJS, run) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName(run), { views: [{ state: 'frozen', xSplit: 1, ySplit: 2 }] });
  const cols = run.columns || [];
  const noteCol = 2 + cols.length;
  ws.mergeCells(1, 1, 1, Math.max(noteCol - 1, 2));
  const t = put(ws, 1, 1, run.cat);
  t.font = { name: 'Calibri', size: 20, bold: true };
  t.alignment = CENTER;
  ws.getRow(1).height = 34;
  ['No.', ...cols, `${NOTE_HEAD}（不用贴进你们的表）`].forEach((h, i) => {
    const cell = put(ws, 2, i + 1, h);
    cell.fill = HEAD_FILL; cell.font = BOLD; cell.alignment = CENTER; cell.border = BOX;
  });
  ws.getCell(2, noteCol).font = GREY_SMALL;
  let r = 2;
  for (const row of run.rows) {
    r++;
    const no = put(ws, r, 1, row.no);
    no.alignment = CENTER; no.border = BOX; no.font = BOLD;
    const whole = row.kind === 'blank' ? row.fill : '';
    const fill = whole === 'red' ? RED_FILL : whole === 'grey' ? GREY_FILL : null;
    const red = new Set(row.red || []), orange = new Set(row.orange || []);
    const values = row.values || {};
    cols.forEach((c, i) => {
      const cell = put(ws, r, 2 + i, values[c] ?? '');
      cell.border = BOX; cell.font = BASE_FONT; cell.alignment = CENTER;
      if (fill) cell.fill = fill;
      if (orange.has(c)) { cell.fill = ORANGE_FILL; cell.font = ORANGE_FONT; }
      if (red.has(c)) { cell.fill = RED_FILL; cell.font = RED_FONT; }
    });
    const note = row.kind === 'blank' ? row.note : row.notes;
    if (note) {
      const n = put(ws, r, noteCol, note);
      n.font = red.size || whole === 'red' ? RED_FONT : orange.size ? ORANGE_FONT : BASE_FONT;
      n.alignment = LEFT;
    }
  }
  ws.getColumn(1).width = 6;
  cols.forEach((c, i) => {
    const longest = Math.max(String(c).length, ...run.rows.slice(0, 200).map((row) => String((row.values || {})[c] ?? '').length));
    ws.getColumn(2 + i).width = Math.min(40, Math.max(8, longest * 1.2 + 2));
  });
  ws.getColumn(noteCol).width = 40;
  const last = Math.max(2 + run.rows.length, 3);
  ws.autoFilter = `A2:${colLetter(Math.max(noteCol - 1, 2))}${last}`;
  landscape(ws, '1:2');
  return wb;
}

export async function xlsx(run, ExcelJS = null) {      // -> Blob
  const X = ExcelJS || await loadScript(EXCELJS, 'ExcelJS');
  const wb = run.cat === '刀单' ? recordBook(X, run) : tableBook(X, run);
  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

// 复制整批：只要认出来的记录（认失败的空行不要），一行一条，Tab 隔开，贴进公司表就行
export function tsv(run) {
  const cols = run.cat === '刀单' ? FIELDS : (run.columns || []);
  const lines = run.rows.filter((r) => r.kind === 'rec').map((r) => cols.map((c) => copyValue(r.values[c])).join('\t'));
  return [lines.join('\r\n'), lines.length];
}
