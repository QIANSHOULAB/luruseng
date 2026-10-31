// 网页版核心的测试：跟电脑版 tests/test_engine.py、test_accuracy.py、test_kb.py、test_tables.py 对着写，规矩得一样。
// 跑法：node --test web/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../core.js';

const wrap = (t) => ({ candidates: [{ content: { parts: [{ text: t }] }, finishReason: 'STOP' }] });
const T = new Date(2026, 9, 29);

test('parse_date：日在前，年份一律按今年', () => {
  const p = (s) => { const d = C.parseDate(s, T); return d && `${d.y}-${d.m}-${d.d}`; };
  assert.equal(p('28/10'), '2026-10-28'); assert.equal(p('1-Oct'), '2026-10-1'); assert.equal(p('01-Oct-26'), '2026-10-1');
  assert.equal(p('28-10-26'), '2026-10-28'); assert.equal(p('28.10.2026'), '2026-10-28'); assert.equal(p('2026-10-28'), '2026-10-28');
  assert.equal(p('Oct 1'), '2026-10-1'); assert.equal(p('28 Oct'), '2026-10-28'); assert.equal(p('3/1'), '2026-1-3');
  assert.equal(p('15/12'), '2026-12-15'); assert.equal(p('28/10/1998'), '2026-10-28'); assert.equal(p('1998-10-28'), '2026-10-28');
  assert.equal(p('1-Oct-25'), '2026-10-1');
  assert.equal(p('31/02'), null); assert.equal(p('hello'), null); assert.equal(p(''), null);
});

test('太平洋时间半夜（每天额度刷新）', () => {
  const f = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);
  assert.equal(C.nextPacificMidnight(f(2026, 10, 29, 8)), f(2026, 10, 30, 7) + 30e3);
  assert.equal(C.nextPacificMidnight(f(2026, 11, 2, 8, 30)), f(2026, 11, 3, 8) + 30e3);
  assert.equal(C.nextPacificMidnight(f(2026, 11, 1, 5)), f(2026, 11, 1, 7) + 30e3);
  assert.equal(C.nextPacificMidnight(f(2027, 3, 14, 9)), f(2027, 3, 15, 7) + 30e3);
});

test('解析回来的 JSON：别名、unsure、标题在哪边', () => {
  let [recs] = C.parseResponse(wrap('```json\n{"records":[{"DATE":"1-Oct","T NO.":"T4","unsure":["T NO.","bogus"]},{"unsure":["date"]}]}\n```'));
  assert.equal(recs.length, 1); assert.equal(recs[0].date, '1-Oct'); assert.equal(recs[0].t_no, 'T4'); assert.equal(recs[0].setter, '');
  assert.deepEqual(recs[0].unsure, ['t_no']);
  assert.deepEqual(C.parseResponse(wrap('[]'))[0], []);
  assert.equal(C.parseResponse(wrap('{"date":"2/10","shift":"N"}'))[0][0].shift, 'N');
  assert.throws(() => C.parseResponse({ promptFeedback: { blockReason: 'SAFETY' } }), /SAFETY/);
  let side;
  [recs, side] = C.parseResponse(wrap('{"title_side": "Right", "records": [{"date": "1/10"}]}'));
  assert.equal(side, 'right'); assert.equal(recs[0].date, '1/10');
  assert.equal(C.parseResponse(wrap('{"title_side": "左边", "records": []}'))[1], 'left');
  assert.equal(C.parseResponse(wrap('[{"date": "1/10"}]'))[1], '');
});

test('整理格式不改内容：刀号、Φ、班次', () => {
  let r = C.cleanRecord({ date: '28/10', machine: 'vm - 12', part_number: 'TD-9155 513-2', mo: '8266 7003', opr_no: '130', t_no: 'T9',
    description: 'T44. m3 tap x2', btmp: '', total_screened: '1', passed: '1', failed: '0', shift: '白', setter: '232 / Yang' });
  assert.equal(r.machine, 'VM-12'); assert.equal(r.part_number, 'TD-9155513-2'); assert.equal(r.mo, '82667003');
  assert.equal(r.t_no, 'T9, T44'); assert.equal(r.description, 'M3 TAP X2'); assert.equal(r.shift, 'D'); assert.equal(r.setter, '232/Yang');
  r = C.cleanRecord({ ...r, t_no: '', description: 'T10. FACEMILL ø40 R0.8' });
  assert.equal(r.t_no, 'T10'); assert.equal(r.description, 'FACEMILL Φ40 R0.8');
  r = C.cleanRecord({ ...r, t_no: 'T6.T7', description: 'Φ 4 FMM X2' });
  assert.equal(r.t_no, 'T6, T7'); assert.equal(r.description, 'Φ4 FMM X2');
  r = C.cleanRecord({ ...r, t_no: '', description: 'TAP M3' });
  assert.equal(r.t_no, ''); assert.equal(r.description, 'TAP M3');
  assert.equal(C.cleanRecord({ ...r, shift: '夜班' }).shift, 'N');
  assert.equal(C.cleanRecord({ ...r, shift: 'Night' }).shift, 'N');
});

test('两遍对答案：多数定，不一样的记下来', () => {
  const a = [{ shift: 'D', date: '28/10', machine: 'VM-1', unsure: [] }];
  const b = [{ shift: 'N', date: '28-10-26', machine: 'vm-1', unsure: ['shift'] }];
  let out = C.vote([a, b, a]);
  assert.equal(out[0].shift, 'D'); assert.deepEqual(out[0].disputed, { shift: ['D', 'N'] }); assert.deepEqual(out[0].unsure, ['shift']);
  out = C.vote([[{ machine: 'A' }], [{ machine: 'B' }], [{ machine: 'C' }]]);
  assert.equal(out[0].machine, 'A'); assert.deepEqual(out[0].disputed.machine, ['A', 'B', 'C']);
  out = C.vote([[{ machine: 'A' }], [], [{ machine: 'A' }]]);
  assert.equal(out.length, 1); assert.deepEqual(out[0].counts, [1, 0, 1]); assert.deepEqual(out[0].disputed, {});
  assert.ok(C.recordsAgree([{ shift: 'Day' }], [{ shift: 'D' }]));
  assert.ok(!C.recordsAgree([{ shift: 'D' }], []));
  assert.equal(C.pickSide(['right', '', 'top', 'right']), 'right');
});

test('谷歌 429：等多久、哪一种', () => {
  assert.equal(C.retryDelay('[{"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "37s"}]'), 37);
  assert.equal(C.retryDelay('[]'), null);
  assert.equal(C.classify429(new C.ApiError(429, 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 20 PerDay')), 'day');
  assert.equal(C.classify429(new C.ApiError(429, 'Your prepayment credits are depleted')), 'prepay');
  assert.equal(C.classify429(new C.ApiError(429, 'Resource exhausted')), 'minute');
});

test('请求：Gemini 3 不发采样参数，2.5 flash 关思考', () => {
  assert.equal(C.modelName('models/gemini-2.5-flash'), 'gemini-2.5-flash');
  assert.deepEqual(C.buildBody('x', 'gemini-2.5-flash').generationConfig.thinkingConfig, { thinkingBudget: 0 });
  const g3 = C.buildBody('x', 'gemini-3.5-flash-lite').generationConfig;
  assert.ok(!('thinkingConfig' in g3) && !('temperature' in g3));
  assert.equal(C.buildBody('x', 'gemini-2.5-flash-lite').generationConfig.temperature, 0.1);
  const p = C.buildBody('x', 'gemini-3.5-flash-lite', true, [['232', 'ZHANG WEI']], '提示').systemInstruction.parts[0].text;
  assert.ok(p.includes('232/ZHANG WEI') && p.endsWith('提示'));
});

test('callApi：钥匙走 ?key=，报错原样带回', async () => {
  let seen;
  const ok = await C.callApi('gemini-3.5-flash-lite', 'AQ.k1', { a: 1 }, { fetchImpl: async (url, init) => { seen = { url, init }; return new Response('{"ok":1}', { status: 200 }); } });
  assert.deepEqual(ok, { ok: 1 });
  assert.ok(seen.url.endsWith('/models/gemini-3.5-flash-lite:generateContent?key=AQ.k1'));
  assert.ok(!('x-goog-api-key' in seen.init.headers));
  const bad = new Response(JSON.stringify({ error: { message: 'API key not valid.', details: [{ reason: 'API_KEY_INVALID' }] } }), { status: 400 });
  await assert.rejects(C.callApi('m', 'k', {}, { fetchImpl: async () => bad }), (e) => e.status === 400 && e.raw() === 'HTTP 400：API key not valid.' && e.detail.includes('API_KEY_INVALID'));
  await assert.rejects(C.callApi('m', 'k', {}, { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }), (e) => e.status === 0 && e.message.includes('网络错误'));
});

// ---------------------------------------------------------------- 写表前的判断
const rec = (kw = {}) => ({ ...Object.fromEntries(C.FIELDS.map((f, i) => [f, ['28/10', 'VM-07', 'TD-524613-5', '82664580', '150', 'T4', 'EM2.5', '1', '1', '1', '0', 'D', '639/Lee Ah Kow'][i]])), ...kw });

test('标红：数字、班次、看不清、两遍不一样、拿不准；日期从不标红', () => {
  let a = C.assessRecord({ ...rec({ passed: '9', total_screened: '10', failed: '0' }), unsure: [], disputed: {} }, { today: T });
  assert.deepEqual(new Set(a.red), new Set(['total_screened', 'passed', 'failed'])); assert.ok(a.notes.includes('PASSED 9 + FAILED 0 ≠ TOTAL 10'));
  assert.deepEqual(a.values.date, { y: 2026, m: 10, d: 28 }); assert.equal(a.values.mo, 82664580);
  a = C.assessRecord({ ...rec({ setter: '6□9/Lee Ah Kow', date: '3□/10', shift: 'X' }), unsure: [], disputed: {} }, { today: T });
  assert.ok(a.red.includes('setter') && a.red.includes('shift') && !a.red.includes('date'));
  assert.ok(a.notes.includes('SHIFT 不是 D/N') && a.notes.includes('SETTER 有看不清的字') && !a.notes.includes('DATE'));
  a = C.assessRecord({ ...rec(), unsure: ['machine', 'date'], disputed: { part_number: ['A', 'B'], date: ['1/10', '2/10'] } }, { today: T });
  assert.deepEqual(new Set(a.red), new Set(['machine', 'part_number']));
  a = C.assessRecord({ ...rec({ setter: '6□9' }), unsure: [], disputed: {} }, { names: [['639', 'Lee Ah Kow'], ['648', 'MURUGAN']], today: T });
  assert.equal(a.values.setter, '639'); assert.ok(!a.red.includes('setter'));
});

// ---------------------------------------------------------------- 数据库（刀单）
function companyBook(rows, extra = []) {     // 跟 tests/test_kb.py 的 company_book 一个样子
  const heads = ['DATE', 'MACHINE', 'PART NUMBER', 'MO', 'OPR NO.', 'TOOL', null, 'BTMP', 'CONTAINMENT/SCREENING DETAIL', null, null, 'SHIFT', 'SETTER'];
  const subs = [null, null, null, null, null, 'T NO.', 'DESCRIPTION', null, 'TOTAL SCREENED', 'PASSED', 'FAILED', null, null];
  const page = (data) => [['TOOL BROKEN RECORD'], heads, subs, ...data];
  return [['SEPT', page(extra)], ['OCT', page(rows)],
    ['NAME', [['EMP NO', 'NAME', 'SHIFT'], [576, 'CHEN JIAN', 'D'], ['648', 'MURUGAN', 'D'], ['652/Wang Lei'], [999, 3, 'N']]]];
}
const D = (m, d) => new Date(2026, m - 1, d);
const ROWS = [
  [D(10, 1), 'VM-07', 'TD-524613-5', 82664580, 150, 'T4', 'EM2.5', 1, 1, 1, 0, 'D', '639/Lee Ah Kow'],
  [D(10, 2), '4X-9', 'TD-HAR8230G', 82665285, 130, 'T2', 'EM6', 4, 4, 4, 0, 'D', '535/RAJ KUMAR'],
  [D(10, 4), '5X-3', 'AB-5313706C', 82666511, 130, 'T7', 'BU10', 1, 1, 1, 0, 'N', '552/ARJUN MENON'],
  [D(10, 4), '5X-5', 'AB-5313706C', 82666511, 130, 'T343', 'EM6', 2, 2, 2, 0, 'D', '551/SELVA RAJAN'],
  [D(10, 4), '4X-8', 'TD-HAR8308G-05', 82665551, 130, 'T3', 'EM1.5', 1, 1, 1, 0, 'D', '535/RAJ KUMAR'],
  [D(10, 7), '4x-16', 'AB-5067282E', 82665168, 150, 'T9', 'EM1.', 4, 4, 4, 0, 'D', '232/ZHANG WEI'],
  [D(10, 26), 'VM-07', 'TD-524613-5', 82665807, 150, 'T4', 'EM2.5', 2, 2, 1, 0, 'D', '495/LIM BOON HUAT'],
  [D(10, 28), '5X-2', 'AB-5086733B', 82666997, 130, 'T12', 'BM1', 1, 1, 1, 0, 'D', '495/LIM BOON HUAT'],
];

test('放公司的表进数据库：去重、名单', () => {
  const db = { records: [], people: [] };
  const r = C.feedKb(db, companyBook(ROWS, [ROWS[0]]), 'TOOL BROKEN RECORD.xlsx');
  assert.equal(r.rows, 9); assert.equal(r.added, 8); assert.deepEqual(r.sheets, ['SEPT', 'OCT']); assert.equal(r.error, '');
  const people = Object.fromEntries(db.people);
  assert.equal(people['576'], 'CHEN JIAN'); assert.equal(people['648'], 'MURUGAN'); assert.equal(people['652'], 'Wang Lei');
  assert.equal(people['535'], 'RAJ KUMAR'); assert.ok(!('999' in people));
  const again = C.feedKb(db, companyBook(ROWS), 'x.xlsx');
  assert.equal(again.added, 0); assert.equal(again.people, 0);
  assert.ok(C.kbSummary(db).startsWith('数据库：8 条记录') && C.kbSummary(db).includes('机台 7 台'));
  assert.match(C.feedKb({ records: [], people: [] }, [['Sheet1', [['日期', '机台'], ['1/10', 'A']]]], 'q.xlsx').error, /不像刀单/);
});

test('拿数据库当准绳：像的改成库里写法，不按零件对历史', () => {
  const db = { records: [], people: [] };
  C.feedKb(db, companyBook(ROWS), 'c.xlsx');
  const s = new C.Snapshot(db.records, db.people);
  let [out, fixed, flags] = s.fix(rec({ machine: 'VM-O7', part_number: 'TD-S24613-5', description: 'EM2.S' }));
  assert.equal(out.machine, 'VM-07'); assert.equal(out.part_number, 'TD-524613-5'); assert.equal(out.description, 'EM2.5');
  assert.deepEqual(new Set(Object.keys(fixed)), new Set(['machine', 'part_number', 'description'])); assert.deepEqual(flags, {});
  [out, fixed, flags] = s.fix(rec({ machine: '4X-16' }));
  assert.equal(out.machine, '4x-16'); assert.deepEqual(fixed, {});
  for (const r of [rec({ description: 'EM6' }), rec({ part_number: 'AB-5313706C', t_no: 'T7', description: 'BU10', opr_no: '130' }), rec({ part_number: 'XY-0001' }), rec({ mo: '82666999' })]) {
    [out, fixed, flags] = s.fix(r);
    assert.deepEqual(flags, {}); assert.deepEqual(fixed, {}); assert.equal(out.mo, r.mo);
  }
  [, , flags] = s.fix(rec({ machine: 'ZZ-99', description: 'QQ7' }));
  assert.deepEqual(flags, {});
  [, , flags] = s.fix(rec({ machine: 'ZZ-99', description: 'QQ7' }), ['machine']);
  assert.ok(flags.machine.includes('模型也拿不准：ZZ-99') && !('description' in flags));
  const empty = new C.Snapshot();
  assert.deepEqual(empty.fix(rec({ machine: 'ZZ-99' })), [rec({ machine: 'ZZ-99' }), {}, {}]); assert.equal(empty.hints(), '');
  assert.ok(s.hints().includes('MACHINE：VM-07') && s.hints().includes('数据库 8 条记录'));
  const a = C.assessRecord({ ...rec({ machine: 'VM-O7' }), unsure: [], disputed: { machine: ['VM-O7', 'VM-07'] } }, { snapshot: s, today: T });
  assert.ok(a.orange.includes('machine') && !a.red.includes('machine') && a.notes.includes('MACHINE VM-O7→VM-07'));
});

// ---------------------------------------------------------------- 自建类别
test('自建类别：第一本定列，以后接在后面，按库纠错', () => {
  const db = { columns: [], records: [] };
  const book = (rows, head = ['日期', '机台', '数量', '备注']) => [['Sheet1', [['质检单'], head, ...rows]]];
  let r = C.feedTable(db, book([['30/10', 'VM-07', 3, ''], ['30/10', 'VM-07', 5, '好'], ['31/10', 'VM-14', 7, ''], ['31/10', 'VM-14', 2, '']]), 'a.xlsx');
  assert.equal(r.added, 4); assert.deepEqual(db.columns, ['日期', '机台', '数量', '备注']);
  r = C.feedTable(db, book([['1/11', 'VM-07', 3, '', '张三']], ['日期', '机台', '数量', '备注', '签名']), 'b.xlsx');
  assert.deepEqual(r.newColumns, ['签名']); assert.deepEqual(db.columns.at(-1), '签名');
  assert.match(C.feedTable({ columns: [], records: [] }, [['S', [['只有一格']]]], 'e.xlsx').error, /没找到表头/);
  const spec = new C.TableSpec('质检单', db);
  assert.ok(!spec.openMode && spec.prompt().includes('c2：机台') && spec.prompt().includes('例如 VM-07'));
  const [recs] = spec.parse(wrap('{"title_side":"top","records":[{"c1":"2/11","c2":"VM-O7","c3":"4","c4":"","c5":"","unsure":["c3"]}]}'));
  assert.equal(recs[0]['机台'], 'VM-O7'); assert.deepEqual(recs[0].unsure, ['数量']);
  const a = C.assessTableRecord({ ...recs[0], disputed: {} }, spec.columns, spec.snapshot);
  assert.equal(a.values['机台'], 'VM-07'); assert.ok(a.orange.includes('机台') && a.red.includes('数量')); assert.equal(a.values['数量'], 4);
  const open = new C.TableSpec('新单子');
  assert.ok(open.openMode && open.prompt().includes('由你来定'));
  const [o1] = open.parse(wrap('{"columns":["Date","M/C No."],"records":[{"values":["1/11","VM-1"],"unsure":["m/c no"]}]}'));
  const [o2] = open.parse(wrap('{"columns":["date","M/C no"],"records":[{"values":["1/11","VM-1"],"unsure":[]}]}'));
  assert.deepEqual(Object.keys(o1[0]).filter((k) => k !== 'unsure'), ['Date', 'M/C No.']); assert.deepEqual(o1[0].unsure, ['M/C No.']);
  assert.deepEqual(Object.keys(o2[0]).filter((k) => k !== 'unsure'), ['Date', 'M/C No.']);
  assert.ok(open.agree(o1, o2));
  assert.equal(C.checkName('质检单', ['刀单', '质检单']), '已经有「质检单」了'); assert.equal(C.checkName('a/b', []), '名字里不能有 \\ / : * ? " < > | 这些符号');
});

test('读录入僧自己出的表：No. 和核对提示不算内容', () => {
  const { columns, recs } = C.readBook([['质检单', [['质检单'], ['No.', '日期', '机台', '核对提示（不用贴进你们的表）'], [1, '30/10', 'VM-07', '机台 几遍认得不一样']]]]);
  assert.deepEqual(columns, ['日期', '机台']); assert.deepEqual(recs[0][1], { '日期': '30/10', '机台': 'VM-07' });
});

test('名单文本、EXIF 读不到不报错', () => {
  assert.deepEqual(C.parseNames('# 注释\n232/ZHANG WEI\n648 MURUGAN\n\nxx'), [['232', 'ZHANG WEI'], ['648', 'MURUGAN']]);
  assert.equal(C.exifTime(new ArrayBuffer(4)), null);
});

// ---------------------------------------------------------------- 核对里直接改格子（跟电脑版 tests/test_viewer.py 的 edit_cell 对着写）
const checkRow = (over = {}) => ({
  no: 1, kind: 'rec', orange: [], notes: '',
  values: { date: { y: 2026, m: 10, d: 28 }, machine: 'VM-07', part_number: 'TD-524613-5', mo: 82664580, opr_no: 800, t_no: 'T4',
    description: 'EM2.5', btmp: 1, total_screened: 10, passed: 9, failed: 0, shift: 'D', setter: '639/Lee Ah Kow' },
  red: [], ...over,
});

test('核对改格子：人打的字按认字的规矩整理，日期按这批的年份', () => {
  const d = C.editValue('date', '1/11', { today: T });
  assert.deepEqual(d, { y: 2026, m: 11, d: 1 });
  assert.equal(C.editValue('machine', ' vm 07 '), 'VM07');
  assert.equal(C.editValue('part_number', 'td–524613－5'), 'TD-524613-5');
  assert.equal(C.editValue('t_no', 't4, t5'), 'T4, T5');
  assert.equal(C.editValue('description', 'em ø6'), 'EM Φ6');
  assert.equal(C.editValue('total_screened', '1,200'), 1200);
  assert.equal(C.editValue('mo', '82664580'), 82664580);
  assert.equal(C.editValue('shift', '夜班'), 'N');
  assert.equal(C.editValue('setter', '639 / Lee Ah Kow'), '639/Lee Ah Kow');
  assert.equal(C.editValue('btmp', '   '), '');
  assert.equal(C.editValue('Qty', '12', { cat: '质检单', orig: 3 }), 12);
  assert.equal(C.editValue('Qty', '1.5', { cat: '质检单', orig: 3 }), 1.5);
  assert.equal(C.editValue('Remark', '  ok  ', { cat: '质检单', orig: '' }), 'ok');
});

test('核对改格子：候选、「对的」、数量对上三格一起不红、打错了还红着', () => {
  const r = checkRow({ red: ['machine', 'total_screened', 'passed', 'failed'],
    notes: 'MACHINE 几遍认得不一样：VM-07 / VM-01 / 空；PASSED 9 + FAILED 0 ≠ TOTAL 10' });
  assert.deepEqual(C.altsOf(r, 'machine'), ['VM-07', 'VM-01']);              // 老批次：从提示里抠
  r.alts = { machine: ['VM-01', 'VM-07'] };
  assert.deepEqual(C.altsOf(r, 'machine'), ['VM-01', 'VM-07']);              // 新批次：存着的
  C.checkCell(r, 'machine', { today: T });                                    // 「对的」：值不动
  assert.equal(r.values.machine, 'VM-07');
  assert.deepEqual(r.red, ['total_screened', 'passed', 'failed']);
  assert.equal(r.notes, 'PASSED 9 + FAILED 0 ≠ TOTAL 10');                   // 这格的提示跟着删
  C.checkCell(r, 'total_screened', { today: T });
  assert.deepEqual(r.red, ['passed', 'failed']);
  assert.equal(C.isChecked(r), false);
  C.checkCell(r, 'failed', { text: '1o', today: T });                         // 打错了：还红，告诉你为什么
  assert.deepEqual(r.red, ['passed', 'failed']);
  assert.match(r.notes, /FAILED 不是数字：1o$/);
  C.checkCell(r, 'failed', { text: '1', today: T });                          // 9 + 1 = 10：三格一起不红
  assert.deepEqual(r.red, []);
  assert.equal(r.notes, C.HUMAN_NOTE);
  assert.deepEqual(r.human, ['machine', 'total_screened', 'failed']);
  assert.equal(C.isChecked(r), true);
  const ok = checkRow({ values: { ...checkRow().values, passed: 10 } });     // 本来对得上，人改成对不上：没核过的那格红
  C.checkCell(ok, 'passed', { text: '8', today: T });
  assert.deepEqual(ok.red, ['total_screened', 'failed']);
  assert.equal(ok.notes, 'PASSED 8 + FAILED 0 ≠ TOTAL 10');
  assert.equal(C.isChecked(ok), false);
  const sh = checkRow({ values: { ...checkRow().values, passed: 10 }, red: ['shift'], notes: 'SHIFT 不是 D/N：X' });
  C.checkCell(sh, 'shift', { text: 'x', today: T });
  assert.deepEqual(sh.red, ['shift']);
  C.checkCell(sh, 'shift', { text: '白', today: T });
  assert.equal(sh.values.shift, 'D');
  assert.equal(sh.notes, C.HUMAN_NOTE);
  assert.equal(C.isChecked({ ...sh, kind: 'blank' }), false);
  assert.equal(C.isChecked(checkRow()), false);                               // 人没动过：不算核过
});

test('核对改格子：自建类别的提示按列名认，长名字不被短名字误删', () => {
  const r = { no: 1, kind: 'rec', orange: [], values: { Part: 'A', 'Part No': 'B1', Qty: 3 }, red: ['Part', 'Part No'],
    notes: 'Part No 几遍认得不一样：B1 / B7；Part 模型拿不准' };
  assert.deepEqual(C.altsOf(r, 'Part No', '质检单'), ['B1', 'B7']);
  C.checkCell(r, 'Part', { cat: '质检单' });
  assert.deepEqual(r.red, ['Part No']);
  assert.equal(r.notes, 'Part No 几遍认得不一样：B1 / B7');
  C.checkCell(r, 'Part No', { text: 'B7', cat: '质检单' });
  assert.equal(r.values['Part No'], 'B7');
  assert.equal(r.notes, C.HUMAN_NOTE);
});

test('核完的那条放进样板资料：同一条再改换掉上次那份，又改红了拿掉', () => {
  const kb = { records: [], people: [] };
  const r = checkRow({ values: { ...checkRow().values, passed: 10 }, red: ['machine'], notes: 'MACHINE 模型拿不准' });
  assert.equal(C.feedChecked(kb, r, { source: '核对 20261031_080000 #1.0' }), false);   // 还红着：不收
  C.checkCell(r, 'machine', { text: 'VM-17', today: T });
  assert.equal(C.feedChecked(kb, r, { source: '核对 20261031_080000 #1.0' }), true);
  assert.equal(kb.records.length, 1);
  assert.equal(kb.records[0].machine, 'VM-17');
  assert.equal(kb.records[0].date, '2026-10-28');
  assert.equal(kb.records[0].mo, '82664580');
  assert.equal(kb.records[0].sheet, '核对');
  assert.equal(kb.records[0].key, C.recordKey(kb.records[0]));
  assert.deepEqual(kb.people, [['639', 'Lee Ah Kow']]);
  C.checkCell(r, 'machine', { text: 'VM-18', today: T });
  assert.equal(C.feedChecked(kb, r, { source: '核对 20261031_080000 #1.0' }), true);
  assert.deepEqual(kb.records.map((x) => x.machine), ['VM-18']);
  C.checkCell(r, 'btmp', { text: 'abc', today: T });                         // 又红了：上次那份拿掉
  assert.equal(C.feedChecked(kb, r, { source: '核对 20261031_080000 #1.0' }), false);
  assert.equal(kb.records.length, 0);
  const other = { key: 'x', source: 'TOOL BROKEN RECORD.xlsx', machine: 'VM-07' };
  kb.records.push(other);
  C.checkCell(r, 'btmp', { text: '1', today: T });
  C.feedChecked(kb, r, { source: '核对 20261031_080000 #1.0' });
  assert.equal(kb.records.length, 2);                                         // 别人放进去的不动
  const db = { columns: ['Date', 'M/C No.'], records: [] };
  const t = { no: 1, kind: 'rec', orange: [], red: [], human: ['Qty'], notes: C.HUMAN_NOTE, values: { Date: '28/10', 'M/C No': 'VM-07', Qty: 5 } };
  assert.equal(C.feedChecked(db, t, { cat: '质检单', columns: ['Date', 'M/C No', 'Qty'], source: 's' }), true);
  assert.deepEqual(db.columns, ['Date', 'M/C No.', 'Qty']);
  assert.deepEqual(db.records[0].data, { Date: '28/10', 'M/C No.': 'VM-07', Qty: '5' });
});
