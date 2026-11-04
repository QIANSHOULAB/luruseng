// 填进公司表（Song 2026-11-01 拍板 1A：直接写进原来那本）。
// 公司那本 TOOL BROKEN RECORD 里有公式（BTMP = TOTAL、FAILED = TOTAL − PASSED）、SETTER 下拉单、批注；
// 整本读出来再写会把这些弄丢，所以拆开 xlsx 直接改 XML：只往最后一条记录下面的行里塞值，别的一个字节不碰。
// 不要 No.、不要颜色、不要核对提示（Song：「不要标记，人核对哪些都不要」）。
// 公司表最后一条在第 33 行，这批的 1 就填第 34 行（Song：「公司表格编号33结尾我们的1就是34」）。
import { FIELDS, findHeader, labelKey, mkey, skel, nkey } from './core.js';
import './strings.js';

const t = (k, v) => globalThis.LURU_I18N.t(k, v);

const SHEET_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';
const SHEET_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet';
// 月份页的名字：照公司那本的叫法（JULY、AUG、SEPT、OCT）
export const MONTH_SHEET = ['', 'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUNE', 'JULY', 'AUG', 'SEPT', 'OCT', 'NOV', 'DEC'];
const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
const KEY_FIELDS = ['date', 'machine', 'part_number', 'mo', 't_no', 'setter'];   // 这几格有字才算一条记录
const ILLEGAL = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
const NOFOLD = { createFolders: false };          // 别往压缩包里加文件夹条目：原表里没有

export class FillError extends Error {}

// ---------------------------------------------------------------- XML 小工具
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function unesc(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}
const startTag = (xml) => xml.slice(0, xml.indexOf('>') + 1);
function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? m[1] : null;
}
export function colNum(letters) { let n = 0; for (const ch of letters) n = n * 26 + ch.charCodeAt(0) - 64; return n; }
export function colName(n) { let s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; }
export function monthOfSheet(name) {                  // JULY → 7、SEPT → 9；XX、NAME → null
  const m = String(name || '').trim().toUpperCase().match(/^([A-Z]{3})/);
  return m ? MONTHS[m[1]] || null : null;
}
export function serial(d) { return Math.round((Date.UTC(d.y, d.m - 1, d.d) - Date.UTC(1899, 11, 30)) / 86400000); }
const texts = (xml) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unesc(m[1])).join('');

export function sharedStrings(xml) {
  return xml ? [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1])) : [];
}

// 一页拆成：sheetData 前面、每一行（原样留着）、sheetData 后面
export function parseSheet(xml) {
  if (/<\w+:sheetData\b/.test(xml)) throw new FillError(t('fill.errNs'));
  const a = xml.indexOf('<sheetData');
  if (a < 0) throw new FillError(t('fill.errNoData'));
  let head, body, tail;
  const self = xml.slice(a).match(/^<sheetData\s*\/>/);
  if (self) {
    head = xml.slice(0, a) + '<sheetData>';
    body = '';
    tail = '</sheetData>' + xml.slice(a + self[0].length);
  } else {
    const open = xml.indexOf('>', a) + 1, b = xml.indexOf('</sheetData>');
    head = xml.slice(0, open); body = xml.slice(open, b); tail = xml.slice(b);
  }
  const rows = new Map();
  for (const m of body.matchAll(/<row\b[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g)) {
    const r = +attr(startTag(m[0]), 'r');
    if (!r) throw new FillError(t('fill.errNoRow'));
    rows.set(r, { r, xml: m[0], touched: false });
  }
  return { head, tail, rows };
}

function rowCells(row) {                              // -> [{col, xml}]
  const inner = row.xml.endsWith('/>') && !row.xml.includes('</row>') ? '' : row.xml.slice(startTag(row.xml).length, -'</row>'.length);
  return [...inner.matchAll(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g)].map((m) => {
    const ref = attr(startTag(m[0]), 'r') || '';
    return { col: colNum(ref.replace(/\d+/g, '')), xml: m[0] };
  });
}

export function cellText(cxml, shared) {
  const tag = startTag(cxml);
  const t = attr(tag, 't');
  if (t === 'inlineStr') { const m = cxml.match(/<is>([\s\S]*?)<\/is>/); return m ? texts(m[1]) : ''; }
  const v = cxml.match(/<v>([\s\S]*?)<\/v>/);
  if (!v) return '';
  return t === 's' ? (shared[+v[1]] ?? '') : unesc(v[1]);
}

function serializeSheet(sheet) {
  const body = [...sheet.rows.values()].sort((a, b) => a.r - b.r).map((r) => r.xml).join('');
  return sheet.head + body + sheet.tail;
}

// ---------------------------------------------------------------- 一页的样子：表头在哪、哪列是哪个字段、最后一条记录在哪
function layout(sheet, shared) {
  const matrix = [];
  for (let r = 1; r <= 15; r++) {
    const row = sheet.rows.get(r);
    const cells = [];
    if (row) for (const c of rowCells(row)) cells[c.col - 1] = cellText(c.xml, shared);
    matrix.push(Array.from(cells, (v) => v ?? ''));
  }
  const hdr = findHeader(matrix);
  if (!hdr) return null;
  const [start, cols] = hdr;
  const colOf = {};
  for (const [c, f] of cols) colOf[f] = c + 1;
  const dataStart = start + 1;
  let last = 0;
  const keys = new Set();
  for (const row of sheet.rows.values()) {
    if (row.r < dataStart) continue;
    const vals = {};
    for (const c of rowCells(row)) for (const f of FIELDS) if (colOf[f] === c.col) vals[f] = cellText(c.xml, shared);
    if (KEY_FIELDS.some((f) => String(vals[f] ?? '').trim())) {
      last = Math.max(last, row.r);
      keys.add(rowKey(vals));
    }
  }
  return { colOf, dataStart, last, keys };
}

// 同一条记录：这一行每一格都一样（写法上的差别不算：VM-07 = VM-7、零件号的横杠、工号后面带不带名字、150 = 150.0、Day = D）。
// 只比日期、机台、零件号、MO、刀号不够：同一天同一把刀断两回（工序、班次、调试员、数量不一样）是两条，不能当一条吞掉
const numKey = (v) => { const t = String(v ?? '').trim(); return /^-?\d+(\.\d+)?$/.test(t) ? String(Number(t)) : nkey(t); };
function rowKey(v) {
  const d = v.date;
  const date = d && typeof d === 'object' && 'm' in d ? String(serial(d)) : /^\d+(\.0+)?$/.test(String(d ?? '').trim()) ? String(parseInt(d, 10)) : nkey(d ?? '');
  const mo = String(v.mo ?? '').replace(/\D/g, '');
  return [date, mkey(v.machine ?? ''), skel(v.part_number ?? ''), mo, numKey(v.opr_no), nkey(v.t_no ?? ''), nkey(v.description ?? ''),
    numKey(v.total_screened), numKey(v.passed), numKey(v.failed), nkey(v.shift ?? '').slice(0, 1), nkey(String(v.setter ?? '').split('/')[0])].join('|');
}

function newCell(ref, style, v, fxml) {
  const s = style != null ? ` s="${style}"` : '';
  const f = fxml || '';
  if (v === '' || v === null || v === undefined) return f ? `<c r="${ref}"${s}>${f}</c>` : `<c r="${ref}"${s}/>`;
  if (typeof v === 'object' && 'm' in v) return `<c r="${ref}"${s}>${f}<v>${serial(v)}</v></c>`;
  if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${s}>${f}<v>${v}</v></c>`;
  const text = esc(String(v).replace(ILLEGAL, ''));
  if (f) return `<c r="${ref}"${s} t="str">${f}<v>${text}</v></c>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
}

// 把一条记录写进第 r 行：样式照最后一条记录那行（底下提前画好的空行有的格式不一样，日期会变成数字），
// 那一行原来的公式照留，别的列不碰。
// -> 写进去的值（带公式的格子除外）：[[列号, 读回来的字], …]——下回再填这批时靠它认出这一行（Excel 存一遍以后读回来还是这些字）
function writeRow(sheet, r, values, look, template) {
  const old = sheet.rows.get(r);
  const cells = new Map((old ? rowCells(old) : []).map((c) => [c.col, c.xml]));
  const tpl = new Map(template ? rowCells(template).map((c) => [c.col, c.xml]) : []);
  const wrote = [];
  for (const f of FIELDS) {
    const col = look.colOf[f];
    if (!col) continue;
    const was = cells.get(col);
    const style = attr(startTag(tpl.get(col) || was || '<c>'), 's');
    const fm = was && was.match(/<f\b[^>]*?(?:\/>|>[\s\S]*?<\/f>)/);
    const cx = newCell(`${colName(col)}${r}`, style, values[f], fm ? fm[0] : '');
    cells.set(col, cx);
    if (!fm) wrote.push([col, cellText(cx, [])]);
  }
  const body = [...cells.entries()].sort((a, b) => a[0] - b[0]).map(([, x]) => x).join('');
  let open;
  if (old) open = startTag(old.xml).replace(/\s*\/>$/, '>').replace(/\sspans="[^"]*"/, '');
  else {
    const t = template ? startTag(template.xml).replace(/\s*\/>$/, '>') : '<row>';
    open = t.replace(/\s(r|spans)="[^"]*"/g, '').replace(/^<row/, `<row r="${r}"`);
  }
  sheet.rows.set(r, { r, xml: `${open}${body}</row>`, touched: true });
  return wrote.sort((a, b) => a[0] - b[0]);
}

function rowTexts(row, cols, shared) {               // 这一行这几列现在是什么字
  const by = new Map(rowCells(row).map((c) => [c.col, c.xml]));
  return cols.map((col) => [col, by.has(col) ? cellText(by.get(col), shared) : '']);
}
const sameCells = (a, b) => a.length === b.length && a.every(([c, t], i) => b[i] && b[i][0] === c && b[i][1] === t);

// 新的一个月：照上个月那页的样子新建一页（表头、格式、SETTER 下拉单照抄，数据、公式、批注不抄）
function blankMonth(xml, dataStart) {
  const sheet = parseSheet(xml);
  for (const row of sheet.rows.values()) {
    if (row.r < dataStart) continue;
    const open = startTag(row.xml).replace(/\s*\/>$/, '>');
    const cells = rowCells(row).map((c) => {
      const s = attr(startTag(c.xml), 's');
      return `<c r="${colName(c.col)}${row.r}"${s != null ? ` s="${s}"` : ''}/>`;
    });
    row.xml = `${open}${cells.join('')}</row>`;
  }
  let out = serializeSheet(sheet);
  out = out.replace(/<(legacyDrawing|legacyDrawingHF|drawing|picture)\b[^>]*\/>/g, '')
    .replace(/<(tableParts|hyperlinks|oleObjects|controls)\b[\s\S]*?<\/\1>/g, '')
    .replace(/\s+tabSelected="[^"]*"/g, '')
    .replace(/(<sheetPr\b[^>]*?)\s+codeName="[^"]*"/, '$1')
    .replace(/(<pageSetup\b[^>]*?)\s+r:id="[^"]*"/g, '$1')
    .replace(/\sxr:uid="\{[^}]*\}"/g, () => ` xr:uid="{${uuid()}}"`);
  return out;
}

function uuid() {
  const h = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// SETTER 下拉单只画到第 182 行，记录写到更下面：把下拉单跟着往下拉
function stretchLists(xml, letter, upto) {
  const grow = (ranges) => {
    let best = null;
    for (const m of ranges.matchAll(new RegExp(`\\b${letter}(\\d+):${letter}(\\d+)\\b`, 'g'))) if (!best || +m[2] > +best[2]) best = m;
    if (!best || +best[2] >= upto) return ranges;
    return ranges.replace(best[0], `${letter}${best[1]}:${letter}${upto}`);
  };
  return xml.replace(/(<xm:sqref>)([^<]*)(<\/xm:sqref>)/g, (_, a, r, b) => a + grow(r) + b)
    .replace(/(<dataValidation\b[^>]*\ssqref=")([^"]*)(")/g, (_, a, r, b) => a + grow(r) + b);
}

const resolve = (target) => (target.startsWith('/') ? target.slice(1) : `xl/${target}`).replace(/\/\.\//g, '/');

// ---------------------------------------------------------------- 主流程
// bytes：公司那本（ArrayBuffer / Uint8Array）；rows：这批的记录（run.rows 里 kind === 'rec' 的，按编号排好）；
// before：这批上回填进这本时记下的 placed（没填过就不给）；sure：上回确实写进了这本（手机上那种下载了让人自己换的，给 false）
// -> {bytes（没东西要写就是 null）, report: [{sheet, from, to, n, created}]（新添的行）, total: 新添几条,
//     updated: [{no, sheet, r}]（上回填的、这回就地改了的）, kept: [编号]（上回填的、表里那行后来有人改过或删了：不动）,
//     dup: 表里本来就有的条数, twins: [[编号, 编号]], placed: [{no, sheet, cells}]（存着，下回再填这批时给 before）}
export async function fillBook(bytes, rows, { JSZip, before = null, sure = true }) {
  const zip = await JSZip.loadAsync(bytes);
  const read = async (p) => { const f = zip.file(p); return f ? f.async('string') : null; };
  let wbXml = await read('xl/workbook.xml');
  let relsXml = await read('xl/_rels/workbook.xml.rels');
  let ctXml = await read('[Content_Types].xml');
  if (!wbXml || !relsXml || !ctXml) throw new FillError(t('fill.errNotXlsx'));
  const shared = sharedStrings(await read('xl/sharedStrings.xml'));
  const rels = new Map([...relsXml.matchAll(/<Relationship\b[^>]*>/g)].map((m) => [attr(m[0], 'Id'), m[0]]));
  const sheets = [...wbXml.matchAll(/<sheet\b[^>]*\/>/g)].map((m) => {
    const rid = attr(m[0], 'r:id');
    return { name: unesc(attr(m[0], 'name') || ''), id: +attr(m[0], 'sheetId'), rid, path: resolve(attr(rels.get(rid) || '', 'Target') || '') };
  });
  // 记录页：有 DATE、MACHINE 表头、名字是月份的那几页
  const months = [];
  for (const s of sheets) {
    const m = monthOfSheet(s.name);
    if (!m || !zip.file(s.path)) continue;
    const xml = await read(s.path);
    const look = layout(parseSheet(xml), shared);
    if (look) months.push({ ...s, month: m, xml, look });
  }
  if (!months.length) throw new FillError(t('fill.errNoMonth'));
  const recs = rows.filter((r) => r && r.kind === 'rec' && r.values);
  const parsed = new Map();                          // 路径 -> 拆开的页：改都改在这上面，最后一起写回去
  const sheetOf = (t) => { if (!parsed.has(t.path)) parsed.set(t.path, parseSheet(t.xml)); return parsed.get(t.path); };
  const dirty = new Set();                           // 改过的页
  const placed = new Map((before || []).filter((p) => p && Array.isArray(p.cells)).map((p) => [p.no, p]));
  const report = [], twins = [], updated = [], kept = [];
  let dup = 0, total = 0;

  // 上回从这批填进这本的（没核完也让填：填完再核、再点一下是常事）：
  // 那一行还是上回填的样子 → 就地改成现在核好的；找不到（有人在 Excel 里改过、删了）→ 不动它，也不另起一行。
  // sure === false（手机上是下载一本填好的、让人自己换掉原来那本）：上回填的一行都找不着，多半是没换——当没填过
  const hits = new Map(), claimed = new Set();
  for (const rec of recs) {
    const p = placed.get(rec.no);
    if (!p) continue;
    const target = months.find((s) => s.name === p.sheet);
    let at = null;
    if (target) {
      const cols = p.cells.map(([c]) => c);
      for (const row of [...sheetOf(target).rows.values()].sort((a, b) => a.r - b.r)) {
        if (row.r < target.look.dataStart || claimed.has(`${target.path}#${row.r}`)) continue;
        if (sameCells(rowTexts(row, cols, shared), p.cells)) { at = row; break; }
      }
    }
    if (at) claimed.add(`${target.path}#${at.r}`);
    hits.set(rec.no, at && { target, at });
  }
  if (!sure && hits.size && [...hits.values()].every((h) => !h)) { for (const no of hits.keys()) placed.delete(no); hits.clear(); }
  const fresh = [];
  for (const rec of recs) {
    if (!hits.has(rec.no)) { fresh.push(rec); continue; }
    const hit = hits.get(rec.no);
    if (!hit) { kept.push(rec.no); continue; }
    const { target, at } = hit;
    const p = placed.get(rec.no);
    const sheet = sheetOf(target);
    const cells = writeRow(sheet, at.r, rec.values, target.look, at);
    if (sameCells(cells, p.cells)) { sheet.rows.set(at.r, at); continue; }   // 没改过：那一行原样留着
    dirty.add(target.path);
    updated.push({ no: rec.no, sheet: target.name, r: at.r });
    placed.set(rec.no, { no: rec.no, sheet: target.name, cells });
  }

  // 没填过的：照日期进哪个月；日期认不成的跟着这批大多数的月份走
  const mOf = (r) => (r.values.date && typeof r.values.date === 'object' ? r.values.date.m : null);
  const count = new Map();
  for (const r of recs) if (mOf(r)) count.set(mOf(r), (count.get(mOf(r)) || 0) + 1);
  const usual = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || months[months.length - 1].month;
  const groups = new Map();
  for (const r of fresh) {
    const m = mOf(r) || usual;
    if (!groups.has(m)) groups.set(m, []);
    groups.get(m).push(r);
  }
  const seen = new Map();                            // 这批里两条一模一样的（可能同一张单子拍了两次）：都填，提一句
  let nextSheetId = Math.max(...sheets.map((s) => s.id || 0)) + 1;
  let nextRid = Math.max(0, ...[...rels.keys()].map((k) => +String(k).replace(/\D/g, '') || 0)) + 1;
  let nextFile = Math.max(0, ...zip.file(/^xl\/worksheets\/sheet\d+\.xml$/).map((f) => +f.name.match(/(\d+)\.xml$/)[1])) + 1;
  for (const [m, list] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    let target = [...months].reverse().find((s) => s.month === m);
    let created = false;
    if (!target) {                                   // 还没有这个月那一页：照最后一个月那页新建，放在最后
      const tpl = months[months.length - 1];
      const name = MONTH_SHEET[m];
      if (sheets.some((s) => s.name.toUpperCase() === name)) throw new FillError(t('fill.errClash', { name }));
      const path = `xl/worksheets/sheet${nextFile++}.xml`;
      const rid = `rId${nextRid++}`;
      const xml = blankMonth(tpl.xml, tpl.look.dataStart);
      zip.file(path, xml, NOFOLD);
      wbXml = wbXml.replace(/<\/sheets>/, `<sheet name="${esc(name)}" sheetId="${nextSheetId++}" r:id="${rid}"/></sheets>`);
      relsXml = relsXml.replace(/<\/Relationships>/, `<Relationship Id="${rid}" Type="${SHEET_REL}" Target="worksheets/${path.split('/').pop()}"/></Relationships>`);
      ctXml = ctXml.replace(/<\/Types>/, `<Override PartName="/${path}" ContentType="${SHEET_TYPE}"/></Types>`);
      target = { name, path, month: m, xml, look: layout(parseSheet(xml), shared) };
      months.push(target);
      created = true;
    }
    const sheet = sheetOf(target);
    const look = dirty.has(target.path) ? layout(sheet, shared) : target.look;
    const template = sheet.rows.get(look.last) || sheet.rows.get(look.dataStart) || null;
    let r = Math.max(look.last + 1, look.dataStart);
    const from = r;
    let n = 0;
    for (const rec of list) {
      const k = rowKey(rec.values);
      if (look.keys.has(k)) { dup++; continue; }      // 公司表里本来就有（别处填过、人手敲过）：不重复填
      if (seen.has(k)) twins.push([seen.get(k), rec.no]); else seen.set(k, rec.no);
      placed.set(rec.no, { no: rec.no, sheet: target.name, cells: writeRow(sheet, r, rec.values, look, template) });
      r++; n++;
    }
    if (n) {
      dirty.add(target.path);
      report.push({ sheet: target.name, from, to: r - 1, n, created });
      total += n;
    } else if (created) {
      report.push({ sheet: target.name, from, to: from - 1, n: 0, created });
    }
  }
  const out = { report, dup, total, twins, updated, kept, placed: [...placed.values()].sort((a, b) => a.no - b.no) };
  if (!total && !updated.length && !report.some((x) => x.created)) return { bytes: null, ...out };
  for (const path of dirty) {
    const t = months.find((s) => s.path === path);
    let xml = serializeSheet(parsed.get(path));
    const maxRow = Math.max(...[...xml.matchAll(/<row\b[^>]*\sr="(\d+)"/g)].map((m) => +m[1]));
    const maxCol = colName(Math.max(...Object.values(t.look.colOf)));
    xml = xml.replace(/<dimension ref="([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?"\s*\/>/, (all, c1, r1, c2, r2) =>
      (r2 && +r2 >= maxRow ? all : `<dimension ref="${c1}${r1}:${c2 && colNum(c2) > colNum(maxCol) ? c2 : maxCol}${Math.max(+(r2 || 0), maxRow)}"/>`));
    const setter = t.look.colOf.setter;
    if (setter) xml = stretchLists(xml, colName(setter), maxRow);
    zip.file(path, xml, NOFOLD);
  }
  // 公式缓存的值可能旧了：打开时让 Excel 整本重算；计算链删掉，Excel 自己重建（不删的话可能弹「修复」）
  if (/<calcPr\b/.test(wbXml)) {
    wbXml = wbXml.replace(/<calcPr\b([^>]*?)\s*\/>/, (all, a) => (/fullCalcOnLoad=/.test(a) ? all.replace(/fullCalcOnLoad="[^"]*"/, 'fullCalcOnLoad="1"') : `<calcPr${a} fullCalcOnLoad="1"/>`));
  } else if (/<\/definedNames>/.test(wbXml)) {
    wbXml = wbXml.replace(/<\/definedNames>/, '</definedNames><calcPr fullCalcOnLoad="1"/>');
  } else {
    wbXml = wbXml.replace(/<\/sheets>/, '</sheets><calcPr fullCalcOnLoad="1"/>');
  }
  if (zip.file('xl/calcChain.xml')) {
    zip.remove('xl/calcChain.xml');
    relsXml = relsXml.replace(/<Relationship\b[^>]*Target="[^"]*calcChain\.xml"[^>]*\/>/g, '');
    ctXml = ctXml.replace(/<Override\b[^>]*PartName="\/xl\/calcChain\.xml"[^>]*\/>/g, '');
  }
  zip.file('xl/workbook.xml', wbXml, NOFOLD);
  zip.file('xl/_rels/workbook.xml.rels', relsXml, NOFOLD);
  zip.file('[Content_Types].xml', ctXml, NOFOLD);
  const bytesOut = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return { bytes: bytesOut, ...out };
}

// 给人看的一句：OCT 第 33–43 行（11 条）；NOV（新建的一页）第 4–5 行（2 条）
export function reportLine(report) {
  return report.filter((x) => x.n).map((x) => t('fill.rows', { sheet: x.sheet, created: x.created ? t('fill.created') : '', from: x.from,
    to: x.to > x.from ? `–${x.to}` : '', n: x.n })).join(t('fill.sep'));
}

// 「✓ 填进 X：」后面那半句：新添的、就地改的、本来就有的、没敢动的、一模一样的
export function fillLine(res) {
  const parts = [];
  const add = reportLine(res.report);
  if (add) parts.push(add);
  if (res.updated && res.updated.length) {
    const by = new Map();
    for (const u of res.updated) { if (!by.has(u.sheet)) by.set(u.sheet, []); by.get(u.sheet).push(u.r); }
    const where = [...by].map(([s, rs]) => t('fill.where', { sheet: s, rows: rs.sort((a, b) => a - b).join(t('list.sep')) })).join(t('fill.sep2'));
    parts.push(t('fill.updated', { n: res.updated.length, where }));
  }
  if (res.dup) parts.push(t('fill.dup', { n: res.dup }));
  if (res.kept && res.kept.length) parts.push(t('fill.kept', { nos: res.kept.join(t('list.sep')) }));
  if (res.twins && res.twins.length) parts.push(t('fill.twins', { nos: res.twins.map((p) => p.join(t('list.sep'))).join(t('fill.sep2')) }));
  return parts.join(t('fill.sep'));
}

export { labelKey };
