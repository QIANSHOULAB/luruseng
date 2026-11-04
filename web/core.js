// 录入僧网页版 · 认单子的核心（跟电脑版 bangong/engine.py、kb.py、tables.py 同一套规矩，改一边要改另一边）
// 纯逻辑：不碰页面、不碰存储，浏览器和 node 测试都能跑。给人看的字（日志里那几句）在 strings.js；
// 提示词、写进表里的核对提示照旧是中文（那是给模型和公司那本表的，核对窗口还要从提示里读候选）。
import './strings.js';

const t = (k, v) => globalThis.LURU_I18N.t(k, v);
const list = (a) => globalThis.LURU_I18N.list(a);

export const VERSION = '1.11.3';
export const MANUAL_STOP = '手动停止';      // 点了「停止」（只当记号比，给人看的字在 strings.js）
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
- 手写的 7 常在中间加一横，横还可能拉得很长、碰到旁边的字：顶上有一横或一个小钩、中间再一横的是 7，不是 4（顶上开口的才是 4）；横碰到后面的 1 时，别把 7 和 1 拼成一个 H。
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
export function mkey(v) {                   // 机台比对用：VM-07、VM-7、vm7 都是同一台
  const k = nkey(v);
  const m = k.match(/^([A-Z0-9]*?[A-Z])-?0*(\d+)$/);
  return m ? `${m[1]}-${m[2]}` : k;
}
export function skel(v) { return nkey(v).replace(/[^A-Z0-9]/g, ''); }   // 零件号只看字母和数字
export function lev(a, b) {                 // 差几个字（替换、多、少各算一个）
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0)));
    prev = cur;
  }
  return prev[b.length];
}
export function swap47(a, b) {              // 只差几个 4↔7：带横的 7 被看成 4（或者反过来）
  if (a.length !== b.length || a === b) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && [a[i], b[i]].sort().join('') !== '47') return false;
  return true;
}
// 手写数字里长得像的：带横的 7 跟 4 最像（Song 那张单子），其次这几对
const LOOKALIKE = new Set(['47', '49', '17', '38', '56', '68', '08', '06', '09', '35', '27', '12']);
export function lookRank(read, cand) {      // 候选排队：只差 4↔7 最像；其次只差一个手写易混的数字；再其次别的只差一个字
  if (swap47(read, cand)) return 0;
  if (read.length === cand.length) {
    const diff = [];
    for (let i = 0; i < read.length; i++) if (read[i] !== cand[i]) diff.push([read[i], cand[i]].sort().join(''));
    if (diff.length === 1 && LOOKALIKE.has(diff[0])) return 1;
  }
  return 2;
}
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export function closeCodes(read, pool, count = new Map(), limit = 4) {   // 工号、工序：只差一个字（或者只差 4↔7）的，最像的排前面
  const n = (c) => (count && count.get ? count.get(c) : count && count[c]) || 0;
  const near = [...pool].filter((c) => c !== read && (swap47(read, c) || lev(read, c) === 1));
  near.sort((a, b) => lookRank(read, a) - lookRank(read, b) || n(b) - n(a) || cmpStr(a, b));
  return near.slice(0, limit);
}
export function isShiftWord(v) { return Object.prototype.hasOwnProperty.call(SHIFT_WORDS, String(v ?? '').trim().toUpperCase()); }
function fmtNum(x) { return x.toFixed(3).replace(/0+$/, '').replace(/\.$/, ''); }
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

// 名字页上的清单列（公司那本 NAME 页：MACHINE、OPERATION 各一列）：拿来当准绳，里面的字不当人名
const LIST_KEYS = {
  MACHINE: 'machine', MACHINES: 'machine', 'M/C': 'machine', MACHINENO: 'machine',
  OPERATION: 'opr_no', OPERATIONS: 'opr_no', OPR: 'opr_no', OPRNO: 'opr_no', OP: 'opr_no', OPNO: 'opr_no',
};
const LIST_OTHER = new Set(['SHIFT', 'TOOL', 'TOOLS', 'TNO', 'DESCRIPTION', 'DATE', 'MO', 'PARTNUMBER', 'PARTNO']);
const LIST_SHEET = /NAME|EMP|LIST|名单|名字|人员|清单/i;
export const LIST_NAME = { machine: '机台表', opr_no: '工序表' };

export function readLists(rows) {           // 前 5 行里找 MACHINE、OPERATION 这样的列头，底下一格一个值 -> [{machine, opr_no}, 清单列]
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const keys = (rows[i] || []).map(labelKey);
    const kinds = new Map();
    keys.forEach((k, c) => { if (LIST_KEYS[k]) kinds.set(c, LIST_KEYS[k]); });
    if (!kinds.size) continue;
    const skip = new Set();
    keys.forEach((k, c) => { if (LIST_KEYS[k] || LIST_OTHER.has(k)) skip.add(c); });
    const out = {};
    for (const [c, kind] of kinds) {
      for (const r of rows.slice(i + 1)) {
        let t = r && c < r.length ? cellText(r[c]) : '';
        if (!t) continue;
        if (kind === 'opr_no') { const n = toInt(t); if (n === null) continue; t = String(n); }
        const b = (out[kind] = out[kind] || []);
        if (!b.includes(t)) b.push(t);
      }
    }
    return [out, skip];
  }
  return [{}, new Set()];
}

export function readPeople(rows, skip = new Set()) {
  // 认「535/RAJ KUMAR」这种格子，或者一格工号紧跟一格名字。清单列里的字不算：不然工序 130 跟班次 NIGHT 会被凑成一个人
  const out = [];
  for (const row of rows) {
    const cells = (row || []).map(cellText);
    cells.forEach((t, j) => {
      if (skip.has(j)) return;
      const m = t.match(SETTER_RE);
      if (m) { if (!isShiftWord(m[2])) out.push([m[1], m[2].trim()]); return; }
      if (/^\d{2,6}$/.test(t)) {
        let k = -1;
        for (let i = j + 1; i < cells.length; i++) if (cells[i]) { k = i; break; }
        const nxt = k >= 0 && !skip.has(k) ? cells[k] : '';
        if (/^[A-Za-z][A-Za-z .'-]{1,60}$/.test(nxt) && nxt.replace(/[^A-Za-z]/g, '').length >= 3 && !isShiftWord(nxt)) out.push([t, nxt.trim()]);
      }
    });
  }
  return out;
}

export function readWorkbook(sheets) {      // sheets: [[页名, 行[]]] -> {recs: [[页名, 记录]], people, used, lists}
  const recs = [], people = [], used = [], loose = [];
  const lists = {}, looseLists = {};
  const addTo = (bucket, kind, vals) => { const b = (bucket[kind] = bucket[kind] || []); for (const v of vals) if (!b.includes(v)) b.push(v); };
  let hasHeader = false;
  for (const [title, rows] of sheets) {
    const hdr = findHeader(rows);
    if (!hdr) {
      const [foundLists, skip] = readLists(rows);
      const found = readPeople(rows, skip);
      const named = LIST_SHEET.test(title);
      if (named) people.push(...found); else loose.push(...found);
      for (const [kind, vals] of Object.entries(foundLists)) addTo(named ? lists : looseLists, kind, vals);
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
  if (hasHeader) {                             // 真是刀单本子，别的页上的工号名字、清单才算数
    people.push(...loose);
    for (const [kind, vals] of Object.entries(looseLists)) addTo(lists, kind, vals);
  }
  return { recs, people, used, lists };
}

// 刀单数据库：{records: [{key, source, sheet, fed_at, ...13 列}], people: [[工号, 名字]]}
export function feedKb(db, sheets, source) {
  const res = { source, rows: 0, added: 0, people: 0, sheets: [], error: '', lists: {} };
  const { recs, people, used, lists } = readWorkbook(sheets);
  if (!recs.length && !people.length && !Object.keys(lists).length) {
    res.error = t('kb.notTool');
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
  db.lists = db.lists || {};
  for (const [kind, vals] of Object.entries(lists)) {     // 机台表、工序表
    const have = (db.lists[kind] = db.lists[kind] || []);
    for (const v of vals) if (!have.includes(v)) have.push(v);
    res.lists[kind] = vals.length;
  }
  res.rows = recs.length;
  res.sheets = used;
  return res;
}
export function feedLine(r) {
  if (r.error) return t('kb.bad', { src: r.source, why: r.error });
  if (r.columns !== undefined) {
    return t('kb.fedTable', { src: r.source, rows: r.rows, added: r.added }) +
      (r.newColumns && r.newColumns.length ? t('kb.newCols', { cols: list(r.newColumns) }) : '');
  }
  const got = list(Object.entries(r.lists || {}).filter(([, n]) => n).map(([k, n]) => t(`kb.list.${k}`, { n })));
  return t('kb.fed', { src: r.source, rows: r.rows, added: r.added }) +
    (r.people ? t('kb.people', { n: r.people }) : '') + (got ? t('kb.lists', { got }) : '') + (r.sheets.length ? t('kb.sheets', { s: list(r.sheets) }) : '');
}
export function kbSummary(db) {
  const n = db.records.length;
  if (!n) return t('kb.empty');
  const d = (f) => new Set(db.records.map((r) => r[f]).filter(Boolean)).size;
  const machines = new Set([...db.records.map((r) => r.machine).filter(Boolean), ...((db.lists || {}).machine || [])].map(mkey));
  const people = db.people.filter(([, nm]) => !isShiftWord(nm)).length;
  return t('kb.sum', { n, m: machines.size, p: d('part_number'), d: d('description'), people });
}

const CAT_FIELDS = ['machine', 'part_number', 'description'];
const SHIFT_NEAR = 8;                                      // 猜班次看这个人离单子最近的几回
const SHIFT_NAME = { D: '白班', N: '夜班' };
export function dayNum(v) {                                // 日期换成第几天（比远近用）：{y,m,d}、Date、「2026-10-30」都认，认不出 null
  if (v && typeof v === 'object' && 'm' in v) return Math.round(Date.UTC(v.y, v.m - 1, v.d) / 86400000);
  if (v instanceof Date) return Math.round(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate()) / 86400000);
  const m = String(v ?? '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000) : null;
}
const SHORT_RE = /^([A-Z]{1,3})(\d+(?:\.\d*)?)$/;          // 公司表里刀具描述的简写：EM3、DR2.5、M4
const CODE_RE = /^Φ?([0-9A-Z]{1,8})-M([0-9O.]{4,8})/;      // 刀具编码：4FEM-M0300C-0080-04（直径 03.00）
const PHI_RE = /^Φ(\d+(?:\.\d+)?)([A-Z]{2,6})$/;           // 手写的 Φ1.5 FEM
const bump = (m, k, n = 1) => m.set(k, (m.get(k) || 0) + n);
export function say(cands) { return cands && cands.length ? `，可能是：${cands.join(' / ')}` : ''; }   // 红格子的候选：点一下就填

export class Snapshot {                     // 拿数据库当准绳
  constructor(records = [], people = [], lists = {}) {
    this.n = records.length;
    this.people = people.filter(([, nm]) => !isShiftWord(nm)).map(([no, nm]) => [String(no), String(nm)]);
    this.canon = {}; this.count = {}; this.byCkey = {};
    for (const f of CAT_FIELDS) {
      const spell = new Map();
      for (const r of records) {
        if (!r[f]) continue;
        const k = nkey(r[f]);
        if (!spell.has(k)) spell.set(k, new Map());
        bump(spell.get(k), r[f]);
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
    this.bySkel = new Map();                  // 零件号去掉横杠以后的样子
    for (const v of this.canon.part_number.values()) {
      if (!this.bySkel.has(skel(v))) this.bySkel.set(skel(v), new Set());
      this.bySkel.get(skel(v)).add(v);
    }
    lists = lists || {};
    // 机台：公司记录里出现过的 + 名字页上的机台表；VM-07 跟 VM-7 算一台，猜的时候写机台表上的写法
    const mc = new Map();
    for (const r of records) if (r.machine) bump(mc, r.machine);
    this.machines = new Map();
    for (const [v] of [...mc.entries()].sort((a, b) => b[1] - a[1])) if (!this.machines.has(mkey(v))) this.machines.set(mkey(v), v);
    const listed = (lists.machine || []).filter(Boolean);
    for (const v of listed) this.machines.set(mkey(v), v);
    this.listedMachines = uniq(listed.map((v) => this.machines.get(mkey(v))));
    this.mcount = new Map();
    for (const [v, c] of mc) bump(this.mcount, this.machines.get(mkey(v)), c);
    this.mkIndex = new Map();                 // 易混字统一以后（VM-O7 → VM-7）对到哪台
    for (const v of this.machines.values()) {
      const k = mkey(ckey(v));
      if (!this.mkIndex.has(k)) this.mkIndex.set(k, new Set());
      this.mkIndex.get(k).add(v);
    }
    this.checkMachine = listed.length > 0 || this.n >= 100;   // 有机台表，或者记录够多，才拿公司的机台把关
    this.partMachines = new Map();            // 这个零件以前上过哪几台机
    for (const r of records) {
      if (!r.part_number || !r.machine) continue;
      const k = skel(r.part_number);
      if (!this.partMachines.has(k)) this.partMachines.set(k, new Map());
      bump(this.partMachines.get(k), this.machines.get(mkey(r.machine)));
    }
    // 工序：有工序表才把关；表上没有、记录里出现过两回以上的也算公司有
    this.oprCount = new Map();
    for (const r of records) { const k = toInt(r.opr_no || ''); if (k !== null) bump(this.oprCount, String(k)); }
    const listedOps = new Set((lists.opr_no || []).map((v) => toInt(String(v))).filter((k) => k !== null).map(String));
    this.oprs = listedOps.size ? new Set([...listedOps, ...[...this.oprCount].filter(([, c]) => c >= 2).map(([k]) => k)]) : new Set();
    // 调试员：名单上的人 + 公司记录里出现过两回以上的工号（只有工号、没写名字的也算）
    this.setterCount = new Map();
    for (const r of records) { const m = String(r.setter || '').match(/^\s*(\d{2,6})(?!\d)/); if (m) bump(this.setterCount, m[1]); }
    this.setterIds = new Set([...this.people.map(([no]) => no), ...[...this.setterCount].filter(([, c]) => c >= 2).map(([k]) => k)]);
    // 刀具描述：公司表里大多是简写（EM3、DR2.5）就照它的写；简写用过哪几种刀（两个字母以上的）
    const tc = new Map();
    let total = 0, shorts = 0;
    for (const [v, c] of this.count.description) {
      total += c;
      const m = nkey(v).match(SHORT_RE);
      if (m) { bump(tc, m[1], c); shorts += c; }
    }
    this.descTypes = new Set([...tc.keys()].filter((t) => t.length >= 2));
    this.shortDesc = total >= 5 && shorts >= 0.6 * total;
    // 班次：每个调试员以前上的白班还是夜班（公司表里一个人基本固定一个班：Song 2026-11-01「用资料库这个人以前是N还是D去猜」）
    this.shiftHist = new Map();               // 工号 -> [[第几天, 'D' / 'N'], …]
    for (const r of records) {
      const m = String(r.setter || '').match(/^\s*(\d{2,6})(?!\d)/);
      const s = normShift(r.shift || '');
      if (!m || (s !== 'D' && s !== 'N')) continue;
      if (!this.shiftHist.has(m[1])) this.shiftHist.set(m[1], []);
      this.shiftHist.get(m[1]).push([dayNum(r.date), s]);
    }
  }
  // ---------------------------------------------------------------- 班次
  shiftGuess(setter, date = null) {
    // 这个人离这张单子最近的 8 回上的什么班：-> {id, v: 'D' / 'N', k: 几回是它, n: 一共几回}，没记录 null
    const m = String(setter || '').match(/^\s*(\d{2,6})(?!\d)/);
    const hist = m && this.shiftHist.get(m[1]);
    if (!hist || !hist.length) return null;
    const at = dayNum(date);
    const far = (x) => (x === null ? Infinity : at === null ? -x : Math.abs(x - at));   // 不知道单子哪天：最近记的排前面
    const near = [...hist].sort((a, b) => far(a[0]) - far(b[0]) || (b[0] ?? -Infinity) - (a[0] ?? -Infinity) || cmpStr(a[1], b[1]))
      .slice(0, SHIFT_NEAR);
    const d = near.filter(([, s]) => s === 'D').length;
    const v = d * 2 >= near.length ? 'D' : 'N';
    return { id: m[1], v, k: v === 'D' ? d : near.length - d, n: near.length };
  }
  shiftCall(setter, date, cur, reads = null) {
    // 班次照这个人以前的班次猜（Song 2026-11-01：没写就猜，不让人一张张填）。-> {v, why} 或 null（不动）
    // 单子上没写：猜（这个人最近几回四分之三以上是一个班）；几遍认得不一样：哪个跟他一向的班一样就是哪个（也要四分之三以上，
    // 不然照旧红着让人看照片：一半一半的人，单子上划了 Day、模型认成 N 的时候，猜反而把它盖过去）；
    // 认得一致却跟他一向的班对不上（单子上没圈、模型自己编了一个）：他一向的班够稳（最近 5 回以上、85% 以上）就改过来。都标橙
    const g = this.shiftGuess(setter, date);
    if (!g) return null;
    const weak = g.n >= 2 && g.k * 4 >= g.n * 3, strong = g.n >= 5 && g.k >= 0.85 * g.n;
    const how = g.k === g.n ? `${g.id} 最近 ${g.n} 回都是${SHIFT_NAME[g.v]}` : `${g.id} 最近 ${g.n} 回有 ${g.k} 回是${SHIFT_NAME[g.v]}`;
    const seen = reads && reads.length > 1 ? uniq(reads.map((x) => (x === '空' ? '空' : normShift(x)))) : null;
    if (seen) return weak && seen.includes(g.v) ? { v: g.v, why: `SHIFT 几遍认得不一样：${seen.join(' / ')}，${how}，就是 ${g.v}` } : null;
    const now = normShift(cur || '');
    if (!now) return weak ? { v: g.v, why: `SHIFT 空→${g.v}（单子上没写班次，${how}）` } : null;
    if ((now === 'D' || now === 'N') && now !== g.v && strong) return { v: g.v, why: `SHIFT ${now}→${g.v}（${how}；单子上真圈了 ${now} 就改回来）` };
    return null;
  }
  roster() { return [...this.people]; }
  hints(maxParts = 200) {
    if (!this.n && !this.machines.size && !this.oprs.size) return '';
    const top = (f, lim) => [...this.count[f].entries()].sort((a, b) => b[1] - a[1]).slice(0, lim).map(([v]) => v);
    const lines = [];
    const machines = top('machine', 100);
    const seen = new Set(machines.map(mkey));
    for (const v of this.listedMachines) if (!seen.has(mkey(v))) { machines.push(v); seen.add(mkey(v)); }
    if (machines.length) lines.push('MACHINE：' + machines.join('、'));
    if (this.oprs.size) lines.push('OPR NO.：' + [...this.oprs].sort((a, b) => a.length - b.length || cmpStr(a, b)).join('、'));
    for (const [f, lim] of [['description', 150], ['part_number', maxParts]]) {
      const vals = top(f, lim);
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
    return f === 'part_number' ? this.snapPart(v) : null;
  }
  snapPart(v) {
    // 零件号再宽一点：去掉横杠比（TD-123-456-01A 就是 TD-123-456-01-A）；B 被看成 13（A13-1234567B）；
    // 去掉横杠以后只差一个字（AB51234567B）。后两种库里得出现过两回以上
    const s = skel(v);
    if (s.length < 4) return null;
    const same = this.bySkel.get(s);
    if (same && same.size) return same.size === 1 ? [...same][0] : null;
    const hit = new Set();
    for (let i = 0; i < s.length - 1; i++) {
      if (s.slice(i, i + 2) !== '13') continue;
      for (const c of this.bySkel.get(s.slice(0, i) + 'B' + s.slice(i + 2)) || []) hit.add(c);
    }
    if (!hit.size) for (const [sk, cs] of this.bySkel) if (lev1(sk, s)) for (const c of cs) hit.add(c);
    if (hit.size === 1) {
      const c = [...hit][0];
      if ((this.count.part_number.get(c) || 0) >= 2) return c;
    }
    return null;
  }
  // ---------------------------------------------------------------- 机台
  knownMachine(x) {                         // 公司有这台机就返回该写的写法（只差易混字的 VM-O7 也算），没有返回 null
    const k = nkey(x);
    if (this.canon.machine.has(k)) return this.canon.machine.get(k);
    if (this.machines.has(mkey(x))) return this.machines.get(mkey(x));
    const hits = this.mkIndex.get(mkey(ckey(x)));
    return hits && hits.size === 1 ? [...hits][0] : null;
  }
  guessMachine(v, part = '') {
    // 公司就那么几台机床，看起来像的就猜（Song 2026-11-01）。-> [猜的, 猜不准时的候选]
    // 只差一个字的只有一台就是它；有好几台，这个零件以前只上过其中一台就是那台；都不行就不猜
    const x = mkey(ckey(v));
    const pm = (part && this.partMachines.get(skel(part))) || new Map();
    const scored = uniq([...this.machines.values()]).map((m) => [lev(x, mkey(ckey(m))), -(pm.get(m) || 0), -(this.mcount.get(m) || 0), m])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || cmpStr(a[3], b[3]));
    if (!scored.length) return ['', []];
    const best = scored[0][0];
    const top = scored.filter((sc) => sc[0] === best).map((sc) => sc[3]);
    if (best <= 1) {
      if (top.length === 1) return [top[0], []];
      const hist = top.filter((m) => pm.get(m));
      return hist.length === 1 ? [hist[0], top.slice(0, 4)] : ['', top.slice(0, 4)];
    }
    return ['', [...scored].sort((a, b) => a[1] - b[1] || a[0] - b[0] || a[2] - b[2] || cmpStr(a[3], b[3])).slice(0, 4).map((sc) => sc[3])];
  }
  machineRule(rec, disputed, unsure, fixed, flags, alts, ctx) {
    const v = rec.machine || '';
    if (!v) return;
    const k = nkey(v);
    if (!this.checkMachine) {               // 公司的机台还认不全：照老规矩，像的改、拿不准的才标
      if (this.canon.machine.has(k)) { rec.machine = this.canon.machine.get(k); return; }
      const c = this.snap('machine', v);
      if (c) { fixed.machine = [v, c, '按数据库改']; rec.machine = c; } else if (unsure.includes('machine')) flags.machine = `MACHINE 数据库里没见过，模型也拿不准：${v}`;
      return;
    }
    let reads = uniq((disputed.machine || [v]).filter((x) => x && x !== '空'));
    if (!reads.length) reads = [v];
    const good = uniq(reads.map((x) => this.knownMachine(x)).filter(Boolean));
    if (good.length === 1) {
      const g = good[0];
      if (reads.length > 1) { fixed.machine = [v, g, `几遍认得不一样：${reads.join(' / ')}，公司只有 ${g}`]; delete disputed.machine; }
      else if (g !== v) fixed.machine = [v, g, '按数据库改'];
      rec.machine = g;
      return;
    }
    if (good.length > 1) { disputed.machine = good; alts.machine = good; rec.machine = this.knownMachine(v) || good[0]; return; }
    delete disputed.machine;                  // 一个都不是公司的机台：看起来像的就猜，实在没法猜才标红
    const [guess, cands] = this.guessMachine(v, rec.part_number || '');
    ctx.machine = { read: v, guess, cands };
    if (guess) { fixed.machine = [v, guess, `公司没有 ${v}，按长得像猜的`]; rec.machine = guess; } else { flags.machine = `MACHINE ${v} 公司没有这台机` + say(cands); alts.machine = cands; }
  }
  // ---------------------------------------------------------------- 工序
  oprRule(rec, disputed, fixed, flags, alts) {
    const v = rec.opr_no || '';
    if (!this.oprs.size || !v) return;
    const key = (x) => { const n = toInt(x); return n !== null ? String(n) : nkey(x); };
    let reads = uniq((disputed.opr_no || [v]).filter((x) => x && x !== '空'));
    if (!reads.length) reads = [v];
    const good = uniq(reads.map(key).filter((x) => this.oprs.has(x)));
    if (good.length === 1) {
      if (reads.length > 1) { fixed.opr_no = [v, good[0], `几遍认得不一样：${reads.join(' / ')}，公司只有 ${good[0]}`]; delete disputed.opr_no; rec.opr_no = good[0]; }
      return;
    }
    if (good.length > 1) { disputed.opr_no = good; alts.opr_no = good; return; }
    delete disputed.opr_no;
    const cands = uniq(reads.flatMap((x) => closeCodes(key(x), this.oprs, this.oprCount))).slice(0, 4);
    flags.opr_no = `OPR_NO ${v} 公司没有这道工序` + (reads.length > 1 ? `（几遍认的：${reads.join(' / ')}）` : '') + say(cands);
    alts.opr_no = cands;
  }
  // ---------------------------------------------------------------- 刀具描述
  descType(letters) {                       // 最长的、公司表里用过的简写（至少两个字母）：4FEM → EM、CZSD → SD
    for (let i = 0; i < letters.length - 1; i++) if (this.descTypes.has(letters.slice(i))) return letters.slice(i);
    return null;
  }
  descParse(x) {
    // 拆成 [刀的简写, 直径, 哪种写法]：4FEM-M0300C-0080-04 → ['EM', '3', 'code']；Φ1.5 FEM → ['EM', '1.5', 'phi']；
    // 已经是简写的 EM8 → ['EM', '8', 'short']；别的样子返回 null
    const t = nkey(x);
    let m = t.match(CODE_RE);
    if (m) {
      const letters = (m[1].match(/[A-Z]+$/) || [''])[0];
      const d = m[2].replace(/O/g, '0').replace(/\./g, '');
      const dia = /^\d{4,6}$/.test(d) ? fmtNum(parseInt(d.slice(0, 2), 10) + parseInt(d.slice(2), 10) / 10 ** (d.length - 2)) : null;
      return [this.descType(letters), dia, 'code'];
    }
    if ((m = t.match(PHI_RE))) return [this.descType(m[2]), fmtNum(parseFloat(m[1])), 'phi'];
    if ((m = t.match(SHORT_RE)) && this.descTypes.has(m[1])) return [m[1], fmtNum(parseFloat(m[2].replace(/\.$/, '') || '0')), 'short'];
    return null;
  }
  shortRule(rec, disputed, fixed, flags, alts) {
    // 单子上的刀具编码照公司的简写写（Song 2026-11-01 定的：4FEM-M0300C-0080-04 写成 EM3，原编码写进核对提示）。
    // 几遍认的编码前面几个字母不一样（HRDR、HL2DR、HZDP）也不要紧：拆出来是同一种刀、同一个直径就算对上
    const v = rec.description;
    const p = this.descParse(v);
    if (!p || p[2] === 'short') return false;
    let reads = uniq((disputed.description || [v]).filter((x) => x && x !== '空'));
    if (!reads.length) reads = [v];
    const parsed = reads.map((x) => this.descParse(x)).filter(Boolean);
    const types = new Set(parsed.map((q) => q[0]).filter(Boolean));
    const dias = new Set(parsed.map((q) => q[1]).filter(Boolean));
    if (types.size === 1 && dias.size === 1 && parsed.every((q) => q[1])) {
      let short = [...types][0] + [...dias][0];
      short = this.canon.description.get(nkey(short)) || short;
      fixed.description = [v, short, '照公司简写'];
      rec.description = short;
      delete disputed.description;
      return true;
    }
    const opts = uniq(parsed.filter((q) => q[0] && q[1]).map((q) => q[0] + q[1]));
    if (!opts.length) return false;
    if (p[0] && p[1]) rec.description = this.canon.description.get(nkey(p[0] + p[1])) || p[0] + p[1];
    delete disputed.description;
    flags.description = `DESCRIPTION 几遍认得不一样：${opts.join(' / ')}（单子上的编码：${reads.join(' / ')}）`;
    alts.description = opts;
    return true;
  }
  fix(rec, unsure = []) {
    // -> [改好的记录, {字段: [原来, 改成, 原因]}, {字段: 标红原因}, {alts: {字段: 候选}, ctx: 等这批认完再看的}]
    // 零件号、刀具描述：跟库里某个只差容易看错的字，就改成库里的写法；刀具编码照公司的简写写。
    // 机台、工序：公司表里压根没有的，机台看起来像的就猜，工序标红列出像的（Song 2026-11-01 定的）。
    // 几遍认得不一样、只有一个是公司有的：就是它。
    // 不按零件对历史标红（Song 定的：零件、刀、MO 之间的老关系不拿来标红；没见过的零件也不标红）。
    rec = { ...rec };
    const fixed = {}, flags = {}, alts = {}, ctx = {};
    const extra = { alts, ctx };
    if (!this.n && !this.machines.size && !this.oprs.size) return [rec, fixed, flags, extra];
    const had = 'disputed' in rec;
    const disputed = { ...(rec.disputed || {}) };
    for (const f of ['part_number', 'description']) {
      const v = rec[f] || '';
      if (!v) continue;
      if (f === 'description' && this.shortDesc && this.shortRule(rec, disputed, fixed, flags, alts)) continue;
      const k = nkey(v);
      if (this.canon[f].has(k)) { rec[f] = this.canon[f].get(k); continue; }
      const c = this.snap(f, v);
      if (c) { fixed[f] = [v, c, '按数据库改']; rec[f] = c; } else if (f !== 'part_number' && unsure.includes(f)) flags[f] = `${LABEL[f]} 数据库里没见过，模型也拿不准：${v}`;
    }
    this.machineRule(rec, disputed, unsure, fixed, flags, alts, ctx);
    this.oprRule(rec, disputed, fixed, flags, alts);
    if (had || Object.keys(disputed).length) rec.disputed = disputed;
    return [rec, fixed, flags, extra];
  }
}

// ---------------------------------------------------------------- SETTER 按名单对
function lettersOf(s) { return String(s || '').toUpperCase().replace(/[^A-Z一-鿿]/g, ''); }
function sim(a, b) {                        // 跟电脑版 difflib.SequenceMatcher(None, a, b).ratio() 一样的算法
  a = lettersOf(a); b = lettersOf(b);
  if (!a || !b) return 0;
  let total = 0;
  const queue = [[0, a.length, 0, b.length]];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop();
    let bi = alo, bj = blo, bk = 0, j2len = new Map();
    for (let i = alo; i < ahi; i++) {
      const next = new Map();
      for (let j = blo; j < bhi; j++) {
        if (a[i] !== b[j]) continue;
        const k = (j2len.get(j - 1) || 0) + 1;
        next.set(j, k);
        if (k > bk) { bi = i - k + 1; bj = j - k + 1; bk = k; }
      }
      j2len = next;
    }
    if (bk) {
      total += bk;
      if (alo < bi && blo < bj) queue.push([alo, bi, blo, bj]);
      if (bi + bk < ahi && bj + bk < bhi) queue.push([bi + bk, ahi, bj + bk, bhi]);
    }
  }
  return (2 * total) / (a.length + b.length);
}
export function splitSetter(x) {            // 「556」「556/Lee Ah Kow」「Lee Ah Kow」-> [工号, 名字]
  const m = String(x || '').match(/^\s*([0-9□]+)\s*(?:[/／\-\s]\s*(.*))?$/);
  return m ? [m[1], (m[2] || '').trim()] : ['', String(x || '').trim()];
}
export function setterCheck(raw, names, valid = null, reads = [], counts = null) {
  // 号对上就自动写成名单上的「工号/名字」，跟公司表那一列的下拉单一个样（Song 2026-11-01）。
  // 有公司数据（valid：名单上的 + 公司表里出现过的工号）才把关：工号哪儿都没有就标红，列出长得像的工号。
  // -> [值, 'ok' / 'fixed' / 'red', 提示, 候选, 名单外的工号]
  const t = String(raw || '').trim();
  const roster = new Map(names.map(([n, nm]) => [String(n), nm]));
  const known = new Set([...roster.keys(), ...(valid || [])]);
  if (!t || !known.size) return [raw, 'ok', '', [], ''];
  const full = (n) => (roster.has(n) ? `${n}/${roster.get(n)}` : n);
  const [num, nm] = splitSetter(t);
  const seen = uniq([t, ...reads].map((x) => String(x || '').trim()).filter((x) => x && x !== '空'));
  if (seen.length > 1) {                    // 几遍认得不一样：只有一个工号是名单上的，就是它
    const good = uniq(seen.map((x) => splitSetter(x)[0]).filter((n) => known.has(n)));
    if (good.length === 1) return [full(good[0]), 'fixed', `SETTER 几遍认得不一样：${seen.join(' / ')}，名单上只有 ${good[0]}`, [], ''];
    if (good.length > 1) return [known.has(num) ? full(num) : t, 'red', `SETTER 几遍认得不一样：${seen.join(' / ')}`, good.map(full), ''];
  }
  if (num && !num.includes('□')) {
    if (roster.has(num)) {
      if (nm && sim(nm, roster.get(num)) < 0.5) return [t, 'red', `SETTER 工号 ${num} 在名单上是 ${roster.get(num)}，单子上名字是「${nm}」`, [full(num)], ''];
      return [full(num), 'ok', '', [], ''];   // 号对上自动对名字
    }
    if (known.has(num) || valid === null) return [t, 'ok', '', [], ''];   // 公司表里出现过、名单上没写名字；或者没有公司数据：照抄
    const nums = uniq([num, ...seen.map((x) => splitSetter(x)[0]).filter((n) => n && !n.includes('□'))]);
    const cands = uniq(nums.flatMap((n) => closeCodes(n, known, counts).map(full))).slice(0, 4);
    return [t, 'red', `SETTER ${num} 名单上没有` + (seen.length > 1 ? `（几遍认的：${seen.join(' / ')}）` : ''), cands, num];
  }
  if (num) {                                // 工号里有看不清的字：名单能唯一补上就补
    const re = new RegExp('^' + num.replace(/□/g, '\\d') + '$');
    const hit = [...known].filter((n) => re.test(n)).sort();
    if (hit.length === 1) return [full(hit[0]), 'ok', `SETTER 看不清的工号按名单补成 ${hit[0]}`, [], ''];
    return [t, 'red', 'SETTER 有看不清的字', hit.slice(0, 4).map(full), ''];
  }
  if (roster.size) {                        // 只写了名字
    let best = null, bs = -1;
    for (const [n, who] of roster) { const sc = sim(nm, who); if (sc > bs) { best = n; bs = sc; } }
    if (bs >= 0.75) return [full(best), 'fixed', `SETTER 按名字对上名单，工号补成 ${best}`, [], ''];
  }
  if (valid === null) return [t, 'ok', '', [], ''];
  return [t, 'red', `SETTER ${nm} 名单上没有`, [], ''];
}

// ---------------------------------------------------------------- 一条记录写进表之前：标红、标橙、核对提示
export function assessRecord(rec, { snapshot = null, names = [], today = new Date() } = {}) {
  // 跟电脑版 RecordBook.assess 同一套：先拿数据库当准绳（橙），再查名单、数字、班次、日期、看不清的字、两遍不一样、模型拿不准（红）
  const notes = [], red = new Set(), orange = new Set(), values = {}, alts = {}, ctx = {};
  const unsure = rec.unsure || [];
  if (snapshot) {
    let fixed, flags, extra;
    [rec, fixed, flags, extra] = snapshot.fix(rec, unsure);
    for (const [f, [old, nw, why]] of Object.entries(fixed)) { orange.add(f); notes.push(old !== nw ? `${f.toUpperCase()} ${old}→${nw}（${why}）` : `${f.toUpperCase()} ${why}`); }
    for (const [f, why] of Object.entries(flags)) { red.add(f); notes.push(why); }
    Object.assign(alts, extra.alts);
    Object.assign(ctx, extra.ctx);
  }
  const disputed = { ...(rec.disputed || {}) };   // 几遍认得不一样的字段（数据库对上的已经拿掉了）
  const valid = snapshot && snapshot.setterIds.size ? snapshot.setterIds : null;   // 有公司数据才把工号关
  for (const f of FIELDS) {
    const raw = rec[f] || '';
    let v = raw;
    if (f === 'date' && raw) {              // 认不成日期才标红（Song 2026-11-01；认成别的日子照旧不管）
      const d = parseDate(raw, today);
      if (d) v = d; else { red.add(f); notes.push(`DATE ${raw} 认不成日期`); ctx.date = { raw }; }
    } else if (NUM_FIELDS.has(f) && raw) {
      const n = toInt(raw);
      if (n === null) { red.add(f); notes.push(`${f.toUpperCase()} 不是数字：${raw}`); } else v = n;
    } else if ((f === 'mo' || f === 'opr_no') && raw) {
      const n = toInt(raw);
      v = n !== null ? n : raw;
    } else if (f === 'shift' && raw) {
      v = normShift(raw);
      if (v !== 'D' && v !== 'N') { red.add(f); notes.push(`SHIFT 不是 D/N：${raw}`); }
    } else if (f === 'setter' && raw && (names.length || valid)) {
      // 号对上自动对名字；有公司数据时，名单上、公司表里都没有的工号标红，列出长得像的（Song 2026-11-01）
      const [val, look, why, cands, read] = setterCheck(raw, names, valid, disputed.setter || [], snapshot ? snapshot.setterCount : null);
      v = val;
      if (look !== 'ok') { delete disputed.setter; (look === 'red' ? red : orange).add(f); }
      if (why) notes.push(why + (look === 'red' ? say(cands) : ''));
      if (cands.length && look === 'red') alts[f] = cands;
      if (read) ctx.setter = { base: why, cands };
    }
    if (typeof v === 'string' && v.includes('□') && !NEVER_RED.has(f) && !red.has(f)) { red.add(f); notes.push(`${f.toUpperCase()} 有看不清的字`); }
    values[f] = v;
  }
  // 换刀调试单上没有 BTMP：照公司那本的规矩抄 TOTAL SCREENED（那本里这两格每行都一样，Song 定的）
  if (values.btmp === '' && Number.isInteger(values.total_screened)) values.btmp = values.total_screened;
  // 班次：单子上没写、几遍不一样、跟这个人一向的班对不上——照他以前的班次猜（橙）。工号还红着（认不出是谁）就先不猜
  if (snapshot && values.setter && !red.has('setter') && !red.has('shift')) {
    const call = snapshot.shiftCall(values.setter, values.date, values.shift, disputed.shift || null);
    if (call) { values.shift = call.v; orange.add('shift'); notes.push(call.why); delete disputed.shift; }
  }
  if (rec.single) notes.push('只认成了一遍，没能对答案');
  if (rec.counts) notes.push('几遍认出的条数不一样（' + rec.counts.join(' / ') + ' 条），按多数定');
  for (const f of FIELDS) {                 // 几遍认出来的不同写法：核对时点一下就填上
    if (f in disputed && !orange.has(f) && !NEVER_RED.has(f) && !red.has(f)) {
      red.add(f); notes.push(`${f.toUpperCase()} 几遍认得不一样：` + disputed[f].join(' / '));
      if (!(f in alts)) alts[f] = disputed[f].filter((x) => x !== '空');
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
  for (const f of red) orange.delete(f);
  return { values, red: [...red], orange: [...orange], notes: notes.join('；'), alts, ctx };
}

// 一批里的单子互相看一眼（Song 2026-11-01），原地改 rows（人动过的那条不碰）：
// 机台公司没有、又没法按长相猜准的：这批同一个 MO（其次同一个零件）的单子写的是哪台，就是哪台；
// 日期认不成的：列出这批别的单子写的日期；工号名单上没有的：同一个 MO、其次同一个零件的单子是谁，排在候选最前面
export function settle(rows) {
  const recs = rows.filter((r) => r && r.kind === 'rec' && r.values);
  if (!recs.some((r) => r.ctx && Object.keys(r.ctx).length && !(r.human || []).length)) return rows;
  const moOf = (r) => String(r.values.mo ?? '').trim();
  const has = (arr, f) => (arr || []).includes(f);
  const top = (m) => {
    if (!m) return null;
    const e = [...m.entries()].sort((a, b) => b[1] - a[1]);
    return e.length && (e.length === 1 || e[0][1] > e[1][1]) ? e[0][0] : null;
  };
  const byMo = new Map(), byPart = new Map();
  const add = (map, k, v) => { if (!map.has(k)) map.set(k, new Map()); bump(map.get(k), v); };
  for (const r of recs) {
    const m = r.values.machine;
    if (!m || (r.ctx && r.ctx.machine) || has(r.red, 'machine')) continue;
    if (moOf(r)) add(byMo, moOf(r), m);
    if (r.values.part_number) add(byPart, r.values.part_number, m);
  }
  const dates = new Map();
  for (const r of recs) {
    const d = r.values.date;
    if (!d || typeof d !== 'object' || has(r.red, 'date')) continue;
    const k = `${d.y}-${d.m}-${d.d}`;
    const e = dates.get(k) || [0, d];
    e[0]++;
    dates.set(k, e);
  }
  const dateCands = [...dates.values()].sort((a, b) => b[0] - a[0]).slice(0, 3).map(([, d]) => showValue(d));
  for (const r of recs) {
    const ctx = r.ctx || {};
    if (!Object.keys(ctx).length || (r.human || []).length) continue;
    let notes = String(r.notes || '').split('；').filter(Boolean);
    const put = (prefix, piece) => { notes = notes.filter((n) => !n.startsWith(prefix)); notes.push(piece); };
    r.alts = r.alts || {};
    if (ctx.machine) {
      const { read, guess, cands } = ctx.machine;
      let ev = moOf(r) ? top(byMo.get(moOf(r))) : null;
      let why = ev ? `这批同一个 MO 的单子是 ${ev}` : '';
      if (!ev && r.values.part_number) { ev = top(byPart.get(r.values.part_number)); why = ev ? `这批同一个零件的单子是 ${ev}` : ''; }
      delete r.alts.machine;
      const val = ev || guess;
      if (val) {
        r.values.machine = val;
        r.red = r.red.filter((f) => f !== 'machine');
        r.orange = uniq([...r.orange, 'machine']);
        put('MACHINE ', `MACHINE ${read}→${val}（公司没有 ${read}，${why || '按长得像猜的'}）`);
      } else {
        r.values.machine = read;
        r.orange = r.orange.filter((f) => f !== 'machine');
        r.red = uniq([...r.red, 'machine']);
        put('MACHINE ', `MACHINE ${read} 公司没有这台机` + say(cands));
        if (cands.length) r.alts.machine = [...cands];
      }
    }
    if (ctx.date) {
      put('DATE ', `DATE ${ctx.date.raw} 认不成日期` + say(dateCands));
      delete r.alts.date;
      if (dateCands.length) r.alts.date = dateCands;
    }
    if (ctx.setter) {
      // 同一个 MO 的单子是谁排最前，其次同一个零件的（Song 2026-11-01 3A：MO 本身认错了，还能靠零件对上人）
      const sure = (r2) => r2 !== r && r2.values.setter && !(r2.ctx && r2.ctx.setter) && !has(r2.red, 'setter');
      const partOf = (x) => skel(x.values.part_number || '');
      const byMoMates = recs.filter((r2) => sure(r2) && moOf(r) && moOf(r2) === moOf(r)).map((r2) => r2.values.setter);
      const byPartMates = recs.filter((r2) => sure(r2) && partOf(r) && partOf(r2) === partOf(r)).map((r2) => r2.values.setter);
      const cands = uniq([...byMoMates, ...byPartMates, ...ctx.setter.cands]).slice(0, 4);
      put('SETTER ', ctx.setter.base + say(cands));
      delete r.alts.setter;
      if (cands.length) r.alts.setter = cands;
    }
    r.notes = notes.join('；');
  }
  return rows;
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
  if (!recs.length) { res.error = t('kb.noHead'); return res; }
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
  if (!db.columns.length) return t('tbl.empty', { name });
  const cols = db.columns;
  return t('tbl.sum', { name, n: db.records.length, c: cols.length, cols: list(cols.slice(0, 8)), more: cols.length > 8 ? '…' : '' });
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

// 红格子的候选：几遍认出来的不同写法，名单、机台表、工序表、这批别的单子给的「可能是」。老批次没存候选，就从核对提示里抠出来。
export function altsOf(row, key, cat = BUILTIN) {
  const have = row.alts && row.alts[key];
  if (have && have.length) return [...have];
  const label = cat === BUILTIN ? key.toUpperCase() : key;
  const out = [];
  for (const piece of String(row.notes || '').split('；')) {
    const head = `${label} 几遍认得不一样：`;
    let tail = null;
    if (cat === BUILTIN && piece.startsWith(label + ' ') && piece.includes('可能是：')) tail = piece.split('可能是：')[1];
    else if (piece.startsWith(head)) tail = piece.slice(head.length).split(/[，（]/)[0];
    if (tail === null) continue;
    for (const v of tail.split(' / ').map((x) => x.trim())) if (v && v !== '空' && !out.includes(v)) out.push(v);
  }
  return out;
}

// 人打的字变成表里该有的样子：规矩跟认出来时一样（日期按这批的年份、数字变数字、班次变 D/N、零件号去空格大写）
export function editValue(key, text, { cat = BUILTIN, orig = undefined, today = new Date(), names = [] } = {}) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  if (cat === BUILTIN) {
    if (key === 'date') return parseDate(t, today) || t;
    if (NUM_FIELDS.has(key) || key === 'mo' || key === 'opr_no') { const n = toInt(t); return n === null ? t : n; }
    if (key === 'shift') return normShift(t);
    if (key === 'machine' || key === 'part_number') return t.replace(/\s+/g, '').replace(DASHES, '-').toUpperCase();
    if (key === 't_no' || key === 'description') return t.replace(DIAMETER, 'Φ').toUpperCase();
    if (key === 'setter') {                  // 只打了工号、名单上有这个人：补成「工号/名字」
      const v = t.replace(/\s*\/\s*/g, '/');
      const who = new Map(names.map(([n, nm]) => [String(n), nm]));
      return who.has(v) ? `${v}/${who.get(v)}` : v;
    }
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
export function checkCell(row, key, { text = undefined, cat = BUILTIN, today = new Date(), roster = [], snapshot = null } = {}) {
  const builtin = cat === BUILTIN;
  const keys = builtin ? FIELDS : uniq([...Object.keys(row.values || {}), key]);
  const name = (k) => (builtin ? k.toUpperCase() : k);
  const names = keys.map(name);
  let bad = null;
  if (text !== undefined) {
    const oldT = row.values.total_screened, oldB = row.values.btmp;
    const v = row.values[key] = editValue(key, text, { cat, orig: row.values[key], today, names: roster });
    if (builtin) bad = typedProblem(key, v);
    // BTMP 是照 TOTAL SCREENED 抄的（空着或者跟它一样）：TOTAL 改了它跟着改；单子上真写了别的数就不动
    if (builtin && key === 'total_screened' && (oldB === '' || oldB == null || oldB === oldT)) {
      row.values.btmp = Number.isInteger(v) ? v : '';
    }
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
  // 核对里把调试员改对了：班次照这个人以前的班次再看一遍（班次人没动过、工号也不红了才看；认的时候工号认不出是谁，没法猜）
  if (builtin && key === 'setter' && snapshot && !row.red.includes('setter') && !row.human.includes('shift')) {
    const cur = row.values.shift || '';
    const reads = row.red.includes('shift') ? uniq([cur || '空', ...altsOf(row, 'shift')]) : null;
    const call = snapshot.shiftCall(row.values.setter, row.values.date, cur, reads);
    if (call) {
      row.values.shift = call.v;
      row.red = row.red.filter((f) => f !== 'shift');
      row.orange = uniq([...(row.orange || []), 'shift']);
      notes = notes.filter((n) => noteOwner(n, names) !== 'SHIFT');
      notes.push(call.why);
      if (row.alts) delete row.alts.shift;
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
  if (!n) return t('name.empty');
  if (n.length > 20) return t('name.long', { max: 20 });
  if (/[\\/:*?"<>|\x00-\x1f]/.test(n) || n.endsWith('.')) return t('name.chars');
  if (existing.map((x) => x.toLocaleLowerCase()).includes(n.toLocaleLowerCase())) return t('name.taken', { n });
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
