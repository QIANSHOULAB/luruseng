// 167 认照片先走 Claude API（Song 那把钥匙，Max 每月送的额度），用完、出错回老办法（大管家 → Gemini）。跟电脑版 bangong/claude.py 一套。
// - 钥匙不在这台：只放在中转站。配上了大管家的（089 的 cid）才走这条：带 cid 把 Claude Messages 请求发到中转站 /ai/messages，
//   站里补上钥匙转给 Claude，原样回。没配对的录入僧一点不变。
// - 请求照大管家 handheld/luru.py 那套从 Gemini 请求翻过来：要求当 system（不变的那段放前面，加 prompt cache），照片放后面；
//   要 JSON 用结构化输出（output_config.format，Gemini 的 schema 翻成 JSON Schema）；不认 schema 就把 schema 写进提示、自己抠 JSON。
//   回答翻回 Gemini 的样子，后面那步（parseResponse）不用动。
// - 模型、档位从 /ai/conf 拿（大管家照它的 config.toml [ai] 推上去的），开工时问一次、缓存 10 分钟，不写死在这里。
// - 退路：额度歇着（503 quota）或者站里没钥匙：这一轮不再问 /ai，30 分钟后再问；别的错（超时、5xx、429、403）这一张走老办法，
//   连着 3 张没成 5 分钟里不问（跟 089 一样）。两遍对答案照旧，哪一遍没成整张换（Miss）。
// - 走中转站、不用官方 SDK：钥匙不能下到浏览器里，请求要先到站里补钥匙；这里只是一条 fetch。
import { RELAY, Miss } from './dagj.js';

export const CONF_MS = 600_000;       // 模型表缓存多久
export const QUOTA_REST = 1_800_000;  // 额度歇着 / 没钥匙：多久以后再问
export const MISSES = 3;
export const REST = 300_000;
export const PARALLEL = 4;            // 同时问几张（Claude 那头按分钟限 tokens，一下子十几张容易撞 429）
export const TIMEOUT = 240_000;       // 一遍最多等多久（Opus low 认一张一般 10～60 秒）
export const MAX_TOKENS = 16000;
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
  constructor({ butler, relay = RELAY, fetchImpl, clock = () => Date.now(), timeout = TIMEOUT } = {}) {
    this.butler = butler;                 // dagj.Butler：用它配对拿到的 cid
    this.relay = relay.replace(/\/$/, '');
    this.fetch = fetchImpl || globalThis.fetch.bind(globalThis);
    this.clock = clock;
    this.timeout = timeout;
    this.cid = null;
    this.reset();
    this.active = 0;
    this.queue = [];
  }

  reset() { this.cache = null; this.cacheAt = 0; this.confP = null; this.misses = 0; this.restUntil = 0; this.useFormat = true; }

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
      return [r.status, j || {}];
    } catch (e) {
      return [0, { error: ctl.signal.aborted ? 'timeout' : String((e && e.message) || e) }];
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

  /** 一个 Gemini 请求交给 Claude -> 照 Gemini 的样子回来的 data；没成抛 ClaudeMiss */
  async read(body, signal) {
    if (!this._cid()) throw new ClaudeMiss('没配对');
    await this._slot();
    try {
      if (signal && signal.aborted) throw new ClaudeMiss('停了', { down: false });
      const c = await this.conf(signal);
      for (let i = 0; i < 2; i++) {
        const fmt = this.useFormat;
        const [st, r] = await this._call('/ai/messages', { method: 'POST', body: claudeBody(body, c, fmt), signal, ms: this.timeout });
        if (signal && signal.aborted) throw new ClaudeMiss('停了', { down: false });
        if (st === 200) {
          try { return geminiShape(r); } catch (e) { throw new ClaudeMiss(String(e.message || e).slice(0, 120), { down: false }); }
        }
        if (st === 503 && (r.why === 'quota' || r.why === 'nokey')) throw new ClaudeMiss(r.why === 'quota' ? 'Claude 额度歇着' : '中转站上还没 Claude 钥匙', { quota: true, first: this._quota() });
        const msg = String(((r && r.error) || {}).message || (r && r.error) || '');
        if (st === 400 && fmt && /output_config|format|schema/i.test(msg)) { this.useFormat = false; continue; }   // 不认结构化输出：写进提示再来一次
        throw new ClaudeMiss(`Claude ${st || ''} ${(r && r.why) || msg}`.trim().slice(0, 120));
      }
      throw new ClaudeMiss('Claude 不认这个格式');
    } finally { this._free(); }
  }
}
