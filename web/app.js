// 录入僧网页版：页面上的按钮、存取、开工收工（认单子的规矩全在 core.js，跟电脑版一套；界面上的字全在 strings.js）
import './strings.js';
import * as C from './core.js';
import * as SH from './sheets.js';
import * as ST from './store.js';
import * as I from './image.js';
import * as B from './book.js';
import * as F from './fill.js';
import { Engine } from './engine.js';
import * as PR from './pair.js';
import { Inbox } from './inbox.js';

const $ = (s) => document.querySelector(s);
const I18N = globalThis.LURU_I18N;
const t = I18N.t;
const catLabel = (c) => (c === C.BUILTIN ? t('builtin') : c);     // 刀单在英文界面叫 Tool breakage（存的还是「刀单」）
const XLSX_LIB = new URL('./vendor/xlsx.full.min.js', import.meta.url).href;
const JSZIP_LIB = new URL('./vendor/jszip.min.js', import.meta.url).href;
const QR_LIB = new URL('./vendor/qrcode.js', import.meta.url).href;
const CONTACT = ['oilsongchengmin', 'gmail.com'].join('@');
const SETTINGS = ['auto_open', 'remember_keys', 'redo'];          // 字在 strings.js 的 row.<键>、row.<键>.d
const DEFAULTS = { category: C.BUILTIN, model: C.DEFAULT_MODEL, auto: false, auto_open: true, remember_keys: true, redo: false };

const S = {
  st: null, cfg: { ...DEFAULTS }, cats: [], queue: [], seen: new Set(), eng: null, busy: false,
  fresh: 0, feeding: false, run: null,                    // run：正在干的这批（核对里看它，改的格子才不会被盖掉）
  pair: null, inbox: null, phoneWaiting: false,           // 手机传图：配对、收图的长连接、手机传齐了等着开工
  cohandle: null, filling: false,                         // 填进公司表：选过的那本（这回开着页面先用手上这个）、正在填
  shown: null, said: null, finished: false,               // 右边大字、小字现在显示的是哪句（换语言时照这个重写）；finished：大字是「干完：…」
};
const two = (n) => String(n).padStart(2, '0');
const nowIso = () => new Date().toISOString().slice(0, 19);
const localWhen = (iso) => {                       // nowIso 存的是世界时：给人看换成本地的「11-01 12:15」
  const d = new Date(`${iso}Z`);
  return Number.isNaN(d.getTime()) ? String(iso) : `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
};
const TOUCH = matchMedia('(pointer: coarse)').matches;      // 手机、平板：没得拖，左右滑翻页
const EMPTY = () => t(TOUCH ? 'app.dropEmptyTouch' : 'app.dropEmpty');

// ---------------------------------------------------------------- 日志、状态
function log(msg) {
  const box = $('#log');
  const p = document.createElement('p');
  p.textContent = msg;
  if (/^[✗■]/.test(msg)) p.className = 'bad';
  else if (msg.startsWith('⚠')) p.className = 'warn';
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.appendChild(p);
  while (box.childElementCount > 600) box.firstElementChild.remove();
  if (stick) box.scrollTop = box.scrollHeight;
}

function status(key, vars) {                  // 数字（含 4/10 这种）蓝色大字；key 是 strings.js 里的键
  S.shown = [key, vars];
  S.finished = key === 'st.done';
  const text = key ? t(key, vars) : '';
  const el = $('#status');
  el.textContent = '';
  for (const part of String(text).split(/(\d+(?:\/\d+)?)/)) {
    if (!part) continue;
    if (/^\d+(?:\/\d+)?$/.test(part)) { const b = document.createElement('b'); b.textContent = part; el.appendChild(b); } else el.append(part);
  }
  el.style.fontSize = '';                    // 太长就缩小字号（跟电脑版一样），不折行
  let size = parseFloat(getComputedStyle(el).fontSize) || 26;
  while (el.scrollWidth > el.clientWidth + 1 && size > 13) { size -= 1; el.style.fontSize = `${size}px`; }
}
function bar(done, total) { $('#bar').style.width = total ? `${Math.round((100 * done) / total)}%` : '0'; }

// 干活时的进度：认完一张跳一格；两张之间按估的时间慢慢往前爬（最多爬到下一格的九成），让人看着它在干活
const FISH = 'slogan.fish', DONE = 'slogan.done', WOKE = 'slogan.woke';
const M = { total: 0, done: 0, tLast: 0, gaps: [], timer: null };
function slogan(key, vars) { S.said = key ? [key, vars] : null; $('#slogan').textContent = key ? t(key, vars) : ''; }
function meterDraw() { $('#bar').style.width = `${(100 * C.meterFrac(M, Date.now())).toFixed(1)}%`; }
function meterStart(total, done = 0, line = FISH) {      // done：接着干的那批，之前已经干完几张
  phoneSay(t('say.start', { d: done, t: total }), true);
  Object.assign(M, { total, done, tLast: Date.now(), gaps: [] });
  clearInterval(M.timer);
  M.timer = setInterval(meterDraw, 250);
  status('st.pages', { d: done, t: total });
  slogan(line);
  meterDraw();
  if (matchMedia('(max-width: 860px)').matches) {      // 窄屏（手机）：任务状态在下面，自己滚过去给人看
    $('.side').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}
function meterTick(d, total) {
  const now = Date.now();
  if (d > M.done) {                              // 真认完一张：跳一格，等额度那句话也换回摸鱼
    M.gaps.push((now - M.tLast) / (d - M.done)); M.tLast = now; M.done = d;
    slogan(FISH);
  }
  M.total = total;
  status('st.pages', { d, t: total });
  phoneSay(t('say.tick', { d, t: total }));
  meterDraw();
}
function meterStop() { clearInterval(M.timer); M.timer = null; }
function waitLine(wait) {                     // 撞了谷歌的额度在等：告诉人它没死。wait：engine 报来的 {when} 或 {secs}
  if (wait && wait.when) return ['slogan.day', { when: wait.when }];
  if (wait && wait.secs) return ['slogan.sec', { s: wait.secs }];
  return [FISH];
}

function refreshQueue(keepStatus = false) {     // keepStatus：刚干完，右边大字留着「干完：…」
  const n = S.queue.length;
  const drop = $('#drop');
  drop.classList.toggle('has', n > 0);
  $('#clear').hidden = !n || S.busy;
  const names = I18N.list(S.queue.slice(0, 6).map((q) => q.file.name));
  $('#droptxt').textContent = n ? t('app.queue', { n, names, more: n > 6 ? '…' : '' }) : EMPTY();
  if (!S.busy && !keepStatus) { status('st.queue', { n }); bar(0, 0); slogan(''); }
}

// ---------------------------------------------------------------- 设置
async function loadCfg() {                     // -> 这个浏览器以前用过录入僧没有（存过设置）
  const saved = (await S.st.get('kv', 'cfg')) || {};
  S.cfg = { ...DEFAULTS, ...saved };
  return Object.keys(saved).length > 0;
}
let saveTimer = null;
function saveCfg(now = false) {
  S.cfg.model = $('#model').value.trim() || C.DEFAULT_MODEL;
  S.cfg.auto = $('#auto').checked;
  S.cfg.category = $('#cat').value || C.BUILTIN;
  if (S.cfg.remember_keys) { S.cfg.key1 = $('#key1').value.trim(); S.cfg.key2 = $('#key2').value.trim(); }
  else { delete S.cfg.key1; delete S.cfg.key2; }     // 不记钥匙：只在这次开着时有效，不存进浏览器
  clearTimeout(saveTimer);
  const go = () => S.st.put('kv', 'cfg', { ...S.cfg }).catch(() => {});
  if (now) return go();
  saveTimer = setTimeout(go, 400);
  return Promise.resolve();
}

// ---------------------------------------------------------------- 类别、数据库
async function loadCats() {
  const all = await S.st.all('cats');
  all.sort((a, b) => (a[1].created || 0) - (b[1].created || 0) || String(a[0]).localeCompare(String(b[0])));
  S.cats = [C.BUILTIN, ...all.map(([k]) => k).filter((k) => k !== C.BUILTIN)];
}
function fillCats(sel, value) {
  sel.textContent = '';
  for (const c of S.cats) sel.add(new Option(catLabel(c), c));
  sel.value = S.cats.includes(value) ? value : C.BUILTIN;
}
async function kbDb() {
  const kb = (await S.st.get('kv', 'kb')) || { records: [], people: [] };
  kb.lists = kb.lists || {};                    // 机台表、工序表（v1.11 起才有）
  return kb;
}
async function roster() {                      // 名单：名单文本加上数据库里认识的人（核对里 SETTER 只打工号，照这个补名字）
  const names = C.parseNames(await namesText());
  const have = new Set(names.map(([n]) => n));
  for (const [n, nm] of (await kbDb()).people) if (!have.has(n) && !C.isShiftWord(nm)) { have.add(n); names.push([n, nm]); }
  return names;
}
async function catDb(name) { return (await S.st.get('cats', name)) || { columns: [], records: [], created: Date.now() }; }
async function namesText() { return (await S.st.get('kv', 'names')) || ''; }

async function refreshCategory(announce = false) {
  const cat = $('#cat').value;
  let line;
  if (cat === C.BUILTIN) {
    const n = C.parseNames(await namesText()).length;
    const all = (await roster()).length;           // 名单文本 + 样板资料里认识的人：关掉页面再打开，一眼看得出样板资料还在
    $('#cathint').textContent = t('cat.hint.builtin');
    $('#nhead').textContent = all ? t('names.head', { n: all }) : t('names.none');
    $('#npath').textContent = !all ? t('names.noneHint') : n < all ? t('names.fromKb', { n: all - n }) : '';
    $('#names').hidden = false;
    line = C.kbSummary(await kbDb());
  } else {
    const db = await catDb(cat);
    const cols = db.columns, n = db.records.length;
    $('#cathint').textContent = cols.length ? t('cat.hint.cols', { c: cols.length, n }) : t('cat.hint.empty');
    $('#nhead').textContent = cols.length ? t('names.cat', { cat, n }) : t('names.catEmpty', { cat });
    $('#npath').textContent = cols.length ? t('names.cols', { cols: I18N.list(cols) }) : t('names.catEmptyHint');
    $('#names').hidden = true;
    line = C.tableSummary(db, cat);
  }
  if (announce) log(line);
}

// ---------------------------------------------------------------- 照片先存一份（Song 选的 A）
// 选了照片就存进这个浏览器，认完一张存一张结果。手机把页面杀了，重新打开自己接着干：还进同一本表、编号不变，不用重选。
// 原照片存在 photos 里：pending/照片id → {blob, name, type, lastModified, hash, added}，干完就删。
// kv 里的 work：正在干的那一笔 {at, auto, want(编号前：选了哪些), run, items:[{no, qid, hash, name}], stuck}，干完、停了、出错了就删，页面被关了才留着。
const PEND = 'pending/';
const P = { chain: Promise.resolve(), n: 0, d: 0, show: false, warned: false };
const canStash = () => S.st.kind === 'idb' && typeof S.st.prefixed === 'function';

function later(fn) {                          // 一件一件来：手机内存小，几张一起读会闪退
  const p = P.chain.then(fn);
  P.chain = p.catch(() => {});
  return p;
}
function stash(q) {                           // -> Promise：存好了（存不了也算完事）
  if (!canStash()) return Promise.resolve();
  P.n++;
  return later(async () => {
    try {
      if (!S.queue.includes(q)) return;                   // 还没轮到就被清掉了
      const f = q.file, buf = await f.arrayBuffer();
      if (!q.hash) q.hash = await I.sha256(buf);           // 顺手算好指纹，开工查重不用再读一遍
      await S.st.put('photos', PEND + q.id, { blob: new Blob([buf], { type: f.type }), name: f.name, type: f.type,
        lastModified: f.lastModified, hash: q.hash, added: Date.now() });
    } catch (e) {
      if (!P.warned) { P.warned = true; log(t('log.notStashed', { e: e.message })); }
    } finally {
      P.d++;
      if (P.show) status('st.saving', { d: P.d, t: P.n });
      if (P.d >= P.n) P.n = P.d = 0;
    }
  });
}
function unstash(q) { if (canStash()) later(() => S.st.del('photos', PEND + q.id)).catch(() => {}); }
async function stashed() {                    // 开工前等照片都存好：开工以后页面被关，照片也丢不了
  if (!P.n) return;
  P.show = true;
  status('st.saving', { d: P.d, t: P.n });
  try { await P.chain; } finally { P.show = false; }
}

const gone = new Set();                        // 拿回来时发现其实已经干完的（清掉了，不算「没存住」）
const doneSince = (done, added) => (done.ms || Date.parse(`${done.at}Z`) || 0) >= added;   // 账本那条是放进来之后记的（ms：记到毫秒）
async function restore() {                     // 上回选了还没干完的照片：从浏览器里拿回来，不用重选
  if (!canStash()) return 0;
  const all = await S.st.prefixed('photos', PEND).catch(() => []);
  all.sort((a, b) => ((a[1] && a[1].added) || 0) - ((b[1] && b[1].added) || 0));
  let back = 0;
  for (const [key, v] of all) {
    const id = key.slice(PEND.length);
    if (S.seen.has(id)) continue;
    let done = v && v.hash && await S.st.get('ledger', v.hash).catch(() => null);
    if (done && S.cfg.redo && v.added && !doneSince(done, v.added)) done = null;   // 开着重干：放进来之后还没干完的照样拿回来
    if (!v || !(v.blob instanceof Blob) || done) {
      if (done) gone.add(id);
      S.st.del('photos', key).catch(() => {});             // 坏了的，或者其实已经干完了：清掉
      continue;
    }
    const file = new File([v.blob], v.name || 'photo.jpg', { type: v.type || v.blob.type || '', lastModified: v.lastModified || 0 });
    S.seen.add(id);
    S.queue.push({ file, id, hash: v.hash, old: true });
    back++;
  }
  return back;
}

async function grab(tries = 1) {              // 一次只让一个窗口干活：两个窗口一起接着干同一批，表就乱了
  if (!navigator.locks) return () => {};
  for (let i = 0; i < tries; i++) {
    const release = await new Promise((ok) => {
      navigator.locks.request('luruseng-work', { ifAvailable: true }, (lock) => {
        if (!lock) { ok(null); return undefined; }
        return new Promise((done) => ok(done));          // 拿着锁，干完 release() 才放
      }).catch(() => ok(() => {}));                        // 这个浏览器不让用锁：那就不管
    });
    if (release) return release;
    if (i + 1 < tries) await new Promise((r) => setTimeout(r, 1500));   // 刚被关掉的那个窗口还没撒手：等等
  }
  return null;
}

async function wakeUp(back) {                  // 打开页面：上回干到一半被关了，自己接着干；留下的照片说一声
  const w = canStash() ? await S.st.get('kv', 'work').catch(() => null) : null;
  if (!w) { if (back) log(t('log.backLeft', { n: back })); return; }
  if (!$('#key1').value.trim() && !$('#key2').value.trim()) { log(t('log.wokeNoKey')); return; }
  if ((w.stuck || 0) >= 3) { log(t('log.wokeStuck')); return; }
  w.stuck = (w.stuck || 0) + 1;                // 接着干一回记一回；干完一张就清零（一张都干不动才是被哪张照片撑爆了）
  await S.st.put('kv', 'work', w).catch(() => {});
  start(!!w.auto, true);
}

async function clearList() {                   // 清空：照片不要了，上回没干完的那批也不接着干了
  for (const q of S.queue) unstash(q);
  S.queue = [];
  S.seen.clear();
  refreshQueue();
  const release = await grab();                // 别的窗口正在干就别动它那一笔
  if (!release) return;
  try {
    const w = await S.st.get('kv', 'work').catch(() => null);
    if (!w) return;
    await S.st.del('kv', 'work').catch(() => {});
    const r = w.run ? await S.st.get('runs', w.run).catch(() => null) : null;
    if (r && !r.rows.length) await S.st.del('runs', r.id).catch(() => {});
  } finally { release(); }
}

// ---------------------------------------------------------------- 加照片
function addFiles(files) {
  let added = 0, sheets = 0, other = 0;
  for (const f of files) {
    if (!f || !f.size) continue;
    if (!I.isImage(f)) { if (SH.supported(f.name)) sheets++; else other++; continue; }
    const id = `${f.name}|${f.size}|${f.lastModified}`;
    if (S.seen.has(id)) continue;
    S.seen.add(id);
    const q = { file: f, id };
    S.queue.push(q);
    stash(q);                                  // 先存一份：开工后页面被手机杀了，重新打开不用重选
    added++;
    if (S.busy) S.fresh++;
  }
  if (added && canStash()) ST.persist();       // 跟浏览器要「别清」
  if (sheets) log(t('log.sheets', { n: sheets }));
  if (other) log(t('log.notPhotos', { n: other }));
  refreshQueue();
  if (added && S.busy) log(t('log.more', { n: added }));
  if (added && !S.busy && $('#auto').checked) start(true);
}

async function entriesToFiles(items) {        // 拖进来的可能是文件夹：一层层翻出里面的照片
  const out = [];
  const walk = async (entry) => {
    if (!entry) return;
    if (entry.isFile) { out.push(await new Promise((ok) => entry.file(ok, () => ok(null)))); return; }
    if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((ok) => reader.readEntries(ok, () => ok([])));
        if (!batch.length) break;
        for (const e of batch) await walk(e);
      }
    }
  };
  for (const it of items) await walk(it);
  return out.filter(Boolean);
}

function setupDrop() {
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  document.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; document.body.classList.add('dragging'); });
  document.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) document.body.classList.remove('dragging'); });
  document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    document.body.classList.remove('dragging');
    if (e.target.closest && e.target.closest('dialog')) return;     // 拖到小卡片上的，小卡片自己管
    const items = [...(e.dataTransfer.items || [])].map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null));
    const files = items.some(Boolean) ? await entriesToFiles(items) : [...e.dataTransfer.files];
    addFiles(files);
  });
  const pick = () => $('#files').click();
  $('#pick').onclick = pick;
  $('#drop').onclick = (e) => { if (!e.target.closest('#clear')) pick(); };
  $('#drop').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } };
  $('#files').onchange = (e) => { addFiles([...e.target.files]); e.target.value = ''; };
  $('#clear').onclick = (e) => { e.preventDefault(); if (!S.busy) clearList(); };
}

// ---------------------------------------------------------------- 开工
let wake = null;
async function keepAwake(on) {                // 干活时屏幕别黑（手机锁屏就停了）
  try {
    if (on && navigator.wakeLock && !wake && document.visibilityState === 'visible') {
      wake = await navigator.wakeLock.request('screen');
      wake.addEventListener('release', () => { wake = null; });
    } else if (!on && wake) { await wake.release(); wake = null; }
  } catch (e) { wake = null; }
}

function setBusy(on) {
  S.busy = on;
  $('#start').disabled = on;
  $('#stop').disabled = !on;
  $('#clear').hidden = on || !S.queue.length;
  keepAwake(on);
}

let chain = Promise.resolve();
function exclusive(fn) {                       // 一次只开一张大图：手机内存小，几张同时开会闪退
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}
const cache = new Map();                       // 同一张图第一遍、第二遍只打开一次
async function openFor(file, keep) {
  let img = cache.get(file);
  if (!img) img = await I.openImage(file);
  if (keep) cache.set(file, img); else cache.delete(file);
  return img;
}

function runId(d = new Date()) {
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}_${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
}

// 新开一批：干过的照片（改了名也认得出）跳过，剩下的按拍摄顺序排好
async function freshTodo() {
  const todo = [], hashes = new Map(), again = [];
  for (const q of [...S.queue]) {
    if (!q.hash) {
      try { q.hash = await I.sha256(q.file); } catch (e) { log(t('log.unreadable', { name: q.file.name, e: e.message })); continue; }
    }
    const done = await S.st.get('ledger', q.hash);
    if (done && S.cfg.redo && !hashes.has(q.hash)) {   // ⚙「干过的照片也重干」开着（测试用）：照样认
      again.push(q.file.name);
      hashes.set(q.hash, q.file.name);
      todo.push(q);
    } else if (done && !S.cfg.redo) {
      log(t('log.doneBefore', { name: q.file.name, xlsx: done.xlsx || '', no: done.no ?? '?' }));
      drop(q);
    } else if (hashes.has(q.hash)) {
      log(t('log.samePhoto', { name: q.file.name, other: hashes.get(q.hash) }));
      drop(q);
    } else {
      hashes.set(q.hash, q.file.name);
      todo.push(q);
    }
  }
  if (again.length) log(t('log.redoing', { n: again.length, names: I18N.list(again.slice(0, 5)) + (again.length > 5 ? '…' : '') }));
  for (const q of todo) if (q.shot === undefined) q.shot = await I.shotTime(q.file);
  todo.sort((a, b) => a.shot - b.shot || a.file.name.toLowerCase().localeCompare(b.file.name.toLowerCase()));
  return todo;
}

async function rules(cat) {                    // 拿数据库当准绳
  let spec = null, snapshot = null, names = C.parseNames(await namesText()), hints = '', what;
  if (cat === C.BUILTIN) {
    const kb = await kbDb();
    snapshot = kb.records.length || kb.people.length || Object.keys(kb.lists).length ? new C.Snapshot(kb.records, kb.people, kb.lists) : null;
    if (snapshot) {
      hints = snapshot.hints();
      const have = new Set(names.map(([n]) => n));
      names = names.concat(snapshot.roster().filter(([n]) => !have.has(n)));
    }
    log(C.kbSummary(kb));
    what = t('log.what.builtin') + (names.length ? t('log.what.names', { n: names.length }) : t('log.what.noNames'));
  } else {
    const db = await catDb(cat);
    spec = new C.TableSpec(cat, db);
    log(C.tableSummary(db, cat));
    what = t('log.what.cat', { cat }) + (spec.openMode ? t('log.what.open') : t('log.what.cols', { n: spec.columns.length }));
  }
  return { spec, snapshot, names, hints, what };
}

async function newRun(cat, total, spec) {
  const base = runId();                          // 同一秒干两批（照片少、网快）：别把上一批盖掉
  let id = base;
  for (let i = 2; await S.st.get('runs', id); i++) id = `${base}_${i}`;
  return {
    id, cat, at: nowIso(), total, width: Math.max(2, String(total).length), photos: [], rows: [],
    xlsx: t('file.xlsx', { id, cat: cat === C.BUILTIN ? '' : '_' + cat }), columns: spec ? [...spec.columns] : null,
  };
}

// 上回干到一半被关掉的那批：认完的收个尾，没了的记一笔，剩下的接着干（编号不变）
async function reopen(run, work) {
  const byId = new Map(S.queue.map((q) => [q.id, q]));
  const plan = C.resumePlan(work.items, run.rows, (qid) => byId.has(qid));
  const todo = new Set(plan.todo.map((x) => x.no));
  run.rows = run.rows.filter((r) => !(r.left && todo.has(r.no)));      // 停的时候记的「没干完」：这回接着干，先拿掉
  for (const x of plan.done) {                 // 认完了、表也存了，就差记进「干过的」、清掉存的照片
    const q = byId.get(x.qid);
    if (!q) continue;
    if (x.hash) await S.st.put('ledger', x.hash, { file: x.name, no: x.no, xlsx: run.xlsx, at: nowIso(), ms: Date.now() }).catch(() => {});
    drop(q);
  }
  for (const x of plan.lost) {
    C.placeRows(run.rows, [{ no: x.no, kind: 'blank', fill: 'grey', left: true,
      note: `未完成：页面被关的时候这张照片没存住，重新选 ${x.name} 再干` }]);
  }
  return { items: plan.todo.map((x) => { const q = byId.get(x.qid); return { no: x.no, file: q.file, q }; }), lost: plan.lost.length };
}

async function start(auto = false, woke = false) {     // woke：打开页面时发现上回干到一半被关了，自己接着干
  if (S.busy) return;
  const k1 = $('#key1').value.trim(), k2 = $('#key2').value.trim();
  if (!k1 && !k2) { log(t('log.noKey')); return; }
  if (k1 && k1 === k2) { log(t('log.sameKey')); return; }
  setBusy(true);                                 // 马上占住：下面要等，别让人连点两下开出两批
  S.fresh = 0;
  let release = null, mine = false, halted = true, extra = null, eng;
  try {
    release = await grab(woke ? 3 : 1);
    if (!release) { log(t('log.otherTab')); return; }
    const was = await S.st.get('kv', 'work').catch(() => null);
    const prev = was && was.run ? await S.st.get('runs', was.run).catch(() => null) : null;
    if (was && !prev && was.want) {              // 点了开始、照片还没存完页面就被关了：存住的接着干，没存住的点名
      const have = new Set(S.queue.map((q) => q.id));
      const miss = was.want.filter((qid) => !have.has(qid) && !gone.has(qid)).map((qid) => qid.split('|')[0]);
      if (miss.length) log(t('log.lostBefore', { n: miss.length, names: I18N.list(miss.slice(0, 6)), more: miss.length > 6 ? '…' : '' }));
    }
    if (!S.queue.length && !prev) {
      if (was) await S.st.del('kv', 'work').catch(() => {});
      if (!woke) log(t('log.noPhotos'));
      return;
    }
    if (woke && !prev) log(t('log.wokeRestart'));
    else if (auto && !woke) log(t('log.autoGo'));
    await saveCfg(true);
    // 先记一笔「在干活」再等照片存完：存照片、查重、干活的时候页面被关了，重新打开都自己接着干
    const work = prev ? { ...was, at: Date.now(), stuck: woke ? was.stuck || 0 : 0 }
      : { at: Date.now(), auto, stuck: woke ? (was && was.stuck) || 0 : 0, want: S.queue.map((q) => q.id) };
    await S.st.put('kv', 'work', work).catch(() => {});
    mine = true;
    await stashed();

    const model = C.modelName($('#model').value);
    let run, items, todoQ = null, lost = 0;
    if (prev) {
      run = prev;
      if (!woke) {                               // 手动点的开始：上回那批干完，接着干列表里别的照片
        const inRun = new Set(work.items.map((x) => x.qid));
        extra = new Set(S.queue.filter((q) => !inRun.has(q.id)));
      }
      ({ items, lost } = await reopen(run, work));
    } else {
      status('st.dedupe');
      bar(0, 0);
      S.phoneWaiting = false;                    // 手机传齐等着的照片，这一批就带上了
      todoQ = await freshTodo();
      if (!todoQ.length) { log(t('log.nothingNew')); halted = false; return; }
    }
    const cat = run ? run.cat : $('#cat').value;
    const { spec, snapshot, names, hints, what } = await rules(cat);
    if (!run) {
      run = await newRun(cat, todoQ.length, spec);
      items = todoQ.map((q, i) => ({ no: i + 1, file: q.file, q }));
      Object.assign(work, { run: run.id, items: items.map((it) => ({ no: it.no, qid: it.q.id, hash: it.q.hash, name: it.file.name })) });
      delete work.want;                          // 编好号了：往后靠 items 认照片
      await S.st.put('kv', 'work', work).catch(() => {});
      log(t('log.start', { v: C.VERSION, n: run.total, batch: C.BATCH, model, twice: C.READS >= 2 ? t('log.twice') : '', what }));
    } else if (items.length) {
      log(t('log.resume', { why: t(woke ? 'log.resumeWoke' : 'log.resumePrev'), n: items.length, xlsx: run.xlsx, model, what }));
    }
    const { id, total, width } = run;
    S.run = run;
    let saveErr = '';
    const saveRun = async () => {                     // 存这批的表：认完一张存一回
      try { await S.st.put('runs', id, run); saveErr = ''; return true; } catch (e) {
        if (saveErr !== e.message) { saveErr = e.message; log(t('log.cantSave', { e: e.message })); }
        return false;
      }
    };
    await saveRun();

    const base = total - items.length;             // 接着干的：之前已经干完（或者记过）几张
    eng = S.eng = new Engine({
      keys: [k1, k2], model, spec, names, hints,
      log: (m, wait) => { log(m); if (wait) { const [k, v] = waitLine(wait); slogan(k, v); phoneSay(t(k, v), true); } },
      prepare: (file, enhance) => exclusive(async () => I.prepare(await openFor(file, !enhance), enhance)),
      stampIt: (file, no, side) => exclusive(async () => I.stamp(await openFor(file, false), no, side)),
    });
    const tagOf = (no) => String(no).padStart(width, '0');
    const assess = (rec) => {
      if (!spec) return { kind: 'rec', ...C.assessRecord(rec, { snapshot, names }) };
      for (const k of Object.keys(rec)) if (!C.META.has(k) && !run.columns.includes(k)) run.columns.push(k);
      return { kind: 'rec', ...C.assessTableRecord(rec, run.columns, spec.snapshot) };
    };
    let res = null;
    if (items.length) {
      meterStart(total, base, woke ? WOKE : FISH);
      res = await eng.run(items, {
        progress: (d) => meterTick(base + d, total),
        onUnfinished: async (it, why) => {
          C.placeRows(run.rows, [{ no: it.no, kind: 'blank', fill: 'grey', left: true, note: `未完成：${why}（照片还在列表里，再点开始接着干）` }]);
        },
        onPhoto: async (it, recs, err, side, stamped) => {   // 认完一张马上存：表、编号照片、干过的记录，最后清掉存的原照片
          const tag = tagOf(it.no), name = it.file.name;
          if (recs === null) {
            C.placeRows(run.rows, [{ no: it.no, kind: 'blank', fill: 'red', retry: true, note: `✗ 识别失败：${err}（照片还在列表里，再点开始会重干）` }]);
            log(`✗ ${tag} ${name} · ${err}`);
            await saveRun();
            return;
          }
          C.placeRows(run.rows, recs.length ? recs.map((rec) => ({ no: it.no, ...assess(rec) }))
            : [{ no: it.no, kind: 'blank', fill: 'red', note: spec ? `这张照片里没认出「${cat}」的记录` : '这张照片里没认出刀具破损记录' }]);
          if (!spec) C.settle(run.rows);               // 这批里互相看一眼：同一个 MO 的机台、别的单子的日期、同一个 MO 的调试员
          if (stamped) {
            try {
              await S.st.put('photos', `${id}/${it.no}`, stamped);
              if (!run.photos.includes(it.no)) run.photos.push(it.no);
            } catch (e) { log(t('log.stampSave', { tag, e: e.message })); }
          }
          if (!(await saveRun())) return;               // 表没存上：照片先留在列表里，别记成干过
          if (work.stuck) { work.stuck = 0; S.st.put('kv', 'work', work).catch(() => {}); }   // 干动了：诈尸次数清零
          if (it.q.hash) {
            try { await S.st.put('ledger', it.q.hash, { file: name, no: it.no, xlsx: run.xlsx, at: nowIso(), ms: Date.now() }); } catch (e) { log(t('log.ledgerSave', { tag, e: e.message })); }
          }
          drop(it.q);
          log(t('log.ok', { tag, name, n: recs.length }));
        },
        onBatch: saveRun,
      });
      const manual = res.stopped === C.MANUAL_STOP;
      if (res.stopped) log(manual ? t('log.stopped') : t('log.halted', { why: res.stopped }));
      if (res.stopped) phoneSay(manual ? t('say.stopped') : t('say.halt', { why: res.stopped }), true);
    } else if (lost) {
      log(t('log.lostLeft', { n: lost }));
    } else {
      log(t('log.wasDone', { xlsx: run.xlsx }));
    }
    halted = !!(res && res.stopped);
    const tl = C.tally(run.rows), kept = tl.ok + tl.failed > 0;
    if (!kept) await S.st.del('runs', id).catch(() => {});
    else { await saveRun(); S.cfg.lastRun = id; await saveCfg(true); ST.persist(); }   // 有东西了才跟浏览器要「别清」
    if (res) {
      const used = eng.usedLine();
      log(t('log.sum', { mark: !tl.failed && !res.stopped ? '✓' : '⚠', ok: tl.ok, rec: tl.records, bad: tl.failed, req: res.requests,
        used: used ? ' · ' + used : '' }) + (kept ? t('log.sumXlsx', { xlsx: run.xlsx }) : ''));
    }
    meterStop();
    bar(tl.ok + tl.failed, total);
    if (kept) status('st.done', { ok: tl.ok, bad: tl.failed });
    slogan(tl.ok && !halted ? DONE : '');
    if (!halted && res) phoneSay(t('say.done', { ok: tl.ok, bad: tl.failed }), true);
    const more = extra && S.queue.some((q) => extra.has(q));
    if (kept && res && res.ok && !halted && !work.auto && !more && S.cfg.auto_open) openViewer(id);
  } catch (e) {
    log(t('log.crash', { e: `${e.name || 'Error'}: ${e.message}` }));
    console.error(e);
  } finally {
    meterStop();
    cache.clear();
    S.eng = null;
    S.run = null;
    if (mine) await S.st.del('kv', 'work').catch(() => {});   // 这一笔了结了（干完、停了、出错了）；只有页面被关才留着
    if (release) release();
    setBusy(false);
    refreshQueue(S.finished);
    if (extra && !halted && S.queue.some((q) => extra.has(q))) {
      log(t('log.next'));
      setTimeout(() => start(auto), 500);
    } else if (((S.fresh && $('#auto').checked) || (mine && S.phoneWaiting)) && S.queue.length) setTimeout(() => start(true), 500);
  }
}
function drop(q) {                               // 干完了（或者不用干）：从列表里拿掉，存的原照片也清掉
  const i = S.queue.indexOf(q);
  if (i >= 0) S.queue.splice(i, 1);
  S.seen.delete(q.id);
  unstash(q);
}

function halt() {
  if (!S.eng) return;
  S.eng.stop();
  status('st.stopping');
  slogan('');
}

// ---------------------------------------------------------------- 下载
function save(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

async function copyText(text, host) {          // host：开着的对话框（对话框外面的东西点不着，临时框得放在它里面）
  try { await navigator.clipboard.writeText(text); return true; } catch (e) {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    host.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e2) { /* 这个浏览器不让复制 */ }
    ta.remove();
    return ok;
  }
}

async function latestRun() {
  if (S.cfg.lastRun) { const r = await S.st.get('runs', S.cfg.lastRun); if (r) return r; }
  const ids = (await S.st.keys('runs')).sort();
  return ids.length ? S.st.get('runs', ids[ids.length - 1]) : null;
}

async function downloadXlsx(run) {
  try {
    save(await (run.cat === C.BUILTIN ? B.cleanXlsx(run) : B.xlsx(run)), run.xlsx);   // 刀单下载干净的：只有公司那 13 列
    return true;
  } catch (e) {
    log(t('log.xlsxErr', { e: e.message }));
    return false;
  }
}

// ---------------------------------------------------------------- 放入样板资料（Song 定的叫法；说明里不提公司）
async function feed(cat, files) {
  if (S.feeding) return;
  S.feeding = true;
  $('#feed').disabled = true;
  log(t('log.feedStart', { n: files.length, cat: catLabel(cat) }));
  try {
    const loadXLSX = () => I.loadScript(XLSX_LIB, 'XLSX');
    if (cat === C.BUILTIN) {
      const kb = await kbDb();
      for (const f of files) {
        try { log(C.feedLine(C.feedKb(kb, await SH.readSheets(f, loadXLSX), f.name))); } catch (e) { log(t('kb.bad', { src: f.name, why: SH.why(e) })); }
      }
      await S.st.put('kv', 'kb', kb);
      ST.persist();
      log(C.kbSummary(kb));
    } else {
      const db = await catDb(cat);
      for (const f of files) {
        try { log(C.feedLine(C.feedTable(db, await SH.readSheets(f, loadXLSX), f.name))); } catch (e) { log(t('kb.bad', { src: f.name, why: SH.why(e) })); }
      }
      await S.st.put('cats', cat, db);
      ST.persist();
      log(C.tableSummary(db, cat));
    }
  } catch (e) {
    log(t('log.feedErr', { e: `${e.name || 'Error'}: ${e.message}` }));
  } finally {
    S.feeding = false;
    $('#feed').disabled = false;
    refreshCategory();
  }
}

function feedDesc(cat) {
  if (cat === C.BUILTIN) return t('feed.desc.builtin');
  return catDb(cat).then((db) => t('feed.desc.cat', { cat }) +
    (db.columns.length ? t('feed.desc.cols', { cols: I18N.list(db.columns) }) : t('feed.desc.first', { cat })));
}

function setupFeed() {
  const dlg = $('#dlg-feed'), sel = $('#feedcat');
  const describe = async () => { $('#feeddesc').textContent = await feedDesc(sel.value); };
  $('#feed').onclick = () => { fillCats(sel, $('#cat').value); describe(); dlg.showModal(); };
  sel.onchange = describe;
  $('#feednew').onclick = () => { dlg.close(); newCategory((name) => { fillCats(sel, name); describe(); dlg.showModal(); }); };
  $('#feedgo').onclick = () => $('#feedfiles').click();
  const take = (files) => {
    const ok = [...files].filter((f) => f && f.size);
    if (!ok.length) return;
    dlg.close();
    feed(sel.value, ok);
  };
  $('#feedfiles').onchange = (e) => { take(e.target.files); e.target.value = ''; };
  const fd = $('#fdrop');
  fd.ondragover = (e) => { e.preventDefault(); fd.classList.add('over'); };
  fd.ondragleave = () => fd.classList.remove('over');
  fd.ondrop = (e) => { e.preventDefault(); fd.classList.remove('over'); take(e.dataTransfer.files); };
}

// ---------------------------------------------------------------- 新建类别
let afterNew = null;
function newCategory(then = null) {
  afterNew = then;
  $('#newname').value = '';
  $('#newerr').textContent = '';
  $('#dlg-new').showModal();
  setTimeout(() => $('#newname').focus(), 30);
}
function setupNew() {
  $('#newcat').onclick = () => newCategory(null);
  $('#dlg-new form').onsubmit = async (e) => {
    e.preventDefault();
    const name = $('#newname').value.trim();
    const why = C.checkName(name, S.cats);
    if (why) { $('#newerr').textContent = why; return; }
    await S.st.put('cats', name, { columns: [], records: [], created: Date.now() });
    await loadCats();
    $('#dlg-new').close();
    fillCats($('#cat'), name);
    saveCfg();
    refreshCategory(true);
    if (afterNew) afterNew(name);
  };
}

// ---------------------------------------------------------------- 名单
function setupNames() {
  const dlg = $('#dlg-names');
  $('#names').onclick = async () => { $('#namestxt').value = await namesText(); dlg.showModal(); };
  $('#namesload').onclick = () => $('#namesfile').click();
  $('#namesfile').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const text = SH.decode(new Uint8Array(await f.arrayBuffer()));
    const cur = $('#namestxt').value.trim();
    $('#namestxt').value = cur ? `${cur}\n${text.trim()}` : text.trim();
  };
  $('#namesok').onclick = async () => {
    await S.st.put('kv', 'names', $('#namestxt').value.replace(/\r\n/g, '\n').trim());
    dlg.close();
    const n = C.parseNames(await namesText()).length;
    log(n ? t('log.namesSaved', { n }) : t('log.namesEmpty'));
    refreshCategory();
  };
}

// ---------------------------------------------------------------- 设置
function settingsText() {                       // ⚙ 底下的落款、找方丈的话、千手院总舵网址（Song 2026-11-01 给的原话）
  $('#setver').replaceChildren(t('set.ver', { v: C.VERSION }), document.createElement('br'), t('set.sign'));
  const hub = $('#hub').href;
  $('#setcontact').replaceChildren(t('set.contact', { mail: CONTACT }), document.createElement('br'), t('set.hubLine'),
    Object.assign(document.createElement('a'), { href: hub, target: '_blank', rel: 'noopener', textContent: hub.replace(/^https?:\/\//, '').replace(/\/$/, '') }));
}

function mb(n) { return n >= 1048576 ? `${(n / 1048576).toFixed(n >= 1073741824 ? 0 : 1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`; }

function setupSettings() {
  const dlg = $('#dlg-set');
  const rows = $('#setrows');
  for (const key of SETTINGS) {
    const r = document.createElement('label');
    r.className = 'srow';
    r.innerHTML = `<div class="t"></div><span class="switch"><input type="checkbox"><span></span></span>`;
    r.querySelector('.t').append(Object.assign(document.createElement('span'), { textContent: t(`row.${key}`) }),
      Object.assign(document.createElement('div'), { className: 'd', textContent: t(`row.${key}.d`) }));
    r.querySelector('.t span').dataset.i18n = `row.${key}`;          // 换语言时跟着换
    r.querySelector('.t .d').dataset.i18n = `row.${key}.d`;
    const box = r.querySelector('input');
    box.dataset.key = key;
    box.onchange = () => {
      S.cfg[key] = box.checked;
      saveCfg(true);
      if (key === 'redo') log(t(box.checked ? 'log.redoOn' : 'log.redoOff'));
    };
    rows.appendChild(r);
  }
  settingsText();
  const mail = $('#mail');
  mail.title = CONTACT;
  mail.onclick = async (e) => {                 // 方丈邮箱：点一下，邮箱亮在底下、顺手复制好；不去开邮件程序（Song 定的）
    e.preventDefault();
    const ok = await copyText(CONTACT, dlg);
    const note = $('#setnote');
    note.textContent = ok ? t('set.copied', { mail: CONTACT }) : t('set.mailShow', { mail: CONTACT });
    note.classList.add('strong');
  };
  $('#gear').onclick = async () => {
    $('#setnote').textContent = '';
    $('#setnote').classList.remove('strong');
    for (const box of rows.querySelectorAll('input')) box.checked = !!S.cfg[box.dataset.key];
    $('#seterr').textContent = S.st.kind === 'memory' ? t('set.private') : '';
    const u = await ST.usage();
    const kb = await kbDb();
    $('#usage').textContent = t('set.usage', { n: kb.records.length }) + (u ? t('set.usageSize', { size: mb(u[0]) }) : '') +
      t('set.usageTail');
    await companyRow();
    dlg.showModal();
  };
  $('#backup').onclick = async () => {
    const data = await ST.exportBackup(S.st, { version: C.VERSION });
    save(new Blob([JSON.stringify(data)], { type: 'application/json' }), t('log.backupFile', { id: runId() }));
    log(t('log.backup', { n: data.kb.records.length, c: Object.keys(data.cats).length }));
  };
  $('#restore').onclick = () => $('#restorefile').click();
  $('#restorefile').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const out = await ST.importBackup(S.st, JSON.parse(SH.decode(new Uint8Array(await f.arrayBuffer()))));
      await loadCats();
      fillCats($('#cat'), $('#cat').value);
      log(t('log.restored', { r: out.records, p: out.people, c: out.cats, cr: out.catRecords, l: out.ledger, nm: out.names }));
      refreshCategory();
      dlg.close();
    } catch (err) {
      $('#seterr').textContent = t('set.restoreErr', { e: err.message });
    }
  };
}

// ---------------------------------------------------------------- 核对
const V = { runs: [], run: null, nos: [], cur: 0, url: '', rowsByNo: new Map() };

function runLabel(run) {
  const m = run.id.match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})/);
  const when = m ? `${m[2]}-${m[3]} ${m[4]}:${m[5]}` : run.id;
  return t('view.run', { when, n: run.total }) + (run.cat === C.BUILTIN ? '' : ' · ' + run.cat);
}

async function openViewer(id = null) {
  const dlg = $('#dlg-view');
  const ids = (await S.st.keys('runs')).sort().reverse();
  V.runs = ids;
  const sel = $('#vruns');
  sel.textContent = '';
  const has = ids.length > 0;
  $('#vbody').hidden = !has;
  $('#vempty').hidden = has;
  for (const b of ['#vprev', '#vnum', '#vgo', '#vnext', '#vccw', '#vcw', '#vxlsx', '#vfill', '#vzip', '#vcopy', '#vdel', '#vruns']) $(b).disabled = !has;
  for (const rid of ids) {
    const r = await S.st.get('runs', rid);
    sel.add(new Option(r ? runLabel(r) : rid, rid));
  }
  if (!dlg.open) dlg.showModal();
  $('#vphoto').focus({ preventScroll: true });   // 一打开 ←→ 就能翻页（别让下拉框抢了方向键）
  if (has) await loadRun(id && ids.includes(id) ? id : (S.cfg.lastRun && ids.includes(S.cfg.lastRun) ? S.cfg.lastRun : ids[0]));
  else $('#vinfo').textContent = '';
}

async function loadRun(id, start = null) {
  V.run = S.run && S.run.id === id ? S.run : await S.st.get('runs', id);   // 正在干的这批：跟干活的用同一份，改的格子不会被盖掉
  $('#vruns').value = id;
  V.rowsByNo = new Map();
  for (const r of V.run.rows) { if (!V.rowsByNo.has(r.no)) V.rowsByNo.set(r.no, []); V.rowsByNo.get(r.no).push(r); }
  V.nos = [...new Set([...V.run.photos, ...V.rowsByNo.keys()])].sort((a, b) => a - b);
  fillState();
  if (!V.nos.length) {                             // 刚开工，一张还没认完
    V.cur = null;
    $('#vnum').value = '';
    for (const el of ['#vphoto', '#vpanel']) $(el).textContent = '';
    $('#vinfo').textContent = t('view.fresh');
    return;
  }
  await show(start && V.nos.includes(start) ? start : V.nos[0]);
}

async function show(no) {
  V.cur = no;
  $('#vnum').value = no ?? '';
  const n = V.nos.length;
  $('#vinfo').textContent = no ? t('view.pos', { no, n }) + (TOUCH ? t('view.posTouch') : '') : '';
  const box = $('#vphoto');
  box.textContent = '';
  if (V.url) { URL.revokeObjectURL(V.url); V.url = ''; }
  const blob = no ? await S.st.get('photos', `${V.run.id}/${no}`) : null;
  if (blob) {
    V.url = URL.createObjectURL(blob);
    const img = new Image();
    img.src = V.url;
    img.alt = t('view.alt', { no });
    box.appendChild(img);
  } else {
    box.appendChild(Object.assign(document.createElement('div'), { className: 'none', textContent: t('view.noPhoto') }));
  }
  fillPanel(no);
}

function runDay(run) {                             // 这批是哪天认的：改日期时按这批的年份
  const m = String(run.id).match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date();
}

function fillPanel(no) {
  const p = $('#vpanel');
  p.textContent = '';
  const recs = V.rowsByNo.get(no) || [];
  const add = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; el.textContent = text; return el; };
  if (!recs.length) { p.append(add('h3', '', `No. ${no}`), add('div', 'dim', t('view.noRec'))); return; }
  const labels = V.run.cat === C.BUILTIN ? C.FIELDS.map((f) => C.LABEL[f]) : (V.run.columns || []);
  const keys = V.run.cat === C.BUILTIN ? C.FIELDS : (V.run.columns || []);
  recs.forEach((rec, k) => {
    const wrap = add('div', 'rec', '');
    wrap.appendChild(add('h3', '', `No. ${no}` + (recs.length > 1 ? t('view.recN', { k: k + 1 }) : '')));
    if (rec.kind === 'blank') { wrap.appendChild(add('div', 'note', I18N.note(rec.note))); p.appendChild(wrap); return; }
    const dl = document.createElement('dl');
    const red = new Set(rec.red), orange = new Set(rec.orange), human = new Set(rec.human || []);
    keys.forEach((f, i) => {
      const v = C.showValue(rec.values[f]);
      // 换刀调试单上本来就没有 BTMP，表里照抄 TOTAL SCREENED：空着、或者就是那份抄的，核对里不列（不用核两遍）
      if (V.run.cat === C.BUILTIN && f === 'btmp' && (!v || v === C.showValue(rec.values.total_screened))
        && !red.has(f) && !orange.has(f)) return;
      dl.appendChild(add('dt', '', labels[i]));
      const look = red.has(f) ? 'red' : orange.has(f) ? 'fixed' : human.has(f) ? 'human' : '';
      const dd = add('dd', ('edit ' + look).trim(), v || '—');
      dd.tabIndex = 0;                               // 核对时直接改：点哪格改哪格，表跟着改
      dd.setAttribute('role', 'button');
      dd.dataset.k = String(k);
      dd.dataset.f = f;
      dd.title = t('view.editTip');
      dd.onclick = () => openCell(dl, dd, rec, k, f, labels[i]);
      dd.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dd.click(); } };
      dl.appendChild(dd);
    });
    wrap.appendChild(dl);
    if (rec.notes) wrap.appendChild(add('div', rec.notes === C.HUMAN_NOTE ? 'note ok' : 'note', I18N.note(rec.notes)));
    p.appendChild(wrap);
  });
}

// 点开一格：红格子底下列出几遍认出来的不同写法，点一个就填上；也能自己打；认对了点「对的」
function openCell(dl, dd, rec, k, f, label) {
  const open = $('#vpanel').querySelector('.cell-ed');
  if (open) {
    const same = open.dataset.for === `${k}/${f}`;
    open.remove();
    if (same) return;                                // 再点一次：收起
  }
  const builtin = V.run.cat === C.BUILTIN;
  const red = (rec.red || []).includes(f), orange = (rec.orange || []).includes(f);
  const ed = document.createElement('div');
  ed.className = 'cell-ed';
  ed.dataset.for = `${k}/${f}`;
  const input = Object.assign(document.createElement('input'), { className: 'field', value: C.showValue(rec.values[f]) });
  for (const [a, v] of [['autocomplete', 'off'], ['autocorrect', 'off'], ['spellcheck', 'false'], ['autocapitalize', 'characters'],
    ['enterkeyhint', 'done'], ['aria-label', t('view.editAria', { label })]]) input.setAttribute(a, v);
  if (builtin && (C.NUM_FIELDS.has(f) || f === 'mo' || f === 'opr_no')) input.inputMode = 'numeric';
  ed.appendChild(input);
  const alts = red ? C.altsOf(rec, f, V.run.cat) : [];
  if (alts.length) {
    const box = Object.assign(document.createElement('div'), { className: 'alts' });
    for (const a of alts) {
      const b = Object.assign(document.createElement('button'), { type: 'button', className: 'pill alt', textContent: a });
      b.onclick = () => saveCell(rec, k, f, label, a);
      box.appendChild(b);
    }
    ed.appendChild(box);
  }
  const btns = Object.assign(document.createElement('div'), { className: 'btns' });
  if (red || orange) {
    const ok = Object.assign(document.createElement('button'), { type: 'button', className: 'pill', textContent: t('view.right') });
    ok.onclick = () => saveCell(rec, k, f, label, undefined);
    btns.appendChild(ok);
  }
  const save = Object.assign(document.createElement('button'), { type: 'button', className: 'pill primary', textContent: t('view.save') });
  save.onclick = () => saveCell(rec, k, f, label, input.value);
  btns.appendChild(save);
  ed.appendChild(btns);
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveCell(rec, k, f, label, input.value); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); ed.remove(); dd.focus(); }
  };
  dd.after(ed);
  input.focus();
  input.select();
}

async function kbSnapshot() {                   // 拿样板资料当准绳（核对里改了调试员，班次照这个人以前的班次再猜一遍）
  const kb = await kbDb();
  return kb.records.length || kb.people.length ? new C.Snapshot(kb.records, kb.people, kb.lists) : null;
}

async function saveCell(rec, k, f, label, text) {
  const before = C.showValue(rec.values[f]);
  const builtin = V.run.cat === C.BUILTIN;
  const shiftWas = [C.showValue(rec.values.shift), (rec.red || []).includes('shift')];
  C.checkCell(rec, f, { text, cat: V.run.cat, today: runDay(V.run), roster: builtin ? await roster() : [],
    snapshot: builtin && f === 'setter' ? await kbSnapshot() : null });
  const after = C.showValue(rec.values[f]);
  const shiftNow = C.showValue(rec.values.shift);
  const shiftMoved = builtin && f === 'setter' && (rec.orange || []).includes('shift')
    && (shiftNow !== shiftWas[0] || (shiftWas[1] && !(rec.red || []).includes('shift')));
  try { await S.st.put('runs', V.run.id, V.run); } catch (e) { $('#vinfo').textContent = t('view.saveErr', { e: e.message }); return; }
  const still = (rec.red || []).includes(f);
  let msg = still ? t('view.still', { label, v: after || t('empty'), why: I18N.note(rec.notes.split('；').pop()) })
    : text === undefined || after === before ? t('view.checked', { label }) : t('view.changed', { label, v: after || t('empty') });
  if (shiftMoved) msg += t('view.shiftToo', { s: shiftNow, id: C.splitSetter(after)[0] });
  try { if (await feedRow(rec, k)) msg += t('view.fedRow'); } catch (e) { /* 样板资料存不下，不耽误改表 */ }
  fillPanel(rec.no);
  const done = V.run.cat === C.BUILTIN && !fillState();     // 最后一个红格子核完：「填进公司表」变蓝，说一声
  $('#vinfo').textContent = msg + (still ? '' : t('view.sheetToo')) + (done && !still ? t('view.allDone') : '');
}

// 核完的那条（没有红格子、人动过）当样板放进这个类别的数据库；同一条再改，换掉上次那份；又改红了就拿掉
async function feedRow(rec, k) {
  const source = `核对 ${V.run.id} #${rec.no}.${k}`;
  const builtin = V.run.cat === C.BUILTIN;
  const db = builtin ? await kbDb() : await catDb(V.run.cat);
  const had = db.records.some((r) => r.source === source);
  if (!had && !C.isChecked(rec)) return false;
  const added = C.feedChecked(db, rec, { cat: V.run.cat, columns: V.run.columns || [], source });
  if (builtin) await S.st.put('kv', 'kb', db); else await S.st.put('cats', V.run.cat, db);
  await refreshCategory();                           // 左边类别的列数、条数跟着变
  return added;
}

function step(d) {
  if (!V.nos.length) return;
  const i = Math.max(0, V.nos.indexOf(V.cur));
  show(V.nos[Math.max(0, Math.min(V.nos.length - 1, i + d))]);
}

async function ask(title, text, ok) {
  const dlg = $('#dlg-ask');
  $('#asktitle').textContent = title;
  $('#asktext').textContent = text;
  $('#askok').textContent = ok;
  dlg.showModal();
  return new Promise((resolve) => {
    const done = (v) => { dlg.close(); resolve(v); };
    $('#askok').onclick = () => done(true);
    dlg.onclose = () => resolve(false);
    dlg.querySelector('[data-close]').onclick = () => done(false);
  });
}

// ---------------------------------------------------------------- 填进公司表（Song 2026-11-01：1A 直接写进原来那本；没核完提醒一句照样让填；不要标记）
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const BOOK_TYPES = () => [{ description: t('fill.bookType'), accept: { [XLSX_MIME]: ['.xlsx'], 'application/vnd.ms-excel.sheet.macroEnabled.12': ['.xlsm'] } }];
const canWrite = () => typeof window.showOpenFilePicker === 'function' && window.isSecureContext;
const redCount = (run) => run.rows.reduce((n, r) => n + (r.kind === 'rec' ? (r.red || []).length : 0), 0);

function fillState() {                             // 只有刀单有「填进公司表」；全核完了它变成蓝的。返回还有几格红的
  const run = V.run, btn = $('#vfill');
  btn.hidden = !run || run.cat !== C.BUILTIN;
  const reds = run ? redCount(run) : 0;
  btn.classList.toggle('primary', !!run && !reds && run.rows.some((r) => r.kind === 'rec'));
  const f = run && run.filled;
  btn.title = f ? t('fill.title', { when: localWhen(f.at), file: f.file }) : '';
  return reds;
}

async function pickCompany() {                     // 选一回公司那本、记住它：以后点一下就填
  const [h] = await window.showOpenFilePicker({ id: 'company-book', types: BOOK_TYPES(), multiple: false });
  S.cohandle = h;
  await S.st.put('kv', 'cohandle', h);
  await S.st.put('kv', 'coname', h.name);
  return h;
}

async function companyHandle() {                   // 选过的那本：页面开着就用手上这个，关了再开从浏览器里取
  if (!S.cohandle) S.cohandle = await S.st.get('kv', 'cohandle').catch(() => null);
  return S.cohandle;
}

async function forgetCompany() {
  S.cohandle = null;
  await S.st.del('kv', 'cohandle').catch(() => {});
  await S.st.del('kv', 'coname').catch(() => {});
}

async function writable(h) {                       // 跟浏览器要「能改这本」：每次开浏览器头一回它会问一声
  if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
  return (await h.requestPermission({ mode: 'readwrite' })) === 'granted';
}

// 写之前留一份原表，写坏了能退回去（留最近 3 份）；这批填之前记着的样子也留着，退回的时候一起退
async function keepBackup(name, bytes, run) {
  const list = ((await S.st.get('kv', 'cobackups')) || []).slice(0, 2);
  list.unshift({ name, at: nowIso(), bytes, run: run.id, filled: run.filled ? JSON.parse(JSON.stringify(run.filled)) : null });
  await S.st.put('kv', 'cobackups', list);
}

const filledLine = (name, res) => t('fill.done', { name, detail: F.fillLine(res) });
const nothingLine = (name, res) => (res.kept.length ? t('fill.untouched', { name, detail: F.fillLine(res) }) : t('fill.allThere', { name }));

// 这批上回填进同一本时记下的那几行：再填就地改它们，不另起一行（换了一本就当没填过）
function fillMemo(run, name) {
  const f = run.filled;
  return f && f.file === name && Array.isArray(f.placed) ? { before: f.placed, sure: !f.download } : {};
}

async function rememberFill(run, name, res, download) {
  run.filled = { file: name, at: nowIso(), report: res.report, placed: res.placed, download };
  await S.st.put('runs', run.id, run).catch(() => {});
}

async function sureToFill(run) {                   // 没核完：提醒一句，照样让填
  const reds = redCount(run);
  return !reds || ask(t('ask.fill.title', { n: reds }), t('ask.fill.text'), t('ask.fill.ok'));
}

// 能不能改这本。刚选完表那一下，浏览器可能不让接着问「能改吗」（要再点一下才算人点的）：请他再点一下
async function allowed(h, info) {
  try {
    if (await writable(h)) return true;
    info(t('fill.noPerm'));
  } catch (e) {
    if (e.name !== 'SecurityError' && e.name !== 'NotAllowedError') throw e;
    info(t('fill.again', { name: h.name }));
  }
  return false;
}

async function fillCompany(run) {
  if (S.filling) return;
  const info = (t) => { $('#vinfo').textContent = t; };
  if (!run.rows.some((r) => r.kind === 'rec')) { info(t('view.noRecs')); return; }
  if (!(await sureToFill(run))) return;
  S.filling = true;
  $('#vfill').disabled = true;
  try {
    let h = await companyHandle();
    if (!h) { info(t('fill.pickOnce')); h = await pickCompany(); }
    if (!(await allowed(h, info))) return;
    let bytes;
    try { bytes = await (await h.getFile()).arrayBuffer(); } catch (e) {
      if (e.name === 'NotFoundError') {             // 挪了地方、改了名：忘掉它，下回点的时候重新选
        await forgetCompany();
        info(t('fill.gone', { name: h.name }));
      } else info(t('fill.cantRead', { name: h.name, e: e.name }));
      return;
    }
    const JSZip = await I.loadScript(JSZIP_LIB, 'JSZip');
    const res = await F.fillBook(bytes, run.rows, { JSZip, ...fillMemo(run, h.name) });
    if (!res.bytes) { info(nothingLine(h.name, res)); return; }
    await keepBackup(h.name, bytes, run);
    try {
      const w = await h.createWritable();
      await w.write(res.bytes);
      await w.close();
    } catch (e) {
      info(t('fill.cantWrite', { name: h.name, e: e.name }));
      return;
    }
    await rememberFill(run, h.name, res, false);
    info(filledLine(h.name, res));
    log(filledLine(h.name, res) + t('fill.logRun', { run: runLabel(run) }));
  } catch (e) {
    if (e && e.name === 'AbortError') info(t('fill.noPick'));
    else info(t('fill.err', { e: e.message }));
  } finally {
    S.filling = false;
    $('#vfill').disabled = false;
    fillState();
  }
}

async function fillByDownload(run, file) {         // 不能直接改文件的浏览器（手机）：填好的那本下载下来，拿它换掉原来那本
  const info = (t) => { $('#vinfo').textContent = t; };
  if (!(await sureToFill(run))) return;
  try {
    const JSZip = await I.loadScript(JSZIP_LIB, 'JSZip');
    const res = await F.fillBook(await file.arrayBuffer(), run.rows, { JSZip, ...fillMemo(run, file.name) });
    if (!res.bytes) { info(nothingLine(file.name, res)); return; }
    save(new Blob([res.bytes], { type: XLSX_MIME }), file.name);
    await rememberFill(run, file.name, res, true);
    info(t('fill.downloaded', { name: file.name, detail: F.fillLine(res) }));
    log(filledLine(file.name, res) + t('fill.logDl', { run: runLabel(run) }));
  } catch (e) {
    info(t('fill.err', { e: e.message }));
  }
}

async function companyRow() {                      // ⚙ 里「公司表」那一行
  const name = await S.st.get('kv', 'coname').catch(() => null);
  const backups = (await S.st.get('kv', 'cobackups').catch(() => null)) || [];
  $('#corow').hidden = !canWrite();
  $('#coname').textContent = name ? t('set.coName', { name }) : t('set.coNone');
  $('#copick').textContent = name ? t('set.coChange') : t('set.coPick');
  $('#coundo').hidden = !backups.length;
}

function setupCompany() {
  $('#copick').onclick = async () => {
    try { await pickCompany(); } catch (e) { if (e.name !== 'AbortError') $('#seterr').textContent = `✗ ${e.message}`; }
    companyRow();
  };
  $('#coundo').onclick = async () => {
    const [last] = (await S.st.get('kv', 'cobackups')) || [];
    const h = await companyHandle();
    if (!last || !h) return;
    const when = localWhen(last.at);
    if (!(await ask(t('ask.undo.title'), t('ask.undo.text', { name: last.name, when }), t('ask.undo.ok')))) return;
    try {
      if (!(await writable(h))) { $('#seterr').textContent = t('set.undoNoPerm'); return; }
      const w = await h.createWritable();
      await w.write(last.bytes);
      await w.close();
      const rest = ((await S.st.get('kv', 'cobackups')) || []).slice(1);
      await S.st.put('kv', 'cobackups', rest);
      const r = last.run && await S.st.get('runs', last.run).catch(() => null);
      if (r) {                                       // 那批记着的「填在哪几行」也退回填之前：再点「填进公司表」照常填
        if (last.filled) r.filled = last.filled; else delete r.filled;
        await S.st.put('runs', r.id, r);
        if (V.run && V.run.id === r.id) { V.run.filled = r.filled; fillState(); }
      }
      log(t('log.undone', { name: last.name, when }));
      $('#setnote').textContent = t('log.undone', { name: last.name, when });
    } catch (e) {
      $('#seterr').textContent = t('set.undoErr', { e: e.name });
    }
    companyRow();
  };
}

function setupViewer() {
  const dlg = $('#dlg-view');
  $('#check').onclick = () => openViewer();
  $('#vclose').onclick = () => dlg.close();
  dlg.addEventListener('close', () => {             // 关了就清空：下回打开不先闪一下上回那张
    if (V.url) { URL.revokeObjectURL(V.url); V.url = ''; }
    for (const id of ['#vphoto', '#vpanel', '#vinfo']) $(id).textContent = '';
  });
  $('#vruns').onchange = () => loadRun($('#vruns').value);
  $('#vprev').onclick = () => step(-1);
  $('#vnext').onclick = () => step(1);
  const jump = () => {
    const want = $('#vnum').value.trim();
    if (!/^\d+$/.test(want) || !V.nos.includes(+want)) {
      $('#vinfo').textContent = want ? t('view.noSuch', { t: want, a: V.nos[0], b: V.nos[V.nos.length - 1] }) : t('view.typeNo');
      return;
    }
    show(+want);
    $('#vnum').blur();
  };
  $('#vgo').onclick = jump;
  $('#vnum').onkeydown = (e) => { if (e.key === 'Enter') jump(); };
  dlg.addEventListener('keydown', (e) => {
    if (e.target === $('#vnum') || e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); step(-1); }
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); step(1); }
  });
  let sx = null;                                   // 手机上左右滑翻页
  $('#vphoto').addEventListener('touchstart', (e) => { sx = e.touches.length === 1 ? e.touches[0].clientX : null; }, { passive: true });
  $('#vphoto').addEventListener('touchend', (e) => {
    if (sx === null) return;
    const dx = e.changedTouches[0].clientX - sx;
    if (Math.abs(dx) > 60) step(dx < 0 ? 1 : -1);
    sx = null;
  });
  $('#vphoto').onclick = () => { if (V.url) window.open(V.url, '_blank'); };
  $('#vphoto').title = t('view.photoTip');
  const turn = async (cw) => {
    const key = `${V.run.id}/${V.cur}`;
    const blob = await S.st.get('photos', key);
    if (!blob) return;
    try { await S.st.put('photos', key, await I.rotate(blob, cw)); } catch (e) { $('#vinfo').textContent = t('view.rotErr', { e: e.message }); return; }
    show(V.cur);
  };
  $('#vccw').onclick = () => turn(false);
  $('#vcw').onclick = () => turn(true);
  $('#vxlsx').onclick = () => downloadXlsx(V.run);
  $('#vfill').onclick = () => {
    if (!canWrite()) { $('#cofile').value = ''; $('#cofile').click(); return; }   // 手机这类不能直接改文件的：先选表，填好下载
    fillCompany(V.run);
  };
  $('#cofile').onchange = (e) => { const f = e.target.files[0]; if (f) fillByDownload(V.run, f); };
  $('#vcopy').onclick = async () => {
    const [text, n] = B.tsv(V.run);
    if (!n) { $('#vinfo').textContent = t('view.noRecs'); return; }
    await copyText(text, dlg);
    $('#vinfo').textContent = t('view.copied', { n });
  };
  $('#vzip').onclick = async () => {
    const run = V.run;
    $('#vinfo').textContent = t('view.zipping');
    try {
      const JSZip = await I.loadScript(JSZIP_LIB, 'JSZip');
      const zip = new JSZip();
      for (const no of [...run.photos].sort((a, b) => a - b)) {
        const blob = await S.st.get('photos', `${run.id}/${no}`);
        if (blob) zip.file(`${String(no).padStart(run.width || 2, '0')}.jpg`, blob);
      }
      zip.file(run.xlsx, await B.xlsx(run));
      save(await zip.generateAsync({ type: 'blob' }), run.xlsx.replace(/\.xlsx$/, '.zip'));
      $('#vinfo').textContent = t('view.zipped', { n: run.photos.length });
    } catch (e) {
      $('#vinfo').textContent = t('view.zipErr', { e: e.message });
    }
  };
  $('#vdel').onclick = async () => {
    const run = V.run;
    if (S.run && S.run.id === run.id) { $('#vinfo').textContent = t('view.busy'); return; }
    const yes = await ask(t('ask.del.title'), t('ask.del.text', { run: runLabel(run) }), t('ask.del.ok'));
    if (!yes) return;
    for (const no of run.photos) await S.st.del('photos', `${run.id}/${no}`);
    await S.st.del('runs', run.id);
    if (S.cfg.lastRun === run.id) { delete S.cfg.lastRun; saveCfg(true); }
    log(t('log.deleted', { run: runLabel(run) }));
    openViewer();
  };
}

// ---------------------------------------------------------------- 手机传图（扫码配对，照片经中转站过来，收齐了自己开工）
function phoneSay(text, now = false) { if (S.inbox) S.inbox.say(text, now); }

function phoneState(state) {                    // 电脑这头的长连接：连上了没有
  S.phoneState = state;
  const on = state === 'on';
  const text = t(!S.pair ? 'phone.idle' : on ? 'phone.on' : state === 'connecting' ? 'phone.connecting' : 'phone.off');
  for (const [dot, txt] of [['#pdot', '#phinttxt'], ['#pdot2', '#pstate']]) {
    $(dot).classList.toggle('on', on);
    $(txt).textContent = text;
  }
}

async function phoneFile(file, info) {          // 手机传来一张：跟选照片一样进列表、先存进浏览器（存好了才让中转站删）
  const id = `${file.name}|${file.size}|${file.lastModified}`;
  if (S.seen.has(id)) return;
  S.seen.add(id);
  const q = { file, id, phone: info.batch };
  S.queue.push(q);
  if (S.busy) S.fresh++;
  refreshQueue(S.busy || S.finished);
  if (info.seq === 1 || info.seq === info.total) log(t('log.phoneGot', { i: info.seq, n: info.total, name: file.name }));
  await stash(q);
}

function phoneBatch(batch, got, total) {        // 手机这一趟收齐了（或者传到一半两分钟没动静）：开工
  log(got >= total ? t('log.phoneAll', { n: got }) : t('log.phonePart', { got, n: total }));
  S.phoneWaiting = true;
  if (!S.busy) start(true);
}

function phoneJoined() {                       // 手机扫码连上了：二维码自己收起来，不用人点
  const dlg = $('#dlg-phone');
  if (!dlg.open) return;
  dlg.close();
  log(t('log.phoneJoined'));
}

function openInbox() {
  if (S.inbox) S.inbox.close();
  S.inbox = new Inbox(S.pair, { onFile: phoneFile, onBatch: phoneBatch, onState: phoneState, onPhone: phoneJoined, log });
  S.inbox.open();
}

async function drawQr() {
  const box = $('#qr');
  const href = PR.link(location.href, S.pair);
  box.dataset.link = href;
  try {
    const qrcode = await I.loadScript(QR_LIB, 'qrcode');
    const qr = qrcode(0, 'M');
    qr.addData(href);
    qr.make();
    box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 3, scalable: true, alt: t('phone.qrAlt') });
  } catch (e) {
    box.textContent = t('phone.qrErr', { e: e.message });
  }
}

async function newPairing() {
  S.pair = PR.newPair();
  await S.st.put('kv', 'phone', S.pair);
  openInbox();
}

function setupPhone() {
  phoneState('off');
  $('#phone').onclick = async () => {
    if (!PR.valid(S.pair)) await newPairing();
    await drawQr();
    phoneState(S.inbox ? S.inbox.state : 'off');
    $('#dlg-phone').showModal();
  };
  $('#phonenew').onclick = async () => {
    const dlg = $('#dlg-phone');
    dlg.close();
    const yes = await ask(t('ask.qr.title'), t('ask.qr.text'), t('ask.qr.ok'));
    if (yes) { await newPairing(); log(t('log.qrNew')); }
    await drawQr();
    dlg.showModal();
  };
}

// ---------------------------------------------------------------- 语言（右上角 EN / 中文；字全在 strings.js）
function pageText() {                            // 页面上不跟着干活变的字：标题、简介、主屏图标的名字
  I18N.apply(document);
  document.title = t('app.title');
  document.querySelector('meta[name="description"]').content = t('app.desc');
  $('#manifest').href = I18N.lang() === 'zh' ? 'manifest.zh.webmanifest' : 'manifest.webmanifest';
  document.documentElement.classList.remove('i18n-wait');
}

async function relabel() {                       // 换了语言：开着的、显示着的都换一遍（日志里已经写下的不动）
  pageText();
  for (const sel of [$('#cat'), $('#feedcat')]) for (const o of sel.options) o.text = catLabel(o.value);
  refreshQueue(true);
  if (S.shown) status(...S.shown);
  if (S.said) slogan(...S.said);
  phoneState(S.phoneState || 'off');
  settingsText();
  if ($('#dlg-set').open) await companyRow();
  if ($('#dlg-feed').open) $('#feeddesc').textContent = await feedDesc($('#feedcat').value);
  if ($('#dlg-view').open && V.run) {
    for (const o of $('#vruns').options) { const r = await S.st.get('runs', o.value); if (r) o.text = runLabel(r); }
    fillState();
    if (V.cur) await show(V.cur);
  }
  await refreshCategory();
}

// ---------------------------------------------------------------- 开机
async function boot() {
  pageText();
  I18N.toggle($('#lang'));
  S.st = await ST.openStore();
  const used = await loadCfg();
  // 默认英文。没选过语言的头一回打开就定下来、记住：这个浏览器以前用过录入僧（存过设置）的照旧中文
  // （跟电脑版老电脑照旧一个意思），新来的英文。记住以后，下回打开不会因为存过设置又变回中文
  if (!I18N.picked() && !/[?&]lang=/.test(location.search)) { I18N.setLang(used ? 'zh' : 'en'); pageText(); }
  I18N.onChange(() => { relabel().catch((e) => console.error(e)); });
  await loadCats();
  fillCats($('#cat'), S.cfg.category);
  const dl = $('#models');
  for (const m of C.MODELS) dl.appendChild(new Option(m, m));
  $('#model').value = S.cfg.model || C.DEFAULT_MODEL;
  $('#auto').checked = !!S.cfg.auto;
  $('#key1').value = S.cfg.key1 || '';
  $('#key2').value = S.cfg.key2 || '';
  for (const id of ['#key1', '#key2', '#model']) $(id).addEventListener('input', () => saveCfg());
  $('#model').addEventListener('change', () => { $('#model').value = C.modelName($('#model').value); saveCfg(); });
  $('#auto').onchange = () => { saveCfg(); if ($('#auto').checked && S.queue.length && !S.busy) start(true); };
  $('#cat').onchange = () => { saveCfg(); refreshCategory(true); };
  $('#start').onclick = () => start(false);
  $('#stop').onclick = halt;
  $('#result').onclick = async () => {
    const run = await latestRun();
    if (!run) { log(t('log.noResult')); return; }
    if (await downloadXlsx(run)) log(t('log.downloaded', { xlsx: run.xlsx, run: runLabel(run) }));
  };
  for (const d of document.querySelectorAll('dialog')) {
    for (const b of d.querySelectorAll('[data-close]')) if (!b.onclick) b.onclick = () => d.close();
  }
  setupDrop();
  setupFeed();
  setupNew();
  setupNames();
  setupSettings();
  setupViewer();
  setupCompany();
  window.addEventListener('beforeunload', (e) => { if (S.busy) { e.preventDefault(); e.returnValue = ''; } });
  document.addEventListener('visibilitychange', () => { if (S.busy) keepAwake(true); });
  refreshQueue();
  if (S.st.kind === 'memory') log(t('log.private'));
  if (!S.cfg.key1 && !S.cfg.key2) log(t('log.first'));
  await refreshCategory(true);
  const back = await restore();                    // 上回的照片还在浏览器里：放回列表
  if (back) refreshQueue();
  await wakeUp(back);                              // 上回干到一半被关了：自己接着干
  setupPhone();
  const pair = await S.st.get('kv', 'phone').catch(() => null);   // 配过对：挂上长连接等手机传图
  if (PR.valid(pair)) { S.pair = pair; openInbox(); }
}

boot().catch((e) => { log(t('log.bootErr', { e: `${e.name || 'Error'}: ${e.message}` })); console.error(e); });
