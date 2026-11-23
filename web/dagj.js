// 089 认照片先问大管家（方丈的私人管家），问不成自己跳回 Gemini（跟电脑版 bangong/dagj.py 一套）。
// - 配对：点「连接大管家」输一次暗号。暗号用大管家的公钥加密着发过去（中转站看不见）；对了，大管家回一把这个浏览器
//   自己的钥匙，存在这个浏览器里（localStorage），关了再开、隔天再开都还连着。
// - 认一张：把本来要发给 Gemini 的那个请求加密交给中转站 /lr/ask，大管家认完照 Gemini 的样子回来。
// - 跳回 Gemini：没配对、连不上、大管家不在、60 秒没回、回了错。连着 3 张没成，5 分钟里直接走 Gemini，5 分钟后再试。
// - 撤掉了（403）或者大管家拆不开（forget）：忘掉这次配对，按钮回到「连接大管家」。

export const RELAY = 'https://luruseng-relay.lunzigeju.workers.dev';
export const WAIT = 60_000;
export const MISSES = 3;
export const REST = 300_000;
export const PARALLEL = 3;
const STORE = 'luru.dagj';
const enc = new TextEncoder();
const dec = new TextDecoder();

export class Miss extends Error {}

export const b64u = (buf) => {
  const u8 = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const unb64u = (s) => {
  const t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

/** 配对表里那一行：哪个浏览器、哪种电脑（不写人名） */
export function label(ua = (globalThis.navigator && navigator.userAgent) || '') {
  const b = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '浏览器';
  const os = /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  return `录入僧网页版 · ${b}${os ? ' · ' + os : ''}`;
}

function loadPair(storage) {
  try {
    const p = JSON.parse(storage.getItem(STORE) || 'null');
    return p && p.cid && p.key && unb64u(p.key).length === 32 ? p : null;
  } catch (e) { return null; }
}

export class Butler {
  constructor({ relay = RELAY, fetchImpl, clock = () => Date.now(), wait = WAIT, storage } = {}) {
    this.relay = relay.replace(/\/$/, '') + '/lr';
    this.fetch = fetchImpl || globalThis.fetch.bind(globalThis);
    this.clock = clock;
    this.wait = wait;
    try { this.storage = storage || globalThis.localStorage; } catch (e) { this.storage = null; }
    this.info = this.storage ? loadPair(this.storage) : null;
    this.misses = 0;
    this.restUntil = 0;
    this.active = 0;
    this.queue = [];
    this.onChange = () => {};
  }

  get paired() { return Boolean(this.info); }

  forget() {
    this.info = null;
    try { this.storage && this.storage.removeItem(STORE); } catch (e) { /* 存不了就算了 */ }
    this.onChange();
  }

  async _json(path, { method = 'GET', body, ms = 20_000, signal } = {}) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(new Error('timeout')), ms);
    const off = () => ctl.abort(signal.reason);
    if (signal) signal.addEventListener('abort', off, { once: true });
    try {
      const r = await this.fetch(this.relay + path, {
        method, signal: ctl.signal, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      });
      let j = {};
      try { j = await r.json(); } catch (e) { /* 不是 JSON */ }
      return [r.status, j || {}];
    } catch (e) {
      return [0, { error: ctl.signal.aborted ? 'timeout' : String(e && e.message || e) }];
    } finally {
      clearTimeout(t);
      if (signal) signal.removeEventListener('abort', off);
    }
  }

  /** -> {ok} / {wrong, left} / {locked, until} / {off} / {error} */
  async pair(code) {
    const [st, hello] = await this._json('/hello');
    if (st !== 200) return { error: `中转站连不上（${st}）` };
    if (!hello.on || !hello.pub) return { off: true };
    const cid = b64u(rand(16));
    const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const epk = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
    const pc = await crypto.subtle.importKey('raw', unb64u(hello.pub), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: pc }, eph.privateKey, 256);
    const hk = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
    const k = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: epk, info: enc.encode('luru/pair') }, hk,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const n = rand(12);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: n, additionalData: enc.encode('luru/pair/' + cid) }, k,
      enc.encode(JSON.stringify({ code: String(code).trim(), label: label() })));
    const [s2, r] = await this._json('/pair', { method: 'POST', ms: 45_000, body: { cid, epk: b64u(epk), n: b64u(n), ct: b64u(ct) } });
    if (s2 === 429 || r.locked) return { locked: true, until: r.until };
    if (s2 === 503) return { off: true };
    if (s2 !== 200) return { error: `没连上（${s2 || r.error}）` };
    if (!r.ok) return { wrong: true, left: r.left };
    let key;
    try {
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(r.n), additionalData: enc.encode('luru/paired/' + cid) }, k, unb64u(r.ct));
      key = JSON.parse(dec.decode(pt)).key;
    } catch (e) { return { error: '大管家回的拆不开' }; }
    const d = new Date();
    this.info = { cid, key, at: d.toISOString().slice(0, 16) };
    try { this.storage && this.storage.setItem(STORE, JSON.stringify(this.info)); } catch (e) { /* 存不了：这次开着能用 */ }
    this.misses = 0;
    this.restUntil = 0;
    this.onChange();
    return { ok: true };
  }

  ready() { return this.paired && this.clock() >= this.restUntil; }
  hit() { this.misses = 0; }
  /** 没成一张；连着 3 张就歇 5 分钟。-> 这回开始歇了没有 */
  miss() {
    this.misses++;
    if (this.misses >= MISSES) { this.restUntil = this.clock() + REST; this.misses = 0; return true; }
    return false;
  }

  async _slot() {
    if (this.active < PARALLEL) { this.active++; return; }
    await new Promise((ok) => this.queue.push(ok));
  }
  _free() { const next = this.queue.shift(); if (next) next(); else this.active--; }

  /** 一个 Gemini 请求交给大管家 -> 照 Gemini 的样子回来的 data；没成抛 Miss */
  async read(body, signal) {
    const p = this.info;
    if (!p) throw new Miss('没配对');
    await this._slot();
    let st, r, key;
    try {
      if (signal && signal.aborted) throw new Miss('停了');
      key = await crypto.subtle.importKey('raw', unb64u(p.key), 'AES-GCM', false, ['encrypt', 'decrypt']);
      const n = rand(12);
      const pt = enc.encode(JSON.stringify({ v: 1, id: b64u(rand(9)), body }));
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: n, additionalData: enc.encode('luru/ask/' + p.cid) }, key, pt);
      [st, r] = await this._json('/ask', { method: 'POST', ms: this.wait, signal, body: { cid: p.cid, n: b64u(n), ct: b64u(ct) } });
    } finally { this._free(); }
    if (st === 403 && (r.revoked || r.unknown)) { this.forget(); throw new Miss('配对被撤了'); }
    if (st === 0) throw new Miss(r.error === 'timeout' ? '60 秒没回' : '连不上');
    if (st === 503) throw new Miss('大管家不在');
    if (st === 504) throw new Miss('大管家没回');
    if (st !== 200) throw new Miss(`中转站 ${st}`);
    if (!r.ok) { if (r.forget) this.forget(); throw new Miss('大管家拆不开'); }
    let ans;
    try {
      const out = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(r.n), additionalData: enc.encode('luru/ans/' + p.cid) }, key, unb64u(r.ct));
      ans = JSON.parse(dec.decode(out));
    } catch (e) { throw new Miss('回的拆不开'); }
    if (!ans.ok) throw new Miss('大管家：' + String(ans.error || '').slice(0, 120));
    return ans.data;
  }
}
