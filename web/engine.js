// 干活的那一套：一批 5 张同时认，每张认两遍对答案，对不上认第三遍；钥匙额度用完自己换、自己等（跟电脑版 engine.Engine 一样）
import './strings.js';
import * as C from './core.js';
import { Miss, fit, BATCH as DAGJ_BATCH } from './dagj.js';
import { ClaudeMiss } from './claude.js';
import { withHints } from './learn.js';

const t = (k, v) => globalThis.LURU_I18N.t(k, v);

export class Result {
  constructor() { Object.assign(this, { ok: 0, records: 0, failed: 0, requests: 0, stopped: '', errors: [] }); }
}

function two(n) { return String(n).padStart(2, '0'); }

// 184：每条记录每一格头两遍各认成什么（「不用标红」看它，人动过的格子也带上它）。挂在数组上、不进 JSON、不进存的表
function readsOf(out, reads) {
  const cand = reads.filter((r) => r.length === out.length).slice(0, 2);
  const per = out.map((rec, i) => Object.fromEntries(Object.keys(rec).filter((f) => !C.META.has(f))
    .map((f) => [f, cand.map((r) => String((r[i] || {})[f] ?? ''))])));
  Object.defineProperty(out, 'reads', { value: per, enumerable: false });
  return out;
}
function when(ms) { const d = new Date(ms); return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`; }

export class Engine {
  // prepare(file, enhance) -> base64 JPG；stampIt(file, no, side) -> 印好编号的照片（可空）
  constructor({ keys, model, spec = null, names = [], hints = '', reads = C.READS, log = () => {}, base,
    fetchImpl, clock = () => Date.now(), sleep = null, prepare, stampIt = null, butler = null, claude = null,
    learned = '', keepSent = false }) {
    this.keys = new C.Keys(keys, clock);
    this.model = C.modelName(model);
    this.spec = spec;
    this.names = names;
    this.hints = hints;
    this.reads = Math.max(1, reads);
    this.log = log;
    this.base = base;
    this.fetchImpl = fetchImpl;
    this.clock = clock;
    this._sleep = sleep;
    this.prepare = prepare;
    this.stampIt = stampIt;
    this.butler = butler;                      // 089 dagj.Butler：配上了就每张先问大管家，问不成跳回 Gemini
    this.claude = claude;                      // 167 claude.Claude：配上了大管家的，每张先走 Claude API（钥匙在中转站），没成再问大管家
    this.by = new Map();                       // 照片 -> 谁认的（'claude' / 'dagj' / 'gemini'）
    this.learned = learned;                    // 184 大管家学会的「常错提醒」：三条路的提示词后面都加上
    this.keepSent = keepSent;                  // 184 越用越准开着：第一遍送去认的那张留着（照片 -> base64），核对里人动过才带去给大管家
    this.sent = new Map();
    this.useSchema = true;
    this.fatal = '';
    this.res = new Result();
    this.halt = new AbortController();         // 点了停止，或者出了没法接着干的错
  }

  stop() { this.halt.abort(); }
  get stopped() { return this.halt.signal.aborted; }

  async wait(seconds) {                       // 能被「停止」打断的等待；电脑睡一觉醒来也按真实时间算
    if (this._sleep) {
      await this._sleep(seconds);
      if (this.stopped) throw new C.Stopped('stopped');
      return;
    }
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end) {
      if (this.stopped) throw new C.Stopped('stopped');
      await new Promise((ok) => {
        const t = setTimeout(ok, Math.min(30000, Math.max(0, end - Date.now())));
        this.halt.signal.addEventListener('abort', () => { clearTimeout(t); ok(); }, { once: true });
      });
    }
    if (this.stopped) throw new C.Stopped('stopped');
  }

  async waitUntil(ts, why) {
    const secs = Math.max(0, (ts - this.clock()) / 1000);
    // 第二个参数给页面用（右边那句「等到几点」「等几秒」），不用从日志的字里抠
    if (secs > 90) this.log(t('eng.waitLong', { why, when: when(ts), h: (secs / 3600).toFixed(1) }), { when: when(ts) });
    else if (secs >= 1) this.log(t('eng.wait', { why, s: Math.floor(secs) }), { secs: Math.floor(secs) });
    await this.wait(secs);
  }

  plainBody(b64, schema) {                    // 没加「常错提醒」的那个请求
    return this.spec ? this.spec.body(b64, this.model, schema) : C.buildBody(b64, this.model, schema, this.names, this.hints);
  }

  body(b64, schema) { return withHints(this.plainBody(b64, schema), this.learned); }

  /** 184 送去认的提示词、那句话、schema（不带「常错提醒」），给大管家重认时用 */
  promptOf() {
    const b = this.plainBody('', true);
    const sys = ((b.systemInstruction || {}).parts || []).map((p) => p.text || '').join('\n\n');
    const ask = (((b.contents || [])[0] || {}).parts || []).filter((p) => typeof p.text === 'string').map((p) => p.text).join('\n');
    return { prompt: sys, ask, schema: (b.generationConfig || {}).responseSchema || null,
      open: !!(this.spec && this.spec.openMode), cols: this.spec ? [...this.spec.columns] : null };
  }

  async read(b64, name) {                      // 认一遍：撞了额度换钥匙或者等，断网、谷歌出错重试
    let body = this.body(b64, this.useSchema);
    let minuteHits = 0, netTries = 0;
    for (;;) {
      if (this.stopped) throw this.fatal ? new C.Fatal(this.fatal) : new C.Stopped('stopped');
      const [i, key] = this.keys.pick();
      if (i === null) {
        await this.waitUntil(key, t(key - this.clock() > 120e3 ? 'eng.allKeys' : 'eng.perMinute'));
        continue;
      }
      try {
        this.res.requests++;
        const data = await C.callApi(this.model, key, body, { base: this.base, fetchImpl: this.fetchImpl });
        this.keys.used[i]++;
        return this.spec ? this.spec.parse(data) : C.parseResponse(data);
      } catch (e) {
        if (!(e instanceof C.ApiError)) throw e;
        if (e.status === 429) {
          const kind = C.classify429(e);
          if (kind === 'prepay') throw new C.Fatal(t('eng.prepay', { i: i + 1, raw: e.raw() }));
          if (kind === 'day') {
            this.keys.park(i, C.nextPacificMidnight(this.clock()));
            this.log(t('eng.dayOut', { i: i + 1, raw: e.raw() }));
          } else {
            minuteHits++;
            if (minuteHits > C.MAX_MINUTE_WAITS) throw e;
            const d = C.retryDelay(e.detail);
            const w = d === null ? C.MINUTE_WAIT : Math.min(C.MINUTE_WAIT, Math.max(3, d + 1));
            this.keys.park(i, this.clock() + w * 1000);
          }
          continue;
        }
        if (e.status === 400 && /schema/i.test(e.message)) {
          if (this.useSchema) {
            this.useSchema = false;
            this.log(t('eng.schema', { raw: e.raw() }));
          }
          if (body.generationConfig.responseSchema) { body = this.body(b64, false); continue; }
        }
        if ([400, 401, 403].includes(e.status) && /API key|API_KEY|permission|PERMISSION/.test(`${e.message} ${e.detail}`)) {
          throw new C.Fatal(t('eng.keyBad', { i: i + 1, raw: e.raw() }));
        }
        if (e.status === 404) throw new C.Fatal(`${this.model} · ${e.raw()}`);
        if (e.status === 0 || e.status >= 500) {
          if (netTries < C.RETRY_WAITS.length) {
            const w = C.RETRY_WAITS[netTries++];
            this.log(t('eng.retry', { name, raw: e.raw(), w }));
            await this.wait(w);
            continue;
          }
        }
        throw e;
      }
    }
  }

  async recognize(file) {                      // 认一张：两遍（第二遍用拉过对比度的图）对得上就收，对不上第三遍当裁判
    try {
      return await this._recognize(file);
    } catch (e) {
      if (e instanceof C.Fatal) {
        if (!this.fatal) this.fatal = e.message;
        this.stop();                           // 同批其他几张别再傻等
      }
      throw e;
    }
  }

  // 089：配上了大管家、它也没在歇着，先整张交给大管家认（跟 Gemini 一样两遍对答案）；哪一遍没成（没连上、不在、
  // 明说接不了；慢到 2 次 5 分钟都没回、回错 2 次）整张换 Gemini 重认。连着 3 张是「用不了」，5 分钟里直接走 Gemini。
  // 167：再往前一步：配上了大管家的先走 Claude API（两遍对答案照旧，哪一遍没成整张换）；额度歇着 30 分钟里不问，
  // 别的错这一张换，连着 3 张没成 5 分钟里不问。没成的接着走上面那套（大管家 → Gemini）。
  async _recognize(file) {
    const b = this.butler;
    const name = file.name || t('eng.photo');
    const a = this.claude;
    if (a && a.ready()) {
      try {
        const out = await this._recognizeWith(file, (img, nm) => this.claudeRead(img, nm));
        a.hit();
        this.by.set(file, 'claude');
        return out;
      } catch (e) {
        if (e instanceof C.Stopped || e instanceof C.Fatal || this.stopped) throw e instanceof C.Fatal ? e : new C.Stopped('stopped');
        if (e && e.quota) { if (e.first) this.log(t('eng.claudeQuota', { why: String(e.message || e).slice(0, 60) })); }
        else {
          const rest = e && e.down === false ? false : a.miss();
          this.log(t('eng.claudeMiss', { name, why: String(e.message || e).slice(0, 80) }));
          if (rest) this.log(t('eng.claudeRest'));
        }
      }
    }
    if (b && b.ready()) {
      try {
        const out = await this._recognizeWith(file, (img, nm) => this.dagjRead(img, nm));
        b.hit();
        this.by.set(file, 'dagj');
        return out;
      } catch (e) {
        if (e instanceof C.Stopped || e instanceof C.Fatal || this.stopped) throw e instanceof C.Fatal ? e : new C.Stopped('stopped');
        const rest = e && e.down === false ? false : b.miss();     // 092：慢、回错换一张，不算「用不了」
        this.log(t('eng.dagjMiss', { name, why: String(e.message || e).slice(0, 80) }));
        if (rest) this.log(t('eng.dagjRest'));
      }
    }
    if (!this.keys.keys.length) throw new Error(t('eng.noKeyFallback'));
    const out = await this._recognizeWith(file, (img, nm) => this.read(img, nm));
    this.by.set(file, 'gemini');
    return out;
  }

  async claudeRead(b64, name) {                // 167 Claude 认一遍：交的是翻过来的 Gemini 请求，回来的也翻回 Gemini 的样子
    const data = await this.claude.read(this.body(await fit(b64), true), this.halt.signal,
      (s) => this.log(t('eng.claudeSlow', { name, s })));   // 180：撞限速只在「细节」里说一声，面板照旧「在干活」
    if (this.stopped) throw new C.Stopped('stopped');
    try {
      return this.spec ? this.spec.parse(data) : C.parseResponse(data);
    } catch (e) { throw new ClaudeMiss(`回的认不出：${e.message}`, { down: false }); }
  }

  async dagjRead(b64, name) {                  // 大管家认一遍：交的就是要发给 Gemini 的那个请求，回来的也是 Gemini 的样子
    let err;
    for (let i = 0; i < 2; i++) {                // 092：回的认不出，先让大管家再认一次，第二次还错才换 Gemini
      const data = await this.butler.read(this.body(await fit(b64), true), this.halt.signal);   // 093：缩到大脑自己会缩到的尺寸
      if (this.stopped) throw new C.Stopped('stopped');
      try {
        return this.spec ? this.spec.parse(data) : C.parseResponse(data);
      } catch (e) { err = e; }
    }
    throw new Miss(`回的认不出：${err.message}`, false);
  }

  async _recognizeWith(file, reader) {
    const name = file.name || t('eng.photo');
    const clean = this.spec ? (r) => this.spec.clean(r) : C.cleanRecord;
    const agree = this.spec ? (a, b) => this.spec.agree(a, b) : (a, b) => C.recordsAgree(a, b);
    const vote = this.spec ? (r) => this.spec.vote(r) : (r) => C.vote(r);
    const jpeg = await this.prepare(file, false);
    if (this.keepSent) this.sent.set(file, jpeg);
    if (this.reads === 1) {
      const [recs, side] = await reader(jpeg, name);
      const one = [recs.map(clean)];
      return [readsOf(vote(one), one), side];
    }
    const enh = this.prepare(file, true);      // 093：加强那张边认第一遍边做，第一遍不等它（一批交得多，别都堵在做图上）
    enh.catch(() => {});
    const plan = [jpeg, enh];
    const reads = [], errs = [], sides = [];
    while (plan.length) {
      let img = plan.shift();
      if (img === enh) img = await enh;
      try {
        const [recs, side] = await reader(img, name);
        reads.push(recs.map(clean));
        sides.push(side);
      } catch (e) {
        if (e instanceof C.Stopped || e instanceof C.Fatal) throw e;
        if (e instanceof Miss) throw e;        // 大管家那头没成：整张换 Gemini，不在大管家这儿补
        errs.push(e);                          // 某一遍没认成：再补一遍，凑够两遍对答案
        if (errs.length === 1 && reads.length + plan.length < 2) plan.push(jpeg);
        continue;
      }
      if (!plan.length && reads.length === 2 && !agree(reads[0], reads[1])) plan.push(jpeg);
    }
    if (!reads.length) throw errs[0];
    const out = vote(reads);
    if (reads.length === 1) for (const r of out) r.single = true;
    return [readsOf(out, reads), C.pickSide(sides)];
  }

  // items: [{no, file}]（按拍摄顺序编好号）。认完一张马上交给 onPhoto（马上存：页面被关了也只丢手上这几张）；
  // 先回来的不一定是小号，表里按编号排是 onPhoto 那边的事。停了、出错了没干完的交给 onUnfinished，每批最后 onBatch
  async run(items, { onPhoto, onUnfinished, onBatch, progress = () => {} }) {
    const res = this.res;
    let done = 0;
    progress(0, items.length);
    const one = async (it) => {
      let recs, side, err = '', stamped = null;
      try {
        [recs, side] = await this.recognize(it.file);
      } catch (e) {
        if (e instanceof C.Stopped || e instanceof C.Fatal) throw e;
        return { recs: null, err: e instanceof C.ApiError ? e.raw() : `${e.name || 'Error'}：${e.message}` };
      }
      if (this.stampIt) {                      // 认完了才印编号：送去认的永远是原图
        try { stamped = await this.stampIt(it.file, it.no, side); } catch (e) { this.log(t('eng.stampErr', { tag: two(it.no), e: e.message })); }
      }
      return { recs, side, err, stamped, by: this.by.get(it.file) || '' };
    };
    const n = (this.butler && this.butler.ready()) || (this.claude && this.claude.ready()) ? Math.max(C.BATCH, DAGJ_BATCH) : C.BATCH;   // 093：交大管家的一批多交几张，中转站分给电脑、掌机
    for (let b = 0; b < items.length; b += n) {
      const batch = items.slice(b, b + n);
      const settled = await Promise.allSettled(batch.map(async (it) => {
        const { recs, side, err, stamped, by } = await one(it);
        if (recs) { res.ok++; res.records += recs.length; } else { res.failed++; res.errors.push([it.file.name, err]); }
        try { await onPhoto(it, recs, err, side, stamped, by); } catch (e) { this.log(t('eng.saveErr', { tag: two(it.no), e: e.message })); }
        progress(++done, items.length);        // 认完一张就报一声，别等一整批（3 张照片也能看见 1、2、3 往上跳）
      }));
      let halt = null;
      for (let k = 0; k < batch.length; k++) {
        const it = batch[k], s = settled[k];
        if (s.status !== 'rejected') continue;
        halt = halt || s.reason;
        const why = s.reason instanceof C.Stopped && !this.fatal ? '已停止' : (this.fatal || s.reason.message);
        await onUnfinished(it, why);
      }
      await onBatch();
      progress(done, items.length);
      if (halt) {
        if (halt instanceof C.Fatal || this.fatal) res.stopped = this.fatal || halt.message;
        else res.stopped = C.MANUAL_STOP;
        break;
      }
    }
    return res;
  }

  usedLine() { return this.keys.used.map((n, i) => (n ? t('eng.used', { i: i + 1, n }) : '')).filter(Boolean).join(' · '); }
}
