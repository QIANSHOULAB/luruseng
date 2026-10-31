// 录入僧网页版 · 认单子的核心（跟电脑版 bangong/engine.py、kb.py、tables.py 同一套规矩，改一边要改另一边）
// 纯逻辑：不碰页面、不碰存储，浏览器和 node 测试都能跑。

export const VERSION = '1.10.1';
export const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
export const MODELS = ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-pro'];
export const BATCH = 5;                 // 同时认几张
export const MAX_SIDE = 2048;
export const JPEG_Q = 0.92;
export const READS = 2;                 // 每张认两遍对答案；对不上认第三遍，按多数定
export const MINUTE_WAIT = 60;
export const RETRY_WAITS = [10, 30, 60];
export const MAX_MINUTE_WAITS = 30;
export const TIMEOUT = 180;
export const BUILTIN = '刀单';

// 公司那本 TOOL BROKEN RECORD 的 13 列（顺序一格不差）
export const FIELDS = ['date', 'machine', 'part_number', 'mo', 'opr_no', 't_no', 'description',
  'btmp', 'total_screened', 'passed', 'failed', 'shift', 'setter'];
export const NUM_FIELDS = new Set(['btmp', 'total_screened', 'passed', 'failed']);
export const NEVER_RED = new Set(['date']);
export const LABEL = {
  date: 'DATE', machine: 'MACHINE', part_number: 'PART NUMBER', mo: 'MO', opr_no: 'OPR NO.', t_no: 'T NO.',
  description: 'DESCRIPTION', btmp: 'BTMP', total_screened: 'TOTAL SCREENED', passed: 'PASSED', failed: 'FAILED',
  shift: 'SHIFT', setter: 'SETTER',
};

export const PROMPT = `你是工厂的刀具破损记录（TOOL BROKEN RECORD）录入员。从图片里找出每一条刀具破损记录，每条记录填下面 13 个字段。
图片可能是一张单子（一条记录），也可能是一页登记表（好几行，每行一条记录）。
最常见的是「TOOL REQUEST FORM 换刀调试单」，一张就是一条记录，各格对应：
  M/C No. 机器号码 → machine；Part Number 产品型号 → part_number；MO Number → mo；Opr No. 步骤 → opr_no；Date & Time 日期时间 → date；
  Shift 班次：只看手写的记号。Day 或 Night 被圈住、打了勾，或者旁边手写了「白」「早」「D」→ D；手写了「夜」「晚」「N」→ N。Day、Night 这两个词是印好的，没有任何手写记号就填空字符串，不要猜；
  Tool Information 刀具信息：手写的一串。所有 T 加数字的都是刀号 → t_no（写了几把刀，比如 T6.T7，就填 "T6, T7"，一把都不能漏），刀号不要写进 description；剩下的原样抄进 description，例如 Φ4 FMM X2、FACEMILL Φ40 R0.8。直径符号 Φ（手写常是一个圆圈中间一竖，也可能写成 ø）一定照写成 Φ，不要漏；印好的「磨损 Wear / 折断 Broken」被圈哪个都不用管；
  Total Quantity Screened 筛选数量 → total_screened；Quantity Passed 合格数量 → passed；Quantity Failed 不合格数量 → failed；
  Setter Emp No. 调试员工号 → setter（通常只写了工号）；单子上没有 BTMP，btmp 填空；QC 签名和 OK/NG 不要。

字段（括号里是单子上可能出现的写法和真实例子）：
- date：日期（DATE）。照单子上写的抄，例如 28/10、28-10-26、1-Oct。新加坡写法，日在前、月在后。
- machine：机台（MACHINE、M/C）。例如 VM-07、VM-14、4X-9、4X-16、5X-3、HM-3。
- part_number：零件号（PART NUMBER、PART NO.）。例如 TD-524613-5、AB-5313706C、AB-144125AE、TD-HAR8308G-05、TD-722-771-00-C。零件号中间没有空格。
- mo：工单号（MO、W/O）。通常是 8 位数字，例如 82664580、82665285。
- opr_no：工序号（OPR NO.、OP）。例如 110、130、150、170。
- t_no：刀号（T NO.、TOOL NO.）。例如 T4、T9、T58、T343。
- description：刀具描述（DESCRIPTION、Tool Information）。例如 EM2.5、EM6、BU10、SD3、DR09、FC6.4、Φ1.5 FEM、FACEMILL Φ40 R0.8。
- btmp：BTMP，数字。
- total_screened：检查总数（TOTAL SCREENED），数字。
- passed：合格数（PASSED），数字。
- failed：不合格数（FAILED），数字。
- shift：班次（SHIFT），只有 D（白班）或 N（夜班）；单子上没标就填空字符串。
- setter：设定员（SETTER、Setter Emp No.）。照单子写的抄：只写了工号就只填工号（例如 232），写了「工号/名字」就照抄（例如 639/Lee Ah Kow）。

规则：
- 照单子上写的抄，不猜、不补、不纠错；某个字实在看不清就用 □ 代替那个字。
- 单子上没写的字段填空字符串。
- 印刷的栏目名（DATE、MACHINE 之类）不是内容，不要抄进值里。
- 分清 0 和 O、1 和 I、5 和 S、8 和 B：数字字段只会是数字；机台和零件号照上面例子的样子判断。
- 被划掉、涂掉作废的内容不要。
- 图片歪斜或横着拍的，按正确方向读。
- unsure：每条记录里你拿不准的字段名（字迹潦草、被挡住、反光、可能看错的），只列真拿不准的；全都看得清就给空数组。
- 一条记录都没有就输出空数组。
- title_side：单子的标题（最上面那行印刷的大字，比如 TOOL REQUEST FORM 换刀调试单、TOOL BROKEN RECORD）在这张照片的哪一边，照片原样看，不要先在脑子里转正：top（上边）、right（右边）、bottom（下边）、left（左边）。
- 只输出 JSON：{"title_side": "top", "records": [{"date": "", "machine": "", ..., "unsure": []}]}，不要任何解释。`;

const S = { type: 'STRING' };
const SA = { type: 'ARRAY', items: S };
export const SCHEMA = {
  type: 'OBJECT',
  properties: {
    title_side: S,
    records: {
      type: 'ARRAY', items: {
        type: 'OBJECT',
        properties: Object.assign(Object.fromEntries(FIELDS.map((f) => [f, S])), { unsure: SA }),
        required: FIELDS.concat(['unsure']),
      },
    },
  },
  required: ['records', 'title_side'],
};

// ---------------------------------------------------------------- 小工具
export function counter(items) {
  const m = new Map();
  for (const x of items) m.set(x, (m.get(x) || 0) + 1);
  return m;
}
export function mostCommon(m) {          // 次数最多的；打平取先出现的（跟 Python Counter 一样）
  let best = null, n = -1;
  for (const [k, c] of m) if (c > n) { best = k; n = c; }
  return [best, n];
}
const uniq = (arr) => [...new Set(arr)];
const ws = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

export class ApiError extends Error {
  constructor(status, message, detail = '') {
    super(message);
    this.status = status;
    this.detail = detail;
  }
  raw() { return this.status ? `HTTP ${this.status}：${this.message}` : this.message; }
}
export class Fatal extends Error {}
export class Stopped extends Error {}

// ---------------------------------------------------------------- 时间：每天的额度在美国太平洋时间半夜刷新
function nthSunday(year, month, n) {     // month 1-12，返回 UTC 毫秒
  const d = new Date(Date.UTC(year, month - 1, 1));
  const add = (7 - d.getUTCDay()) % 7;
  return Date.UTC(year, month - 1, 1 + add + (n - 1) * 7);
}
export function pacificOffsetHours(utcMs) {
  const y = new Date(utcMs).getUTCFullYear();
  const start = nthSunday(y, 3, 2) + 10 * 3600e3;    // 2:00 PST = 10:00 UTC
  const end = nthSunday(y, 11, 1) + 9 * 3600e3;      // 2:00 PDT = 09:00 UTC
  return utcMs >= start && utcMs < end ? -7 : -8;
}
export function nextPacificMidnight(nowMs) {
  const off = pacificOffsetHours(nowMs);
  const local = new Date(nowMs + off * 3600e3);
  const midnightLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1);
  const guess = midnightLocal - off * 3600e3;
  const off2 = pacificOffsetHours(guess);
  return midnightLocal - off2 * 3600e3 + 30e3;       // 多等 30 秒，免得卡在边上
}

// ---------------------------------------------------------------- 钥匙
export class Keys {
  constructor(keys, clock = () => Date.now()) {
    this.keys = keys.map((k) => (k || '').trim()).filter(Boolean);
    this.deadUntil = this.keys.map(() => 0);
    this.used = this.keys.map(() => 0);
    this.clock = clock;
  }
  pick() {                                 // [序号, 钥匙]；都在冷却就 [null, 最早恢复时间]
    const now = this.clock();
    for (let i = 0; i < this.keys.length; i++) if (this.deadUntil[i] <= now) return [i, this.keys[i]];
    return [null, Math.min(...this.deadUntil)];
  }
  park(i, until) { this.deadUntil[i] = Math.max(this.deadUntil[i], until); }
}

// ---------------------------------------------------------------- 名单、提示词、请求
export function parseNames(text) {        // 一行一个「工号/名字」，# 开头是注释
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = t.match(/^(\d+)\s*[/／\s]\s*(.+?)$/);
    if (m) out.push([m[1], m[2].replace(/\s+/g, ' ')]);
  }
  return out;
}

export function modelName(m) { return String(m || '').trim().replace(/^models\//, '') || DEFAULT_MODEL; }

export function buildPrompt(names = [], hints = '') {
  let out = PROMPT;
  if (names && names.length) {
    out += '\n\n设定员名单（只用来帮你认潦草的工号和名字）：SETTER 还是照单子上写的抄，' +
      '只写了工号就只填工号，不要补名字。\n' + names.map(([n, nm]) => `${n}/${nm}`).join('\n');
  }
  if (hints) out += '\n\n' + hints;
  return out;
}

export function genConfig(model, schema) {
  const gen = { responseMimeType: 'application/json' };
  if (schema) gen.responseSchema = schema;
  if (/^gemini-[12]\./.test(model)) gen.temperature = 0.1;          // Gemini 3 起不发采样参数
  if (/^gemini-2\.5-flash(?!-lite)/.test(model)) gen.thinkingConfig = { thinkingBudget: 0 };
  return gen;
}

export function buildBody(b64, model, schema = true, names = [], hints = '') {
  return {
    systemInstruction: { parts: [{ text: buildPrompt(names, hints) }] },
    contents: [{ role: 'user', parts: [
      { text: '把这张图片里的刀具破损记录逐条填好。' },
      { inline_data: { mime_type: 'image/jpeg', data: b64 } },
    ] }],
    generationConfig: genConfig(model, schema ? SCHEMA : null),
  };
}

export async function callApi(model, key, body, { base = API_BASE, signal, fetchImpl } = {}) {
  // 钥匙只走 URL 参数 ?key=（跟电脑版一样）。报错原样带回 HTTP 状态码和谷歌的 error.message。
  const f = fetchImpl || globalThis.fetch.bind(globalThis);
  const url = `${base.replace(/\/$/, '')}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error('timeout')), TIMEOUT * 1000);
  const onAbort = () => ctl.abort(signal.reason);
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  let res, raw;
  try {
    res = await f(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
    raw = await res.text();
  } catch (e) {
    if (signal && signal.aborted) throw new Stopped('stopped');
    const why = ctl.signal.aborted ? `等了 ${TIMEOUT} 秒没回音` : (e && e.message) || String(e);
    throw new ApiError(0, `网络错误：${why}`);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
  if (!res.ok) {
    let msg = raw.slice(0, 500) || res.statusText || '', detail = '';
    try {
      const err = JSON.parse(raw).error || {};
      msg = err.message || msg;
      detail = JSON.stringify(err.details || '');
    } catch (e) { /* 原样 */ }
    throw new ApiError(res.status, msg, detail);
  }
  try { return JSON.parse(raw); } catch (e) { throw new ApiError(0, '返回的不是 JSON：' + raw.slice(0, 300)); }
}

// ---------------------------------------------------------------- 解析回来的 JSON
const ALIASES = {
  date: 'date', '日期': 'date',
  machine: 'machine', m_c: 'machine', mc: 'machine', machine_no: 'machine',
  part_number: 'part_number', part_no: 'part_number', partno: 'part_number', part: 'part_number',
  mo: 'mo', mo_no: 'mo', w_o: 'mo', wo: 'mo',
  opr_no: 'opr_no', opr: 'opr_no', op: 'opr_no', opr_number: 'opr_no',
  t_no: 't_no', tno: 't_no', tool_no: 't_no',
  description: 'description', tool_description: 'description', desc: 'description',
  btmp: 'btmp',
  total_screened: 'total_screened', total: 'total_screened', screened: 'total_screened',
  passed: 'passed', pass: 'passed', failed: 'failed', fail: 'failed',
  shift: 'shift', setter: 'setter',
};
export function normKey(k) {
  const t = String(k).trim().toLowerCase().replace(/[\s./\-]+/g, '_').replace(/^_+|_+$/g, '');
  return ALIASES[t] || t;
}

export function responseJson(data) {
  const cands = (data && data.candidates) || [];
  if (!cands.length) {
    const br = ((data && data.promptFeedback) || {}).blockReason;
    throw new Error(br ? `promptFeedback.blockReason = ${br}` : '返回里没有 candidates');
  }
  const c = cands[0];
  const parts = ((c.content || {}).parts) || [];
  const text = parts.filter((p) => !p.thought).map((p) => p.text || '').join('');
  const t = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try { return JSON.parse(t); } catch (e) {
    throw new Error(`finishReason = ${c.finishReason || ''}，JSON 解析不了：${text.slice(0, 200)}`);
  }
}

const SIDES = {
  top: 'top', up: 'top', upper: 'top', '上': 'top', '上边': 'top', '上面': 'top', '顶': 'top', '顶部': 'top',
  right: 'right', '右': 'right', '右边': 'right', '右侧': 'right',
  bottom: 'bottom', down: 'bottom', lower: 'bottom', '下': 'bottom', '下边': 'bottom', '下面': 'bottom', '底': 'bottom', '底部': 'bottom',
  left: 'left', '左': 'left', '左边': 'left', '左侧': 'left',
};
export function normSide(v) { return SIDES[String(v || '').trim().toLowerCase()] || ''; }

function items(v) {
  if (Array.isArray(v)) return v.filter(Boolean).map(String);
  return String(v || '').split(/[,，、;；\s]+/).filter(Boolean);
}

export function parseResponse(data) {        // -> [记录, 标题在哪一边]
  const obj = responseJson(data);
  const side = obj && typeof obj === 'object' && !Array.isArray(obj) ? normSide(obj.title_side) : '';
  let recs = obj;
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) recs = obj.records ?? obj.rows ?? obj;
  if (recs && typeof recs === 'object' && !Array.isArray(recs)) recs = [recs];
  if (!Array.isArray(recs)) throw new Error('JSON 里没有 records：' + JSON.stringify(obj).slice(0, 200));
  const out = [];
  for (const r of recs) {
    const rec = Object.fromEntries(FIELDS.map((f) => [f, '']));
    let unsure = new Set();
    if (r && typeof r === 'object' && !Array.isArray(r)) {
      for (const [k, v] of Object.entries(r)) {
        const nk = normKey(k);
        if (nk === 'unsure') unsure = new Set(items(v).map(normKey).filter((x) => FIELDS.includes(x)));
        else if (nk in rec && v !== null && v !== undefined) rec[nk] = ws(v);
      }
    } else if (Array.isArray(r)) {
      FIELDS.forEach((f, i) => { if (i < r.length) rec[f] = r[i] === null || r[i] === undefined ? '' : ws(r[i]); });
    }
    if (FIELDS.some((f) => rec[f])) {
      rec.unsure = [...unsure].sort();
      out.push(rec);
    }
  }
  return [out, side];
}

// ---------------------------------------------------------------- 日期、数字、班次
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
function monthOf(name) {
  const n = name.toLowerCase().replace(/\.+$/, '');
  return MONTHS[n.slice(0, 4)] || MONTHS[n.slice(0, 3)] || null;
}
export function parseDate(s, today = new Date()) {
  // 新加坡写法：日在前。年份一律按今年（Song 定的：认成 1998 之类也改成今年，不往去年推）。返回 {y, m, d} 或 null
  const t = String(s || '').trim().toLowerCase();
  if (!t) return null;
  let m = null, d = null, mm;
  if ((mm = t.match(/^(\d{4})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})$/))) { m = +mm[2]; d = +mm[3]; }
  else if ((mm = t.match(/^(\d{1,2})\s*[-/. ]?\s*([a-z]{3,9})\.?(?:\s*[-/., ]\s*(\d{2,4}))?$/))) { d = +mm[1]; m = monthOf(mm[2]); }
  else if ((mm = t.match(/^([a-z]{3,9})\.?\s*(\d{1,2})(?:\s*,?\s*(\d{2,4}))?$/))) { m = monthOf(mm[1]); d = +mm[2]; }
  else if ((mm = t.match(/^(\d{1,2})\s*[-/.]\s*(\d{1,2})(?:\s*[-/.]\s*(\d{2,4}))?$/))) { d = +mm[1]; m = +mm[2]; }
  if (!m || !d) return null;
  const y = today.getFullYear();
  const dt = new Date(y, m - 1, d);
  if (dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return { y, m, d };
}
export function toInt(s) {
  const t = String(s ?? '').trim().replace(/,/g, '');
  return /^\d{1,12}$/.test(t) ? parseInt(t, 10) : null;
}
const SHIFT_WORDS = {
  DAY: 'D', NIGHT: 'N', 'D/S': 'D', 'N/S': 'N', DS: 'D', NS: 'N', 'DAY SHIFT': 'D', 'NIGHT SHIFT': 'N',
  '白': 'D', '白班': 'D', '早': 'D', '早班': 'D', '日': 'D', '日班': 'D', '夜': 'N', '夜班': 'N', '晚': 'N', '晚班': 'N',
};
export function normShift(s) {
  const t = String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');
  return SHIFT_WORDS[t] || t;
}

// ---------------------------------------------------------------- 认完先整理格式（不改内容）
const DASHES = /[‐‑‒–—―－ー一]/g;
const DIAMETER = /[ØøΦφϕ⌀Фф∅]/g;
const T_LEAD = /^\s*((?:T\s*\d+\s*[.,，、;；/&+]*\s*)+)(.*)$/i;
export function tNumbers(s) { return [...String(s || '').matchAll(/T\s*(\d+)/gi)].map((m) => 'T' + m[1]); }

export function cleanRecord(rec) {
  const r = { ...rec };
  for (const f of ['part_number', 'machine']) r[f] = String(r[f] || '').replace(/\s+/g, '').replace(DASHES, '-').toUpperCase();
  for (const f of ['mo', 'opr_no', 'btmp', 'total_screened', 'passed', 'failed']) r[f] = String(r[f] || '').replace(/\s+/g, '');
  let desc = String(r.description || '').replace(DIAMETER, 'Φ');
  let tn = tNumbers(r.t_no);
  const m = desc.match(T_LEAD);
  if (m && tNumbers(m[1]).length) {                // 「T44 M3 TAP X2」：开头的 T44 是刀号，不是描述
    for (const t of tNumbers(m[1])) if (!tn.includes(t)) tn.push(t);
    desc = m[2];
  }
  desc = desc.replace(/^[\s.,，、:;；\-]+/, '');
  desc = desc.replace(/\s*Φ\s*/g, ' Φ').trim();
  r.description = desc.replace(/\s+/g, ' ').toUpperCase();
  r.t_no = tn.length ? uniq(tn).join(', ') : String(r.t_no || '').trim().toUpperCase();
  if (r.shift) r.shift = normShift(r.shift);
  r.setter = String(r.setter || '').trim().replace(/\s*\/\s*/g, '/');
  return r;
}

// ---------------------------------------------------------------- 两遍对答案
const D2000 = new Date(2000, 0, 1);
export function voteKey(f, v) {
  const t = String(v || '').trim();
  if (f === 'date') {
    const d = parseDate(t, D2000);
    return d ? `${d.d}/${d.m}` : t.replace(/\s+/g, '');
  }
  if (NUM_FIELDS.has(f) || f === 'mo' || f === 'opr_no') {
    const n = toInt(t);
    return n !== null ? String(n) : t.replace(/\s+/g, '').toUpperCase();
  }
  if (f === 'shift') return normShift(t);
  return t.replace(/\s+/g, '').toUpperCase();
}

export function recordsAgree(a, b, fields = FIELDS, key = voteKey) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) for (const f of fields) if (key(f, a[i][f] || '') !== key(f, b[i][f] || '')) return false;
  return true;
}

export function vote(reads, fields = FIELDS, key = voteKey) {
  // 条数先按多数定，再一格一格按多数定（打平用第一遍的）。几遍不一样的格子记进 disputed，写表时标红。
  if (reads.length === 1) return reads[0].map((r) => ({ ...r, disputed: {} }));
  const [target0, n] = mostCommon(counter(reads.map((r) => r.length)));
  const target = n === 1 ? reads[0].length : target0;
  const cand = reads.filter((r) => r.length === target);
  const out = [];
  for (let i = 0; i < target; i++) {
    const rec = {}, disputed = {};
    for (const f of fields) {
      const vals = cand.map((r) => r[i][f] || '');
      const keys = vals.map((v) => key(f, v));
      const c = counter(keys);
      const [, top] = mostCommon(c);
      const best = c.get(keys[0]) === top ? keys[0] : mostCommon(c)[0];
      rec[f] = vals[keys.indexOf(best)];
      if (c.size > 1 || n === 1) disputed[f] = uniq(vals.map((v) => v || '空'));
    }
    rec.unsure = [...new Set(cand.flatMap((r) => r[i].unsure || []))].sort();
    rec.disputed = disputed;
    if (cand.length < reads.length) rec.counts = reads.map((r) => r.length);
    out.push(rec);
  }
  return out;
}

export function pickSide(sides) {
  const known = sides.filter(Boolean);
  if (!known.length) return '';
  const c = counter(known);
  const [, top] = mostCommon(c);
  return c.get(known[0]) === top ? known[0] : mostCommon(c)[0];
}

export function retryDelay(detail) {
  const m = String(detail || '').match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  return m ? parseFloat(m[1]) : null;
}
export function classify429(e) {
  const s = `${e.message} ${e.detail}`;
  if (/prepay/i.test(s)) return 'prepay';
  if (/PerDay|per day|daily/i.test(s)) return 'day';
  return 'minute';
}

// ---------------------------------------------------------------- 数据库：比对用的写法
const CONFUSE = { O: '0', Q: '0', D: '0', I: '1', L: '1', '|': '1', S: '5', B: '8', Z: '2', G: '6' };
export function labelKey(v) { return String(v ?? '').toUpperCase().replace(/[^A-Z/]/g, ''); }
export function nkey(v) {
  return String(v ?? '').toUpperCase().replace(/[‐-―_~]/g, '-').replace(/,/g, '.').replace(/\s+/g, '');
}
export function ckey(v) { return [...nkey(v)].map((ch) => CONFUSE[ch] || ch).join(''); }
export function lev1(a, b) {                // 只差一个字（替换、多一个或少一个）
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
    return diff === 1;
  }
  if (a.length > b.length) [a, b] = [b, a];
  for (let i = 0; i < b.length; i++) if (a === b.slice(0, i) + b.slice(i + 1)) return true;
  return false;
}
export function cellText(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  if (typeof v === 'number' && Number.isInteger(v)) return String(v);
  return String(v).replace(/\s+/g, ' ').trim();
}
export function recordKey(rec, fields = FIELDS) { return fields.map((f) => nkey(rec[f] || '')).join('|'); }

const HEADER_KEYS = {
  DATE: 'date', MACHINE: 'machine', 'M/C': 'machine', MACHINENO: 'machine',
  PARTNUMBER: 'part_number', PARTNO: 'part_number', MO: 'mo', MONO: 'mo', 'W/O': 'mo',
  OPRNO: 'opr_no', OPR: 'opr_no', OPNO: 'opr_no', TNO: 't_no', TOOLNO: 't_no',
  DESCRIPTION: 'description', TOOLDESCRIPTION: 'description', BTMP: 'btmp',
  TOTALSCREENED: 'total_screened', PASSED: 'passed', FAILED: 'failed', SHIFT: 'shift', SETTER: 'setter',
};
export const SETTER_RE = /^\s*(\d{2,6})\s*[/／]\s*([A-Za-z][A-Za-z .'-]*[A-Za-z])\s*$/;

export function findHeader(rows) {          // 同时有 DATE 和 MACHINE 的那一行；下一行是小表头
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const row = rows[i] || [];
    const keys = row.map(labelKey);
    if (keys.includes('DATE') && (keys.includes('MACHINE') || keys.includes('M/C'))) {
      const sub = rows[i + 1] || [];
      const cols = new Map();
      const taken = new Set();
      for (let c = 0; c < Math.max(row.length, sub.length); c++) {
        for (const v of [sub[c], row[c]]) {
          const f = HEADER_KEYS[labelKey(v)];
          if (f && !taken.has(f)) { cols.set(c, f); taken.add(f); break; }
        }
      }
      const usesSub = [...cols.keys()].some((c) => c < sub.length && HEADER_KEYS[labelKey(sub[c])]);
      return [usesSub ? i + 2 : i + 1, cols];
    }
  }
  return null;
}

export function readPeople(rows) {
  const out = [];
  for (const row of rows) {
    const cells = (row || []).map(cellText);
    cells.forEach((t, j) => {
      const m = t.match(SETTER_RE);
      if (m) { out.push([m[1], m[2].trim()]); return; }
      if (/^\d{2,6}$/.test(t)) {
        const nxt = cells.slice(j + 1).find((x) => x) || '';
        if (/^[A-Za-z][A-Za-z .'-]{1,60}$/.test(nxt) && nxt.replace(/[^A-Za-z]/g, '').length >= 3) out.push([t, nxt.trim()]);
      }
    });
  }
  return out;
}

export function readWorkbook(sheets) {      // sheets: [[页名, 行[]]] -> {recs: [[页名, 记录]], people, used}
  const recs = [], people = [], used = [], loose = [];
  let hasHeader = false;
  for (const [title, rows] of sheets) {
    const hdr = findHeader(rows);
    if (!hdr) {
      const found = readPeople(rows);
      if (/NAME|EMP|名单|名字|人员/i.test(title)) people.push(...found); else loose.push(...found);
      continue;
    }
    hasHeader = true;
    const [start, cols] = hdr;
    let n = 0;
    for (const row of rows.slice(start)) {
      const rec = Object.fromEntries(FIELDS.map((f) => [f, '']));
      for (const [c, f] of cols) if (row && c < row.length) rec[f] = cellText(row[c]);
      const core = ['machine', 'part_number', 'mo', 't_no', 'description', 'setter'].filter((f) => rec[f]).length;
      if (core >= 3) {
        recs.push([title, rec]);
        n++;
        const m = rec.setter.match(SETTER_RE);
        if (m) people.push([m[1], m[2].trim()]);
      }
    }
    if (n) used.push(title);
  }
  if (hasHeader) people.push(...loose);        // 真是刀单本子，别的页上的工号名字才算数
  return { recs, people, used };
}

// 刀单数据库：{records: [{key, source, sheet, fed_at, ...13 列}], people: [[工号, 名字]]}
export function feedKb(db, sheets, source) {
  const res = { source, rows: 0, added: 0, people: 0, sheets: [], error: '' };
  const { recs, people, used } = readWorkbook(sheets);
  if (!recs.length && !people.length) {
    res.error = '这本不像刀单：没找到 DATE、MACHINE 那样的表头，一条没吃。是别的单子的话，放进它自己的类别';
    return res;
  }
  const now = new Date().toISOString().slice(0, 19);
  const have = new Set(db.records.map((r) => r.key));
  for (const [sheet, r] of recs) {
    const key = recordKey(r);
    if (have.has(key)) continue;
    have.add(key);
    db.records.push({ key, source, sheet, fed_at: now, ...r });
    res.added++;
  }
  const known = new Set(db.people.map(([n]) => n));
  for (const [n, nm] of people) {
    if (known.has(n)) continue;
    known.add(n);
    db.people.push([n, nm]);
    res.people++;
  }
  res.rows = recs.length;
  res.sheets = used;
  return res;
}
export function feedLine(r) {
  if (r.error) return `✗ ${r.source}：${r.error}`;
  if (r.columns !== undefined) {
    return `✓ 放进去 ${r.source}：读到 ${r.rows} 行，新增 ${r.added} 行（其余以前放过）` +
      (r.newColumns && r.newColumns.length ? `，新列：${r.newColumns.join('、')}` : '');
  }
  return `✓ 吃进 ${r.source}：读到 ${r.rows} 行记录，新增 ${r.added} 行（其余以前吃过）` +
    (r.people ? `，新认识 ${r.people} 人` : '') + (r.sheets.length ? `（${r.sheets.join('、')}）` : '');
}
export function kbSummary(db) {
  const n = db.records.length;
  if (!n) return '数据库还是空的：点「放入样板资料」喂几本改对的刀单表，喂得越多它越不瞎';
  const d = (f) => new Set(db.records.map((r) => r[f]).filter(Boolean)).size;
  return `数据库：${n} 条记录 · 机台 ${d('machine')} 台 · 零件 ${d('part_number')} 种 · 刀具描述 ${d('description')} 种 · 认识 ${db.people.length} 人`;
}

const CAT_FIELDS = ['machine', 'part_number', 'description'];
export class Snapshot {                     // 拿数据库当准绳
  constructor(records = [], people = []) {
    this.n = records.length;
    this.people = people;
    this.canon = {}; this.count = {}; this.byCkey = {};
    for (const f of CAT_FIELDS) {
      const spell = new Map();
      for (const r of records) {
        if (!r[f]) continue;
        const k = nkey(r[f]);
        if (!spell.has(k)) spell.set(k, new Map());
        const m = spell.get(k);
        m.set(r[f], (m.get(r[f]) || 0) + 1);
      }
      this.canon[f] = new Map();
      this.count[f] = new Map();
      for (const [k, m] of spell) {
        const c = mostCommon(m)[0];
        this.canon[f].set(k, c);
        this.count[f].set(c, [...m.values()].reduce((a, b) => a + b, 0));
      }
      this.byCkey[f] = new Map();
      for (const [k, v] of this.canon[f]) {
        const ck = ckey(k);
        if (!this.byCkey[f].has(ck)) this.byCkey[f].set(ck, new Set());
        this.byCkey[f].get(ck).add(v);
      }
    }
  }
  roster() { return [...this.people]; }
  hints(maxParts = 200) {
    if (!this.n) return '';
    const lines = [];
    for (const [f, lim] of [['machine', 100], ['description', 150], ['part_number', maxParts]]) {
      const vals = [...this.count[f].entries()].sort((a, b) => b[1] - a[1]).slice(0, lim).map(([v]) => v);
      if (vals.length) lines.push(`${LABEL[f]}：` + vals.join('、'));
    }
    return `公司记录里出现过的值（数据库 ${this.n} 条记录）：单子上的字跟其中某个很像时，一律以这里的写法为准；` +
      '明显不一样的（新机台、新零件、新刀）照单子原样抄。\n' + lines.join('\n');
  }
  snap(f, v) {
    const k = nkey(v);
    const cands = this.byCkey[f].get(ckey(v)) || new Set();
    if (cands.size === 1) return [...cands][0];
    if (k.length >= 4) {
      const near = new Set();
      for (const [kk, c] of this.canon[f]) if (lev1(kk, k)) near.add(c);
      if (near.size === 1) {
        const c = [...near][0];
        if ((this.count[f].get(c) || 0) >= 2) return c;
      }
    }
    return null;
  }
  fix(rec, unsure = []) {
    // 认出来的值跟库里某个只差一个容易看错的字，就改成库里的写法（橙）。
    // 不按零件对历史（Song 定的：零件、刀、MO 之间的老关系不拿来标红；没见过的零件也不标红）。
    rec = { ...rec };
    const fixed = {}, flags = {};
    if (!this.n) return [rec, fixed, flags];
    for (const f of CAT_FIELDS) {
      const v = rec[f] || '';
      if (!v) continue;
      const k = nkey(v);
      if (this.canon[f].has(k)) { rec[f] = this.canon[f].get(k); continue; }
      const c = this.snap(f, v);
      if (c) { fixed[f] = [v, c, '按数据库改']; rec[f] = c; }
      else if (f !== 'part_number' && unsure.includes(f)) flags[f] = `${LABEL[f]} 数据库里没见过，模型也拿不准：${v}`;
    }
    return [rec, fixed, flags];
  }
}

// ---------------------------------------------------------------- 一条记录写进表之前：标红、标橙、核对提示
export function assessRecord(rec, { snapshot = null, names = [], today = new Date() } = {}) {
  // 跟电脑版 RecordBook._record_row 同一套：先拿数据库当准绳（橙），再查数字、班次、看不清的字、两遍不一样、模型拿不准（红）
  const notes = [], red = new Set(), orange = new Set(), values = {};
  const unsure = rec.unsure || [];
  const disputed = { ...(rec.disputed || {}) };
  if (snapshot) {
    let fixed, flags;
    [rec, fixed, flags] = snapshot.fix(rec, unsure);
    for (const [f, [old, nw, why]] of Object.entries(fixed)) { orange.add(f); notes.push(`${f.toUpperCase()} ${old}→${nw}（${why}）`); }
    for (const [f, why] of Object.entries(flags)) { red.add(f); notes.push(why); }
  }
  for (const f of FIELDS) {
    const raw = rec[f] || '';
    let v = raw;
    if (f === 'date' && raw) {
      const d = parseDate(raw, today);
      if (d) v = d;                         // 日期从不标红（Song 定的：错了无所谓），认不出就照原样写
    } else if (NUM_FIELDS.has(f) && raw) {
      const n = toInt(raw);
      if (n === null) { red.add(f); notes.push(`${f.toUpperCase()} 不是数字：${raw}`); } else v = n;
    } else if ((f === 'mo' || f === 'opr_no') && raw) {
      const n = toInt(raw);
      v = n !== null ? n : raw;
    } else if (f === 'shift' && raw) {
      v = normShift(raw);
      if (v !== 'D' && v !== 'N') { red.add(f); notes.push(`SHIFT 不是 D/N：${raw}`); }
    } else if (f === 'setter' && raw) {
      // SETTER 照单子抄；只有工号里有看不清的字（□）而名单能唯一补上时才补
      if (raw.includes('□') && names.length) {
        const mm = raw.match(/^\s*([0-9□]+)(.*)$/);
        if (mm && mm[1].includes('□')) {
          const re = new RegExp('^' + mm[1].replace(/□/g, '\\d') + '$');
          const hit = names.filter(([n]) => re.test(n)).map(([n]) => n);
          if (hit.length === 1) { v = hit[0] + mm[2]; notes.push(`SETTER 看不清的工号按名单补成 ${hit[0]}`); }
        }
      }
    }
    if (typeof v === 'string' && v.includes('□') && !NEVER_RED.has(f)) { red.add(f); notes.push(`${f.toUpperCase()} 有看不清的字`); }
    values[f] = v;
  }
  if (rec.single) notes.push('只认成了一遍，没能对答案');
  if (rec.counts) notes.push('几遍认出的条数不一样（' + rec.counts.join(' / ') + ' 条），按多数定');
  const alts = {};                            // 几遍认出来的不同写法：核对时点一下就填上
  for (const f of FIELDS) {
    if (f in disputed && !orange.has(f) && !NEVER_RED.has(f)) {
      red.add(f); notes.push(`${f.toUpperCase()} 几遍认得不一样：` + disputed[f].join(' / '));
      alts[f] = disputed[f].filter((v) => v !== '空');
    }
  }
  for (const f of FIELDS) {
    if (unsure.includes(f) && !red.has(f) && !orange.has(f) && !NEVER_RED.has(f)) { red.add(f); notes.push(`${f.toUpperCase()} 模型拿不准`); }
  }
  const t = values.total_screened, p = values.passed, fl = values.failed;
  if ([t, p, fl].every(Number.isInteger) && p + fl !== t) {
    ['total_screened', 'passed', 'failed'].forEach((f) => red.add(f));
    notes.push(`PASSED ${p} + FAILED ${fl} ≠ TOTAL ${t}`);
  }
  return { values, red: [...red], orange: [...orange], notes: notes.join('；'), alts };
}

// 格子显示成字（核对、复制整行用）
const MON = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function showValue(v) {
  if (v && typeof v === 'object' && 'm' in v) return `${v.d}-${MON[v.m]}`;
  return v === null || v === undefined ? '' : String(v);
}
export function copyValue(v) {               // 粘进 Excel 也认得出是日期：年-月-日
  if (v && typeof v === 'object' && 'm' in v) return `${v.y}-${String(v.m).padStart(2, '0')}-${String(v.d).padStart(2, '0')}`;
  return v === null || v === undefined ? '' : String(v).replace(/[\t\r\n]+/g, ' ');
}

// ---------------------------------------------------------------- 自建类别
export const DATE_HEAD = /日期|时间|date|time/i;
const NUM_RE = /^-?\d+(?:\.\d+)?$/;
export const NOTE_HEAD = '核对提示';
export const META = new Set(['unsure', 'disputed', 'counts', 'single']);

export function colkey(name) {
  return String(name ?? '').toLocaleLowerCase().replace(/[\s.:：。,，、/\\\-_()（）[\]【】#№]+/g, '');
}
function headerish(texts) {
  const words = texts.filter((t) => !/^[-\d.,/: ]+$/.test(t));
  return texts.length >= 2 && words.length >= Math.max(2, Math.floor(texts.length * 0.6)) && texts.every((t) => t.length <= 40);
}
export function readTable(rows) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const cells = (rows[i] || []).map(cellText);
    const texts = cells.map((t, j) => [j, t]).filter(([, t]) => t);
    if (!headerish(texts.map(([, t]) => t))) continue;
    if (!rows.slice(i + 1, i + 61).some((r) => (r || []).some((v) => cellText(v)))) continue;
    const cols = [];
    for (const [j, t] of texts) {
      if (t.startsWith(NOTE_HEAD)) continue;
      if (j === 0 && ['no', '序号'].includes(t.trim().toLowerCase().replace(/\.+$/, ''))) continue;
      cols.push([j, t]);
    }
    if (cols.length) return [cols, rows.slice(i + 1)];
  }
  return null;
}
export function readBook(sheets) {          // -> {columns, recs: [[页名, {列名: 值}]], used}
  const columns = [], seen = new Map(), recs = [], used = [];
  for (const [title, rows] of sheets) {
    const t = readTable(rows);
    if (!t) continue;
    const [cols, data] = t;
    for (const [, nm] of cols) if (!seen.has(colkey(nm))) { seen.set(colkey(nm), nm); columns.push(nm); }
    const heads = new Set(cols.map(([, nm]) => colkey(nm)));
    let n = 0;
    for (const row of data) {
      const rec = {};
      for (const [j, nm] of cols) rec[seen.get(colkey(nm))] = row && j < row.length ? cellText(row[j]) : '';
      const vals = Object.values(rec).filter(Boolean);
      if (!vals.length || vals.every((v) => heads.has(colkey(v)))) continue;
      recs.push([title, rec]);
      n++;
    }
    if (n) used.push(title);
  }
  return { columns, recs, used };
}

// 一个自建类别的数据库：{columns: [列名], records: [{key, source, sheet, fed_at, data: {列: 值}}]}
export function feedTable(db, sheets, source) {
  const res = { source, rows: 0, added: 0, sheets: [], error: '', columns: [], newColumns: [] };
  const { columns, recs, used } = readBook(sheets);
  if (!recs.length) { res.error = '没找到表头和记录（表头要在前 15 行，至少两列）'; return res; }
  const have = new Map(db.columns.map((nm) => [colkey(nm), nm]));
  for (const nm of columns) {                // 第一本的表头定成这个类别的列；以后多出来的列接在后面
    if (!have.has(colkey(nm))) { db.columns.push(nm); have.set(colkey(nm), nm); res.newColumns.push(nm); }
  }
  const now = new Date().toISOString().slice(0, 19);
  const keys = new Set(db.records.map((r) => r.key));
  for (const [sheet, rec] of recs) {
    const data = {};
    for (const [k, v] of Object.entries(rec)) if (v) data[have.get(colkey(k))] = v;
    const key = db.columns.map((c) => nkey(data[c] || '')).join('|');
    if (keys.has(key)) continue;
    keys.add(key);
    db.records.push({ key, source, sheet, fed_at: now, data });
    res.added++;
  }
  res.rows = recs.length;
  res.sheets = used;
  res.columns = [...db.columns];
  return res;
}
export function tableSummary(db, name) {
  if (!db.columns.length) return `「${name}」还没放过表：先认全部内容，改对了点「放入样板资料」，表头就定成这个类别的列`;
  const cols = db.columns;
  return `「${name}」数据库：${db.records.length} 条记录 · ${cols.length} 列（${cols.slice(0, 8).join('、')}${cols.length > 8 ? '…' : ''}）`;
}

export class TableSnapshot {
  constructor(columns = [], records = []) {
    this.columns = [...columns];
    this.records = records;
    this.n = records.length;
    const vals = Object.fromEntries(this.columns.map((c) => [c, records.map((r) => r[c] || '').filter(Boolean)]));
    this.datey = new Set(this.columns.filter((c) => DATE_HEAD.test(c)));
    this.numeric = new Set(this.columns.filter((c) => !this.datey.has(c) && vals[c].length >= 3 &&
      vals[c].filter((v) => NUM_RE.test(v.replace(/,/g, ''))).length >= 0.8 * vals[c].length));
    this.canon = {}; this.count = {};
    for (const c of this.columns) {
      const spell = new Map();
      for (const v of vals[c]) {
        const k = nkey(v);
        if (!spell.has(k)) spell.set(k, new Map());
        spell.get(k).set(v, (spell.get(k).get(v) || 0) + 1);
      }
      this.canon[c] = new Map();
      this.count[c] = new Map();
      for (const [k, m] of spell) {
        const best = mostCommon(m)[0];
        this.canon[c].set(k, best);
        this.count[c].set(best, [...m.values()].reduce((a, b) => a + b, 0));
      }
    }
    // 来回就那几个值的列（机台、零件、名字这种）：值会重复出现，又不是数字、日期、长句子
    this.cat = new Set(this.columns.filter((c) => !this.numeric.has(c) && !this.datey.has(c) && vals[c].length >= 3 &&
      this.canon[c].size <= Math.max(1, Math.floor(vals[c].length * 0.7)) &&
      vals[c].reduce((a, v) => a + v.length, 0) / vals[c].length <= 40));
    this.byCkey = {};
    for (const c of this.cat) {
      this.byCkey[c] = new Map();
      for (const [k, v] of this.canon[c]) {
        const ck = ckey(k);
        if (!this.byCkey[c].has(ck)) this.byCkey[c].set(ck, new Set());
        this.byCkey[c].get(ck).add(v);
      }
    }
  }
  columnLines() {
    return this.columns.map((c, i) => {
      const lim = this.cat.has(c) ? 60 : 3;
      const ex = [...this.count[c].entries()].sort((a, b) => b[1] - a[1]).slice(0, lim).map(([v]) => v);
      let tip = this.numeric.has(c) ? '（数字）' : '';
      if (ex.length) tip += '，例如 ' + ex.join('、');
      return `- c${i + 1}：${c}${tip}`;
    });
  }
  hints() {
    if (!this.columns.some((c) => this.cat.has(c))) return '';
    return '上面「例如」后面的值都是以前录对的：单子上的字跟其中某个很像时，一律以那里的写法为准；明显不一样的（新的）照单子原样抄。';
  }
  examples(k = 3) {
    const good = this.records.filter((r) => this.columns.filter((c) => r[c]).length >= Math.max(1, Math.floor(this.columns.length / 2)));
    return good.slice(-k);
  }
  snap(c, v) {
    const cands = this.byCkey[c].get(ckey(v)) || new Set();
    if (cands.size === 1) return [...cands][0];
    const k = nkey(v);
    if (k.length >= 4) {
      const near = new Set();
      for (const [kk, x] of this.canon[c]) if (lev1(kk, k)) near.add(x);
      if (near.size === 1) {
        const x = [...near][0];
        if ((this.count[c].get(x) || 0) >= 2) return x;
      }
    }
    return null;
  }
  fix(rec) {
    rec = { ...rec };
    const fixed = {};
    for (const c of this.cat) {
      const v = rec[c] || '';
      if (!v) continue;
      const k = nkey(v);
      if (this.canon[c].has(k)) { rec[c] = this.canon[c].get(k); continue; }
      const x = this.snap(c, v);
      if (x && x !== v) { fixed[c] = [v, x, '按数据库改']; rec[c] = x; }
    }
    return [rec, fixed, {}];
  }
}

const RULES = `规则：
- 照单子上写的抄，不猜、不补、不纠错；某个字实在看不清就用 □ 代替那个字。
- 单子上没写的就填空字符串。
- 印刷的栏目名不是内容，不要抄进值里。
- 被划掉、涂掉作废的内容不要。
- 图片歪斜或横着拍的，按正确方向读。
- 一条记录都没有就输出空数组。
- title_side：单子的标题（最上面那行印刷的大字）在这张照片的哪一边，照片原样看，不要先在脑子里转正：top（上边）、right（右边）、bottom（下边）、left（左边）。`;

function txt(v) { return v === null || v === undefined ? '' : ws(v); }

export class TableSpec {                    // 刀单以外的类别怎么认（提示词、解析、整理、对答案）
  constructor(name, db = { columns: [], records: [] }) {
    this.name = name;
    this.columns = [...db.columns];
    this.snapshot = db.columns.length ? new TableSnapshot(db.columns, db.records.map((r) => r.data)) : null;
    this.reg = new Map(this.columns.map((c) => [colkey(c), c]));
  }
  get openMode() { return !this.columns.length; }
  prompt() {
    if (this.openMode) {
      return `你是工厂的录入员，要把「${this.name}」这种单子上的内容整理成表格。这种单子还没有定好的表头，由你来定：
- 先看单子上印好的栏目名（比如 Date、M/C No.、Qty、日期、数量），用它们当列名。栏目名中英文都有的只写英文那部分，没有英文就写中文；同一种单子每次用一样的列名，不要自己发明新说法。
- 每条记录一行，把每个栏目里手写或打印的内容填进对应的列。一张单子通常就是一条记录；一页登记表就是每行一条记录。
- 只有印好的说明文字、没有填内容的栏目也要列出来（值填空字符串），这样列是全的。

${RULES}
- unsure：每条记录里你拿不准的列名，字迹潦草、被挡住、反光、可能看错的；全都看得清就给空数组。
- 只输出 JSON：{"title_side": "top", "columns": ["列名1", "列名2"], "records": [{"values": ["列名1的内容", "列名2的内容"], "unsure": []}]}，values 跟 columns 一一对应，不要任何解释。`;
    }
    const snap = this.snapshot;
    const lines = snap ? snap.columnLines() : this.columns.map((c, i) => `- c${i + 1}：${c}`);
    const keys = this.columns.map((_, i) => `"c${i + 1}": ""`).join(', ');
    let out = `你是工厂的录入员，要把「${this.name}」这种单子上的内容录进表格。从图片里找出每一条记录，每条记录填下面这些列：
${lines.join('\n')}
图片可能是一张单子（通常一条记录），也可能是一页登记表（好几行，每行一条记录）。

${RULES}
- unsure：每条记录里你拿不准的列（写列的编号，比如 c2），字迹潦草、被挡住、反光、可能看错的；全都看得清就给空数组。
- 只输出 JSON：{"title_side": "top", "records": [{${keys}, "unsure": []}]}，不要任何解释。`;
    if (snap) {
      if (snap.hints()) out += '\n\n' + snap.hints();
      const ex = snap.examples();
      if (ex.length) {
        out += '\n\n以前录对的几条（只是让你看格式和写法，不要抄进结果）：\n' + ex.map((r) =>
          JSON.stringify(Object.fromEntries(this.columns.map((c, i) => [`c${i + 1}`, r[c] || ''])))).join('\n');
      }
    }
    return out;
  }
  schema() {
    if (this.openMode) {
      const item = { type: 'OBJECT', properties: { values: SA, unsure: SA }, required: ['values', 'unsure'] };
      return { type: 'OBJECT', properties: { title_side: S, columns: SA, records: { type: 'ARRAY', items: item } }, required: ['columns', 'records', 'title_side'] };
    }
    const keys = this.columns.map((_, i) => `c${i + 1}`);
    const item = { type: 'OBJECT', properties: Object.assign(Object.fromEntries(keys.map((k) => [k, S])), { unsure: SA }), required: keys.concat(['unsure']) };
    return { type: 'OBJECT', properties: { title_side: S, records: { type: 'ARRAY', items: item } }, required: ['records', 'title_side'] };
  }
  body(b64, model, schema = true) {
    return {
      systemInstruction: { parts: [{ text: this.prompt() }] },
      contents: [{ role: 'user', parts: [{ text: `把这张「${this.name}」上的内容逐条录好。` }, { inline_data: { mime_type: 'image/jpeg', data: b64 } }] }],
      generationConfig: genConfig(model, schema ? this.schema() : null),
    };
  }
  colName(raw) {                            // 认全部内容时：几张照片、几遍的列名统一成第一次见到的写法
    const t = ws(raw);
    const k = colkey(t);
    if (!k) return '';
    if (!this.reg.has(k)) this.reg.set(k, t);
    return this.reg.get(k);
  }
  parse(data) {
    const obj = responseJson(data);
    const isObj = obj && typeof obj === 'object' && !Array.isArray(obj);
    const side = isObj ? normSide(obj.title_side) : '';
    let recs = isObj ? (obj.records || []) : obj;
    if (recs && typeof recs === 'object' && !Array.isArray(recs)) recs = [recs];
    if (!Array.isArray(recs)) throw new Error('JSON 里没有 records：' + JSON.stringify(obj).slice(0, 200));
    const out = [];
    if (this.openMode) {
      const cols = isObj ? (obj.columns || []).map((c) => this.colName(c)) : [];
      for (const r of recs) {
        const rec = {};
        let vals = [], unsure = [];
        if (r && typeof r === 'object' && Array.isArray(r.values)) { vals = r.values; unsure = r.unsure || []; }
        else if (r && typeof r === 'object' && !Array.isArray(r)) {
          unsure = r.unsure || [];
          for (const [k, v] of Object.entries(r)) if (k !== 'unsure' && this.colName(k)) rec[this.colName(k)] = txt(v);
        } else if (Array.isArray(r)) vals = r;
        else continue;
        cols.forEach((c, i) => { if (c && i < vals.length) rec[c] = txt(vals[i]); });
        cols.slice(vals.length).forEach((c) => { if (c && !(c in rec)) rec[c] = ''; });
        if (Object.values(rec).some(Boolean)) {
          const names = new Map(Object.keys(rec).map((x) => [colkey(x), x]));
          rec.unsure = [...new Set(items(unsure).filter((u) => names.has(colkey(u))).map((u) => names.get(colkey(u))))].sort();
          out.push(rec);
        }
      }
      return [out, side];
    }
    const idx = new Map(this.columns.map((c, i) => [`c${i + 1}`, c]));
    const byKey = new Map(this.columns.map((c) => [colkey(c), c]));
    for (const r of recs) {
      const rec = Object.fromEntries(this.columns.map((c) => [c, '']));
      const unsure = new Set();
      if (r && typeof r === 'object' && !Array.isArray(r)) {
        for (const [k, v] of Object.entries(r)) {
          if (k === 'unsure') {
            for (const u of items(v)) { const c = idx.get(String(u).trim().toLowerCase()) || byKey.get(colkey(u)); if (c) unsure.add(c); }
            continue;
          }
          const c = idx.get(String(k).trim().toLowerCase()) || byKey.get(colkey(k));
          if (c && v !== null && v !== undefined) rec[c] = txt(v);
        }
      } else if (Array.isArray(r)) this.columns.forEach((c, i) => { rec[c] = txt(r[i]); });
      if (this.columns.some((c) => rec[c])) { rec.unsure = [...unsure].sort(); out.push(rec); }
    }
    return [out, side];
  }
  numeric() { return this.snapshot ? this.snapshot.numeric : new Set(); }
  clean(rec) {
    const out = {};
    const num = this.numeric();
    for (const [k, v] of Object.entries(rec)) {
      if (META.has(k)) { out[k] = v; continue; }
      const t = ws(v);
      out[k] = num.has(k) ? t.replace(/\s+/g, '') : t;
    }
    return out;
  }
  voteKey(c, v) {
    const t = String(v || '').trim();
    if (DATE_HEAD.test(c)) { const d = parseDate(t, D2000); if (d) return `${d.d}/${d.m}`; }
    const n = toInt(t);
    if (n !== null) return String(n);
    return t.replace(/\s+/g, '').toUpperCase();
  }
  fields(reads) {
    const out = [...this.columns];
    for (const recs of reads) for (const r of recs) for (const k of Object.keys(r)) if (!META.has(k) && !out.includes(k)) out.push(k);
    return out;
  }
  agree(a, b) { return recordsAgree(a, b, this.fields([a, b]), (f, v) => this.voteKey(f, v)); }
  vote(reads) { return vote(reads, this.fields(reads), (f, v) => this.voteKey(f, v)); }
}

export function assessTableRecord(rec, columns, snapshot = null) {
  // 跟电脑版 TableBook._record 同一套
  const unsure = rec.unsure || [];
  const disputed = { ...(rec.disputed || {}) };
  const red = new Set(), orange = new Set(), notes = [];
  if (snapshot && snapshot.n) {
    let fixed;
    [rec, fixed] = snapshot.fix(rec);
    for (const [c, [old, nw, why]] of Object.entries(fixed)) { orange.add(c); notes.push(`${c} ${old}→${nw}（${why}）`); }
  }
  const numeric = snapshot ? snapshot.numeric : new Set();
  const values = {}, alts = {};
  for (const c of columns) {
    const raw = rec[c] || '';
    let v = raw;
    const never = DATE_HEAD.test(c);
    if (numeric.has(c) && raw) {
      const t = raw.replace(/,/g, '');
      if (NUM_RE.test(t)) v = /^-?\d+$/.test(t) ? parseInt(t, 10) : parseFloat(t);
      else { red.add(c); notes.push(`${c} 不是数字：${raw}`); }
    }
    if (typeof v === 'string' && v.includes('□') && !never) { red.add(c); notes.push(`${c} 有看不清的字`); }
    if (c in disputed && !orange.has(c) && !never) {
      red.add(c); notes.push(`${c} 几遍认得不一样：` + disputed[c].join(' / '));
      alts[c] = disputed[c].filter((v) => v !== '空');
    }
    else if (unsure.includes(c) && !red.has(c) && !orange.has(c) && !never) { red.add(c); notes.push(`${c} 模型拿不准`); }
    values[c] = v;
  }
  if (rec.single) notes.push('只认成了一遍，没能对答案');
  if (rec.counts) notes.push('几遍认出的条数不一样（' + rec.counts.join(' / ') + ' 条），按多数定');
  return { values, red: [...red], orange: [...orange], notes: uniq(notes).join('；'), alts };
}

// ---------------------------------------------------------------- 核对里人改格子（跟电脑版 viewer.edit_cell 同一套）
export const HUMAN_NOTE = '✓ 人核过';
const SUM = ['total_screened', 'passed', 'failed'];

// 红格子的候选：几遍认出来的不同写法。老批次没存候选，就从核对提示里抠出来。
export function altsOf(row, key, cat = BUILTIN) {
  const have = row.alts && row.alts[key];
  if (have && have.length) return [...have];
  const label = cat === BUILTIN ? key.toUpperCase() : key;
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = String(row.notes || '').match(new RegExp(`(?:^|；)${esc} 几遍认得不一样：([^；]+)`));
  return m ? m[1].split(' / ').map((v) => v.trim()).filter((v) => v && v !== '空') : [];
}

// 人打的字变成表里该有的样子：规矩跟认出来时一样（日期按这批的年份、数字变数字、班次变 D/N、零件号去空格大写）
export function editValue(key, text, { cat = BUILTIN, orig = undefined, today = new Date() } = {}) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  if (cat === BUILTIN) {
    if (key === 'date') return parseDate(t, today) || t;
    if (NUM_FIELDS.has(key) || key === 'mo' || key === 'opr_no') { const n = toInt(t); return n === null ? t : n; }
    if (key === 'shift') return normShift(t);
    if (key === 'machine' || key === 'part_number') return t.replace(/\s+/g, '').replace(DASHES, '-').toUpperCase();
    if (key === 't_no' || key === 'description') return t.replace(DIAMETER, 'Φ').toUpperCase();
    if (key === 'setter') return t.replace(/\s*\/\s*/g, '/');
    return t;
  }
  if (typeof orig === 'number') {
    const n = t.replace(/,/g, '');
    if (NUM_RE.test(n)) return /^-?\d+$/.test(n) ? parseInt(n, 10) : parseFloat(n);
  }
  return t;
}

// 核对提示里的一句是哪一格的：开头写着格子名（刀单是 MACHINE 这样的大写，自建类别是列名）；名字有长有短，取最长对得上的
function noteOwner(piece, names) {
  let best = null;
  for (const nm of names) if (piece.startsWith(nm + ' ') && (!best || nm.length > best.length)) best = nm;
  return best;
}

// 人打进刀单格子里的字，跟认出来的一样查一遍：数字格要是数字、班次要是 D/N、不能有看不清的 □
function typedProblem(key, v) {
  if (v === '' || v === null || v === undefined) return null;
  if (NUM_FIELDS.has(key) && !Number.isInteger(v)) return `${key.toUpperCase()} 不是数字：${v}`;
  if (key === 'shift' && v !== 'D' && v !== 'N') return `SHIFT 不是 D/N：${v}`;
  if (typeof v === 'string' && v.includes('□') && !NEVER_RED.has(key)) return `${key.toUpperCase()} 有看不清的字`;
  return null;
}

// 核对一格：给了 text 就改成它，没给就是「对的」（照原样，只把红去掉）。改过的格子记进 human，表里染成淡绿。
// 这一格的核对提示跟着删；红格子全处理完，提示换成「✓ 人核过」。
export function checkCell(row, key, { text = undefined, cat = BUILTIN, today = new Date() } = {}) {
  const builtin = cat === BUILTIN;
  const keys = builtin ? FIELDS : uniq([...Object.keys(row.values || {}), key]);
  const name = (k) => (builtin ? k.toUpperCase() : k);
  const names = keys.map(name);
  let bad = null;
  if (text !== undefined) {
    const v = row.values[key] = editValue(key, text, { cat, orig: row.values[key], today });
    if (builtin) bad = typedProblem(key, v);
  }
  row.red = (row.red || []).filter((f) => f !== key);
  row.orange = (row.orange || []).filter((f) => f !== key);
  row.human = uniq([...(row.human || []), key]);
  let notes = String(row.notes || '').split('；').filter((n) => n && n !== HUMAN_NOTE && noteOwner(n, names) !== name(key));
  if (bad) { row.red.push(key); notes.push(bad); }      // 打错了（数字格打了字母之类）：还红着，等再改或者点「对的」
  if (builtin && SUM.includes(key)) {                 // 数量：PASSED + FAILED 要等于 TOTAL
    const [t, p, f] = SUM.map((k) => row.values[k]);
    if ([t, p, f].every(Number.isInteger)) {
      notes = notes.filter((n) => !n.startsWith('PASSED '));
      if (p + f === t) row.red = row.red.filter((k) => !SUM.includes(k));          // 对上了：三格一起不红
      else {                                                                        // 还对不上：没核过的那几格红着
        row.red = uniq([...row.red, ...SUM.filter((k) => !row.human.includes(k))]);
        notes.push(`PASSED ${p} + FAILED ${f} ≠ TOTAL ${t}`);
      }
    }
  }
  row.notes = row.red.length ? notes.join('；') : HUMAN_NOTE;
  return row;
}

// 这条核完了：没有红格子，人也动过它
export function isChecked(row) {
  return !!row && row.kind !== 'blank' && !(row.red || []).length && (row.human || []).length > 0;
}

// 核完的那条当样板放进数据库；同一条再改，换掉上次放进去的那份（source 认人）。返回放没放进去
export function feedChecked(db, row, { cat = BUILTIN, columns = [], source }) {
  db.records = db.records.filter((r) => r.source !== source);   // 又改红了：上次放进去的那份也拿掉
  if (!isChecked(row)) return false;
  const now = new Date().toISOString().slice(0, 19);
  if (cat === BUILTIN) {
    const rec = Object.fromEntries(FIELDS.map((f) => [f, copyValue(row.values[f])]));
    const key = recordKey(rec);
    const m = rec.setter.match(SETTER_RE);                 // 跟放表进去一样：调试员的工号名字记进名单
    if (m && !db.people.some(([n]) => n === m[1])) db.people.push([m[1], m[2].trim()]);
    if (db.records.some((r) => r.key === key)) return false;
    db.records.push({ key, source, sheet: '核对', fed_at: now, ...rec });
    return true;
  }
  const have = new Map(db.columns.map((nm) => [colkey(nm), nm]));   // 跟「放入样板资料」一样：列名按写法对，多出来的列接在后面
  for (const nm of columns) if (!have.has(colkey(nm))) { db.columns.push(nm); have.set(colkey(nm), nm); }
  const data = {};
  for (const [c, raw] of Object.entries(row.values || {})) {
    const v = copyValue(raw);
    const col = have.get(colkey(c));
    if (v && col) data[col] = v;
  }
  const key = db.columns.map((c) => nkey(data[c] || '')).join('|');
  if (db.records.some((r) => r.key === key)) return false;
  db.records.push({ key, source, sheet: '核对', fed_at: now, data });
  return true;
}

// ---------------------------------------------------------------- 新类别的名字
export function checkName(name, existing) {
  const n = String(name || '').trim();
  if (!n) return '名字不能空着';
  if (n.length > 20) return '名字太长了（最多 20 个字）';
  if (/[\\/:*?"<>|\x00-\x1f]/.test(n) || n.endsWith('.')) return '名字里不能有 \\ / : * ? " < > | 这些符号';
  if (existing.map((x) => x.toLocaleLowerCase()).includes(n.toLocaleLowerCase())) return `已经有「${n}」了`;
  return '';
}

// ---------------------------------------------------------------- 拍照片的时间（EXIF），按拍摄顺序编号
export function exifTime(buf) {
  // 只读 JPEG 里的 DateTimeOriginal（没有就 DateTime）；读不到返回 null
  try {
    const v = new DataView(buf);
    if (v.getUint16(0) !== 0xffd8) return null;
    let off = 2;
    while (off + 4 < v.byteLength) {
      const marker = v.getUint16(off);
      const len = v.getUint16(off + 2);
      if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) {
        const t = off + 10;
        const le = v.getUint16(t) === 0x4949;
        const u16 = (p) => v.getUint16(t + p, le), u32 = (p) => v.getUint32(t + p, le);
        const readStr = (p, n) => { let s = ''; for (let i = 0; i < n - 1; i++) s += String.fromCharCode(v.getUint8(t + p + i)); return s; };
        const ifd = (p, want) => {
          const n = u16(p);
          const found = {};
          for (let i = 0; i < n; i++) {
            const e = p + 2 + i * 12, tag = u16(e);
            if (want.includes(tag)) found[tag] = tag === 0x8769 ? u32(e + 8) : readStr(u32(e + 8), u32(e + 4));
          }
          return found;
        };
        const ifd0 = ifd(u32(4), [0x0132, 0x8769]);
        const exif = ifd0[0x8769] ? ifd(ifd0[0x8769], [0x9003]) : {};
        const raw = exif[0x9003] || ifd0[0x0132];
        const m = raw && raw.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
        return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null;
      }
      if ((marker & 0xff00) !== 0xff00) break;
      off += 2 + len;
    }
  } catch (e) { /* 坏的 EXIF：不管 */ }
  return null;
}

// 进度条别干等：认完一张跳一格；两张之间按估的时间慢慢往前爬，最多爬到下一格的九成（真认完才跳满）
// m = {total, done, tLast(上一张认完的时刻), gaps(之前每张之间隔了多久)}；guess：还没认完一张时先按 6 秒估
export function meterFrac(m, now, guess = 6000) {
  if (!m.total) return 0;
  if (m.done >= m.total) return 1;
  const g = m.gaps.slice(-5);
  const gap = g.length ? g.reduce((x, y) => x + y, 0) / g.length : guess;
  return (m.done + 0.9 * (1 - Math.exp(-(now - m.tLast) / gap))) / m.total;
}

// ---------------------------------------------------------------- 认完一张存一张；页面被关了接着干
// 表里的一行：{no, kind:'rec'|'blank', …}；retry：认失败了（照片留在列表里，下回重干）；left：没干完（停了、照片丢了）
// 认完一张马上进表：先回来的不一定是小号，按编号插进去（同一张的几条挨在一起、顺序不变）
export function placeRows(rows, add) {
  if (!add.length) return rows;
  let i = rows.length;
  while (i > 0 && rows[i - 1].no > add[0].no) i--;
  rows.splice(i, 0, ...add);
  return rows;
}

// 这批干得怎么样（按张算，一张认出几条也只算一张）
export function tally(rows) {
  const ok = new Set(), bad = new Set();
  let records = 0;
  for (const r of rows) {
    if (r.kind === 'rec') records++;
    if (r.retry) bad.add(r.no);
    else if (!r.left) ok.add(r.no);
  }
  for (const no of bad) ok.delete(no);
  return { ok: ok.size, failed: bad.size, records };
}

// 上回干到一半被关掉的那批：items = [{no, qid, …}]（开工时编的号），rows = 表里已经有的，have(qid) = 照片还在不在
// -> done 认完了也存进表了（只差收尾）· retry 认失败了（照片留着下回重干）· todo 接着干 · lost 照片没了（得重选）
// （todo 里要是有「没干完」的灰行，接着干之前先拿掉，免得一张两行）
export function resumePlan(items, rows, have) {
  const seen = new Set(), retry = new Set(), left = new Set();
  for (const r of rows) {
    if (r.left) { left.add(r.no); continue; }
    seen.add(r.no);
    if (r.retry) retry.add(r.no);
  }
  const out = { done: [], retry: [], todo: [], lost: [] };
  for (const x of items) {
    if (seen.has(x.no)) (retry.has(x.no) ? out.retry : out.done).push(x);
    else if (have(x.qid)) out.todo.push(x);
    else if (!left.has(x.no)) out.lost.push(x);          // 已经记过「照片丢了」的，不再记一遍
  }
  return out;
}
