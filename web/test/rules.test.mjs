// 拿公司表当规矩把关（Song 2026-11-01 拍板：1A 2A 3A 4A，机台看起来像的就猜）。跟电脑版 tests/test_rules.py 对着写，规矩得一样。
// 名字是编的，机台、零件、工号也都是编的：同事和公司的数据不进 GitHub。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../core.js';
import { exportBackup, importBackup } from '../store.js';

const PEOPLE = [['9471', 'TAN AH MENG'], ['9491', 'GOH KIM SENG'], ['9641', 'ALI BIN OMAR'], ['9556', 'HOO PENG'],
  ['9495', 'NG SOO LAN'], ['9392', 'KOH TECK']];
const MACHINES = ['KM-3', 'QM-7', 'QM-8', 'QM-9', 'QM-12', 'QM-14', 'QM-17', '7X-2', '7X-3', 'RM-2'];
const OPS = [110, 130, 150, 170, 190, 210, 230];
const D = new Date(2026, 9, 20);
const ROWS = [
  [D, 'QM-07', 'PX-101202-5', 90001001, 150, 'T4', 'EM2.5', 1, 1, 1, 0, 'D', '9471/TAN AH MENG'],
  [D, '7X-2', 'KB-7104562B', 90002002, 130, 'T12', 'BM1', 1, 1, 1, 0, 'D', '9495'],
  [D, '7X-2', 'KB-7104562B', 90002002, 130, 'T4', 'EM3', 1, 1, 1, 0, 'N', '9495'],
  [D, 'QM-8', 'KB-7104562B', 90003003, 110, 'T5', 'EM8', 1, 1, 1, 0, 'D', '9491'],
  [D, 'QM-14', 'PX-333-444-01-A', 90004004, 150, 'T7', 'DR2.5', 2, 2, 2, 0, 'N', '9556'],
  [D, 'KM-3', 'KB-7300111C', 90005005, 170, 'T2', 'SD3', 1, 1, 1, 0, 'D', '9392/KOH TECK'],
  [D, 'QM-9', 'KB-7300111C', 90005005, 170, 'T3', 'M4', 1, 1, 1, 0, 'D', '9641'],
  [D, 'QM-12', 'PX-101202-5', 90001001, 130, 'T9', 'EM6', 1, 1, 1, 0, 'N', '9231'],
];

function companyBook(rows = ROWS) {         // 跟公司那本一个样：记录页 + NAME 页（工号/名字、MACHINE、OPERATION、TOOL、SHIFT，中间隔着空列）
  const heads = ['DATE', 'MACHINE', 'PART NUMBER', 'MO', 'OPR NO.', 'TOOL', null, 'BTMP', 'CONTAINMENT/SCREENING DETAIL', null, null, 'SHIFT', 'SETTER'];
  const subs = [null, null, null, null, null, 'T NO.', 'DESCRIPTION', null, 'TOTAL SCREENED', 'PASSED', 'FAILED', null, null];
  const name = [['Employee Name / ID', null, 'MACHINE', null, 'OPERATION', null, 'TOOL', null, 'SHIFT']];
  for (let i = 0; i < Math.max(PEOPLE.length, MACHINES.length); i++) {
    name.push([i < PEOPLE.length ? `${PEOPLE[i][0]}/${PEOPLE[i][1]}` : null, null, MACHINES[i] ?? null, null, OPS[i] ?? null, null, null, null,
      ['DAY', 'NIGHT'][i] ?? null]);
  }
  return [['OCT', [['TOOL BROKEN RECORD'], heads, subs, ...rows]], ['NAME', name]];
}
function snap() {
  const db = { records: [], people: [] };
  const r = C.feedKb(db, companyBook(), 'TOOL BROKEN RECORD 2026.xlsx');
  assert.equal(r.error, '');
  return [db, r, new C.Snapshot(db.records, db.people, db.lists)];
}
const rec = (kw = {}) => ({
  ...Object.fromEntries(C.FIELDS.map((f) => [f, ''])),
  date: '30/10', machine: 'QM-14', part_number: 'PX-101202-5', mo: '90001001', opr_no: '150', t_no: 'T4',
  description: 'EM2.5', total_screened: '1', passed: '1', failed: '0', shift: 'D', setter: '9471', ...kw,
});
const T = new Date(2026, 10, 1);

test('NAME 页的机台表、工序表读进来；班次的字不当人', () => {
  const [db, r, s] = snap();
  assert.deepEqual(r.lists, { machine: MACHINES.length, opr_no: 7 });
  assert.ok(C.feedLine(r).includes('认得机台表 10 台、工序表 7 道'));
  const roster = Object.fromEntries(s.roster());
  assert.equal(roster['9471'], 'TAN AH MENG'); assert.equal(roster['9392'], 'KOH TECK');
  assert.ok(!('110' in roster) && !('130' in roster));
  assert.deepEqual([...s.oprs].sort(), ['110', '130', '150', '170', '190', '210', '230']);
  assert.ok(s.checkMachine); assert.equal(s.knownMachine('QM-07'), 'QM-07'); assert.equal(s.knownMachine('qm7'), 'QM-7');
  assert.equal(s.knownMachine('RM-2'), 'RM-2');
  assert.ok(s.setterIds.has('9495') && !s.setterIds.has('9231'));
  assert.ok(s.hints().includes('OPR NO.：110、130、150、170、190、210、230'));
  assert.ok(C.kbSummary(db).includes('机台 10 台'));
});

test('零件号去掉横杠比、B 被看成 13 也认', () => {
  const [, , s] = snap();
  for (const [read, want] of [['PX-333-444-01A', 'PX-333-444-01-A'], ['K13-7104562B', 'KB-7104562B'], ['KB47104562B', 'KB-7104562B'], ['KB-7104562D', 'KB-7104562B']]) {
    const [out, fixed, flags] = s.fix(rec({ part_number: read }));
    assert.equal(out.part_number, want); assert.deepEqual(fixed.part_number, [read, want, '按数据库改']); assert.deepEqual(flags, {});
  }
  const [out, fixed] = s.fix(rec({ part_number: 'KB-A99999AD' }));
  assert.equal(out.part_number, 'KB-A99999AD'); assert.ok(!('part_number' in fixed));
});

test('机台：公司有的不动，没有的看起来像就猜，猜不准标红', () => {
  const [, , s] = snap();
  let [out, fixed, flags, extra] = s.fix(rec({ machine: 'QM-17' }));
  assert.equal(out.machine, 'QM-17'); assert.deepEqual(fixed, {}); assert.deepEqual(flags, {}); assert.deepEqual(extra.ctx, {});
  [out, fixed] = s.fix(rec({ machine: 'QM-O7' }));
  assert.equal(out.machine, 'QM-7'); assert.equal(fixed.machine[2], '按数据库改');
  [out, fixed, flags, extra] = s.fix(rec({ machine: '7K-2' }));
  assert.equal(out.machine, '7X-2'); assert.deepEqual(fixed.machine, ['7K-2', '7X-2', '公司没有 7K-2，按长得像猜的']);
  assert.deepEqual(extra.ctx.machine, { read: '7K-2', guess: '7X-2', cands: [] });
  [out, fixed] = s.fix(rec({ machine: 'QM-2', part_number: 'KB-7104562B' }));
  assert.equal(out.machine, 'QM-8'); assert.ok('machine' in fixed);
  [out, fixed, flags, extra] = s.fix(rec({ machine: 'QM-2', part_number: 'XY-1' }));
  assert.equal(out.machine, 'QM-2'); assert.ok(!('machine' in fixed));
  assert.ok(flags.machine.startsWith('MACHINE QM-2 公司没有这台机，可能是：')); assert.equal(extra.alts.machine.length, 4);
  [out, fixed] = s.fix({ ...rec({ machine: '7X-2' }), disputed: { machine: ['7X-2', '7K-2'] } });
  assert.equal(out.machine, '7X-2'); assert.deepEqual(fixed.machine, ['7X-2', '7X-2', '几遍认得不一样：7X-2 / 7K-2，公司只有 7X-2']);
  assert.deepEqual(out.disputed, {});
});

test('工序不是公司那几道：标红，带横的 7 排最前', () => {
  const [, , s] = snap();
  let [out, fixed, flags, extra] = s.fix(rec({ opr_no: '140' }));
  assert.equal(flags.opr_no, 'OPR_NO 140 公司没有这道工序，可能是：170 / 190 / 130 / 150');
  assert.deepEqual(extra.alts.opr_no, ['170', '190', '130', '150']);
  [out, fixed, flags] = s.fix({ ...rec({ opr_no: '140' }), disputed: { opr_no: ['140', '170'] } });
  assert.equal(out.opr_no, '170'); assert.deepEqual(flags, {}); assert.equal(fixed.opr_no[2], '几遍认得不一样：140 / 170，公司只有 170');
  assert.deepEqual(s.fix(rec({ opr_no: '130' }))[2], {});
});

test('刀具编码照公司的简写写', () => {
  const [, , s] = snap();
  assert.ok(s.shortDesc && ['EM', 'DR', 'SD', 'BM'].every((t) => s.descTypes.has(t)));
  for (const [code, short] of [['4FEM-M0300C-0080-04', 'EM3'], ['2CEM-MO3000N-D110-00', 'EM3'], ['CFEM-M0.400C-0110-01', 'EM4'],
    ['HRDR-M0600DC-0700-00', 'DR6'], ['CZSD-M03000N-0900-00', 'SD3'], ['Φ1.5 FEM', 'EM1.5'], ['Φ4EM-M0250C-0080-06', 'EM2.5']]) {
    const [out, fixed, flags] = s.fix(rec({ description: code }));
    assert.equal(out.description, short, code); assert.deepEqual(fixed.description, [code, short, '照公司简写']); assert.deepEqual(flags, {});
  }
  let reads = ['HRDR-M0600DC-0700-00', 'HL2DR-M06000C-0700-00', 'HZDP-M06000C-0700-00'];
  let [out, fixed, flags, extra] = s.fix({ ...rec({ description: reads[0] }), disputed: { description: reads } });
  assert.equal(out.description, 'DR6'); assert.ok('description' in fixed); assert.deepEqual(out.disputed, {});
  reads = ['4FEM-M0300C-0080-04', '4FEM-M0800C-0080-04'];
  [out, fixed, flags, extra] = s.fix({ ...rec({ description: reads[0] }), disputed: { description: reads } });
  assert.equal(out.description, 'EM3'); assert.deepEqual(extra.alts.description, ['EM3', 'EM8']);
  assert.ok(flags.description.startsWith('DESCRIPTION 几遍认得不一样：EM3 / EM8（单子上的编码：'));
  for (const keep of ['FACEMILL Φ40 R0.8', 'EM8', 'Φ4 FMM X2']) {
    [out, fixed] = s.fix(rec({ description: keep }));
    assert.equal(out.description, keep); assert.ok(!('description' in fixed));
  }
});

test('号对上自动对名字，名单外的标红；这批里互相看一眼', () => {
  const [, , s] = snap();
  const names = s.roster();
  const rows = [
    rec({ machine: 'QM-2', part_number: 'K13-7104562B', mo: '90002002', setter: '9441', opr_no: '140' }),
    rec({ machine: '7X-2', part_number: 'KB-7104562B', mo: '90002002', setter: '9491', date: '13-51' }),
    rec({ machine: 'QM-14', setter: '9556', description: '4FEM-M0300C-0080-04', date: '30/10' }),
  ].map((r, i) => ({ no: i + 1, kind: 'rec', ...C.assessRecord({ ...r, unsure: [], disputed: {} }, { snapshot: s, names, today: T }) }));
  C.settle(rows);
  const [r1, r2, r3] = rows;
  assert.equal(r1.values.machine, '7X-2'); assert.ok(r1.orange.includes('machine'));
  assert.ok(r1.notes.includes('MACHINE QM-2→7X-2（公司没有 QM-2，这批同一个 MO 的单子是 7X-2）'));
  assert.ok(r1.red.includes('setter')); assert.deepEqual(r1.alts.setter, ['9491/GOH KIM SENG', '9471/TAN AH MENG', '9641/ALI BIN OMAR']);
  assert.ok(r1.red.includes('opr_no')); assert.equal(r1.alts.opr_no[0], '170');
  assert.equal(r1.values.part_number, 'KB-7104562B');
  assert.equal(r2.values.setter, '9491/GOH KIM SENG'); assert.ok(!r2.red.includes('setter'));
  assert.ok(r2.red.includes('date')); assert.deepEqual(r2.alts.date, ['30-Oct']); assert.ok(r2.notes.includes('DATE 13-51 认不成日期，可能是：30-Oct'));
  assert.equal(r3.values.description, 'EM3'); assert.ok(r3.notes.includes('DESCRIPTION 4FEM-M0300C-0080-04→EM3（照公司简写）'));
  assert.equal(r3.values.setter, '9556/HOO PENG'); assert.deepEqual(r3.red, []);
  assert.deepEqual(C.altsOf({ notes: r1.notes }, 'setter'), ['9491/GOH KIM SENG', '9471/TAN AH MENG', '9641/ALI BIN OMAR']);   // 老批次：从提示里抠
  C.checkCell(r2, 'date', { text: '30-Oct', today: T });
  assert.deepEqual(r2.values.date, { y: 2026, m: 10, d: 30 }); assert.ok(!r2.red.includes('date'));
  C.checkCell(r1, 'setter', { text: '9491', today: T, roster: names });
  assert.equal(r1.values.setter, '9491/GOH KIM SENG'); assert.ok(!r1.red.includes('setter'));
  const before = JSON.stringify(r1);
  C.settle(rows);                                        // 人动过的那条不再碰
  assert.equal(JSON.stringify(r1), before);
});

test('setterCheck 跟电脑版一个规矩', () => {
  const NAMES = [['9639', 'Lee Ah Kow'], ['9535', 'RAJ KUMAR'], ['9552', 'ARJUN MENON'], ['9232', 'ZHANG WEI']];
  const m = (raw, valid = null, reads = []) => C.setterCheck(raw, NAMES, valid, reads);
  assert.deepEqual(m('9535'), ['9535/RAJ KUMAR', 'ok', '', [], '']);
  assert.deepEqual(m('9535/Raj'), ['9535/RAJ KUMAR', 'ok', '', [], '']);
  assert.deepEqual(m('9639 Lee A Kow').slice(0, 2), ['9639/Lee Ah Kow', 'ok']);
  let [v, look, why] = m('ARJUN MENON');
  assert.equal(v, '9552/ARJUN MENON'); assert.equal(look, 'fixed'); assert.ok(why.includes('工号补成 9552'));
  let cands;
  [v, look, why, cands] = m('9535/ZHANG WEI');
  assert.equal(look, 'red'); assert.ok(why.includes('工号 9535 在名单上是 RAJ KUMAR')); assert.deepEqual(cands, ['9535/RAJ KUMAR']);
  assert.deepEqual(m('9999/NOBODY HERE').slice(0, 2), ['9999/NOBODY HERE', 'ok']);
  const valid = new Set(['9639', '9535', '9552', '9232', '9471', '9491', '9641', '9777']);
  let read;
  [v, look, why, cands, read] = m('9441', valid);
  assert.deepEqual([v, look, read, why], ['9441', 'red', '9441', 'SETTER 9441 名单上没有']); assert.deepEqual(cands, ['9471', '9491', '9641']);
  assert.deepEqual(m('9777', valid), ['9777', 'ok', '', [], '']);
  [v, look, why] = m('9441', valid, ['9441', '9491']);
  assert.deepEqual([v, look], ['9491', 'fixed']); assert.ok(why.includes('名单上只有 9491'));
  assert.deepEqual(C.setterCheck('9535', []), ['9535', 'ok', '', [], '']);
});

test('没喂公司表：工号照抄不标，机台、工序不把关；认不成的日期才标红', () => {
  const a = C.assessRecord({ ...rec({ setter: '9441', machine: 'QM-2', opr_no: '140', date: '13-51' }), unsure: [], disputed: {} }, { today: T });
  assert.deepEqual(a.red, ['date']); assert.equal(a.values.setter, '9441'); assert.equal(a.notes, 'DATE 13-51 认不成日期');
});

test('提示词认得带横的 7', () => {
  assert.ok(C.PROMPT.includes('中间再一横的是 7，不是 4') && C.PROMPT.includes('拼成一个 H'));
});

test('备份带上机台表、工序表，恢复时合并', async () => {
  const mem = new Map([['kv/kb', { records: [], people: [], lists: { machine: ['QM-7'], opr_no: ['110'] } }]]);
  const st = {
    get: async (s, k) => mem.get(`${s}/${k}`), put: async (s, k, v) => { mem.set(`${s}/${k}`, v); },
    all: async () => [], keys: async () => [], many: async () => {},
  };
  const data = await exportBackup(st);
  assert.deepEqual(data.kb.lists, { machine: ['QM-7'], opr_no: ['110'] });
  mem.set('kv/kb', { records: [], people: [], lists: { machine: ['QM-8'] } });
  await importBackup(st, data);
  assert.deepEqual(mem.get('kv/kb').lists, { machine: ['QM-8', 'QM-7'], opr_no: ['110'] });
});

// ---------------------------------------------------------------- 班次照这个人以前的班次猜（Song 2026-11-01：1B「用资料库这个人以前是N还是D去猜」）、3A
const SHIFT_ROWS = [   // 9556 一向夜班；9471 一向白班
  ...[21, 22, 23, 24, 25, 26].map((d) => [new Date(2026, 9, d), 'QM-14', 'PX-333-444-01-A', 90004004, 150, 'T7', 'DR2.5', 1, 1, 1, 0, 'N', '9556/HOO PENG']),
  ...[21, 22, 23, 24].map((d) => [new Date(2026, 9, d), 'QM-07', 'PX-101202-5', 90001001, 150, 'T4', 'EM2.5', 1, 1, 1, 0, 'D', '9471']),
];
function shiftSnap() {
  const db = { records: [], people: [] };
  assert.equal(C.feedKb(db, companyBook([...ROWS, ...SHIFT_ROWS]), 'TOOL BROKEN RECORD 2026.xlsx').error, '');
  return new C.Snapshot(db.records, db.people, db.lists);
}
const assess = (s, kw) => C.assessRecord({ ...rec(kw), unsure: [], disputed: kw.disputed || {} }, { snapshot: s, names: s.roster(), today: T });

test('班次照这个人以前的班次猜：没写就猜、几遍不一样挑跟他一样的、编出来对不上的改过来（跟电脑版一样）', () => {
  const s = shiftSnap();
  assert.deepEqual(s.shiftGuess('9556/HOO PENG', { y: 2026, m: 10, d: 30 }), { id: '9556', v: 'N', k: 7, n: 7 });
  assert.deepEqual(s.shiftGuess('9471', { y: 2026, m: 10, d: 30 }), { id: '9471', v: 'D', k: 5, n: 5 });
  assert.deepEqual(s.shiftGuess('9495', null), { id: '9495', v: 'D', k: 1, n: 2 });
  assert.equal(s.shiftGuess('9441', null), null);
  const look = (a) => [a.values.shift, a.orange.includes('shift') ? 'fixed' : a.red.includes('shift') ? 'red' : ''];
  const a1 = assess(s, { setter: '9556', shift: '' });
  const a2 = assess(s, { setter: '9556', shift: 'D' });
  const a3 = assess(s, { setter: '9556', shift: 'D', disputed: { shift: ['D', 'N'] } });
  const a4 = assess(s, { setter: '9556', shift: 'N' });
  const a5 = assess(s, { setter: '9495', shift: '', disputed: { shift: ['空', 'N'] } });
  const a6 = assess(s, { setter: '9441', shift: '' });
  const a7 = assess(s, { setter: '9471', shift: '' });
  assert.deepEqual([a1, a2, a3, a4, a5, a6, a7].map(look),
    [['N', 'fixed'], ['N', 'fixed'], ['N', 'fixed'], ['N', ''], ['', 'red'], ['', ''], ['D', 'fixed']]);
  assert.ok(a1.notes.includes('SHIFT 空→N（单子上没写班次，9556 最近 7 回都是夜班）'), a1.notes);
  assert.ok(a2.notes.includes('SHIFT D→N（9556 最近 7 回都是夜班；单子上真圈了 D 就改回来）'));
  assert.ok(a3.notes.includes('SHIFT 几遍认得不一样：D / N，9556 最近 7 回都是夜班，就是 N'));
  assert.ok(a7.notes.includes('SHIFT 空→D（单子上没写班次，9471 最近 5 回都是白班）'));
  assert.ok(a6.red.includes('setter'));
});

test('核对里把调试员改对了：班次照这个人以前的班次再猜一遍；人改过的班次不动', () => {
  const s = shiftSnap();
  const names = s.roster();
  const r1 = { no: 1, kind: 'rec', ...assess(s, { setter: '9551', shift: '', disputed: { shift: ['空', 'N'] } }) };
  const r2 = { no: 2, kind: 'rec', ...assess(s, { setter: '9551', shift: 'D' }) };
  const r3 = { no: 3, kind: 'rec', ...assess(s, { setter: '9551', shift: '' }) };
  assert.ok(r1.red.includes('shift') && r1.red.includes('setter'));
  C.checkCell(r1, 'setter', { text: '9556', today: T, roster: names, snapshot: s });
  assert.equal(r1.values.setter, '9556/HOO PENG'); assert.equal(r1.values.shift, 'N');
  assert.ok(r1.orange.includes('shift') && !r1.red.length); assert.equal(r1.notes, C.HUMAN_NOTE);
  C.checkCell(r2, 'setter', { text: '9556', today: T, roster: names, snapshot: s });
  assert.equal(r2.values.shift, 'N'); assert.ok(r2.orange.includes('shift'));
  C.checkCell(r3, 'setter', { text: '9556', today: T, roster: names });          // 没给样板资料：不猜
  assert.equal(r3.values.shift, ''); assert.ok(!r3.orange.includes('shift'));
  C.checkCell(r2, 'shift', { text: 'D', today: T });                             // 人自己改了班次
  C.checkCell(r2, 'setter', { text: '9556', today: T, roster: names, snapshot: s });
  assert.equal(r2.values.shift, 'D');
});

test('3A：MO 认错了一位，同一个零件的单子是谁也排在候选前面', () => {
  const s = shiftSnap();
  const rows = [
    assess(s, { part_number: 'KB-7104562B', mo: '90002002', setter: '9491' }),
    assess(s, { part_number: 'KB-7104562B', mo: '90002092', setter: '9441' }),
  ].map((a, i) => ({ no: i + 1, kind: 'rec', ...a }));
  C.settle(rows);
  assert.equal(rows[1].alts.setter[0], '9491/GOH KIM SENG', rows[1].alts.setter);
});
