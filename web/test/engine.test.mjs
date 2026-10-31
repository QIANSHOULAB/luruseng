// 网页版干活那一套（engine.js）：跟电脑版 tests/test_engine.py 同样的场景，用假的谷歌服务器
// 跑：node --test web/test/engine.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../core.js';
import { Engine } from '../engine.js';

const K1 = 'AIzaKEY1_mock', K2 = 'AIzaKEY2_mock';

function quota(per) {
  const qid = { day: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', minute: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }[per];
  return [429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota, please check your plan and billing details.',
    details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: qid }] }] } }];
}

// 假服务器：按钥匙决定返回什么（跟 tests/mock_server.py 一样的几种）
function server() {
  const S = { modes: {}, once: {}, log: [], inflight: 0, peak: 0, delay: 2, calls: {} };
  S.answer = (mode, body) => {
    if (mode === 'noschema' && body.generationConfig.responseSchema) {
      return [400, { error: { code: 400, message: 'Invalid JSON payload received. Unknown name "responseSchema" at \'generation_config\': Cannot find field.' } }];
    }
    if (mode === 'day' || mode === 'minute') return quota(mode);
    if (mode === 'prepay') return [429, { error: { code: 429, message: 'Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing.' } }];
    if (mode === 'invalid') return [400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', details: [{ reason: 'API_KEY_INVALID' }] } }];
    if (mode === '500') return [500, { error: { code: 500, message: 'An internal error has occurred.' } }];
    let text;
    if (mode === 'garbage') text = '这不是 JSON';
    else {
      const img = body.contents[0].parts.find((p) => p.inline_data).inline_data.data;
      const { w } = JSON.parse(Buffer.from(img, 'base64').toString());
      const nth = S.calls[w] = (S.calls[w] || 0) + 1;
      const rec = { date: '28/10', machine: 'VM-07', part_number: 'TD-524613-5', mo: '82664580', opr_no: String(w), t_no: 'T4',
        description: 'EM2.5', btmp: '1', total_screened: '1', passed: '1', failed: '0', shift: 'D', setter: '639/Lee Ah Kow' };
      let recs = [rec];
      if (mode === 'two') recs = [rec, { ...rec, date: '1-Oct', t_no: 'T9', shift: 'N' }];
      else if (mode === 'none') recs = [];
      else if (mode === 'flip') recs = [{ ...rec, shift: nth === 2 ? 'N' : 'D' }];
      const sys = body.systemInstruction.parts[0].text;
      if (sys.includes('这种单子还没有定好的表头')) {
        text = JSON.stringify({ title_side: 'right', columns: ['Date', 'M/C No.', 'Qty', 'Remark'], records: [{ values: ['28/10', 'VM-07', String(w), ''], unsure: [] }] });
      } else text = JSON.stringify({ title_side: mode === 'side_left' ? '左边' : 'top', records: recs });
    }
    return [200, { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] }];
  };
  S.fetch = async (url, init) => {
    const key = new URL(url).searchParams.get('key');
    const body = JSON.parse(init.body);
    let mode = S.modes[key] || 'ok';
    const once = S.once[key];
    if (once && once[1] > 0) { mode = once[0]; once[1]--; }
    S.log.push({ key, mode, url, gen: body.generationConfig, img: body.contents[0].parts[1].inline_data.data });
    S.inflight++;
    S.peak = Math.max(S.peak, S.inflight);
    await new Promise((r) => setTimeout(r, S.delay));
    S.inflight--;
    const [status, obj] = S.answer(mode, body);
    return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return S;
}

function photos(n, start = 0) {                 // 第 i 张「宽」800+i：假服务器把宽度填进 OPR NO.，用来核对编号和顺序
  return Array.from({ length: n }, (_, i) => ({ no: i + 1, file: { name: `img_${i + start}.jpg`, w: 800 + i + start } }));
}
const prepare = async (file, enhance) => Buffer.from(JSON.stringify({ w: file.w, enhance })).toString('base64');

class FakeClock {
  constructor(t) { this.t = t; this.slept = []; this.hook = null; }
  now = () => this.t;
  sleep = async (s) => { this.slept.push(s); this.t += s * 1000; if (this.hook) this.hook(this); };
}

async function go(items, srv, opts = {}) {
  const logs = [], photosOut = [], unfinished = [], ticks = [];
  let batches = 0;
  const eng = new Engine({ keys: [K1], model: C.DEFAULT_MODEL, reads: 1, log: (m) => logs.push(m), fetchImpl: srv.fetch,
    prepare, sleep: async () => {}, ...opts });
  if (opts.stopAfter) setTimeout(() => eng.stop(), opts.stopAfter);
  const res = await eng.run(items, {
    onPhoto: async (it, recs, err, side) => photosOut.push({ no: it.no, recs, err, side }),
    onUnfinished: async (it, why) => unfinished.push({ no: it.no, why }),
    onBatch: async () => { batches++; },
    progress: (d, t) => ticks.push([d, t]),
  });
  return { res, logs, photosOut, unfinished, batches, eng, ticks };
}

test('twelve photos come back numbered in order, five at a time', async () => {
  const srv = server();
  const { res, photosOut, batches } = await go(photos(12), srv);
  assert.equal(res.ok, 12); assert.equal(res.records, 12); assert.equal(res.requests, 12);
  assert.ok(srv.peak <= 5 && srv.peak >= 2);
  assert.equal(batches, 3);
  assert.deepEqual(photosOut.map((p) => p.no), [...Array(12).keys()].map((i) => i + 1));
  assert.deepEqual(photosOut.map((p) => p.recs[0].opr_no), [...Array(12).keys()].map((i) => String(800 + i)));
  const g = srv.log[0].gen;
  assert.ok(!('temperature' in g));
  assert.deepEqual(new Set(g.responseSchema.properties.records.items.required), new Set([...C.FIELDS, 'unsure']));
});

test('two reads agree: two requests per photo, the second one sees the sharpened picture', async () => {
  const srv = server();
  const { res, photosOut } = await go(photos(3), srv, { reads: 2 });
  assert.equal(res.requests, 6);
  assert.deepEqual(srv.log.map((e) => JSON.parse(Buffer.from(e.img, 'base64')).enhance).sort(), [false, false, false, true, true, true]);
  assert.ok(photosOut.every((p) => !p.recs[0].single && !Object.keys(p.recs[0].disputed).length));
});

test('two reads disagree: a third read decides, the cell stays red', async () => {
  const srv = server();
  srv.modes = { [K1]: 'flip' };
  const { res, photosOut } = await go(photos(1), srv, { reads: 2 });
  assert.equal(res.requests, 3);
  const rec = photosOut[0].recs[0];
  assert.equal(rec.shift, 'D');
  assert.deepEqual(rec.disputed.shift, ['D', 'N']);
  const a = C.assessRecord(rec);
  assert.ok(a.red.includes('shift') && a.notes.includes('SHIFT 几遍认得不一样：D / N'));
});

test('two records on one photo share its number; empty photo keeps its slot', async () => {
  const srv = server();
  srv.once = { [K1]: ['two', 1] };
  const r1 = await go(photos(3), srv);
  assert.equal(r1.res.records, 4);
  assert.equal(r1.photosOut.find((p) => p.recs.length === 2).recs[1].shift, 'N');
  const srv2 = server();
  srv2.once = { [K1]: ['none', 1] };
  const r2 = await go(photos(3), srv2);
  assert.deepEqual(r2.photosOut.map((p) => p.recs.length).sort(), [0, 1, 1]);
});

test('key 1 out for the day: key 2 takes over', async () => {
  const srv = server();
  srv.modes = { [K1]: 'day' };
  const { res, eng, logs } = await go(photos(10), srv, { keys: [K1, K2] });
  const keys = srv.log.map((e) => e.key);
  assert.equal(res.ok, 10);
  assert.equal(keys.filter((k) => k === K2).length, 10);
  assert.ok(keys.filter((k) => k === K1).length <= 5);
  assert.ok(eng.keys.deadUntil[0] > Date.now() + 60e3);
  assert.ok(logs.some((m) => m.startsWith('钥匙1 今天的额度用完了')));
  assert.equal(eng.usedLine(), '钥匙2×10');
});

test('both keys out for the day: waits for the Pacific midnight reset, then finishes', async () => {
  const srv = server();
  const clock = new FakeClock(Date.UTC(2026, 9, 29, 8, 0));       // 新加坡 16:00
  srv.modes = { [K1]: 'day', [K2]: 'day' };
  clock.hook = (c) => { if (c.t >= Date.UTC(2026, 9, 30, 7, 0)) srv.modes = {}; };   // 太平洋午夜（夏令时）
  const { res, logs, photosOut } = await go(photos(7), srv, { keys: [K1, K2], clock: clock.now, sleep: clock.sleep });
  assert.equal(res.ok, 7); assert.equal(res.failed, 0);
  assert.deepEqual(photosOut.map((p) => p.no), [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(logs.some((m) => m.includes('等到') && m.includes('额度刷新后接着干')));
  assert.ok(Math.max(...clock.slept) > 20 * 3600);
});

test('per-minute limit: waits at most a minute, then carries on', async () => {
  const srv = server();
  const clock = new FakeClock(1_800_000_000_000);
  srv.once = { [K1]: ['minute', 3] };
  const { res } = await go(photos(3), srv, { clock: clock.now, sleep: clock.sleep });
  assert.equal(res.ok, 3); assert.equal(res.failed, 0);
  assert.ok(clock.slept.length && Math.max(...clock.slept) <= 60);
});

test('prepaid credits used up: stops at once, nothing is lost', async () => {
  const srv = server();
  srv.modes = { [K1]: 'prepay', [K2]: 'ok' };
  const { res, unfinished } = await go(photos(8), srv, { keys: [K1, K2] });
  assert.match(res.stopped, /prepayment credits are depleted/);
  assert.equal(res.ok, 0);
  assert.ok(srv.log.length <= 5);
  assert.ok(unfinished.length === 5 && unfinished.every((u) => u.why.includes('prepayment')));
});

test('bad key stops with Google\'s own words', async () => {
  const srv = server();
  srv.modes = { [K1]: 'invalid' };
  const { res } = await go(photos(2), srv);
  assert.ok(res.stopped.includes('钥匙1 · HTTP 400：API key not valid'));
});

test('Google 500 is retried', async () => {
  const srv = server();
  srv.once = { [K1]: ['500', 2] };
  const { res } = await go(photos(2), srv);
  assert.equal(res.ok, 2); assert.equal(res.requests, 4);
});

test('model that rejects the schema: falls back to plain JSON', async () => {
  const srv = server();
  srv.modes = { [K1]: 'noschema' };
  const { res, logs } = await go(photos(2), srv);
  assert.equal(res.ok, 2);
  assert.ok(logs.some((m) => m.startsWith('模型不认结构化输出格式')));
  assert.ok(!srv.log[srv.log.length - 1].gen.responseSchema);
});

test('garbage answer: that photo fails, keeps its number, the rest go on', async () => {
  const srv = server();
  srv.once = { [K1]: ['garbage', 1] };
  const { res, photosOut } = await go(photos(3), srv);
  assert.equal(res.ok, 2); assert.equal(res.failed, 1);
  const bad = photosOut.find((p) => p.recs === null);
  assert.ok(bad.err.includes('JSON 解析不了'));
  assert.deepEqual(photosOut.map((p) => p.no), [1, 2, 3]);
});

test('stop button: what is in hand is marked unfinished, nothing after it starts', async () => {
  const srv = server();
  srv.delay = 40;
  const { res, unfinished, photosOut } = await go(photos(15), srv, { sleep: null, stopAfter: 60 });
  assert.equal(res.stopped, '手动停止');
  assert.ok(res.ok < 15);
  assert.ok(unfinished.length > 0 && unfinished.every((u) => u.why === '已停止'));
  assert.equal(photosOut.length + unfinished.length <= 15, true);
});

test('own category, first time: columns come from the form, title side comes back', async () => {
  const srv = server();
  const spec = new C.TableSpec('质检单');
  const { res, photosOut } = await go(photos(2), srv, { spec, reads: 2 });
  assert.equal(res.ok, 2);
  assert.deepEqual(Object.keys(photosOut[0].recs[0]).filter((k) => !C.META.has(k)), ['Date', 'M/C No.', 'Qty', 'Remark']);
  assert.equal(photosOut[0].recs[0].Qty, '800');
  assert.equal(photosOut[0].side, 'right');
});

test('progress ticks per photo, not per batch: 3 photos count 1, 2, 3 as each one finishes', async () => {
  const srv = server();
  const { ticks } = await go(photos(3), srv);
  assert.deepEqual(ticks.map(([d]) => d), [0, 1, 2, 3, 3]);          // 开头 0、每张一跳、整批存完再报一次
  assert.ok(ticks.every(([, t]) => t === 3));
  const { ticks: t7 } = await go(photos(7), server());
  assert.deepEqual(t7.map(([d]) => d), [0, 1, 2, 3, 4, 5, 5, 6, 7, 7]);
});
