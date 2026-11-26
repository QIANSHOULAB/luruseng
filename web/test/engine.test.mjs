// 网页版干活那一套（engine.js）：跟电脑版 tests/test_engine.py 同样的场景，用假的谷歌服务器
// 跑：node --test web/test/engine.test.mjs
import './zh.mjs';
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
  const S = { modes: {}, once: {}, log: [], inflight: 0, peak: 0, delay: 2, calls: {}, slow: {} };   // slow：{宽: 毫秒} 这张慢
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
    const w = JSON.parse(Buffer.from(body.contents[0].parts[1].inline_data.data, 'base64').toString()).w;
    await new Promise((r) => setTimeout(r, S.slow[w] ?? S.delay));
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
  const logs = [], photosOut = [], unfinished = [], ticks = [], events = [];
  let batches = 0;
  const eng = new Engine({ keys: [K1], model: C.DEFAULT_MODEL, reads: 1, log: (m) => logs.push(m), fetchImpl: srv.fetch,
    prepare, sleep: async () => {}, ...opts });
  if (opts.stopAfter) setTimeout(() => eng.stop(), opts.stopAfter);
  const res = await eng.run(items, {
    onPhoto: async (it, recs, err, side) => { photosOut.push({ no: it.no, recs, err, side }); events.push(`photo ${it.no}`); },
    onUnfinished: async (it, why) => unfinished.push({ no: it.no, why }),
    onBatch: async () => { batches++; events.push('batch'); },
    progress: (d, t) => ticks.push([d, t]),
  });
  return { res, logs, photosOut, unfinished, batches, eng, ticks, events };
}

test('twelve photos come back numbered in order, five at a time', async () => {
  const srv = server();
  const { res, photosOut, batches } = await go(photos(12), srv);
  assert.equal(res.ok, 12); assert.equal(res.records, 12); assert.equal(res.requests, 12);
  assert.ok(srv.peak <= 5 && srv.peak >= 2);
  assert.equal(batches, 3);
  const byNo = [...photosOut].sort((a, b) => a.no - b.no);          // 认完一张交一张：先回来的不一定是小号，编号跟照片对得上就行
  assert.deepEqual(byNo.map((p) => p.no), [...Array(12).keys()].map((i) => i + 1));
  assert.deepEqual(byNo.map((p) => p.recs[0].opr_no), [...Array(12).keys()].map((i) => String(800 + i)));
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
  assert.deepEqual(photosOut.map((p) => p.no).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7]);
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
  assert.deepEqual(photosOut.map((p) => p.no).sort(), [1, 2, 3]);
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

test('each photo is handed over the moment it is done: a slow one does not hold up the batch', async () => {
  const srv = server();
  srv.slow = { 800: 80 };                        // 第 1 张慢吞吞：2、3 先认完先存（页面这时被关，2、3 也不白干）
  const { events, ticks, photosOut } = await go(photos(3), srv);
  assert.deepEqual(events, ['photo 2', 'photo 3', 'photo 1', 'batch']);
  assert.deepEqual(ticks.map(([d]) => d), [0, 1, 2, 3, 3]);
  assert.deepEqual(photosOut.find((p) => p.no === 1).recs[0].opr_no, '800');
});

test('saving a photo blows up: logged, the rest still go on', async () => {
  const srv = server();
  const logs = [], got = [];
  const eng = new Engine({ keys: [K1], model: C.DEFAULT_MODEL, reads: 1, log: (m) => logs.push(m), fetchImpl: srv.fetch, prepare, sleep: async () => {} });
  const res = await eng.run(photos(3), {
    onPhoto: async (it) => { if (it.no === 2) throw new Error('QuotaExceededError'); got.push(it.no); },
    onUnfinished: async () => {}, onBatch: async () => {},
  });
  assert.equal(res.ok, 3);
  assert.equal(res.stopped, '');
  assert.deepEqual(got.sort(), [1, 3]);
  assert.ok(logs.some((m) => m === '✗ 02 结果没存上：QuotaExceededError'), logs);
});

// ---------------------------------------------------------------- 089 先问大管家，问不成跳回 Gemini
import { Butler, Miss, BATCH as DAGJ_BATCH } from '../dagj.js';

function butler(answer) {                        // 真的 Butler（歇不歇照它自己的算），只把「交给中转站」换成假的
  const mem = new Map();
  const b = new Butler({ storage: { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) } });
  b.info = { cid: 'c'.repeat(22), key: 'k', at: '' };
  b.calls = 0;
  b.read = async (body) => { b.calls++; return answer(body, b.calls); };
  return b;
}
const fromSrv = (srv) => async (body) => { const [, obj] = srv.answer('ok', body); return obj; };
async function goB(items, srv, b, opts = {}) {
  const logs = [], out = [];
  const eng = new Engine({ keys: [K1], model: C.DEFAULT_MODEL, reads: 1, log: (m) => logs.push(m), fetchImpl: srv.fetch,
    prepare, sleep: async () => {}, butler: b, ...opts });
  const res = await eng.run(items, {
    onPhoto: async (it, recs, err, side, stamped, by) => { out.push({ no: it.no, recs, err, by }); },
    onUnfinished: async () => {}, onBatch: async () => {}, progress: () => {},
  });
  return { res, logs, out };
}

test('089 paired: every photo goes to the butler, Gemini is never asked, each says who read it', async () => {
  const srv = server();
  const b = butler(fromSrv(srv));
  const { res, out } = await goB(photos(6), srv, b, { reads: 2 });
  assert.equal(res.ok, 6);
  assert.equal(res.requests, 0);
  assert.equal(b.calls, 12);
  assert.ok(out.every((p) => p.by === 'dagj'));
  assert.deepEqual(out.map((p) => p.recs[0].opr_no).sort(), [...Array(6).keys()].map((i) => String(800 + i)));
});

test('089 the butler misses one: that photo goes to Gemini whole, the rest stay with the butler', async () => {
  const srv = server();
  const b = butler(async (body, n) => { if (n === 1) throw new Miss('大管家不在'); return fromSrv(srv)(body); });
  const { res, out, logs } = await goB(photos(1), srv, b, { reads: 2 });
  assert.equal(res.ok, 1);
  assert.equal(out[0].by, 'gemini');
  assert.equal(res.requests, 2);
  assert.ok(logs.some((m) => m.includes('大管家没认成') && m.includes('大管家不在')));
  const again = await goB(photos(2), srv, b, { reads: 1 });
  assert.ok(again.out.every((p) => p.by === 'dagj'));
});

test('089 three misses in a row: five minutes straight to Gemini, then the butler again', async () => {
  const srv = server();
  let t = 1_000_000;
  const b = butler(async () => { throw new Miss('60 秒没回'); });
  b.clock = () => t;
  const n = DAGJ_BATCH + 3;
  const { res, out, logs } = await goB(photos(n), srv, b);
  assert.equal(res.ok, n);
  assert.ok(out.every((p) => p.by === 'gemini'));
  assert.equal(b.calls, DAGJ_BATCH);             // 093：头一批 12 张同时问了；第二批 3 张直接 Gemini
  assert.equal(logs.filter((m) => m.includes('5 分钟')).length, 1);
  t += 300_001;
  b.read = async (body) => { b.calls++; return fromSrv(srv)(body); };
  const later = await goB(photos(1), srv, b);
  assert.equal(later.out[0].by, 'dagj');
});

test('089 no key at all: the butler still works; a photo it misses fails, the run goes on', async () => {
  const srv = server();
  const b = butler(async (body, n) => { if (n === 2) throw new Miss('大管家没回'); return fromSrv(srv)(body); });
  const { res, out } = await goB(photos(3), srv, b, { keys: [] });
  assert.equal(res.ok, 2);
  assert.equal(res.failed, 1);
  assert.match(out.find((p) => !p.recs).err, /没填钥匙/);
});

test('089 revoked (403): the butler forgets the pairing, the photo goes to Gemini', async () => {
  const srv = server();
  const mem = new Map([['luru.dagj', JSON.stringify({ cid: 'c'.repeat(22), key: 'A'.repeat(43), at: '' })]]);
  let changed = 0;
  const b = new Butler({ storage: { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) },
    fetchImpl: async () => new Response(JSON.stringify({ revoked: true }), { status: 403 }) });
  b.onChange = () => changed++;
  assert.equal(b.paired, true);
  const { out } = await goB(photos(1), srv, b);
  assert.equal(out[0].by, 'gemini');
  assert.equal(b.paired, false);
  assert.equal(mem.has('luru.dagj'), false);
  assert.equal(changed, 1);
});

// ---------------------------------------------------------------- 167 先走 Claude API（钥匙在中转站），不成再问大管家，再不成 Gemini
import { Claude, ClaudeMiss, jsonSchema, claudeBody, QUOTA_REST, REST as CLAUDE_REST } from '../claude.js';

/** 假中转站 /ai：照 luruseng-relay src/ai.js 回。把 Claude 请求翻回 Gemini 的样子交给假谷歌出字，再包成 Claude 的回答 */
function relay(srv, { mode = () => 'ok', conf = { luru: { model: 'claude-opus-5-5', effort: 'low' } } } = {}) {
  const R = { conf: 0, msgs: [], heads: [] };
  R.fetch = async (url, init) => {
    const path = new URL(url).pathname;
    R.heads.push(init.headers['x-lr-cid']);
    if (path === '/ai/conf') { R.conf++; return new Response(JSON.stringify({ ok: true, conf, key: true, rest: null }), { status: 200 }); }
    const body = JSON.parse(init.body);
    R.msgs.push(body);
    const m = mode(R.msgs.length, body);
    if (m && m.status) return new Response(JSON.stringify(m.body || { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }), { status: m.status, headers: m.headers || {} });
    if (m === 'quota') return new Response(JSON.stringify({ why: 'quota', until: 1 }), { status: 503 });
    if (m === '500') return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Internal server error' } }), { status: 500 });
    if (m === 'noformat' && body.output_config.format) {
      return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'output_config.format: schema is not supported' } }), { status: 400 });
    }
    const img = body.messages[0].content.find((b) => b.type === 'image').source.data;
    const g = { systemInstruction: { parts: [{ text: body.system[0].text }] }, contents: [{ parts: [{ text: '' }, { inline_data: { mime_type: 'image/jpeg', data: img } }] }], generationConfig: {} };
    const [, obj] = srv.answer('ok', g);
    const text = obj.candidates[0].content.parts[0].text;
    const said = m === 'noformat' ? '好的：\n```json\n' + text + '\n```' : text;
    return new Response(JSON.stringify({ id: 'msg', type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn',
      content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: said }], usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200, headers: (m && m.ok) || {} });
  };
  return R;
}
const claudeOf = (R, b, t = null) => new Claude({ butler: b, fetchImpl: R.fetch, ...(t ? { clock: () => t.now } : {}) });

test('167 schema: Gemini types become JSON Schema with additionalProperties false', () => {
  const s = jsonSchema(C.SCHEMA);
  assert.equal(s.type, 'object');
  assert.equal(s.additionalProperties, false);
  assert.equal(s.properties.records.type, 'array');
  assert.equal(s.properties.records.items.additionalProperties, false);
  assert.deepEqual(s.properties.records.items.properties.unsure, { type: 'array', items: { type: 'string' } });
  const body = claudeBody(C.buildBody('QUJD', C.DEFAULT_MODEL, true), { model: 'claude-opus-5-5', effort: 'low' });
  assert.equal(body.output_config.effort, 'low');
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral' });
  assert.ok(!('thinking' in body) && !('temperature' in body));
  assert.deepEqual(body.messages[0].content.map((b) => b.type), ['text', 'image']);      // 照片放后面
  const plain = claudeBody(C.buildBody('QUJD', C.DEFAULT_MODEL, true), { model: 'm', effort: 'low' }, false);
  assert.ok(!plain.output_config.format);
  assert.match(plain.messages[0].content.at(-2).text, /JSON Schema/);
});

test('167 API works: every photo read twice by Claude, the butler and Gemini never asked, model from /ai/conf', async () => {
  const srv = server();
  const R = relay(srv);
  const b = butler(async () => { throw new Error('不该问大管家'); });
  const { res, out, logs } = await goB(photos(5), srv, b, { reads: 2, claude: claudeOf(R, b) });
  assert.equal(res.ok, 5);
  assert.equal(res.requests, 0);
  assert.equal(b.calls, 0);
  assert.equal(R.msgs.length, 10);
  assert.equal(R.conf, 1);                                     // 开工问一次，缓存着
  assert.ok(R.msgs.every((m) => m.model === 'claude-opus-5-5' && m.output_config.effort === 'low'));
  assert.ok(R.heads.every((h) => h === 'c'.repeat(22)));
  assert.ok(out.every((p) => p.by === 'claude'));
  assert.deepEqual(out.map((p) => p.recs[0].opr_no).sort(), [...Array(5).keys()].map((i) => String(800 + i)));
  assert.ok(!logs.some((m) => m.includes('Claude')), logs);
});

test('167 API resting (503 quota): the butler takes over, said once, /ai left alone for 30 minutes', async () => {
  const srv = server();
  const t = { now: 1_000_000 };
  const R = relay(srv, { mode: () => 'quota' });
  const b = butler(fromSrv(srv));
  const a = claudeOf(R, b, t);
  const { res, out, logs } = await goB(photos(3), srv, b, { reads: 2, claude: a });
  assert.equal(res.ok, 3);
  assert.ok(out.every((p) => p.by === 'dagj'));
  assert.equal(logs.filter((m) => m.includes('Claude 先歇着')).length, 1, logs);
  const asked = R.msgs.length;
  assert.ok(asked >= 1 && asked <= 3);
  const again = await goB(photos(2), srv, b, { claude: a });
  assert.ok(again.out.every((p) => p.by === 'dagj'));
  assert.equal(R.msgs.length, asked);                          // 歇着：不再问
  t.now += QUOTA_REST + 1;
  a.fetch = relay(srv).fetch;
  const back = await goB(photos(1), srv, b, { claude: a });
  assert.equal(back.out[0].by, 'claude');
});

test('167 API error: the butler; the butler not there either: Gemini', async () => {
  const srv = server();
  const R = relay(srv, { mode: () => '500' });
  const b = butler(async () => { throw new Miss('大管家不在'); });
  const { res, out, logs } = await goB(photos(1), srv, b, { reads: 2, claude: claudeOf(R, b) });
  assert.equal(res.ok, 1);
  assert.equal(out[0].by, 'gemini');
  assert.equal(res.requests, 2);
  assert.ok(logs.some((m) => m.includes('Claude 没认成') && m.includes('500')), logs);
  assert.ok(logs.some((m) => m.includes('大管家没认成')), logs);
});

test('167 three API misses in a row: five minutes without /ai, then Claude again', async () => {
  const srv = server();
  const t = { now: 1_000_000 };
  const R = relay(srv, { mode: () => '500' });
  const b = butler(fromSrv(srv));
  const a = claudeOf(R, b, t);
  const n = DAGJ_BATCH + 3;
  const { res, out, logs } = await goB(photos(n), srv, b, { claude: a });
  assert.equal(res.ok, n);
  assert.ok(out.every((p) => p.by === 'dagj'));
  assert.equal(R.msgs.length, DAGJ_BATCH);                     // 头一批同时问了；第二批直接大管家
  assert.equal(logs.filter((m) => m.includes('Claude 连着 3 张')).length, 1);
  t.now += CLAUDE_REST + 1;
  a.fetch = relay(srv).fetch;
  const later = await goB(photos(1), srv, b, { claude: a });
  assert.equal(later.out[0].by, 'claude');
});

test('167 one of the two reads fails: the whole photo goes to the butler (both reads there)', async () => {
  const srv = server();
  const R = relay(srv, { mode: (n) => (n === 2 ? '500' : 'ok') });
  const b = butler(fromSrv(srv));
  const { res, out } = await goB(photos(1), srv, b, { reads: 2, claude: claudeOf(R, b) });
  assert.equal(res.ok, 1);
  assert.equal(out[0].by, 'dagj');
  assert.equal(R.msgs.length, 2);
  assert.equal(b.calls, 2);
});

test('167 not paired: /ai never asked, Gemini as before', async () => {
  const srv = server();
  const R = relay(srv);
  const mem = new Map();
  const b = new Butler({ storage: { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) } });
  const { res, out } = await goB(photos(2), srv, b, { claude: claudeOf(R, b) });
  assert.equal(res.ok, 2);
  assert.ok(out.every((p) => p.by === 'gemini'));
  assert.equal(R.msgs.length + R.conf, 0);
});

test('167 structured output refused: asked again with the schema in the words, JSON dug out', async () => {
  const srv = server();
  const R = relay(srv, { mode: () => 'noformat' });
  const b = butler(fromSrv(srv));
  const a = claudeOf(R, b);
  const { out } = await goB(photos(2), srv, b, { claude: a });
  assert.ok(out.every((p) => p.by === 'claude'));
  assert.equal(a.useFormat, false);
  assert.ok(R.msgs.at(-1).messages[0].content.at(-1).text.includes('只输出 JSON'));
  assert.ok(new ClaudeMiss('x', { quota: true }) instanceof Miss);
});

// ---------------------------------------------------------------- 180 限速：429 照 retry-after 等、排回队尾；剩的 token 不够先等
/** 假钟：「睡」就是把钟拨快，睡了多久记下来 */
function fakeTime(at = Date.parse('2026-11-26T03:00:00Z')) {
  const t = { now: at, waits: [] };
  t.sleep = async (ms) => { t.waits.push(ms); t.now += ms; };
  return t;
}
const paced = (R, b, t) => new Claude({ butler: b, fetchImpl: R.fetch, clock: () => t.now, sleep: t.sleep });
const imageOf = (m) => m.messages[0].content.find((x) => x.type === 'image').source.data;

test('180 429 with retry-after: waits that long, then Claude reads the photo; nothing falls back', async () => {
  const srv = server();
  const t = fakeTime();
  const R = relay(srv, { mode: (n) => (n === 1 ? { status: 429, headers: { 'retry-after': '7' } } : 'ok') });
  const b = butler(async () => { throw new Error('不该问大管家'); });
  const a = paced(R, b, t);
  const { res, out, logs } = await goB(photos(1), srv, b, { reads: 2, claude: a });
  assert.equal(res.ok, 1);
  assert.equal(out[0].by, 'claude');
  assert.equal(R.msgs.length, 3);                              // 撞一下、重发、第二遍
  assert.deepEqual(t.waits, [7000]);
  assert.equal(b.calls, 0);
  assert.equal(a.misses, 0);
  assert.ok(logs.some((m) => m.includes('限速') && m.includes('7 秒')), logs);
  assert.ok(!logs.some((m) => m.includes('没认成')), logs);
});

test('180 the same photo hits 429 three times (no retry-after: 20 s each): only then the butler', async () => {
  const srv = server();
  const t = fakeTime();
  const R = relay(srv, { mode: () => ({ status: 429 }) });
  const b = butler(fromSrv(srv));
  const a = paced(R, b, t);
  const { out, logs } = await goB(photos(1), srv, b, { reads: 2, claude: a });
  assert.equal(R.msgs.length, 3);
  assert.deepEqual(t.waits, [20000, 20000]);
  assert.equal(out[0].by, 'dagj');
  assert.equal(a.misses, 1);
  assert.ok(logs.some((m) => m.includes('Claude 没认成') && m.includes('429 连撞 3 次')), logs);
});

test('180 the relay daily limit (429 why day) is not a rate limit: straight to the butler, no waiting', async () => {
  const srv = server();
  const t = fakeTime();
  const R = relay(srv, { mode: () => ({ status: 429, body: { why: 'day', max: 400 } }) });
  const b = butler(fromSrv(srv));
  const { out } = await goB(photos(1), srv, b, { reads: 2, claude: paced(R, b, t) });
  assert.equal(R.msgs.length, 1);
  assert.deepEqual(t.waits, []);
  assert.equal(out[0].by, 'dagj');
});

test('180 not enough input tokens left for another photo: waits for the reset before sending', async () => {
  const srv = server();
  const t = fakeTime();
  const sent = [];
  const R = relay(srv, { mode: (n) => {
    sent.push(t.now);
    return { ok: { 'anthropic-ratelimit-input-tokens-remaining': n === 1 ? '3000' : '400000', 'anthropic-ratelimit-input-tokens-reset': new Date(t.now + 30_000).toISOString() } };
  } });
  const b = butler(async () => { throw new Error('不该问大管家'); });
  const { out } = await goB(photos(2), srv, b, { reads: 1, claude: paced(R, b, t) });
  assert.ok(out.every((p) => p.by === 'claude'));
  assert.deepEqual(t.waits, []);                               // 两张一起发的时候还不知道剩多少
  const a = paced(R, b, t);
  R.msgs.length = 0; sent.length = 0;
  const two = await goB(photos(1), srv, b, { reads: 2, claude: a });
  assert.equal(two.out[0].by, 'claude');
  assert.deepEqual(t.waits, [30000]);                          // 第一遍回来说只剩 3000：第二遍等到补满
  assert.equal(sent[1] - sent[0], 30000);
  await goB(photos(1), srv, b, { reads: 2, claude: a });
  assert.deepEqual(t.waits, [30000]);                          // 剩得多：不等
});

test('180 the one that hit 429 goes to the back of the queue (four at a time)', async () => {
  const srv = server();
  const t = fakeTime();
  const R = relay(srv, { mode: (n) => (n === 1 ? { status: 429, headers: { 'retry-after': '3' } } : 'ok') });
  const a = paced(R, butler(fromSrv(srv)), t);
  const body = (i) => C.buildBody(Buffer.from(`img${i}`).toString('base64'), C.DEFAULT_MODEL, true);
  const num = (m) => Number(Buffer.from(imageOf(m), 'base64').toString().slice(3));
  let release;
  const held = new Promise((ok) => { release = ok; });         // 1、2、3 一直占着位子：只剩一个位子轮着用
  a.fetch = async (url, init) => {
    if (String(url).endsWith('/ai/conf')) return R.fetch(url, init);
    const m = JSON.parse(init.body);
    R.msgs.push(m);
    if (R.msgs.length === 1) return new Response('{}', { status: 429, headers: { 'retry-after': '3' } });
    if (R.msgs.length === 7) release();
    if ([1, 2, 3].includes(num(m))) await held;
    return new Response(JSON.stringify({ type: 'message', role: 'assistant', model: m.model, stop_reason: 'end_turn', content: [{ type: 'text', text: '{"records":[]}' }] }), { status: 200 });
  };
  await Promise.all([0, 1, 2, 3, 4, 5].map((i) => a.read(body(i))));
  assert.deepEqual(R.msgs.map(num), [0, 1, 2, 3, 4, 5, 0]);    // 撞了的排在等着的 4、5 后面
});

test('180 stop while waiting: no more requests', async () => {
  const srv = server();
  const R = relay(srv, { mode: () => ({ status: 429, headers: { 'retry-after': '60' } }) });
  const a = claudeOf(R, butler(fromSrv(srv)));
  const ctl = new AbortController();
  const body = C.buildBody('QUJD', C.DEFAULT_MODEL, true);
  await assert.rejects(a.read(body, ctl.signal, () => setTimeout(() => ctl.abort(), 20)), (e) => e instanceof ClaudeMiss && e.down === false);
  assert.equal(R.msgs.length, 1);
});

// ---------------------------------------------------------------- 183 点开错格子的「猜」：三条路认出来的记录都带
const FAKE_BOOK = () => {                       // 编的公司资料：机台、工序、调试员、简写
  const recs = [];
  for (let i = 0; i < 8; i++) {
    recs.push({ date: { y: 2026, m: 10, d: i + 1 }, machine: ['QM-7', 'QM-8', 'QM-9', 'QM-14'][i % 4], part_number: 'PX-101202-5',
      mo: String(90001000 + i), opr_no: String([150, 170][i % 2]), description: ['EM3', 'EM8'][i % 2], shift: 'D', setter: ['9471', '9491'][i % 2] });
  }
  return new C.Snapshot(recs, [['9471', 'TAN AH MENG'], ['9491', 'GOH KIM SENG']], { machine: ['QM-7', 'QM-8', 'QM-9', 'QM-14'], opr_no: ['150', '170'] });
};
function twoReads() {                           // 假回答：第一遍夜白不一样、机台、工序、工号公司都没有，刀具编码两遍直径不同
  const srv = server();
  let n = 0;
  srv.answer = () => {
    const second = ++n === 2;
    const rec = { date: '30/10', machine: 'QM-2', part_number: 'XY-1', mo: '90009999', opr_no: '140', t_no: 'T4',
      description: second ? '4FEM-M0800C-0080-04' : '4FEM-M0300C-0080-04', btmp: '1', total_screened: '1', passed: '1', failed: '0',
      shift: second ? 'N' : 'D', setter: '9441', unsure: [] };
    return [200, { candidates: [{ content: { parts: [{ text: JSON.stringify({ title_side: 'top', records: [rec] }) }] }, finishReason: 'STOP' }] }];
  };
  return srv;
}

for (const path of ['gemini', 'dagj', 'claude']) {
  test(`183 ${path}: the record keeps both reads and the company candidates, so every wrong cell has its guesses`, async () => {
    const srv = twoReads();
    const b = butler(fromSrv(srv));
    const opts = { reads: 2, butler: path === 'gemini' ? null : b };
    if (path === 'claude') opts.claude = claudeOf(relay(srv), b);
    const { out } = await goB(photos(1), srv, b, opts);
    assert.equal(out[0].by, path);
    const book = FAKE_BOOK();
    const row = C.assessRecord(out[0].recs[0], { snapshot: book, names: book.roster(), today: new Date(2026, 10, 1) });
    for (const f of ['shift', 'machine', 'opr_no', 'setter', 'description']) assert.ok(row.red.includes(f), `${path} ${f} ${row.red} ${row.notes}`);
    assert.deepEqual(row.alts.shift, ['D', 'N']);
    assert.ok(row.alts.machine.length >= 2 && row.alts.machine.every((m) => m.startsWith('QM-')), row.alts.machine);
    assert.deepEqual([...row.alts.opr_no].sort(), ['150', '170']);
    assert.ok(row.alts.setter.includes('9491/GOH KIM SENG') || row.alts.setter.includes('9471/TAN AH MENG'), row.alts.setter);
    assert.deepEqual(row.alts.description, ['EM3', 'EM8']);
    assert.deepEqual(C.quickGuesses(row, 'shift'), ['N']);
    for (const f of ['machine', 'opr_no', 'setter']) assert.ok(C.quickGuesses(row, f).length, f);
  });
}
