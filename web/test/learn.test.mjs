// 184 录入僧越用越准（learn.js、dagj.js 的 learn / learnList、engine.js 加提醒）：假中转站 + 假大管家，记、打包、排队、交、回执
// 跑：node --test web/test/learn.test.mjs
import './zh.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../core.js';
import * as L from '../learn.js';
import { Engine } from '../engine.js';
import { Butler, b64u, unb64u } from '../dagj.js';
import { Claude } from '../claude.js';
import { openStore } from '../store.js';

const enc = new TextEncoder(), dec = new TextDecoder();
const LIST = { ver: 3, at: 1, lists: { [C.BUILTIN]: ['MACHINE 手写的 Q 常被看成 0'], '*': ['7 中间带横'], 别的: ['不该出现'] },
  nored: [{ cat: C.BUILTIN, col: 'setter', value: '9999' }] };
const BLOCK = L.HEAD + '\n- MACHINE 手写的 Q 常被看成 0\n- 7 中间带横';

// ---------------------------------------------------------------- 假中转站 + 假大管家（照 relay /lr/learn、/lr/learn/list 的约定）
async function fakeRelay({ mode = () => 'ok', list = LIST } = {}) {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const R = { got: [], tries: 0, lists: 0, key: b64u(raw), cid: 'c'.repeat(22) };
  const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
  R.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path === '/lr/learn/list') {
      R.lists++;
      return init.headers && init.headers['x-lr-cid'] === R.cid ? json(200, { ok: true, learn: list }) : json(403, { unknown: true });
    }
    if (path !== '/lr/learn') return json(404, {});
    R.tries++;
    const m = mode(R.tries);
    if (m === 'away') return json(503, { off: true });
    if (m === 'old') return json(200, { ok: false, forget: true });       // 还没装新版的大管家：拆不开
    if (m === 'big') return json(413, {});
    if (m === 'revoked') return json(403, { revoked: true });
    const body = JSON.parse(init.body);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(body.n), additionalData: enc.encode('luru/learn/' + body.cid) }, key, unb64u(body.ct));
    const pkg = JSON.parse(dec.decode(pt));
    R.got.push(pkg);
    const n = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: n, additionalData: enc.encode('luru/learned/' + body.cid) }, key,
      enc.encode(JSON.stringify({ ok: true, got: pkg.items.length })));
    return json(200, { ok: true, n: b64u(n), ct: b64u(ct) });
  };
  return R;
}

function pairedButler(R) {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  const b = new Butler({ fetchImpl: R.fetch, storage });
  if (R.key) { b.info = { cid: R.cid, key: R.key, at: '' }; mem.set('luru.dagj', JSON.stringify(b.info)); }
  return b;
}

function run(id = '20261126_114300', cat = C.BUILTIN) {
  const vals = { date: { y: 2026, m: 11, d: 26 }, machine: 'VM-07', part_number: 'TD-1', mo: 82660000, opr_no: 110, t_no: 'T4',
    description: 'EM2.5', btmp: 1, total_screened: 1, passed: 1, failed: 0, shift: 'D', setter: '639' };
  const row = (no) => ({ no, kind: 'rec', values: { ...vals }, red: ['machine', 'shift'], orange: ['setter'], notes: '', human: [],
    reads: { machine: ['VM-O7', 'VM-07'], shift: ['D', 'N'], setter: ['639', '639'] }, by: 'claude', model: 'claude-opus-5-5' });
  return { id, cat, at: '2026-11-26T03:43:00', total: 3, rows: [row(1), row(2), row(3)], photos: [1, 2, 3], columns: null, learnVer: 3 };
}

async function learner(R, { on = true, clock = null } = {}) {
  const st = await openStore();
  const b = pairedButler(R);
  const runs = new Map();
  const t = { now: 1_800_000_000_000 };
  const ln = new L.Learner({ st, butler: b, on: () => on.value ?? on, app: 'web 1.13.10', device: () => '录入僧网页版 · 测试',
    runOf: async (id) => runs.get(id), clock: clock || (() => t.now) });
  return { st, b, ln, runs, t };
}

// ---------------------------------------------------------------- 提醒、不用标红、答案
test('184 the hint block: this category plus "*", the agreed wording, added as its own part after the prompt', () => {
  assert.equal(L.hintBlock(LIST, C.BUILTIN), BLOCK);
  assert.equal(L.hintBlock(null, C.BUILTIN), '');
  assert.equal(L.hintBlock({ ver: 1, lists: {} }, C.BUILTIN), '');
  const plain = C.buildBody('QUJD', C.DEFAULT_MODEL, true);
  const b = L.withHints(plain, BLOCK);
  assert.equal(b.systemInstruction.parts.length, 2);
  assert.equal(b.systemInstruction.parts[1].text, BLOCK);
  assert.equal(plain.systemInstruction.parts.length, 1);              // 原来那个不动
  assert.equal(L.withHints(plain, ''), plain);
});

test('184 nored: same category and column, both reads equal the value -> not red, its note and guesses go too', () => {
  const book = null;
  const rec = { date: '26/11', machine: 'VM-07', part_number: 'TD-1', mo: '1', opr_no: '9', t_no: 'T4', description: 'EM2.5', btmp: '1',
    total_screened: '1', passed: '1', failed: '0', shift: 'D', setter: '9999', unsure: ['setter', 'machine'], disputed: {} };
  const row = { kind: 'rec', ...C.assessRecord(rec, { snapshot: book, names: [['639', 'LEE']] }) };
  assert.ok(row.red.includes('setter') && row.red.includes('machine'), row.red);
  row.reads = { setter: ['9999', '9999'], machine: ['VM-07', 'VM-07'] };
  assert.deepEqual(L.unred(row, LIST, C.BUILTIN), ['setter']);
  assert.ok(!row.red.includes('setter') && row.red.includes('machine'));
  assert.ok(!/SETTER/.test(row.notes) && /MACHINE/.test(row.notes), row.notes);
  const two = { kind: 'rec', ...C.assessRecord(rec, { names: [['639', 'LEE']] }), reads: { setter: ['9999', '9998'] } };
  assert.deepEqual(L.unred(two, LIST, C.BUILTIN), []);                 // 两遍不一样：照旧红
  const other = { kind: 'rec', ...C.assessRecord(rec, { names: [['639', 'LEE']] }), reads: { setter: ['9999', '9999'] } };
  assert.deepEqual(L.unred(other, LIST, '质检单'), []);                // 别的类别：照旧红
});

test('184 answer has the recognition shape (builtin, own columns, open mode)', () => {
  const r = run();
  const a = L.answerOf(r.rows.filter((x) => x.no === 1), C.BUILTIN, { side: 'top' });
  assert.deepEqual(Object.keys(a), ['title_side', 'records']);
  assert.deepEqual(Object.keys(a.records[0]), [...C.FIELDS, 'unsure']);
  assert.equal(a.records[0].date, '2026-11-26');
  assert.equal(a.records[0].mo, '82660000');
  const rows = [{ no: 1, kind: 'rec', values: { 日期: '1/11', 数量: 5 } }];
  assert.deepEqual(L.answerOf(rows, '质检单', { cols: ['日期', '数量'] }), { title_side: '', records: [{ c1: '1/11', c2: '5', unsure: [] }] });
  assert.deepEqual(L.answerOf(rows, '质检单', { open: true, side: 'left' }), { title_side: 'left', columns: ['日期', '数量'], records: [{ values: ['1/11', '5'], unsure: [] }] });
});

test('184 packages stay under 3 MB: photos spill into more packages, each carries the batch line', () => {
  const big = 'A'.repeat(1_200_000);
  const photos = [1, 2, 3, 4].map((page) => ({ batch: 'b', page, data: big }));
  const items = [{ cat: C.BUILTIN, col: 'machine' }];
  const out = L.packages({ device: 'd', app: 'web', batches: [{ batch: 'b' }], items, photos });
  assert.equal(out.length, 2);
  assert.ok(out.every((p) => L.bytes(p) <= L.MAX_PKG && p.batches.length === 1 && p.v === 1 && p.kind === 'learn' && p.id.length >= 16));
  assert.deepEqual(out.flatMap((p) => p.photos.map((x) => x.page)), [1, 2, 3, 4]);
  assert.equal(out[0].items.length, 1);
  const [a, b] = L.halve(out[0]);
  assert.equal(a.photos.length + b.photos.length, out[0].photos.length);
  assert.equal(L.halve({ items: [1], photos: [] }), null);
});

// ---------------------------------------------------------------- 记、排队、交
test('184 edit, ok and a picked guess all land in the package, with the photo of the touched page only', async () => {
  const R = await fakeRelay();
  const { ln, runs, st } = await learner(R);
  const r = run();
  runs.set(r.id, r);
  await ln.keepPage(r.id, 1, { data: 'SU1H', prompt: 'P', ask: 'A', schema: C.SCHEMA, side: 'top' });
  await ln.keepPage(r.id, 2, { data: 'SU1I', prompt: 'P', ask: 'A', schema: C.SCHEMA, side: 'top' });
  await ln.touch(r, r.rows[0], 0, 'machine', { before: 'VM-07', after: 'QM-07', act: 'edit', color: 'red' });
  r.rows[0].values.machine = 'QM-07';
  await ln.touch(r, r.rows[0], 0, 'shift', { before: 'D', after: 'D', act: 'ok', color: 'red' });
  await ln.touch(r, r.rows[2], 0, 'setter', { before: '639', after: '693', act: 'guess', color: 'orange' });
  assert.equal(await ln.pack(false), 0);                                // 还没闲 10 分钟
  assert.equal(await ln.pack(true), 1);                                 // 核完了（关了核对）
  assert.equal(await ln.pack(true), 0);                                 // 打过的不再打
  const out = await ln.send();
  assert.deepEqual([out.sent, out.left], [1, 0]);
  assert.equal(R.got.length, 1);
  const p = R.got[0];
  assert.deepEqual([p.v, p.kind, p.device, p.app], [1, 'learn', '录入僧网页版 · 测试', 'web 1.13.10']);
  assert.deepEqual(p.batches, [{ batch: r.id, cat: C.BUILTIN, cells: 39, edited: 3, list_ver: 3, at: '2026-11-26T03:43:00Z' }]);
  assert.deepEqual(p.items.map((i) => i.act), ['edit', 'ok', 'guess']);
  const m = p.items[0];
  assert.deepEqual({ ...m, at: 'x' }, { cat: C.BUILTIN, col: 'machine', before: 'VM-07', after: 'QM-07', act: 'edit', color: 'red',
    reads: ['VM-O7', 'VM-07'], by: 'claude', model: 'claude-opus-5-5', batch: r.id, page: 1, row: 1, at: 'x' });
  assert.deepEqual(p.photos.map((x) => x.page), [1]);                   // 第 3 张没留照片、第 2 张没人动：都不带
  assert.equal(p.photos[0].data, 'SU1H');
  assert.equal(p.photos[0].answer.records[0].machine, 'QM-07');         // 人定完的
  assert.deepEqual(p.photos[0].schema, C.SCHEMA);
  assert.equal((await ln.queued()).length, 0);                          // 收到回执：删了
  assert.equal(st.kind, 'memory');
});

test('184 switch off: nothing recorded, nothing sent; turning it off clears what was waiting', async () => {
  const R = await fakeRelay();
  const on = { value: true };
  const { ln, runs } = await learner(R, { on });
  const r = run();
  runs.set(r.id, r);
  await ln.touch(r, r.rows[0], 0, 'machine', { before: 'VM-07', after: 'QM-07', act: 'edit', color: 'red' });
  await ln.pack(true);
  on.value = false;
  await ln.forgetAll();
  await ln.touch(r, r.rows[1], 0, 'machine', { before: 'VM-07', after: 'QM-07', act: 'edit', color: 'red' });
  await ln.keepPage(r.id, 2, { data: 'x' });
  assert.equal(await ln.pack(true), 0);
  await ln.send();
  on.value = true;
  assert.equal(await ln.pack(true), 0);
  assert.equal((await ln.queued()).length, 0);
  assert.equal(R.tries, 0);
});

test('184 unpaired: nothing recorded, no hints, nothing leaves the device', async () => {
  const R = await fakeRelay();
  R.key = null;
  const { ln, runs, b } = await learner(R);
  assert.equal(b.paired, false);
  const r = run();
  runs.set(r.id, r);
  assert.equal(ln.active(), false);
  assert.equal(await ln.refresh(), false);
  assert.equal(ln.block(C.BUILTIN), '');
  await ln.touch(r, r.rows[0], 0, 'machine', { before: 'a', after: 'b', act: 'edit', color: 'red' });
  assert.equal(await ln.pack(true), 0);
  await ln.send();
  assert.deepEqual([R.tries, R.lists], [0, 0]);
});

test('184 butler away (503), old butler (forget), too big (413): kept and retried; receipt deletes; pairing stays', async () => {
  let away = true;
  const R = await fakeRelay({ mode: (n) => (away ? (n === 1 ? 'away' : 'old') : n === 3 ? 'big' : 'ok') });
  const { ln, runs, b, t } = await learner(R);
  const r = run();
  runs.set(r.id, r);
  for (const no of [1, 2]) await ln.keepPage(r.id, no, { data: 'SU1H', prompt: 'P', schema: null });
  for (const k of [0, 1]) await ln.touch(r, r.rows[k], 0, 'machine', { before: 'VM-07', after: 'QM-07', act: 'edit', color: 'red' });
  t.now += L.IDLE;                                                       // 10 分钟没动：到点自己打包、交
  await ln.tick();
  assert.equal(R.tries, 1);
  assert.equal((await ln.queued()).length, 1);                           // 大管家不在：留着
  await ln.tick();
  assert.equal(R.tries, 1);                                              // 不到 10 分钟不再交
  t.now += L.RESEND;
  await ln.tick();
  assert.equal(R.tries, 2);                                              // 老大管家回 forget：照样留着，配对不丢
  assert.equal(b.paired, true);
  assert.equal((await ln.queued()).length, 1);
  away = false;
  const out = await ln.send();                                           // 回来了：太大劈成两包，接着交完
  assert.equal(out.sent, 2);
  assert.equal((await ln.queued()).length, 0);
  assert.deepEqual(R.got.map((p) => p.photos.length).sort(), [1, 1]);
  assert.ok(R.got.every((p) => p.batches[0].batch === r.id));
});

test('184 revoked: stop sending, keep the package for when it is paired again', async () => {
  const R = await fakeRelay({ mode: () => 'revoked' });
  const { ln, runs, b } = await learner(R);
  const r = run();
  runs.set(r.id, r);
  await ln.touch(r, r.rows[0], 0, 'machine', { before: 'VM-07', after: 'QM-07', act: 'edit', color: 'red' });
  await ln.pack(true);
  const out = await ln.send();
  assert.equal(out.why, 'gone');
  assert.equal(b.paired, false);
  assert.equal((await ln.queued()).length, 1);
  await ln.send();
  assert.equal(R.tries, 1);
});

test('184 the queue is capped: oldest dropped past 50 packages', async () => {
  const R = await fakeRelay();
  const { ln, runs, t } = await learner(R);
  for (let i = 0; i < L.MAX_QUEUE + 3; i++) {
    const r = run(`20261126_1143${String(i).padStart(2, '0')}`);
    runs.set(r.id, r);
    await ln.touch(r, r.rows[0], 0, 'machine', { before: 'a', after: 'b', act: 'edit', color: 'red' });
    t.now += 1;
  }
  await ln.pack(true);
  const q = await ln.queued();
  assert.equal(q.length, L.MAX_QUEUE);
  assert.equal(q[0][1].pkg.batches[0].batch, '20261126_114303');        // 最老的三包扔了
});

test('184 the list is read at start and cached; a failed read keeps the cached one', async () => {
  const R = await fakeRelay();
  const { ln, st } = await learner(R);
  assert.equal(await ln.refresh(), true);
  assert.equal(ln.ver(), 3);
  assert.equal(ln.block(C.BUILTIN), BLOCK);
  const again = new L.Learner({ st, butler: pairedButler({ ...R, fetch: async () => new Response('{}', { status: 500 }) }), runOf: async () => null });
  await again.load();
  assert.equal(await again.refresh(), false);
  assert.equal(again.block(C.BUILTIN), BLOCK);
});

// ---------------------------------------------------------------- 三条路的请求里真有那段提醒；「不用标红」真不红
function gemini(seen) {
  const answer = (body) => {
    const rec = { date: '26/11', machine: 'VM-07', part_number: 'TD-1', mo: '82660000', opr_no: '110', t_no: 'T4', description: 'EM2.5',
      btmp: '1', total_screened: '1', passed: '1', failed: '0', shift: 'D', setter: '9999', unsure: ['setter'] };
    seen.push(body);
    return { candidates: [{ content: { parts: [{ text: JSON.stringify({ title_side: 'top', records: [rec] }) }] }, finishReason: 'STOP' }] };
  };
  return { answer, fetch: async (url, init) => new Response(JSON.stringify(answer(JSON.parse(init.body))), { status: 200 }) };
}
const prepare = async (file) => Buffer.from(JSON.stringify({ w: file.w })).toString('base64');

for (const path of ['gemini', 'dagj', 'claude']) {
  test(`184 ${path}: the hints are in the outgoing request, the reads come back, nored keeps the cell white`, async () => {
    const seen = [], g = gemini(seen);
    const b = new Butler({ storage: { getItem: () => null, setItem() {}, removeItem() {} } });
    b.info = { cid: 'c'.repeat(22), key: 'k', at: '' };
    b.read = async (body) => g.answer(body);
    const msgs = [];
    const claude = path === 'claude' ? new Claude({ butler: b, fetchImpl: async (url, init) => {
      if (new URL(url).pathname === '/ai/conf') return new Response(JSON.stringify({ ok: true, key: true, conf: { luru: {} } }), { status: 200 });
      const m = JSON.parse(init.body);
      msgs.push(m);
      const img = m.messages[0].content.find((x) => x.type === 'image').source.data;
      const text = g.answer({ systemInstruction: { parts: [{ text: m.system[0].text }] }, contents: [{ parts: [{ inline_data: { data: img } }] }] }).candidates[0].content.parts[0].text;
      return new Response(JSON.stringify({ type: 'message', model: m.model, stop_reason: 'end_turn', content: [{ type: 'text', text }] }), { status: 200 });
    } }) : null;
    const out = [];
    const eng = new Engine({ keys: ['AIzaKEY1_mock'], model: C.DEFAULT_MODEL, reads: 2, log: () => {}, fetchImpl: g.fetch, prepare,
      sleep: async () => {}, butler: path === 'gemini' ? null : b, claude, learned: L.hintBlock(LIST, C.BUILTIN), keepSent: true });
    await eng.run([{ no: 1, file: { name: 'a.jpg', w: 801 } }], { onPhoto: async (it, recs, err, side, st, by) => out.push({ recs, by }),
      onUnfinished: async () => {}, onBatch: async () => {}, progress: () => {} });
    assert.equal(out[0].by, path);
    if (path === 'claude') {
      assert.equal(msgs.length, 2);
      assert.ok(msgs.every((m) => m.system[0].text.endsWith('\n\n' + BLOCK)), msgs[0].system[0].text.slice(-200));
    } else {
      assert.equal(seen.length, 2);
      assert.ok(seen.every((x) => x.systemInstruction.parts.at(-1).text === BLOCK));
    }
    assert.ok(eng.sent.size === 1);                                      // 开着越用越准：送去认的那张留着
    const p = eng.promptOf();
    assert.ok(!p.prompt.includes(L.HEAD) && p.prompt.startsWith('你是工厂') && p.schema === C.SCHEMA && p.ask);
    const recs = out[0].recs;
    assert.deepEqual(recs.reads[0].setter, ['9999', '9999']);
    assert.ok(!Object.keys(recs[0]).includes('reads') && JSON.stringify(recs).indexOf('reads') < 0);   // 不进存的表
    const row = { kind: 'rec', ...C.assessRecord(recs[0], { names: [['639', 'LEE']] }), reads: recs.reads[0] };
    assert.ok(row.red.includes('setter'));
    L.unred(row, LIST, C.BUILTIN);
    assert.ok(!row.red.includes('setter'), row.red);
  });
}
