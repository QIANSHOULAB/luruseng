// 读表：放入数据库认的几种格式，统一变成 [[页名, 行[]]]（跟电脑版 bangong/sheets.py 一个意思）
// .xlsx / .xlsm / .xls 交给 SheetJS；.csv 自己认编码（UTF-8、Excel 中文版的 GBK、「Unicode 文本」的 UTF-16）和分隔符。
// 别的系统「导出 Excel」出来的假 .xls：其实是 .xlsx、老 .xls、文字表的照读；网页（HTML）导出的也交给 SheetJS 读。

export const EXTS = ['.xlsx', '.xlsm', '.xls', '.csv'];
export const ACCEPT = '.xlsx,.xlsm,.xls,.csv';
export const UNSUPPORTED = '只认 .xlsx、.xlsm、.xls 和 .csv（照片、PDF、Word 不吃：数据库只认人核对过的表）';
const NOT_EXCEL = '不是 Excel 文件，打不开：用 Excel 打开看看，能打开就另存为 .xlsx 再放';
const LOCKED = '这本表加了密码，打不开：用 Excel 打开、去掉密码另存一份再放';
const BROKEN = '这本表坏了，打不开：用 Excel 打开看看，能打开就另存为 .xlsx 再放';

export class SheetError extends Error {}

export function supported(name) {
  const n = String(name || '').toLowerCase();
  return EXTS.some((e) => n.endsWith(e));
}

export function decode(bytes, strict = false) {
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) {
    try { return new TextDecoder(bytes[0] === 0xff ? 'utf-16le' : 'utf-16be', { fatal: true }).decode(bytes.subarray(2)); } catch (e) { /* 往下试 */ }
  }
  const head = bytes.subarray(0, 4096);
  if (!(strict && head.includes(0))) {
    for (const enc of ['utf-8', 'gb18030']) {
      try {
        let t = new TextDecoder(enc, { fatal: true }).decode(bytes);
        if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
        return t;
      } catch (e) { /* 下一个 */ }
    }
  }
  return strict ? null : new TextDecoder('windows-1252').decode(bytes);
}

function sniff(text) {                       // 逗号、分号、Tab：前几行里数量最稳定的那个
  const lines = text.slice(0, 4096).split(/\r?\n/).filter((l) => l.trim()).slice(0, 10);
  let best = ',', score = -1;
  for (const d of ['\t', ';', ',']) {
    const counts = lines.map((l) => l.split(d).length - 1);
    if (!counts.length || !counts[0]) continue;
    const same = counts.filter((c) => c === counts[0]).length;
    const s = same * 100 + counts[0];
    if (s > score) { score = s; best = d; }
  }
  return best;
}

export function parseCsv(text) {
  const d = sniff(text);
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"' && cell === '') q = true;
    else if (ch === d) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => (c.trim() ? c : null)));
}

function stem(name) { return String(name || '').replace(/\.[^.]+$/, ''); }

function cellOf(XLSX, cell, date1904) {
  if (!cell || cell.v === undefined || cell.v === null || cell.t === 'e' || cell.t === 'z') return null;
  if (cell.t === 'n' && cell.z && XLSX.SSF.is_date(cell.z)) {
    // 日期自己从序号算，不让 SheetJS 转：它按 1899 年的时区换算，新加坡会差 25 秒，零点的日期就成了前一天
    const d = XLSX.SSF.parse_date_code(cell.v, { date1904 });
    if (d && d.y) return new Date(d.y, d.m - 1, d.d, d.H || 0, d.M || 0, Math.floor(d.S || 0));
  }
  if (cell.t === 'd' && cell.v instanceof Date) return cell.v;
  return cell.v;
}

function viaSheetJS(XLSX, data, type) {
  let wb;
  try {
    wb = XLSX.read(data, { type, cellNF: true, cellDates: false, dense: false });
  } catch (e) {
    const msg = String(e && e.message || e).toLowerCase();
    throw new SheetError(/password|encrypt/.test(msg) ? LOCKED : BROKEN);
  }
  const date1904 = !!(wb.Workbook && wb.Workbook.WBProps && wb.Workbook.WBProps.date1904);
  return wb.SheetNames.map((nm) => {
    const ws = wb.Sheets[nm];
    let maxR = -1, maxC = -1;                 // 按真有东西的格子算范围（有的表声明自己一百万行）
    for (const k of Object.keys(ws || {})) {
      if (k[0] === '!') continue;
      const a = XLSX.utils.decode_cell(k);
      if (a.r > maxR) maxR = a.r;
      if (a.c > maxC) maxC = a.c;
    }
    const rows = [];
    for (let r = 0; r <= maxR; r++) {         // 跟电脑版一样从 A1 读起
      const row = [];
      for (let c = 0; c <= maxC; c++) row.push(cellOf(XLSX, ws[XLSX.utils.encode_cell({ r, c })], date1904));
      rows.push(row);
    }
    return [nm, rows];
  });
}

export async function readSheets(file, loadXLSX) {
  const name = file.name || '';
  if (!supported(name)) throw new SheetError(UNSUPPORTED);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (name.toLowerCase().endsWith('.csv')) return [[stem(name), parseCsv(decode(bytes))]];   // CSV 只当文字读
  const PK = bytes[0] === 0x50 && bytes[1] === 0x4b;
  const OLE2 = bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
  if (PK || OLE2) return viaSheetJS(await loadXLSX(), bytes, 'array');
  const text = decode(bytes, true);
  if (text === null || !text.trim()) throw new SheetError(NOT_EXCEL);
  if (text.trimStart().startsWith('<')) {     // 网页导出的「假 Excel」：SheetJS 认得 HTML 表格
    const sheets = viaSheetJS(await loadXLSX(), text, 'string');
    if (sheets.some(([, rows]) => rows.length)) return sheets;
    throw new SheetError(NOT_EXCEL);
  }
  return [[stem(name), parseCsv(text)]];
}

export function why(e) {
  return e instanceof SheetError ? e.message : `读不了：${(e && e.name) || 'Error'}：${(e && e.message) || e}`;
}
