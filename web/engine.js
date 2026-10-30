// 干活的那一套：一批 5 张同时认，每张认两遍对答案，对不上认第三遍；钥匙额度用完自己换、自己等（跟电脑版 engine.Engine 一样）
import * as C from './core.js';

export class Result {
  constructor() { Object.assign(this, { ok: 0, records: 0, failed: 0, requests: 0, stopped: '', errors: [] }); }
}

function two(n) { return String(n).padStart(2, '0'); }
function when(ms) { const d = new Date(ms); return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`; }

export class Engine {
  // prepare(file, enhance) -> base64 JPG；stampIt(file, no, side) -> 印好编号的照片（可空）
  constructor({ keys, model, spec = null, names = [], hints = '', reads = C.READS, log = () => {}, base,
    fetchImpl, clock = () => Date.now(), sleep = null, prepare, stampIt = null }) {
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
    if (secs > 90) this.log(`⏸ ${why}，等到 ${when(ts)} 额度刷新后接着干（约 ${(secs / 3600).toFixed(1)} 小时，这个页面别关）`);
    else if (secs >= 1) this.log(`⏸ ${why}，等 ${Math.floor(secs)} 秒`);
    await this.wait(secs);
  }

  body(b64, schema) {
    return this.spec ? this.spec.body(b64, this.model, schema) : C.buildBody(b64, this.model, schema, this.names, this.hints);
  }

  async read(b64, name) {                      // 认一遍：撞了额度换钥匙或者等，断网、谷歌出错重试
    let body = this.body(b64, this.useSchema);
    let minuteHits = 0, netTries = 0;
    for (;;) {
      if (this.stopped) throw this.fatal ? new C.Fatal(this.fatal) : new C.Stopped('stopped');
      const [i, key] = this.keys.pick();
      if (i === null) {
        await this.waitUntil(key, key - this.clock() > 120e3 ? '所有钥匙额度都用完了' : '每分钟次数到顶');
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
          if (kind === 'prepay') throw new C.Fatal(`钥匙${i + 1} · ${e.raw()}（账单账户预付余额用完，等也没用）`);
          if (kind === 'day') {
            this.keys.park(i, C.nextPacificMidnight(this.clock()));
            this.log(`钥匙${i + 1} 今天的额度用完了 · ${e.raw()}`);
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
            this.log(`模型不认结构化输出格式，改用纯 JSON 提示重试 · ${e.raw()}`);
          }
          if (body.generationConfig.responseSchema) { body = this.body(b64, false); continue; }
        }
        if ([400, 401, 403].includes(e.status) && /API key|API_KEY|permission|PERMISSION/.test(`${e.message} ${e.detail}`)) {
          throw new C.Fatal(`钥匙${i + 1} · ${e.raw()}`);
        }
        if (e.status === 404) throw new C.Fatal(`${this.model} · ${e.raw()}`);
        if (e.status === 0 || e.status >= 500) {
          if (netTries < C.RETRY_WAITS.length) {
            const w = C.RETRY_WAITS[netTries++];
            this.log(`${name} · ${e.raw()} · ${w} 秒后重试`);
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

  async _recognize(file) {
    const name = file.name || '照片';
    const clean = this.spec ? (r) => this.spec.clean(r) : C.cleanRecord;
    const agree = this.spec ? (a, b) => this.spec.agree(a, b) : (a, b) => C.recordsAgree(a, b);
    const vote = this.spec ? (r) => this.spec.vote(r) : (r) => C.vote(r);
    const jpeg = await this.prepare(file, false);
    if (this.reads === 1) {
      const [recs, side] = await this.read(jpeg, name);
      return [vote([recs.map(clean)]), side];
    }
    const plan = [jpeg, await this.prepare(file, true)];
    const reads = [], errs = [], sides = [];
    while (plan.length) {
      const img = plan.shift();
      try {
        const [recs, side] = await this.read(img, name);
        reads.push(recs.map(clean));
        sides.push(side);
      } catch (e) {
        if (e instanceof C.Stopped || e instanceof C.Fatal) throw e;
        errs.push(e);                          // 某一遍没认成：再补一遍，凑够两遍对答案
        if (errs.length === 1 && reads.length + plan.length < 2) plan.push(jpeg);
        continue;
      }
      if (!plan.length && reads.length === 2 && !agree(reads[0], reads[1])) plan.push(jpeg);
    }
    if (!reads.length) throw errs[0];
    const out = vote(reads);
    if (reads.length === 1) for (const r of out) r.single = true;
    return [out, C.pickSide(sides)];
  }

  // items: [{no, file}]（按拍摄顺序编好号）。每批干完按编号顺序交给 onPhoto / onUnfinished，再 onBatch（存一次）
  async run(items, { onPhoto, onUnfinished, onBatch, progress = () => {} }) {
    const res = this.res;
    let done = 0;
    progress(0, items.length);
    for (let b = 0; b < items.length; b += C.BATCH) {
      const batch = items.slice(b, b + C.BATCH);
      const settled = await Promise.allSettled(batch.map(async (it) => {
        let recs, side, err = '', stamped = null;
        try {
          [recs, side] = await this.recognize(it.file);
        } catch (e) {
          if (e instanceof C.Stopped || e instanceof C.Fatal) throw e;
          return { recs: null, err: e instanceof C.ApiError ? e.raw() : `${e.name || 'Error'}：${e.message}` };
        }
        if (this.stampIt) {                    // 认完了才印编号：送去认的永远是原图
          try { stamped = await this.stampIt(it.file, it.no, side); } catch (e) { this.log(`${two(it.no)} 编号照片没印成：${e.message}`); }
        }
        return { recs, side, err, stamped };
      }));
      let halt = null;
      for (let k = 0; k < batch.length; k++) {     // 按编号顺序写进表
        const it = batch[k], s = settled[k];
        if (s.status === 'rejected') {
          halt = halt || s.reason;
          const why = s.reason instanceof C.Stopped && !this.fatal ? '已停止' : (this.fatal || s.reason.message);
          await onUnfinished(it, why);
          continue;
        }
        const { recs, side, err, stamped } = s.value;
        if (recs) { res.ok++; res.records += recs.length; } else { res.failed++; res.errors.push([it.file.name, err]); }
        await onPhoto(it, recs, err, side, stamped);
        done++;
      }
      await onBatch();
      progress(done, items.length);
      if (halt) {
        if (halt instanceof C.Fatal || this.fatal) res.stopped = this.fatal || halt.message;
        else res.stopped = '手动停止';
        break;
      }
    }
    return res;
  }

  usedLine() { return this.keys.used.map((n, i) => (n ? `钥匙${i + 1}×${n}` : '')).filter(Boolean).join(' · '); }
}
