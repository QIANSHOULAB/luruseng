// 填进公司表（web/fill.js）：拿一本照公司那本的样子手搭的假表（名字、零件、机台全是编的）来填，查只动该动的地方。
import './zh.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as F from '../fill.js';

const require = createRequire(import.meta.url);
const JSZip = require('../vendor/jszip.min.js');

const SS = ['TOOL BROKEN RECORD', 'DATE', 'MACHINE ', 'PART NUMBER', 'MO', 'OPR NO.', 'TOOL', 'BTMP', 'CONTAINMENT/SCREENING DETAIL', 'SHIFT', 'SETTER',
  'T NO.', 'DESCRIPTION', 'TOTAL SCREENED', 'PASSED', 'FAILED', 'QM-7', 'PX-101202-5', 'T4', 'EM2.5', 'D', '9471/TAN AH MENG', 'EM=END MILL',
  'Employee Name / ID', 'MACHINE', 'OPERATION'];
const s = (t) => SS.indexOf(t);
const str = (ref, st, t) => `<c r="${ref}" s="${st}" t="s"><v>${s(t)}</v></c>`;
const num = (ref, st, v) => `<c r="${ref}" s="${st}"><v>${v}</v></c>`;
const empty = (ref, st) => `<c r="${ref}" s="${st}"/>`;

function record(r, date) {                       // 公司那本里的一条：H、K 是普通值
  return `<row r="${r}" spans="1:13">${num(`A${r}`, 3, date)}${str(`B${r}`, 1, 'QM-7')}${str(`C${r}`, 1, 'PX-101202-5')}${num(`D${r}`, 2, 90001000 + r)}` +
    `${num(`E${r}`, 2, 150)}${str(`F${r}`, 4, 'T4')}${str(`G${r}`, 4, 'EM2.5')}${num(`H${r}`, 6, 1)}${num(`I${r}`, 4, 1)}${num(`J${r}`, 4, 1)}` +
    `${num(`K${r}`, 4, 0)}${str(`L${r}`, 4, 'D')}${str(`M${r}`, 12, '9471/TAN AH MENG')}</row>`;
}
function blank(r, { formulas = false, stray = false, dateStyle = 3 } = {}) {   // 提前画好框的空行；有的带公式，有一行孤零零填了 TOTAL
  const h = formulas ? (r === 7 ? `<c r="H${r}" s="6"><f t="shared" ref="H7:H9" si="0">I7</f><v>0</v></c>` : `<c r="H${r}" s="6"><f t="shared" si="0"/><v>0</v></c>`) : empty(`H${r}`, 6);
  const k = formulas ? (r === 7 ? `<c r="K${r}" s="4"><f t="shared" ref="K7:K9" si="1">I7-J7</f><v>0</v></c>` : `<c r="K${r}" s="4"><f t="shared" si="1"/><v>0</v></c>`)
    : stray ? `<c r="K${r}" s="4"><f>I${r}-J${r}</f><v>1</v></c>` : empty(`K${r}`, 4);
  const i = stray ? num(`I${r}`, 4, 1) : empty(`I${r}`, 4);
  return `<row r="${r}" spans="1:13">${empty(`A${r}`, dateStyle)}${empty(`B${r}`, 1)}${empty(`C${r}`, 1)}${empty(`D${r}`, 2)}${empty(`E${r}`, 2)}` +
    `${empty(`F${r}`, 4)}${empty(`G${r}`, 4)}${h}${i}${empty(`J${r}`, 4)}${k}${empty(`L${r}`, 4)}${empty(`M${r}`, 12)}</row>`;
}
const HEAD = `<row r="1" spans="1:15" ht="34.5" customHeight="1">${str('A1', 18, 'TOOL BROKEN RECORD')}</row>` +
  `<row r="2" spans="1:15">${str('A2', 20, 'DATE')}${str('B2', 20, 'MACHINE ')}${str('C2', 20, 'PART NUMBER')}${str('D2', 20, 'MO')}${str('E2', 20, 'OPR NO.')}` +
  `${str('F2', 20, 'TOOL')}${empty('G2', 20)}${str('H2', 20, 'BTMP')}${str('I2', 20, 'CONTAINMENT/SCREENING DETAIL')}${empty('J2', 20)}${empty('K2', 20)}` +
  `${str('L2', 20, 'SHIFT')}${str('M2', 21, 'SETTER')}${str('O2', 0, 'EM=END MILL')}</row>` +
  `<row r="3" spans="1:15">${empty('A3', 20)}${str('F3', 7, 'T NO.')}${str('G3', 7, 'DESCRIPTION')}${str('I3', 7, 'TOTAL SCREENED')}${str('J3', 7, 'PASSED')}${str('K3', 7, 'FAILED')}</row>`;
const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ' +
  'xmlns:xr="http://schemas.microsoft.com/office/spreadsheetml/2014/revision" mc:Ignorable="xr" xr:uid="{D3B0BC23-3890-44E4-A577-A3E099C0587A}"';
const DV = '<extLst><ext uri="{CCE6A557-97BC-4b89-ADB6-D9C93CAAB3DF}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main">' +
  '<x14:dataValidations count="1" xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main"><x14:dataValidation type="list" allowBlank="1" ' +
  'xr:uid="{F2D553F8-3A2D-40D3-8DDB-C89A2CF71A53}"><x14:formula1><xm:f>NAME!$A$2:$A$41</xm:f></x14:formula1><xm:sqref>M4:M12</xm:sqref>' +
  '</x14:dataValidation></x14:dataValidations></ext></extLst>';
const D1 = 46296;                                 // 2026-10-01

function octSheet() {
  const rows = HEAD + record(4, D1) + record(5, D1 + 1) + record(6, D1 + 2) +
    [7, 8, 9].map((r) => blank(r, { formulas: true })).join('') + blank(10) + blank(11, { stray: true }) + blank(12, { dateStyle: 1 });
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet ${NS}><sheetPr codeName="Sheet6"/><dimension ref="A1:O12"/>` +
    '<sheetViews><sheetView tabSelected="1" workbookViewId="0"><pane ySplit="3" topLeftCell="A4" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    `<sheetFormatPr defaultRowHeight="15"/><cols><col min="1" max="1" width="7.14" customWidth="1"/></cols><sheetData>${rows}</sheetData>` +
    '<mergeCells count="2"><mergeCell ref="F2:G2"/><mergeCell ref="I2:K2"/></mergeCells>' +
    '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/><pageSetup orientation="landscape" r:id="rId1"/>' +
    `<legacyDrawing r:id="rId2"/>${DV}</worksheet>`;
}
const NAME_SHEET = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet ${NS.replace(/ xr:uid="[^"]*"/, '')}><dimension ref="A1:E2"/><sheetData>` +
  `<row r="1">${str('A1', 0, 'Employee Name / ID')}${str('C1', 0, 'MACHINE')}${str('E1', 0, 'OPERATION')}</row>` +
  `<row r="2">${str('A2', 0, '9471/TAN AH MENG')}${str('C2', 0, 'QM-7')}${num('E2', 0, 150)}</row></sheetData></worksheet>`;

async function companyBook() {
  const z = new JSZip();
  const put = (p, d) => z.file(p, d, { createFolders: false });   // Excel 存的表里没有文件夹条目
  put('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="vml" ContentType="application/vnd.openxmlformats-officedocument.vmlDrawing"/><Default Extension="bin" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.printerSettings"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
    '<Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/>' +
    '<Override PartName="/xl/comments1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"/></Types>');
  put('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  put('xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="1"/></bookViews><sheets>' +
    '<sheet name="NAME" sheetId="5" r:id="rId1"/><sheet name="OCT" sheetId="10" r:id="rId2"/></sheets>' +
    '<definedNames><definedName name="_xlnm.Print_Titles" localSheetId="1">OCT!$1:$3</definedName></definedNames><calcPr calcId="191029"/></workbook>');
  put('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>' +
    '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>' +
    '<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain" Target="calcChain.xml"/></Relationships>');
  put('xl/sharedStrings.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${SS.length}" uniqueCount="${SS.length}">` +
    SS.map((t) => `<si><t xml:space="preserve">${t}</t></si>`).join('') + '</sst>');
  put('xl/worksheets/sheet1.xml', NAME_SHEET);
  put('xl/worksheets/sheet2.xml', octSheet());
  put('xl/worksheets/_rels/sheet2.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/printerSettings" Target="../printerSettings/printerSettings1.bin"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing" Target="../drawings/vmlDrawing1.vml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="../comments1.xml"/></Relationships>');
  put('xl/printerSettings/printerSettings1.bin', new Uint8Array([1, 2, 3]));
  put('xl/drawings/vmlDrawing1.vml', '<xml/>');
  put('xl/comments1.xml', '<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors><author>x</author></authors><commentList/></comments>');
  put('xl/calcChain.xml', '<calcChain xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><c r="H7" i="2"/><c r="K7" i="2"/></calcChain>');
  return z.generateAsync({ type: 'uint8array' });
}

const D = (m, d) => ({ y: 2026, m, d });
function row(no, kw = {}) {
  return { no, kind: 'rec', red: [], orange: [], notes: '', values: {
    date: D(10, 30), machine: 'QM-12', part_number: 'PX-333-444-01-A', mo: 90004004, opr_no: 150, t_no: `T${no}`, description: 'EM3',
    btmp: 1, total_screened: 1, passed: 1, failed: 0, shift: 'N', setter: '9556/HOO PENG', ...kw } };
}
async function open(bytes) {
  const z = await JSZip.loadAsync(bytes);
  const get = async (p) => (z.file(p) ? z.file(p).async('string') : null);
  return { z, get, names: Object.keys(z.files) };
}
const rowXml = (xml, r) => (xml.match(new RegExp(`<row r="${r}"[^>]*?(?:/>|>[\\s\\S]*?</row>)`)) || [null])[0];

test('接着最后一条往下填：值照写、样式照最后一条那行、公式照留，别的不碰', async () => {
  const before = await companyBook();
  const old = await open(before);
  const rows = [row(1), row(2, { failed: 1, passed: 0, setter: '9441' }), { no: 3, kind: 'blank', note: 'x' }, row(4, { description: 'FACEMILL Φ40 R0.8 & <x>' })];
  const res = await F.fillBook(before, rows, { JSZip });
  assert.deepEqual(res.report, [{ sheet: 'OCT', from: 7, to: 9, n: 3, created: false }]);
  assert.equal(res.total, 3); assert.equal(res.dup, 0); assert.deepEqual(res.twins, []);
  assert.equal(F.reportLine(res.report), 'OCT 第 7–9 行（3 条）');
  const now = await open(res.bytes);
  const oldOct = await old.get('xl/worksheets/sheet2.xml'), oct = await now.get('xl/worksheets/sheet2.xml');
  for (const r of [1, 2, 3, 4, 5, 6, 10, 11, 12]) assert.equal(rowXml(oct, r), rowXml(oldOct, r), `第 ${r} 行不该动`);
  const r7 = rowXml(oct, 7);
  assert.ok(r7.startsWith('<row r="7">'), r7);                                          // spans 拿掉了
  assert.ok(r7.includes(`<c r="A7" s="3"><v>${F.serial(D(10, 30))}</v></c>`), r7);       // 日期：Excel 的日期数，样式照最后一条（日期格式）
  assert.ok(r7.includes('<c r="B7" s="1" t="inlineStr"><is><t xml:space="preserve">QM-12</t></is></c>'), r7);
  assert.ok(r7.includes('<c r="D7" s="2"><v>90004004</v></c>'), r7);
  assert.ok(r7.includes('<c r="H7" s="6"><f t="shared" ref="H7:H9" si="0">I7</f><v>1</v></c>'), r7);   // 公式照留，缓存的值换成这条的
  assert.ok(r7.includes('<c r="K7" s="4"><f t="shared" ref="K7:K9" si="1">I7-J7</f><v>0</v></c>'), r7);
  assert.ok(r7.includes('<c r="M7" s="12" t="inlineStr"><is><t xml:space="preserve">9556/HOO PENG</t></is></c>'), r7);
  assert.ok(rowXml(oct, 8).includes('<c r="H8" s="6"><f t="shared" si="0"/><v>1</v></c>'));
  assert.ok(rowXml(oct, 8).includes('<c r="M8" s="12" t="inlineStr"><is><t xml:space="preserve">9441</t></is></c>'));   // 没核完的也照填
  assert.ok(rowXml(oct, 9).includes('FACEMILL Φ40 R0.8 &amp; &lt;x&gt;'));
  assert.ok(!/<c r="N7"|<c r="A7"[^>]*s="1"/.test(oct));
  assert.ok(oct.includes('<dimension ref="A1:O12"/>') && oct.includes('<xm:sqref>M4:M12</xm:sqref>') && oct.includes('<legacyDrawing r:id="rId2"/>'));
  // 计算链删掉，打开时整本重算；别的部件一个字节不动
  assert.ok(!now.names.includes('xl/calcChain.xml'));
  assert.ok(!(await now.get('xl/_rels/workbook.xml.rels')).includes('calcChain') && !(await now.get('[Content_Types].xml')).includes('calcChain'));
  assert.ok((await now.get('xl/workbook.xml')).includes('<calcPr calcId="191029" fullCalcOnLoad="1"/>'));
  for (const p of ['xl/worksheets/sheet1.xml', 'xl/sharedStrings.xml', 'xl/comments1.xml', 'xl/worksheets/_rels/sheet2.xml.rels', '_rels/.rels']) {
    assert.equal(await now.get(p), await old.get(p), p);
  }
  assert.deepEqual(now.names.filter((n) => n.endsWith('/')), []);                       // 没往压缩包里加文件夹条目
  // 再填一遍：都已经在表里了，一条不填；这批里两条一模一样的：都填，提一句
  const again = await F.fillBook(res.bytes, rows, { JSZip });
  assert.equal(again.bytes, null); assert.equal(again.dup, 3); assert.equal(again.total, 0);
  const twins = await F.fillBook(before, [row(1), row(2), row(5, { t_no: 'T1' })], { JSZip });
  assert.deepEqual(twins.twins, [[1, 5]]); assert.equal(twins.total, 3);
});

test('写到提前画好的行外面：新行照最后一条的样子，范围和下拉单跟着往下拉', async () => {
  const rows = Array.from({ length: 8 }, (_, i) => row(i + 1));
  const res = await F.fillBook(await companyBook(), rows, { JSZip });
  assert.deepEqual(res.report, [{ sheet: 'OCT', from: 7, to: 14, n: 8, created: false }]);
  const oct = await (await open(res.bytes)).get('xl/worksheets/sheet2.xml');
  assert.ok(rowXml(oct, 11).includes('<c r="I11" s="4"><v>1</v></c>') && rowXml(oct, 11).includes('<f>I11-J11</f>'));   // 孤零零那行：值盖上，公式留着
  assert.ok(rowXml(oct, 12).includes(`<c r="A12" s="3"><v>`), rowXml(oct, 12));          // 空行的日期格式不对（s=1）：照最后一条那行的日期样式
  const r14 = rowXml(oct, 14);
  assert.ok(r14.startsWith('<row r="14">') && r14.includes('<c r="A14" s="3">') && r14.includes('<c r="M14" s="12" t="inlineStr">'), r14);
  assert.ok(oct.includes('<dimension ref="A1:O14"/>') && oct.includes('<xm:sqref>M4:M14</xm:sqref>'), oct.slice(0, 300));
  const order = [...oct.matchAll(/<row r="(\d+)"/g)].map((m) => +m[1]);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test('新的一个月：照上个月那页新建一页，数据、公式、批注不抄；认不成的日期跟着这批大多数的月份走', async () => {
  const rows = [row(1, { date: D(11, 2) }), row(2, { date: D(11, 3) }), row(3, { date: '13-51' }), row(4, { date: D(10, 31) })];
  const res = await F.fillBook(await companyBook(), rows, { JSZip });
  assert.deepEqual(res.report, [{ sheet: 'OCT', from: 7, to: 7, n: 1, created: false }, { sheet: 'NOV', from: 4, to: 6, n: 3, created: true }]);
  assert.equal(F.reportLine(res.report), 'OCT 第 7 行（1 条）；NOV（新建的一页） 第 4–6 行（3 条）');
  const now = await open(res.bytes);
  const wb = await now.get('xl/workbook.xml');
  assert.ok(wb.includes('<sheet name="NOV" sheetId="11" r:id="rId6"/></sheets>'), wb);
  assert.ok((await now.get('xl/_rels/workbook.xml.rels')).includes('<Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>'));
  assert.ok((await now.get('[Content_Types].xml')).includes('<Override PartName="/xl/worksheets/sheet3.xml"'));
  const nov = await now.get('xl/worksheets/sheet3.xml');
  assert.ok(!/r:id=|tabSelected|codeName|legacyDrawing|D3B0BC23|F2D553F8/.test(nov), nov.slice(0, 600));
  assert.ok(nov.includes('<xm:sqref>M4:M12</xm:sqref>') && nov.includes('<mergeCell ref="I2:K2"/>') && nov.includes('<pageSetup orientation="landscape"/>'));
  assert.equal(rowXml(nov, 2), rowXml(await (await open(await companyBook())).get('xl/worksheets/sheet2.xml'), 2));   // 表头原样
  assert.ok(rowXml(nov, 4).includes(`<v>${F.serial(D(11, 2))}</v>`));
  assert.ok(rowXml(nov, 6).includes('<is><t xml:space="preserve">13-51</t></is>'));         // 认不成的日期照原样写
  assert.ok(!rowXml(nov, 7).includes('<v>') && !rowXml(nov, 7).includes('<f'), rowXml(nov, 7));   // 上个月的数据、公式没抄过来
  assert.ok(!now.names.includes('xl/worksheets/_rels/sheet3.xml.rels'));
});

test('不像公司那本：说清楚', async () => {
  const z = await JSZip.loadAsync(await companyBook());
  z.file('xl/workbook.xml', (await z.file('xl/workbook.xml').async('string')).replace('name="OCT"', 'name="RECORD"'));
  await assert.rejects(F.fillBook(await z.generateAsync({ type: 'uint8array' }), [row(1)], { JSZip }), /找不到按月份分页/);
  await assert.rejects(F.fillBook(new Uint8Array([1, 2, 3]), [row(1)], { JSZip }));
  assert.equal(F.monthOfSheet('JULY'), 7); assert.equal(F.monthOfSheet('SEPT'), 9); assert.equal(F.monthOfSheet('XX'), null); assert.equal(F.monthOfSheet('NAME'), null);
});

async function edit(bytes, path, fn) {               // 模拟人在 Excel 里动了这本：改一个部件的 XML 再存回去
  const z = await JSZip.loadAsync(bytes);
  z.file(path, fn(await z.file(path).async('string')), { createFolders: false });
  return z.generateAsync({ type: 'uint8array' });
}

test('填完再核、再点一下：上回填的那几行就地改成核好的，不另起一行；人在 Excel 里改过的不动', async () => {
  const first = [row(1), row(2, { setter: '9441' }), row(3, { machine: 'VM-2' })];
  const a = await F.fillBook(await companyBook(), first, { JSZip });
  assert.deepEqual(a.placed.map((p) => [p.no, p.sheet]), [[1, 'OCT'], [2, 'OCT'], [3, 'OCT']]);
  assert.ok(a.placed[0].cells.every(([c]) => c !== 8 && c !== 11), '带公式的 H、K 不进指纹');
  // 核对里改了第 2 张的 SETTER（不在查重的键里）、第 3 张的机台（在键里）
  const fixed = [row(1), row(2, { setter: '9471/TAN AH MENG' }), row(3, { machine: 'QM-12' })];
  const b = await F.fillBook(a.bytes, fixed, { JSZip, before: a.placed });
  assert.deepEqual(b.updated, [{ no: 2, sheet: 'OCT', r: 8 }, { no: 3, sheet: 'OCT', r: 9 }]);
  assert.equal(b.total, 0); assert.equal(b.dup, 0); assert.deepEqual(b.kept, []); assert.deepEqual(b.report, []);
  assert.equal(F.fillLine(b), '上回填的改了 2 条（OCT 第 8、9 行）');
  const oct = await (await open(b.bytes)).get('xl/worksheets/sheet2.xml');
  assert.ok(rowXml(oct, 8).includes('9471/TAN AH MENG') && !rowXml(oct, 8).includes('9441'), rowXml(oct, 8));
  assert.ok(rowXml(oct, 9).includes('QM-12') && !rowXml(oct, 9).includes('VM-2'));
  assert.ok(rowXml(oct, 8).includes('<f t="shared" si="0"/>'), '公式还在');
  assert.ok(!rowXml(oct, 10).includes('<v>'), '没另起一行');
  // 再点一下、啥也没改：一个字节不写
  const c = await F.fillBook(b.bytes, fixed, { JSZip, before: b.placed });
  assert.equal(c.bytes, null); assert.deepEqual(c.updated, []); assert.deepEqual(c.kept, []);
  // Excel 存过一遍（行内字变成共享字符串）也认得出是自己填的那几行
  const resaved = await edit(b.bytes, 'xl/worksheets/sheet2.xml', (x) => x.replace(
    '<c r="B7" s="1" t="inlineStr"><is><t xml:space="preserve">QM-12</t></is></c>', `<c r="B7" s="1" t="s"><v>${SS.indexOf('QM-7')}</v></c>`));
  const z = await JSZip.loadAsync(resaved);
  z.file('xl/sharedStrings.xml', (await z.file('xl/sharedStrings.xml').async('string')).replace('<si><t xml:space="preserve">QM-7</t></si>', '<si><t>QM-12</t></si>'), { createFolders: false });
  const shared = await F.fillBook(await z.generateAsync({ type: 'uint8array' }), fixed, { JSZip, before: b.placed });
  assert.equal(shared.bytes, null, '换成共享字符串不算有人改过'); assert.deepEqual(shared.kept, []);
  // 人在 Excel 里把第 7 行的机台改了：这回第 1 张也改了，可那行不是上回填的样子了——不动它，也不另起一行
  const human = await edit(b.bytes, 'xl/worksheets/sheet2.xml', (x) => x.replace(
    '<c r="B7" s="1" t="inlineStr"><is><t xml:space="preserve">QM-12</t></is></c>', '<c r="B7" s="1" t="inlineStr"><is><t>QM-99</t></is></c>'));
  const d = await F.fillBook(human, [row(1, { mo: 90009999 }), ...fixed.slice(1)], { JSZip, before: b.placed });
  assert.deepEqual(d.kept, [1]); assert.equal(d.bytes, null); assert.equal(d.total, 0);
  assert.equal(F.fillLine(d), '第 1 张上回填过，表里那行后来有人改过或删了，没动它');
  assert.deepEqual(d.placed, b.placed, '没动的那条还记着：下回也不会另起一行');
  // 换了一本表（上回记的行一行都对不上）：照样不另起一行；要重填就用「下载」
  const other = await F.fillBook(await companyBook(), fixed, { JSZip, before: b.placed });
  assert.deepEqual(other.kept, [1, 2, 3]); assert.equal(other.bytes, null);
});

test('手机上那种（下载一本让人自己换）：上回填的一行都找不着，多半是没换——当没填过，照样往下填', async () => {
  const rows = [row(1), row(2)];
  const a = await F.fillBook(await companyBook(), rows, { JSZip });
  const notSwapped = await F.fillBook(await companyBook(), rows, { JSZip, before: a.placed, sure: false });
  assert.deepEqual(notSwapped.kept, []); assert.equal(notSwapped.total, 2);
  assert.deepEqual(notSwapped.report, [{ sheet: 'OCT', from: 7, to: 8, n: 2, created: false }]);
  const swapped = await F.fillBook(a.bytes, [row(1), row(2, { opr_no: 170 })], { JSZip, before: a.placed, sure: false });
  assert.deepEqual(swapped.updated, [{ no: 2, sheet: 'OCT', r: 8 }]); assert.equal(swapped.total, 0);
});

test('表里本来就有的才算重复：整行一样才算（工号带不带名字、VM-07 跟 VM-7、Day 跟 D 不算差别）；同一天同一把刀断两回、工序不一样，是两条', async () => {
  const same = row(1, { date: D(10, 1), machine: 'QM-07', part_number: 'PX1012025', mo: 90001004, opr_no: 150, t_no: 'T4', description: 'EM2.5',
    btmp: 1, total_screened: 1, passed: 1, failed: 0, shift: 'Day', setter: '9471' });
  const other = { ...same, no: 2, values: { ...same.values, opr_no: 170 } };
  const res = await F.fillBook(await companyBook(), [same, other], { JSZip });
  assert.equal(res.dup, 1); assert.equal(res.total, 1); assert.deepEqual(res.twins, []);
  assert.deepEqual(res.placed.map((p) => p.no), [2]);
  assert.equal(F.fillLine(res), 'OCT 第 7 行（1 条）；1 条表里本来就有，没重复填');
});
