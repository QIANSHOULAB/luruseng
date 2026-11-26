// 184 录入僧越用越准（Song 11-26：「自动把人修改过的数据传回到我们的数据里面去做修改……默认打开。」
// 「只要他填了我的暗号，他那个数据就是自动传回来给我做产品测试的。」）。跟电脑版 bangong/learn.py 一套。
// - 只有对上暗号（089 配了大管家）的才记、才发；⚙ 里一个开关，默认开，关了一格都不记、不发（攒着的也清掉）。没配对的连开关都不露。
// - 记什么：核对里人动过的每一格：改了值（edit）、点了「对的」（ok）、点了猜的值（guess）。每格带：类别、栏、认的（写进表的）、
//   人定的、原来什么颜色、两遍各认成什么、谁认的（claude / butler / gemini）和模型、第几批第几张、这台叫什么、几点。
//   人动过至少一格的那张，带上当时送去认的那张缩过的照片、提示词、schema，和人定完的整张答案（照认出来的 JSON 的样子），
//   大管家拿去重认一遍、一格一格比。没动过的张不带照片。
// - 什么时候发：这批核完（关了核对、换了批）或者核对 10 分钟没动 → 打成一包排队；大管家不在、出错就留在这台（IndexedDB），
//   开页面、每 10 分钟、干完下一批再交；收到回执才删。一包 JSON 不超过 3 MB，照片多就拆几包；最多攒 50 包 / 150 MB，满了扔最老的。
// - 读回来：开页面、配上对时找中转站要大管家学会的「常错提醒」，存一份；认照片时三条路（Claude / 大管家 / Gemini）的提示词后面
//   都加上这个类别的几行。拿不到就照旧认，不挡认照片。「不用标红」（nored）：同类别同一栏、两遍都认成那个值的，不标红。
import * as C from './core.js';

export const IDLE = 600_000;          // 核对多久没动就打包
export const RESEND = 600_000;        // 多久再交一次排着的
export const MAX_PKG = 3_000_000;     // 一包 JSON 最大多少字节
export const MAX_QUEUE = 50;          // 最多攒几包
export const MAX_BYTES = 150_000_000; // 最多攒多少字节
export const LIST = 'learn/list';     // kv：大管家学会的那份
export const LOG = 'learn/log/';      // kv：每批人动过的格子（+ 批次号）
export const Q = 'learn/q/';          // kv：排着队等交的包（+ 毫秒时间）
export const IMG = 'learn/img/';      // photos：送去认的那张缩过的照片、提示词（+ 批次号/编号）
export const KEEP_DAYS = 14;          // 送去认的照片留几天（过了还没核就不要了）
export const HEAD = '常错提醒（大管家从人改过的格子里学的，是看字的提醒，不是规矩）：';

const uniq = (a) => [...new Set(a)];
const norm = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
const enc = new TextEncoder();
export const bytes = (o) => enc.encode(JSON.stringify(o)).length;
export function rid(n = 18) {
  const u8 = crypto.getRandomValues(new Uint8Array(n));
  return btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const iso = (ms) => new Date(ms).toISOString().slice(0, 19) + 'Z';
const WHO = { claude: 'claude', dagj: 'butler', gemini: 'gemini' };
export const who = (by) => WHO[by] || '';

// ---------------------------------------------------------------- 读回来的那份
/** 这个类别的几行提醒（这一类的 + 「*」所有类别的），去重 */
export function hintLines(learn, cat) {
  const l = learn && learn.lists && typeof learn.lists === 'object' ? learn.lists : null;
  if (!l) return [];
  const pick = (k) => (Array.isArray(l[k]) ? l[k] : []);
  return uniq([...pick(cat), ...pick('*')].map((x) => String(x ?? '').trim()).filter(Boolean));
}

/** 加在提示词后面的那段；没有就空字符串 */
export function hintBlock(learn, cat) {
  const lines = hintLines(learn, cat);
  return lines.length ? HEAD + '\n' + lines.map((x) => '- ' + x).join('\n') : '';
}

/** 本来要发的请求（Gemini 的样子）-> 提示词后面另加一段的新请求（原来那个不动；Claude 那条路两段用空行接上） */
export function withHints(body, block) {
  if (!block || !body || !body.systemInstruction) return body;
  const parts = [...(body.systemInstruction.parts || []), { text: block }];   // 跟大管家考试一样：提示词后面另起一段
  return { ...body, systemInstruction: { ...body.systemInstruction, parts } };
}

function colMatch(rule, cat, f) {
  const c = String(rule || '').trim();
  if (!c) return false;
  if (cat === C.BUILTIN) return c.toLowerCase() === f || c.toUpperCase() === (C.LABEL[f] || '').toUpperCase();
  return C.colkey(c) === C.colkey(f);
}

/** 「不用标红」：同类别、同一栏，两遍都认成规则里那个值 */
export function noRed(learn, cat, f, reads) {
  const rules = learn && Array.isArray(learn.nored) ? learn.nored : [];
  if (!rules.length || !Array.isArray(reads) || reads.length < 2) return false;
  return rules.some((r) => r && (r.cat === cat || r.cat === '*') && colMatch(r.col, cat, f)
    && norm(reads[0]) === norm(r.value) && norm(reads[1]) === norm(r.value) && norm(r.value) !== '');
}

/** 标红那一步之后：合上「不用标红」的格子拿掉红、拿掉它的核对提示和候选。原地改 row，返回拿掉了哪几格 */
export function unred(row, learn, cat) {
  if (!row || !row.reads || !(row.red || []).length) return [];
  const off = row.red.filter((f) => noRed(learn, cat, f, row.reads[f]));
  if (!off.length) return off;
  const builtin = cat === C.BUILTIN;
  const keys = builtin ? C.FIELDS : Object.keys(row.values || {});
  const name = (k) => (builtin ? k.toUpperCase() : k);
  const names = keys.map(name);
  const mine = new Set(off.map(name));
  row.red = row.red.filter((f) => !off.includes(f));
  row.notes = String(row.notes || '').split('；').filter((n) => n && !mine.has(C.noteOwner(n, names))).join('；');
  for (const f of off) {
    if (row.ctx) delete row.ctx[f];
    if (row.alts) delete row.alts[f];
  }
  return off;
}

// ---------------------------------------------------------------- 打包
/** 人定完的整张答案，照认出来的 JSON 的样子（刀单：13 个字段；自建类别：c1、c2…；认全部内容：columns + values） */
export function answerOf(rows, cat, page = {}) {
  const recs = (rows || []).filter((r) => r && r.kind === 'rec' && r.values);
  const v = (x) => C.copyValue(x);
  const side = page.side || '';
  if (cat === C.BUILTIN) {
    return { title_side: side, records: recs.map((r) => ({ ...Object.fromEntries(C.FIELDS.map((f) => [f, v(r.values[f])])), unsure: [] })) };
  }
  const cols = Array.isArray(page.cols) && page.cols.length ? page.cols : uniq(recs.flatMap((r) => Object.keys(r.values)));
  if (page.open) {
    return { title_side: side, columns: cols, records: recs.map((r) => ({ values: cols.map((c) => v(r.values[c])), unsure: [] })) };
  }
  return { title_side: side, records: recs.map((r) => ({ ...Object.fromEntries(cols.map((c, i) => [`c${i + 1}`, v(r.values[c])])), unsure: [] })) };
}

/** 一批要交的东西拆成几包，每包 JSON 不超过 max 字节（批次那几行每包都带：大管家按批次号留最后一份） */
export function packages({ device, app, batches, items, photos }, max = MAX_PKG) {
  const fresh = () => ({ v: 1, kind: 'learn', id: rid(), device, app, batches, items: [], photos: [] });
  const out = [];
  let cur = fresh(), n = bytes(cur);
  const put = (list, x) => {
    const b = bytes(x) + 1;
    if (n + b > max && (cur.items.length || cur.photos.length)) { out.push(cur); cur = fresh(); n = bytes(cur); }
    cur[list].push(x);
    n += b;
  };
  for (const it of items || []) put('items', it);
  for (const ph of photos || []) put('photos', ph);
  if (cur.items.length || cur.photos.length || !out.length) out.push(cur);
  return out;
}

/** 413 太大：一包劈成两包；劈不动 -> null */
export function halve(pkg) {
  const two = (a, b) => [{ ...pkg, id: rid(), ...a }, { ...pkg, id: rid(), ...b }];
  const ph = pkg.photos || [], it = pkg.items || [];
  if (ph.length > 1) { const h = Math.ceil(ph.length / 2); return two({ photos: ph.slice(0, h) }, { items: [], photos: ph.slice(h) }); }
  if (it.length > 1) { const h = Math.ceil(it.length / 2); return two({ items: it.slice(0, h) }, { items: it.slice(h) }); }
  if (ph.length === 1 && it.length) return two({ photos: [] }, { items: [] });
  return null;
}

/** 这批一共认出、写进表几格 */
export function cellsOf(run) {
  const recs = (run.rows || []).filter((r) => r && r.kind === 'rec');
  const n = run.cat === C.BUILTIN ? C.FIELDS.length : (run.columns || []).length;
  return recs.length * n;
}

// ---------------------------------------------------------------- 记、排队、交
export class Learner {
  // st：store.js 那个；butler：dagj.Butler；runOf(id) -> 那一批（正在核的那份优先）；on() -> ⚙ 开关开着没有
  constructor({ st, butler, runOf, on = () => true, app = 'web', device = () => '', clock = () => Date.now(), log = () => {} }) {
    Object.assign(this, { st, butler, runOf, on, app, device, clock, log });
    this.list = null;
    this.sending = null;
    this.lastSend = 0;
    this.chain = Promise.resolve();
  }

  get paired() { return Boolean(this.butler && this.butler.paired); }
  active() { return this.paired && Boolean(this.on()); }
  block(cat) { return this.paired ? hintBlock(this.list, cat) : ''; }
  ver() { return (this.list && Number(this.list.ver)) || 0; }

  _one(fn) { const p = this.chain.then(fn, fn); this.chain = p.catch(() => {}); return p; }   // 记、打包一件一件来，别互相盖

  async load() {
    try { this.list = (await this.st.get('kv', LIST)) || null; } catch (e) { this.list = null; }
  }

  /** 找中转站要那份；拿不到照旧用存着的（或者没有） */
  async refresh() {
    if (!this.paired) return false;
    let got = null;
    try { got = await this.butler.learnList(); } catch (e) { got = null; }
    if (!got) return false;
    this.list = got.learn;
    try { await this.st.put('kv', LIST, this.list); } catch (e) { /* 存不了：这次开着能用 */ }
    return true;
  }

  /** 认完一张：送去认的那张缩过的照片、提示词留着，等人核（开关关着什么都不存） */
  async keepPage(runId, no, page) {
    if (!this.active()) return;
    try { await this.st.put('photos', `${IMG}${runId}/${no}`, { ...page, ms: this.clock() }); } catch (e) { /* 存不下就不带照片 */ }
  }

  /** 核对里动了一格。before：写进表的；after：人定的；act：edit / ok / guess；color：原来的颜色 */
  touch(run, rec, k, f, { before, after, act, color }) {
    if (!this.active() || !run || !rec) return Promise.resolve();
    return this._one(async () => {
      const at = this.clock();
      const log = (await this.st.get('kv', LOG + run.id)) || { batch: run.id, items: {}, sent: {}, last: 0 };
      const key = `${rec.no}|${k}|${f}`;
      const had = log.items[key];
      log.items[key] = had ? { ...had, after, act, at: iso(at) } : {
        cat: run.cat, col: f, before, after, act, color: color || '', reads: ((rec.reads || {})[f] || []).map(String),
        by: rec.by || '', model: rec.model || '', batch: run.id, page: rec.no, row: k + 1, at: iso(at),
      };
      log.last = at;
      await this.st.put('kv', LOG + run.id, log);
    });
  }

  /** 人动过、还没打包的那几格打成包排队。force：这批核完了（关了核对），不等 10 分钟 -> 打了几包 */
  pack(force = false) {
    return this._one(async () => {
      if (!this.active()) return 0;
      let made = 0;
      for (const [k, log] of await this.st.prefixed('kv', LOG)) {
        const fresh = Object.entries(log.items || {}).filter(([key, it]) => log.sent[key] !== JSON.stringify(it));
        if (!fresh.length || (!force && this.clock() - (log.last || 0) < IDLE)) continue;
        const run = await this.runOf(log.batch);
        if (!run) { await this.st.del('kv', k); continue; }
        const batch = { batch: run.id, cat: run.cat, cells: cellsOf(run), edited: Object.keys(log.items).length,
          list_ver: Number(run.learnVer) || 0, at: run.at ? `${run.at}Z` : iso(this.clock()) };
        const photos = [];
        for (const no of uniq(fresh.map(([, it]) => it.page)).sort((a, b) => a - b)) {
          let page = null;
          try { page = await this.st.get('photos', `${IMG}${run.id}/${no}`); } catch (e) { page = null; }
          if (!page || !page.data) continue;
          photos.push({ batch: run.id, page: no, cat: run.cat, mime: 'image/jpeg', data: page.data, prompt: page.prompt || '',
            ask: page.ask || '', schema: page.schema ?? null, answer: answerOf(run.rows.filter((r) => r.no === no), run.cat, page) });
        }
        const pkgs = packages({ device: this.device(), app: `${this.app}`, batches: [batch], items: fresh.map(([, it]) => it), photos });
        for (const p of pkgs) await this._enqueue(p);
        for (const [key, it] of fresh) log.sent[key] = JSON.stringify(it);
        await this.st.put('kv', k, log);
        made += pkgs.length;
      }
      if (made) await this._cap();
      return made;
    });
  }

  async _enqueue(pkg) {
    const n = this.seq = Math.max((this.seq || 0) + 1, this.clock() * 1000);
    await this.st.put('kv', Q + String(n).padStart(16, '0'), { size: bytes(pkg), pkg });
  }

  async queued() { return (await this.st.prefixed('kv', Q)).sort((a, b) => (a[0] < b[0] ? -1 : 1)); }

  async _cap() {                               // 一直交不出去：最多 50 包 / 150 MB，扔最老的
    const q = await this.queued();
    let total = q.reduce((s, [, v]) => s + ((v && v.size) || 0), 0);
    let left = q.length;
    for (const [k, v] of q) {
      if (left <= MAX_QUEUE && total <= MAX_BYTES) break;
      await this.st.del('kv', k);
      left--;
      total -= (v && v.size) || 0;
    }
  }

  /** 排着的一包一包交；大管家不在、出错就停，过一阵再来 -> {sent, left, why} */
  send() {
    if (this.sending) return this.sending;
    this.sending = (async () => {
      const out = { sent: 0, left: 0, why: '' };
      try {
        if (!this.active()) return out;
        this.lastSend = this.clock();
        for (let round = 0, again = true; again && round < 8; round++) {   // 劈开的排到最后：这一轮交完别的再来一遍
          again = false;
          const q = await this.queued();
          out.left = q.length;
          for (const [k, v] of q) {
            if (!this.active()) break;
            const pkg = v && v.pkg;
            if (!pkg) { await this.st.del('kv', k); out.left--; continue; }
            const r = await this.butler.learn(pkg);
            if (r.ok) { await this.st.del('kv', k); out.sent++; out.left--; continue; }
            if (r.split) {
              const parts = halve(pkg);
              await this.st.del('kv', k);
              out.left--;
              if (parts) { for (const p of parts) { await this._enqueue(p); out.left++; } again = true; }
              continue;
            }
            out.why = r.gone ? 'gone' : r.why || 'later';
            again = false;
            break;
          }
        }
      } catch (e) {
        out.why = String((e && e.message) || e);
      } finally {
        this.sending = null;
      }
      if (out.sent) this.log(out);
      return out;
    })();
    return this.sending;
  }

  /** 10 分钟一回：到点的打包，隔 10 分钟再交一次排着的 */
  async tick() {
    if (!this.active()) return;
    await this.pack(false);
    if (this.clock() - this.lastSend >= RESEND && (await this.queued()).length) await this.send();
  }

  /** ⚙ 里关了：攒着的、记着的、留着的照片全清掉 */
  forgetAll() {
    return this._one(async () => {
      for (const [k] of await this.st.prefixed('kv', LOG)) await this.st.del('kv', k);
      for (const [k] of await this.st.prefixed('kv', Q)) await this.st.del('kv', k);
      for (const k of await this._imgKeys()) await this.st.del('photos', k);
    });
  }

  async _imgKeys() {
    const ks = await this.st.keys('photos');
    return ks.filter((k) => typeof k === 'string' && k.startsWith(IMG));
  }

  /** 开页面时：送去认的照片，那批已经删了的、放了 14 天的，清掉 */
  async tidy(runIds) {
    const have = new Set(runIds);
    const old = this.clock() - KEEP_DAYS * 86_400_000;
    for (const k of await this._imgKeys()) {
      const id = k.slice(IMG.length).split('/')[0];
      let drop = !have.has(id);
      if (!drop) { const m = id.match(/^(\d{4})(\d{2})(\d{2})_/); drop = !!m && Date.UTC(+m[1], +m[2] - 1, +m[3]) < old; }
      if (drop) await this.st.del('photos', k);
    }
    for (const [k, log] of await this.st.prefixed('kv', LOG)) if (!have.has(log.batch)) await this.st.del('kv', k);
  }
}
