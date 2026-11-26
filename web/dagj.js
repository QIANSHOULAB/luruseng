// 089 认照片先问大管家（方丈的私人管家），问不成自己跳回 Gemini（跟电脑版 bangong/dagj.py 一套）。
// - 配对：点「连接大管家」输一次暗号。暗号用大管家的公钥加密着发过去（中转站看不见）；对了，大管家回一把这个浏览器
//   自己的钥匙，存在这个浏览器里（localStorage），关了再开、隔天再开都还连着。
// - 认一张：把本来要发给 Gemini 的那个请求加密交给中转站 /lr/ask，大管家认完照 Gemini 的样子回来。
// - 跳回 Gemini（092 Song 11-23：「如果不是大管家用不了，不用 Gemini」）：只有没配对、连不上（隔 5 秒再试还不行）、大管家不在、
//   明说接不了、被撤，才直接换；慢不算：交过去就一直等，一遍最多 5 分钟，没回再交一次，第二次也没回才换；回了错也先再认一次。
//   连着 3 张是「用不了」才 5 分钟里直接走 Gemini，5 分钟后再试；因为慢、因为错换的不算进去。
// - 撤掉了（403）或者大管家拆不开（forget）：忘掉这次配对，按钮回到「连接大管家」。
// - 093 电脑、掌机一起认：一批同时交 BATCH 张，中转站按两台的空位分、都满就在站里排着（排队不算 5 分钟，从大管家取走起算，
//   中转站自己管：过了回 504 = 这一遍慢）。照片先缩到大脑自己会缩到的尺寸（fit，Opus 5.5：长边 2576、视觉 token 4784），
//   本来就在限度以内的原样发。

export const RELAY = 'https://luruseng-relay.lunzigeju.workers.dev';
export const WAIT = 1_230_000;        // 093：一次交过去最多等多久：中转站排队最多 15 分钟 + 大管家认 5 分钟，再宽一点
export const MISSES = 3;
export const REST = 300_000;
export const PARALLEL = 16;           // 093：同时问几张（排队交给中转站：电脑 4 + 掌机 8）
export const BATCH = 12;              // 093：配上大管家时一批交几张（没配上照旧 core.BATCH）
export const EDGE = 2576, TOKENS = 4784, PATCH = 28;   // 093：Opus 5.5 看图的限度（Claude 文档 vision-coordinates）

const up = (a) => Math.ceil(a / PATCH);
export const imageTokens = (w, h) => up(w) * up(h);
/** 大脑那边会把图缩到多大（照 Claude 文档的 resized_size）；本来就放得下 -> 原样 */
export function resizedSize(w, h, maxEdge = EDGE, maxTokens = TOKENS) {
  const fits = (a, b) => up(a) * PATCH <= maxEdge && up(b) * PATCH <= maxEdge && imageTokens(a, b) <= maxTokens;
  if (fits(w, h)) return [w, h];
  if (h > w) { const [rh, rw] = resizedSize(h, w, maxEdge, maxTokens); return [rw, rh]; }
  const ar = w / h;
  let lo = 1, hi = w;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid, Math.max(Math.round(mid / ar), 1))) lo = mid; else hi = mid;
  }
  return [lo, Math.max(Math.round(lo / ar), 1)];
}

/** 093：发给大管家之前缩到大脑自己会缩到的尺寸（JPEG 0.9）；本来就在限度以内的不动。b64 进、b64 出 */
export async function fit(b64) {
  try {
    const blob = new Blob([unb64(b64)], { type: 'image/jpeg' });
    const bmp = await createImageBitmap(blob);
    const [w, h] = resizedSize(bmp.width, bmp.height);
    if (w === bmp.width && h === bmp.height) { bmp.close && bmp.close(); return b64; }
    const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(bmp, 0, 0, w, h);
    bmp.close && bmp.close();
    const out = c.convertToBlob ? await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 })
      : await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.9));
    const u8 = new Uint8Array(await out.arrayBuffer());
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  } catch (e) { return b64; }
}
const unb64 = (s) => { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
const STORE = 'luru.dagj';
const enc = new TextEncoder();
const dec = new TextDecoder();

/** down=true：大管家真的用不了（没配对、连不上、不在、明说接不了、被撤），才算进「连着 3 张」；慢、回错（false）只换这一张 */
export class Miss extends Error {
  constructor(msg, down = true) { super(msg); this.down = down; }
}

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
  constructor({ relay = RELAY, fetchImpl, clock = () => Date.now(), wait = WAIT, sleep = (ms) => new Promise((ok) => setTimeout(ok, ms)), storage } = {}) {
    this.relay = relay.replace(/\/$/, '') + '/lr';
    this.fetch = fetchImpl || globalThis.fetch.bind(globalThis);
    this.clock = clock;
    this.wait = wait;
    this.sleep = sleep;
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

  async _json(path, { method = 'GET', body, ms = 20_000, signal, headers = {} } = {}) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(new Error('timeout')), ms);
    const off = () => ctl.abort(signal.reason);
    if (signal) signal.addEventListener('abort', off, { once: true });
    try {
      const r = await this.fetch(this.relay + path, {
        method, signal: ctl.signal,
        ...(body || Object.keys(headers).length ? { headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) } } : {}),
        ...(body ? { body: JSON.stringify(body) } : {}),
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
    if (this.clock() < this.restUntil) return false;   // 093：一批同时问的多：已经在歇了，别的没成的不再算一轮
    this.misses++;
    if (this.misses >= MISSES) { this.restUntil = this.clock() + REST; this.misses = 0; return true; }
    return false;
  }

  async _slot() {
    if (this.active < PARALLEL) { this.active++; return; }
    await new Promise((ok) => this.queue.push(ok));
  }
  _free() { const next = this.queue.shift(); if (next) next(); else this.active--; }

  async _askOnce(p, key, body, signal) {
    const n = rand(12);
    const pt = enc.encode(JSON.stringify({ v: 1, id: b64u(rand(9)), body }));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: n, additionalData: enc.encode('luru/ask/' + p.cid) }, key, pt);
    return this._json('/ask', { method: 'POST', ms: this.wait, signal, body: { cid: p.cid, n: b64u(n), ct: b64u(ct) } });
  }

  /** 一遍：交过去等大管家认完。093：中转站排队不算时间，从大管家取走起最多 5 分钟，中转站自己管，过了回 504。
   *  -> [状态码, 回的]；慢（504、等过头）-> null */
  async _round(p, key, body, signal) {
    if (signal && signal.aborted) throw new Miss('停了', false);
    let [st, r] = await this._askOnce(p, key, body, signal);
    if (signal && signal.aborted) throw new Miss('停了', false);
    if (st === 0 && r.error !== 'timeout') {             // 连不上：隔 5 秒再试一次
      await this.sleep(5000);
      [st, r] = await this._askOnce(p, key, body, signal);
      if (st === 0 && r.error !== 'timeout') throw new Miss('连不上');
    }
    if (st === 504 || st === 0) return null;
    return [st, r];
  }

  /** 一个 Gemini 请求交给大管家 -> 照 Gemini 的样子回来的 data；没成抛 Miss。
   *  092：慢不算用不了（一遍最多 5 分钟，没回再交一次，第二次也没回才 Miss，down=false）；回了错先再认一次。 */
  async read(body, signal) {
    const p = this.info;
    if (!p) throw new Miss('没配对');
    await this._slot();
    try {
      if (signal && signal.aborted) throw new Miss('停了', false);
      const key = await crypto.subtle.importKey('raw', unb64u(p.key), 'AES-GCM', false, ['encrypt', 'decrypt']);
      let slow = 0, errs = 0;
      for (;;) {
        const got = await this._round(p, key, body, signal);
        if (!got) {
          if (++slow >= 2) throw new Miss('大管家 2 次都没回，换 Gemini', false);
          continue;
        }
        const [st, r] = got;
        if (st === 403 && (r.revoked || r.unknown)) { this.forget(); throw new Miss('配对被撤了'); }
        if (st === 503) throw new Miss(r.cant ? '大管家在陪玩' : '大管家不在');
        if (st !== 200) throw new Miss(`中转站 ${st}`);
        if (!r.ok) {
          if (r.forget) { this.forget(); throw new Miss('大管家拆不开'); }
          if (++errs >= 2) throw new Miss('大管家回错 2 次', false);
          continue;
        }
        let ans;
        try {
          const out = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(r.n), additionalData: enc.encode('luru/ans/' + p.cid) }, key, unb64u(r.ct));
          ans = JSON.parse(dec.decode(out));
        } catch (e) { throw new Miss('回的拆不开', false); }
        if (ans.ok) return ans.data;
        if (ans.cant) throw new Miss('大管家：' + String(ans.error || '').slice(0, 120));     // 明说接不了（陪玩）：算不在
        if (++errs >= 2) throw new Miss('大管家：' + String(ans.error || '').slice(0, 120), false);
      }
    } finally { this._free(); }
  }

  // ---------------------------------------------------------------- 184 录入僧越用越准（learn.js 管记、管排队，这里只管封好交过去）
  /** 一包「人改过的格子」交给大管家（跟 /lr/ask 一样封）。
   *  -> {ok, got}：大管家收下了（删这包）/ {split}：太大（413）/ {gone}：配对没了（拆不开、被撤）/ {later, why}：过一阵再交 */
  async learn(pkg) {
    const p = this.info;
    if (!p) return { gone: true };
    let key, ct;
    const n = rand(12);
    try {
      key = await crypto.subtle.importKey('raw', unb64u(p.key), 'AES-GCM', false, ['encrypt', 'decrypt']);
      ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: n, additionalData: enc.encode('luru/learn/' + p.cid) }, key,
        enc.encode(JSON.stringify(pkg)));
    } catch (e) { return { later: true, why: String((e && e.message) || e) }; }
    const [st, r] = await this._json('/learn', { method: 'POST', ms: 120_000, body: { cid: p.cid, n: b64u(n), ct: b64u(ct) } });
    if (st === 413) return { split: true };
    if (st === 403 && (r.revoked || r.unknown)) { this.forget(); return { gone: true }; }
    if (st !== 200) return { later: true, why: String(st || r.error || '') };
    // forget:true 在这里不是「忘掉配对」：还没装新版的大管家拆不开学的包也这么回。照 {ok:false} 办：留着，过一阵再交
    if (!r.ok) return { later: true, why: r.forget ? 'forget' : 'not ok' };
    try {
      const out = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(r.n), additionalData: enc.encode('luru/learned/' + p.cid) }, key, unb64u(r.ct));
      const ans = JSON.parse(dec.decode(out));
      if (ans && ans.ok) return { ok: true, got: ans.got };
    } catch (e) { /* 回执拆不开：当没收到，过一阵再交（大管家那头按 id 去重） */ }
    return { later: true, why: 'receipt' };
  }

  /** 大管家学会的那份「常错提醒」：-> {learn}（learn 可能是 null = 还没学到什么）；没配对、拿不到 -> null */
  async learnList() {
    const p = this.info;
    if (!p) return null;
    const [st, r] = await this._json('/learn/list', { headers: { 'x-lr-cid': p.cid } });
    if (st === 200 && r && r.ok) return { learn: r.learn && typeof r.learn === 'object' ? r.learn : null };
    return null;
  }
}
