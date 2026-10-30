// 放入数据库读表（sheets.js）：.xlsx / .xls / .csv（GBK、UTF-8、UTF-16、分号）/ 网页导出的假 .xls / 坏表
// 跑：node --test web/test/sheets.test.mjs（.xlsx、.xls 样本用 python 现做：要 openpyxl、xlwt）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as C from '../core.js';
import * as SH from '../sheets.js';

const require = createRequire(import.meta.url);
const XLSX = require('../vendor/xlsx.full.min.js');
const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'luruseng-sheets-'));
const load = async () => XLSX;

function file(name, bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return { name, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
}
function gbk(text) {                          // 只给测试用：常用的几个汉字转 GBK
  const map = { 日: [0xc8, 0xd5], 期: [0xc6, 0xda], 机: [0xbb, 0xfa], 台: [0xcc, 0xa8], 数: [0xca, 0xfd], 量: [0xc1, 0xbf],
    检: [0xbc, 0xec], 验: [0xd1, 0xe9], 员: [0xd4, 0xb1], 张: [0xd5, 0xc5], 三: [0xc8, 0xfd], 李: [0xc0, 0xee], 四: [0xcb, 0xc4] };
  const out = [];
  for (const ch of text) { if (map[ch]) out.push(...map[ch]); else out.push(...Buffer.from(ch)); }
  return Buffer.from(out);
}

let books = null;
function companyBooks() {
  if (books) return books;
  const py = `
import sys, os
sys.path.insert(0, ${JSON.stringify(path.join(root, 'tests'))}); sys.path.insert(0, ${JSON.stringify(root)})
from test_kb import company_book
from test_formats import to_xls
b = company_book(os.path.join(${JSON.stringify(tmp)}, 'c.xlsx'))
to_xls(b, os.path.join(${JSON.stringify(tmp)}, 'c.xls'))
`;
  execFileSync('python3', ['-c', py]);
  books = ['c.xlsx', 'c.xls'].map((n) => file(n, fs.readFileSync(path.join(tmp, n))));
  return books;
}

test('company book: .xlsx and old .xls read the same, dates right in any time zone', async () => {
  const [x, xls] = companyBooks();
  const a = C.readWorkbook(await SH.readSheets(x, load));
  const b = C.readWorkbook(await SH.readSheets(xls, load));
  assert.equal(a.recs.length, 8);
  assert.deepEqual(a.recs.map(([, r]) => C.recordKey(r)), b.recs.map(([, r]) => C.recordKey(r)));
  assert.equal(a.recs[0][1].date, '2026-10-01');
  assert.deepEqual(new Map(a.people), new Map(b.people));
  const db = { records: [], people: [] };
  assert.equal(C.feedKb(db, await SH.readSheets(x, load), 'c.xlsx').added, 8);
  assert.equal(C.feedKb(db, await SH.readSheets(xls, load), 'c.xls').added, 0);       // 同一本存成老格式：不重复吃
});

test('csv in GBK, UTF-8 with BOM, UTF-16 and with semicolons', async () => {
  const body = '日期,机台,数量,检验员\n28/10,VM-07,5,张三\n29/10,VM-14,7,李四\n';
  const variants = [
    ['gbk.csv', gbk(body)],
    ['utf8.csv', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body)])],
    ['utf16.csv', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body.replace(/,/g, '\t'), 'utf16le')])],
    ['semi.csv', Buffer.from(body.replace(/,/g, ';'))],
  ];
  for (const [name, bytes] of variants) {
    const db = { columns: [], records: [] };
    const r = C.feedTable(db, await SH.readSheets(file(name, bytes), load), name);
    assert.equal(r.error, '', name);
    assert.equal(r.added, 2, name);
    assert.deepEqual(db.columns, ['日期', '机台', '数量', '检验员'], name);
    assert.equal(db.records[1].data['检验员'], '李四', name);
  }
});

test('quoted csv cells keep their commas and quotes', () => {
  const rows = SH.parseCsv('a,b\n"x, y","say ""hi"""\n');
  assert.deepEqual(rows, [['a', 'b'], ['x, y', 'say "hi"']]);
});

test('web page saved as .xls is read; broken, locked-looking and wrong files say why', async () => {
  const html = '<html><body><table><tr><td>DATE</td><td>MACHINE</td><td>PART NUMBER</td><td>MO</td><td>T NO.</td><td>SETTER</td></tr>' +
    '<tr><td>29/10</td><td>VM-32</td><td>TD-2</td><td>82660001</td><td>T5</td><td>701/Kumar</td></tr></table></body></html>';
  const r = C.feedKb({ records: [], people: [] }, await SH.readSheets(file('导出.xls', html), load), '导出.xls');
  assert.equal(r.added, 1);
  await assert.rejects(SH.readSheets(file('坏.xls', Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(100, 120)])), load), /坏了/);
  await assert.rejects(SH.readSheets(file('scan.pdf', '%PDF-1.4'), load), /只认/);
  await assert.rejects(SH.readSheets(file('空.xls', Buffer.from([0, 1, 2, 0, 0, 0, 9])), load), /不是 Excel 文件/);
  assert.match(SH.why(new Error('x')), /读不了/);
});
