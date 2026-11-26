// 167 认照片先走 Claude API（Song 那把钥匙，Max 每月送的额度），用完、出错回老办法（大管家 → Gemini）。跟电脑版 bangong/claude.py 一套。
// - 钥匙不在这台：只放在中转站。配上了大管家的（089 的 cid）才走这条：带 cid 把 Claude Messages 请求发到中转站 /ai/messages，
//   站里补上钥匙转给 Claude，原样回。没配对的录入僧一点不变。
// - 请求照大管家 handheld/luru.py 那套从 Gemini 请求翻过来：要求当 system（不变的那段放前面，加 prompt cache），照片放后面；
//   要 JSON 用结构化输出（output_config.format，Gemini 的 schema 翻成 JSON Schema）；不认 schema 就把 schema 写进提示、自己抠 JSON。
//   回答翻回 Gemini 的样子，后面那步（parseResponse）不用动。
// - 模型、档位从 /ai/conf 拿（大管家照它的 config.toml [ai] 推上去的），开工时问一次、缓存 10 分钟，不写死在这里。
// - 退路：额度歇着（503 quota）或者站里没钥匙：这一轮不再问 /ai，30 分钟后再问；别的错（超时、5xx、403）这一张走老办法，
//   连着 3 张没成 5 分钟里不问（跟 089 一样）。两遍对答案照旧，哪一遍没成整张换（Miss）。
// - 限速（180）：429 照回来的 retry-after 等（没有就等 20 秒），这一张排回队尾；同一张连撞 3 次才走老办法。
//   回答带的 anthropic-ratelimit-input-tokens-remaining 不够再发一张（约 1 万输入 token）时，先等到 -reset。
//   中转站一天上限那个 429（why: day）不是限速，照旧走老办法。
// - 走中转站、不用官方 SDK：钥匙不能下到浏览器里，请求要先到站里补钥匙；这里只是一条 fetch。
import { RELAY, Miss } from './dagj.js';

export const CONF_MS = 600_000;       // 模型表缓存多久
export const QUOTA_REST = 1_800_000;  // 额度歇着 / 没钥匙：多久以后再问
export const MISSES = 3;
export const REST = 300_000;
export const PARALLEL = 4;            // 同时问几张（Claude 那头按分钟限 tokens，一下子十几张容易撞 429）
export const TIMEOUT = 240_000;       // 一遍最多等多久（Opus low 认一张一般 10～60 秒）
export const MAX_TOKENS = 16000;
export const SLOW_WAIT = 20_000;      // 180：429 没带 retry-after 等多久
export const SLOW_HITS = 3;           // 同一张连撞几次 429 才走老办法
export const NEED_TOKENS = 10_000;    // 一张两遍约这么多输入 token（167 量的）：剩得比这少就先等
export const READ_TOKENS = 5_000;     // 发一遍先记上这么多（回来的头会盖掉）：同时在路上的几个不会都以为还够
export const WAIT_CAP = 120_000;      // 一回最多等多久（头上的时间离谱、这台钟不准也不干等）
const DEFAULT = { model: 'claude-opus-5-5', effort: 'low' };

/** 这一张 Claude 没认成：quota=true 是额度歇着 / 没钥匙（不算进「连着 3 张」）；down=false 是回了认不出的（只换这一张） */
export class ClaudeMiss extends Miss {
  constructor(msg, { quota = false, down = true, first = false } = {}) { super(msg, down); this.quota = quota; this.first = first; }
}

/** Gemini 的 schema（type 大写）-> JSON Schema（结构化输出要 additionalProperties: false） */
export function jsonSchema(g) {
  if (!g || typeof g !== 'object') return g;
  const t = String(g.type || '').toLowerCase();
  const out = {};
  if (t) out.type = t;
  if (typeof g.description === 'string') out.description = g.description;
  if (Array.isArray(g.enum)) out.enum = g.enum.slice();
  if (t === 'object') {
    out.properties = Object.fromEntries(Object.entries(g.properties || {}).map(([k, v]) => [k, jsonSchema(v)]));
    out.required = Array.isArray(g.required) ? g.required.slice() : [];
    out.additionalProperties = false;
  }
  if (t === 'array' && g.items) out.items = jsonSchema(g.items);
  if (g.nullable && t) return { anyOf: [out, { type: 'null' }] };
  return out;
}

/** 本来要发给 Gemini 的请求 -> Claude Messages 请求 */
export function claudeBody(body, { model, effort }, useFormat = true) {
  const sys = (((body || {}).systemInstruction || {}).parts || []).map((p) => (p && typeof p.text === 'string' ? p.text : '')).filter(Boolean).join('\n\n');
  const content = [];
  for (const turn of (body || {}).contents || []) {
    for (const p of (turn || {}).parts || []) {
      if (!p || typeof p !== 'object') continue;
      if (typeof p.text === 'string') content.push({ type: 'text', text: p.text });
      const d = p.inline_data || p.inlineData;
      if (d) content.push({ type: 'image', source: { type: 'base64', media_type: d.mime_type || d.mimeType || 'image/jpeg', data: d.data } });
    }
  }
  const schema = ((body || {}).generationConfig || {}).responseSchema;
  const out = { model, max_tokens: MAX_TOKENS, output_config: { effort } };
  if (sys) out.system = [{ type: 'text', text: sys, cache_control: { type: 'ephemeral' } }];   // 不变的那段：两遍、一批里的每张都一样，读缓存
  if (schema && useFormat) out.output_config.format = { type: 'json_schema', schema: jsonSchema(schema) };
  else {
    if (schema) content.push({ type: 'text', text: '照这个 JSON Schema 输出：\n' + JSON.stringify(jsonSchema(schema)) });
    content.push({ type: 'text', text: '只输出 JSON。' });
  }
  out.messages = [{ role: 'user', content }];
  return out;
}

/** 回的字里抠出 JSON（结构化输出就是整段；没用上的时候可能带 ``` 或一两句话） */
export function extractJson(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try { JSON.parse(t); return t; } catch (e) { /* 往下抠 */ }
  for (const [a, b] of [['{', '}'], ['[', ']']]) {
    const i = t.indexOf(a), j = t.lastIndexOf(b);
    if (i >= 0 && j > i) { try { JSON.parse(t.slice(i, j + 1)); return t.slice(i, j + 1); } catch (e) { /* 下一种 */ } }
  }
  throw new Error('Claude 回的不是 JSON：' + t.slice(0, 200));
}

/** Claude 的回答 -> Gemini 的样子（parseResponse 认得） */
export function geminiShape(msg) {
  if (!msg || msg.type !== 'message') throw new Error('不是 Claude 的回答');
  if (msg.stop_reason === 'refusal') throw new Error('Claude 不认这张（refusal）');
  if (msg.stop_reason === 'max_tokens') throw new Error('Claude 写到上限没写完');
  const text = (msg.content || []).filter((b) => b && b.type === 'text').map((b) => b.text || '').join('');
  return { candidates: [{ content: { role: 'model', parts: [{ text: extractJson(text) }] }, finishReason: 'STOP' }], modelVersion: 'claude/' + (msg.model || '') };
}

export class Claude {
  constructor({ butler, relay = RELAY, fetchImpl, clock = () => Date.now(), timeout = TIMEOUT, sleep = null } = {}) {
    this.butler = butler;                 // dagj.Butler：用它配对拿到的 cid
    this.relay = relay.replace(/\/$/, '');
    this.fetch = fetchImpl || globalThis.fetch.bind(globalThis);
    this.clock = clock;
    this.timeout = timeout;
    this._sleep = sleep;
    this.cid = null;
    this.reset();
    this.active = 0;
    this.queue = [];
  }

  reset() {
    this.cache = null; this.cacheAt = 0; this.confP = null; this.misses = 0; this.restUntil = 0; this.useFormat = true;
    this.holdUntil = 0;                                       // 180：429 叫等到几点
    this.left = null; this.leftReset = 0; this.leftNo = 0;    // 180：这一分钟还剩多少输入 token（不知道 = null）、几点补满
  }

  _cid() {
    const p = this.butler && this.butler.info;
    const cid = p ? p.cid : null;
    if (cid !== this.cid) { this.cid = cid; this.reset(); }   // 重新配了对 / 撤了：从头来
    return cid;
  }

  ready() { return Boolean(this._cid()) && this.clock() >= this.restUntil; }
  hit() { this.misses = 0; }
  /** 没成一张（不算额度歇着的）；连着 3 张歇 5 分钟。-> 这回开始歇了没有 */
  miss() {
    if (this.clock() < this.restUntil) return false;
    this.misses++;
    if (this.misses >= MISSES) { this.restUntil = this.clock() + REST; this.misses = 0; return true; }
    return false;
  }
  /** 额度歇着 / 没钥匙：30 分钟里不问。-> 是不是这回才开始歇（日志只说一次） */
  _quota() {
    const first = this.clock() >= this.restUntil;
    this.restUntil = Math.max(this.restUntil, this.clock() + QUOTA_REST);
    this.cache = null;
    return first;
  }

  async _call(path, { method = 'GET', body, signal, ms = 20_000 } = {}) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(new Error('timeout')), ms);
    const off = () => ctl.abort(signal.reason);
    if (signal) signal.addEventListener('abort', off, { once: true });
    try {
      const r = await this.fetch(this.relay + path, {
        method, signal: ctl.signal,
        headers: { 'x-lr-cid': this.cid, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      let j = {};
      try { j = await r.json(); } catch (e) { /* 不是 JSON */ }
      return [r.status, j || {}, r.headers];
    } catch (e) {
      return [0, { error: ctl.signal.aborted ? 'timeout' : String((e && e.message) || e) }, null];
    } finally {
      clearTimeout(t);
      if (signal) signal.removeEventListener('abort', off);
    }
  }

  /** 模型表：缓存 10 分钟。-> {model, effort}；歇着 / 没钥匙抛 ClaudeMiss(quota) */
  async conf(signal) {
    if (this.cache && this.clock() - this.cacheAt < CONF_MS) return this.cache;
    if (!this.confP) this.confP = this._conf(signal).finally(() => { this.confP = null; });   // 一批同时开工：只问一次
    return this.confP;
  }

  async _conf(signal) {
    const [st, j] = await this._call('/ai/conf', { signal });
    if (st !== 200 || !j.ok) throw new ClaudeMiss(`中转站 ${st || j.error}`);
    if (!j.key) throw new ClaudeMiss('中转站上还没 Claude 钥匙', { quota: true, first: this._quota() });
    if (j.rest && j.rest > this.clock()) throw new ClaudeMiss('Claude 额度歇着', { quota: true, first: this._quota() });
    const l = (j.conf && j.conf.luru) || {};
    this.cache = { model: String(l.model || DEFAULT.model), effort: String(l.effort || DEFAULT.effort) };
    this.cacheAt = this.clock();
    return this.cache;
  }

  async _slot() {
    if (this.active < PARALLEL) { this.active++; return; }
    await new Promise((ok) => this.queue.push(ok));
  }
  _free() { const next = this.queue.shift(); if (next) next(); else this.active--; }

  // ---------------------------------------------------------------- 180 限速
  async _wait(until, signal) {                 // 能被「停止」打断；按真实时间算
    while (this.clock() < until) {
      if (signal && signal.aborted) throw new ClaudeMiss('停了', { down: false });
      const ms = until - this.clock();
      if (this._sleep) { await this._sleep(ms); continue; }
      await new Promise((ok) => {
        const done = () => { clearTimeout(t); if (signal) signal.removeEventListener('abort', done); ok(); };
        const t = setTimeout(done, Math.min(30_000, ms));
        if (signal) signal.addEventListener('abort', done, { once: true });
      });
    }
    if (signal && signal.aborted) throw new ClaudeMiss('停了', { down: false });
  }

  /** 发之前看一眼：429 叫等着的、剩的 token 不够再发一张的，先等 */
  async _room(signal) {
    for (;;) {
      const now = this.clock();
      if (this.left !== null && this.leftReset <= now) this.left = null;      // 过了补满的点：旧数不算了
      const low = this.left !== null && this.left < NEED_TOKENS;
      const until = Math.max(this.holdUntil, low ? Math.min(this.leftReset, now + WAIT_CAP) : 0);
      if (until <= now) { if (this.left !== null) this.left -= READ_TOKENS; return; }
      const seen = this.leftNo;
      await this._wait(until, signal);
      if (low && this.leftNo === seen) this.left = null;                      // 等过了、这期间没来新数：当补上了
    }
  }

  _note(headers) {                             // 回答带的限速头（中转站原样带回来的；没有就什么也不记）
    if (!headers) return;
    const left = String(headers.get('anthropic-ratelimit-input-tokens-remaining') || '').trim();
    const at = Date.parse(headers.get('anthropic-ratelimit-input-tokens-reset') || '');
    if (!/^\d+$/.test(left) || !Number.isFinite(at)) return;
    this.left = Number(left); this.leftReset = at; this.leftNo++;
  }

  _slow(headers) {                             // 撞了 429：等 retry-after 秒，没有就 20 秒
    const raw = String((headers && headers.get('retry-after')) || '').trim();
    const s = raw ? Number(raw) : NaN;
    const ms = Number.isFinite(s) && s >= 0 ? Math.min(WAIT_CAP, Math.max(1000, s * 1000)) : SLOW_WAIT;
    this.holdUntil = Math.max(this.holdUntil, this.clock() + ms);
    return ms;
  }

  /** 一个 Gemini 请求交给 Claude -> 照 Gemini 的样子回来的 data；没成抛 ClaudeMiss。
   *  onSlow(秒)：撞了限速、这一张要等等再认 */
  async read(body, signal, onSlow = null) {
    if (!this._cid()) throw new ClaudeMiss('没配对');
    let hits = 0;                              // 这一遍连撞了几回 429（成了一遍就走了，下一遍从 0 数）
    for (;;) {
      await this._slot();
      try {
        if (signal && signal.aborted) throw new ClaudeMiss('停了', { down: false });
        const c = await this.conf(signal);
        for (;;) {
          await this._room(signal);
          const fmt = this.useFormat;
          const [st, r, headers] = await this._call('/ai/messages', { method: 'POST', body: claudeBody(body, c, fmt), signal, ms: this.timeout });
          if (signal && signal.aborted) throw new ClaudeMiss('停了', { down: false });
          this._note(headers);
          if (st === 200) {
            try { return geminiShape(r); } catch (e) { throw new ClaudeMiss(String(e.message || e).slice(0, 120), { down: false }); }
          }
          if (st === 503 && (r.why === 'quota' || r.why === 'nokey')) throw new ClaudeMiss(r.why === 'quota' ? 'Claude 额度歇着' : '中转站上还没 Claude 钥匙', { quota: true, first: this._quota() });
          const msg = String(((r && r.error) || {}).message || (r && r.error) || '');
          if (st === 429 && r.why !== 'day') {
            const ms = this._slow(headers);
            if (++hits >= SLOW_HITS) throw new ClaudeMiss(`Claude 429 连撞 ${hits} 次`);
            if (onSlow) onSlow(Math.ceil(ms / 1000));
            break;                             // 让出位子，排回队尾
          }
          if (st === 400 && fmt && /output_config|format|schema/i.test(msg)) { this.useFormat = false; continue; }   // 不认结构化输出：写进提示再来一次
          throw new ClaudeMiss(`Claude ${st || ''} ${(r && r.why) || msg}`.trim().slice(0, 120));
        }
      } finally { this._free(); }
    }
  }
}
