// 录入僧网页版：页面上的按钮、存取、开工收工（认单子的规矩全在 core.js，跟电脑版一套）
import * as C from './core.js';
import * as SH from './sheets.js';
import * as ST from './store.js';
import * as I from './image.js';
import * as B from './book.js';
import { Engine } from './engine.js';

const $ = (s) => document.querySelector(s);
const XLSX_LIB = new URL('./vendor/xlsx.full.min.js', import.meta.url).href;
const JSZIP_LIB = new URL('./vendor/jszip.min.js', import.meta.url).href;
const CONTACT = ['oilsongchengmin', 'gmail.com'].join('@');
const SETTINGS = [
  ['auto_open', '干完自动打开核对', '手动点「开始工作」干完后，自动打开核对，点格子就能改'],
  ['remember_keys', '记住钥匙', '钥匙存在这个浏览器里，下次不用再填；公用电脑建议关掉'],
];
const DEFAULTS = { category: C.BUILTIN, model: C.DEFAULT_MODEL, auto: false, auto_open: true, remember_keys: true };

const S = {
  st: null, cfg: { ...DEFAULTS }, cats: [], queue: [], seen: new Set(), eng: null, busy: false,
  fresh: 0, feeding: false, lock: null,
};
const two = (n) => String(n).padStart(2, '0');
const TOUCH = matchMedia('(pointer: coarse)').matches;      // 手机、平板：没得拖，左右滑翻页
const EMPTY = TOUCH ? '还没选照片' : '把照片拖进来，或点右边「选照片」';

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

function status(text) {                       // 数字（含 4/10 这种）蓝色大字
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
const FISH = '你可以去摸鱼了，剩下的交给老衲。';
const DONE = '干完了，你核对就好。';
const M = { total: 0, done: 0, tLast: 0, gaps: [], timer: null };
function slogan(text) { $('#slogan').textContent = text || ''; }
function meterDraw() { $('#bar').style.width = `${(100 * C.meterFrac(M, Date.now())).toFixed(1)}%`; }
function meterStart(total) {
  Object.assign(M, { total, done: 0, tLast: Date.now(), gaps: [] });
  clearInterval(M.timer);
  M.timer = setInterval(meterDraw, 250);
  status(`0/${total} 张`);
  slogan(FISH);
  meterDraw();
  if (matchMedia('(max-width: 860px)').matches) {      // 窄屏（手机）：任务状态在下面，自己滚过去给人看
    $('.side').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}
function meterTick(d, t) {
  const now = Date.now();
  if (d > M.done) { M.gaps.push((now - M.tLast) / (d - M.done)); M.tLast = now; M.done = d; }
  M.total = t;
  status(`${d}/${t} 张`);
  slogan(FISH);
  meterDraw();
}
function meterStop() { clearInterval(M.timer); M.timer = null; }
function waitLine(msg) {                      // 撞了谷歌的额度在等：告诉人它没死
  let m = msg.match(/等到 (\S+ \S+) 额度刷新/);
  if (m) return `今天的免费额度用完了，老衲蹲点等到 ${m[1]} 接着干，这个页面别关。`;
  m = msg.match(/等 (\d+) 秒/);
  return m ? `谷歌喘口气，老衲蹲点等 ${m[1]} 秒，你接着摸。` : FISH;
}

function refreshQueue(keepStatus = false) {     // keepStatus：刚干完，右边大字留着「干完：…」
  const n = S.queue.length;
  const drop = $('#drop');
  drop.classList.toggle('has', n > 0);
  $('#clear').hidden = !n || S.busy;
  const names = S.queue.slice(0, 6).map((q) => q.file.name).join('、');
  $('#droptxt').textContent = n ? `${n} 张：${names}${n > 6 ? '…' : ''}` : EMPTY;
  if (!S.busy && !keepStatus) { status(`待识别 ${n} 张`); bar(0, 0); slogan(''); }
}

// ---------------------------------------------------------------- 设置
async function loadCfg() {
  const saved = (await S.st.get('kv', 'cfg')) || {};
  S.cfg = { ...DEFAULTS, ...saved };
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
  for (const c of S.cats) sel.add(new Option(c, c));
  sel.value = S.cats.includes(value) ? value : C.BUILTIN;
}
async function kbDb() { return (await S.st.get('kv', 'kb')) || { records: [], people: [] }; }
async function catDb(name) { return (await S.st.get('cats', name)) || { columns: [], records: [], created: Date.now() }; }
async function namesText() { return (await S.st.get('kv', 'names')) || ''; }

async function refreshCategory(announce = false) {
  const cat = $('#cat').value;
  let line;
  if (cat === C.BUILTIN) {
    const n = C.parseNames(await namesText()).length;
    $('#cathint').textContent = '内置 · 专属优化';
    $('#nhead').textContent = n ? `名单：${n} 人` : '没有名单';
    $('#npath').textContent = n ? '' : '没有也能用，SETTER 就照单子抄';
    $('#names').hidden = false;
    line = C.kbSummary(await kbDb());
  } else {
    const db = await catDb(cat);
    const cols = db.columns, n = db.records.length;
    $('#cathint').textContent = cols.length ? `自建 · ${cols.length} 列 · ${n} 条记录` : '自建 · 还没放过表';
    $('#nhead').textContent = cols.length ? `「${cat}」数据库：${n} 条` : `「${cat}」还没放过表`;
    $('#npath').textContent = cols.length ? '列：' + cols.join('、') : '先认全部内容，改对了点「放入样板资料」，表头就定成它的列';
    $('#names').hidden = true;
    line = C.tableSummary(db, cat);
  }
  if (announce) log(line);
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
    S.queue.push({ file: f, id });
    added++;
    if (S.busy) S.fresh++;
  }
  if (sheets) log(`✗ ${sheets} 本表格没放进照片里：表格请点「放入样板资料」`);
  if (other) log(`✗ 跳过 ${other} 个不是照片的文件`);
  refreshQueue();
  if (added && S.busy) log(`又来了 ${added} 张：这批干完再干`);
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
  $('#clear').onclick = (e) => { e.preventDefault(); if (S.busy) return; S.queue = []; S.seen.clear(); refreshQueue(); };
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

async function start(auto = false) {
  if (S.busy) return;
  const k1 = $('#key1').value.trim(), k2 = $('#key2').value.trim();
  if (!k1 && !k2) { log('✗ 先填钥匙。还没有？点钥匙框后面的「免费领钥匙」，两分钟的事，一分钱不花'); return; }
  if (k1 && k1 === k2) { log('✗ 两个钥匙填的是同一把（额度按项目算，同一把没意义）'); return; }
  if (!S.queue.length) { log('还没选照片：点「选照片…」，或者把照片拖进来'); return; }
  if (auto) log('▶ 来图就干：照片来了，自己开工');
  await saveCfg(true);
  setBusy(true);
  S.fresh = 0;
  const cat = $('#cat').value, model = C.modelName($('#model').value);
  let eng;
  try {
    status('查重…');
    bar(0, 0);
    // 干过的照片（改了名也认得出）：跳过
    const todo = [], hashes = new Map();
    for (const q of [...S.queue]) {
      if (!q.hash) {
        try { q.hash = await I.sha256(q.file); } catch (e) { log(`✗ ${q.file.name} 读不了：${e.message}`); continue; }
      }
      const done = await S.st.get('ledger', q.hash);
      if (done) {
        log(`↷ ${q.file.name} 以前干过（${done.xlsx || ''} 第 ${done.no ?? '?'} 张），跳过`);
        drop(q);
      } else if (hashes.has(q.hash)) {
        log(`↷ ${q.file.name} 跟 ${hashes.get(q.hash)} 是同一张，跳过`);
        drop(q);
      } else {
        hashes.set(q.hash, q.file.name);
        todo.push(q);
      }
    }
    if (!todo.length) { log('列表里没有新照片，收工。'); return; }
    for (const q of todo) if (q.shot === undefined) q.shot = await I.shotTime(q.file);
    todo.sort((a, b) => a.shot - b.shot || a.file.name.toLowerCase().localeCompare(b.file.name.toLowerCase()));

    // 拿数据库当准绳
    let spec = null, snapshot = null, names = C.parseNames(await namesText()), hints = '', what;
    if (cat === C.BUILTIN) {
      const kb = await kbDb();
      snapshot = kb.records.length || kb.people.length ? new C.Snapshot(kb.records, kb.people) : null;
      if (snapshot) {
        hints = snapshot.hints();
        const have = new Set(names.map(([n]) => n));
        names = names.concat(snapshot.roster().filter(([n]) => !have.has(n)));
      }
      log(C.kbSummary(kb));
      what = '，类别「刀单」' + (names.length ? `，名单 ${names.length} 人` : '，没有名单');
    } else {
      const db = await catDb(cat);
      spec = new C.TableSpec(cat, db);
      log(C.tableSummary(db, cat));
      what = `，类别「${cat}」` + (spec.openMode ? '（还没定列：认全部内容）' : `（${spec.columns.length} 列）`);
    }

    const total = todo.length, width = Math.max(2, String(total).length);
    const base = runId();                          // 同一秒干两批（照片少、网快）：别把上一批盖掉
    let id = base;
    for (let i = 2; await S.st.get('runs', id); i++) id = `${base}_${i}`;
    const run = {
      id, cat, at: new Date().toISOString().slice(0, 19), total, width, photos: [], rows: [],
      xlsx: `识别结果_${id}${cat === C.BUILTIN ? '' : '_' + cat}.xlsx`, columns: spec ? [...spec.columns] : null,
    };
    const items = todo.map((q, i) => ({ no: i + 1, file: q.file, q }));
    log(`▶ 开工（录入僧网页版 v${C.VERSION}）：${total} 张，按拍摄顺序编号 1–${total}，每批 ${C.BATCH} 张，模型 ${model}` +
      (C.READS >= 2 ? '，每张认两遍对答案' : '') + what);

    meterStart(total);
    const elog = (m) => { log(m); if (m.startsWith('⏸')) slogan(waitLine(m)); };
    eng = S.eng = new Engine({
      keys: [k1, k2], model, spec, names, hints, log: elog,
      prepare: (file, enhance) => exclusive(async () => I.prepare(await openFor(file, !enhance), enhance)),
      stampIt: (file, no, side) => exclusive(async () => I.stamp(await openFor(file, false), no, side)),
    });
    const tagOf = (no) => String(no).padStart(width, '0');
    const assess = (rec) => {
      if (!spec) return { kind: 'rec', ...C.assessRecord(rec, { snapshot, names }) };
      for (const k of Object.keys(rec)) if (!C.META.has(k) && !run.columns.includes(k)) run.columns.push(k);
      return { kind: 'rec', ...C.assessTableRecord(rec, run.columns, spec.snapshot) };
    };
    const res = await eng.run(items, {
      progress: meterTick,
      onUnfinished: async (it, why) => {
        run.rows.push({ no: it.no, kind: 'blank', fill: 'grey', note: `未完成：${why}（照片还在列表里，再点开始接着干）` });
      },
      onPhoto: async (it, recs, err, side, stamped) => {
        const tag = tagOf(it.no), name = it.file.name;
        if (recs === null) {
          run.rows.push({ no: it.no, kind: 'blank', fill: 'red', note: `✗ 识别失败：${err}（照片还在列表里，再点开始会重干）` });
          log(`✗ ${tag} ${name} · ${err}`);
          return;
        }
        if (!recs.length) {
          run.rows.push({ no: it.no, kind: 'blank', fill: 'red',
            note: spec ? `这张照片里没认出「${cat}」的记录` : '这张照片里没认出刀具破损记录' });
        }
        for (const rec of recs) run.rows.push({ no: it.no, ...assess(rec) });
        if (stamped) {
          try { await S.st.put('photos', `${id}/${it.no}`, stamped); run.photos.push(it.no); } catch (e) { log(`${tag} 编号照片存不下：${e.message}`); }
        }
        await S.st.put('ledger', it.q.hash, { file: name, no: it.no, xlsx: run.xlsx, at: new Date().toISOString().slice(0, 19) });
        drop(it.q);
        log(`✓ ${tag} ${name} · ${recs.length} 条`);
      },
      onBatch: async () => { try { await S.st.put('runs', id, run); } catch (e) { log(`✗ 结果存不下：${e.message}`); } },
    });
    if (res.stopped) log(res.stopped === '手动停止' ? '■ 已停止，没干完的下次接着干' : `■ 停工：${res.stopped}`);
    const kept = res.ok > 0 || res.failed > 0;
    if (!kept) await S.st.del('runs', id).catch(() => {});
    else { S.cfg.lastRun = id; await saveCfg(true); ST.persist(); }     // 有东西了才跟浏览器要「别清」
    const used = eng.usedLine();
    log(`${!res.failed && !res.stopped ? '✓' : '⚠'} 成功 ${res.ok} 张（${res.records} 条记录）· 失败 ${res.failed} 张 · ` +
      `${res.requests} 次请求${used ? ' · ' + used : ''}` + (kept ? `\n结果：${run.xlsx}（点「下载结果」，或者「核对」里下载）` : ''));
    meterStop();
    bar(res.ok + res.failed, total);
    if (kept) status(`干完：成功 ${res.ok} · 失败 ${res.failed}`);
    slogan(res.ok && !res.stopped ? DONE : '');
    if (kept && res.ok && !res.stopped && !auto && S.cfg.auto_open) openViewer(id);
  } catch (e) {
    log(`✗ 程序出错：${e.name || 'Error'}：${e.message}`);
    console.error(e);
  } finally {
    meterStop();
    cache.clear();
    S.eng = null;
    setBusy(false);
    refreshQueue($('#status').textContent.startsWith('干完'));
    if (S.fresh && $('#auto').checked && S.queue.length) setTimeout(() => start(true), 500);
  }
}
function drop(q) {
  const i = S.queue.indexOf(q);
  if (i >= 0) S.queue.splice(i, 1);
  S.seen.delete(q.id);
}

function halt() {
  if (!S.eng) return;
  S.eng.stop();
  status('正在停…（等手上这几张回来）');
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
    save(await B.xlsx(run), run.xlsx);
    return true;
  } catch (e) {
    log(`✗ 表格出不来：${e.message}`);
    return false;
  }
}

// ---------------------------------------------------------------- 放入样板资料（Song 定的叫法；说明里不提公司）
async function feed(cat, files) {
  if (S.feeding) return;
  S.feeding = true;
  $('#feed').disabled = true;
  log(`开始把 ${files.length} 本表放进「${cat}」的数据库…`);
  try {
    const loadXLSX = () => I.loadScript(XLSX_LIB, 'XLSX');
    if (cat === C.BUILTIN) {
      const kb = await kbDb();
      for (const f of files) {
        try { log(C.feedLine(C.feedKb(kb, await SH.readSheets(f, loadXLSX), f.name))); } catch (e) { log(`✗ ${f.name}：${SH.why(e)}`); }
      }
      await S.st.put('kv', 'kb', kb);
      ST.persist();
      log(C.kbSummary(kb));
    } else {
      const db = await catDb(cat);
      for (const f of files) {
        try { log(C.feedLine(C.feedTable(db, await SH.readSheets(f, loadXLSX), f.name))); } catch (e) { log(`✗ ${f.name}：${SH.why(e)}`); }
      }
      await S.st.put('cats', cat, db);
      ST.persist();
      log(C.tableSummary(db, cat));
    }
  } catch (e) {
    log(`✗ 放入样板资料出错：${e.name || 'Error'}：${e.message}`);
  } finally {
    S.feeding = false;
    $('#feed').disabled = false;
    refreshCategory();
  }
}

function feedDesc(cat) {
  if (cat === C.BUILTIN) {
    return '改对的刀单表，人工录的、录入僧认完改好的都行，一次能塞好几本。\n' +
      'Excel（.xlsx、.xls）、CSV 都行。\n不像刀单的表（没有 DATE、MACHINE 表头）一条都不吃，免得别的单子串进来。';
  }
  return catDb(cat).then((db) => `认完、改对了的「${cat}」结果表（录入僧出的那本就行），可以一次选好几本。\n` +
    `Excel（.xlsx、.xls）、CSV 都行。\n` +
    (db.columns.length ? `现在的列：${db.columns.join('、')}。表里多出来的列会接在后面。` : `第一本的表头会定成「${cat}」的列。`));
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
    log(n ? `✓ 名单存好了：${n} 人` : '名单是空的：没有也能用，SETTER 就照单子抄');
    refreshCategory();
  };
}

// ---------------------------------------------------------------- 设置
function mb(n) { return n >= 1048576 ? `${(n / 1048576).toFixed(n >= 1073741824 ? 0 : 1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`; }

function setupSettings() {
  const dlg = $('#dlg-set');
  const rows = $('#setrows');
  for (const [key, title, desc] of SETTINGS) {
    const r = document.createElement('label');
    r.className = 'srow';
    r.innerHTML = `<div class="t"></div><span class="switch"><input type="checkbox"><span></span></span>`;
    r.querySelector('.t').append(title, Object.assign(document.createElement('div'), { className: 'd', textContent: desc }));
    const box = r.querySelector('input');
    box.dataset.key = key;
    box.onchange = () => { S.cfg[key] = box.checked; saveCfg(true); };
    rows.appendChild(r);
  }
  $('#setver').innerHTML = '';
  $('#setver').append(`录入僧网页版 v${C.VERSION}`, document.createElement('br'), '千手院方丈释手');
  const mail = $('#mail');
  mail.title = CONTACT;
  mail.onclick = async (e) => {                 // 方丈邮箱：点一下，邮箱亮在底下、顺手复制好；不去开邮件程序（Song 定的）
    e.preventDefault();
    const ok = await copyText(CONTACT, dlg);
    const note = $('#setnote');
    note.textContent = ok ? `${CONTACT}　已复制，粘进邮箱找方丈算账` : `方丈邮箱：${CONTACT}`;
    note.classList.add('strong');
  };
  $('#gear').onclick = async () => {
    $('#setnote').textContent = '';
    $('#setnote').classList.remove('strong');
    for (const box of rows.querySelectorAll('input')) box.checked = !!S.cfg[box.dataset.key];
    $('#seterr').textContent = S.st.kind === 'memory' ? '这个浏览器不让存东西（无痕窗口？）：关掉页面数据就没了，记得备份' : '';
    const u = await ST.usage();
    const kb = await kbDb();
    $('#usage').textContent = `数据库 ${kb.records.length} 条` + (u ? ` · 这个浏览器里一共存了 ${mb(u[0])}` : '') +
      '。换电脑、清浏览器之前先备份一份。';
    dlg.showModal();
  };
  $('#backup').onclick = async () => {
    const data = await ST.exportBackup(S.st, { version: C.VERSION });
    save(new Blob([JSON.stringify(data)], { type: 'application/json' }), `录入僧备份_${runId()}.json`);
    log(`✓ 备份下载好了：数据库 ${data.kb.records.length} 条、自建类别 ${Object.keys(data.cats).length} 个（钥匙不在里面）`);
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
      log(`✓ 恢复好了（合并进来，原来的一条没删）：数据库新增 ${out.records} 条、${out.people} 人，` +
        `自建类别新增 ${out.cats} 个、${out.catRecords} 条，干过的照片 ${out.ledger} 张，名单 ${out.names} 行`);
      refreshCategory();
      dlg.close();
    } catch (err) {
      $('#seterr').textContent = `✗ 恢复不了：${err.message}`;
    }
  };
}

// ---------------------------------------------------------------- 核对
const V = { runs: [], run: null, nos: [], cur: 0, url: '', rowsByNo: new Map() };

function runLabel(run) {
  const m = run.id.match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})/);
  const when = m ? `${m[2]}-${m[3]} ${m[4]}:${m[5]}` : run.id;
  return `${when} 这批（${run.total} 张）${run.cat === C.BUILTIN ? '' : ' · ' + run.cat}`;
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
  for (const b of ['#vprev', '#vnum', '#vgo', '#vnext', '#vccw', '#vcw', '#vxlsx', '#vzip', '#vcopy', '#vdel', '#vruns']) $(b).disabled = !has;
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
  V.run = await S.st.get('runs', id);
  $('#vruns').value = id;
  V.rowsByNo = new Map();
  for (const r of V.run.rows) { if (!V.rowsByNo.has(r.no)) V.rowsByNo.set(r.no, []); V.rowsByNo.get(r.no).push(r); }
  V.nos = [...new Set([...V.run.photos, ...V.rowsByNo.keys()])].sort((a, b) => a - b);
  await show(start && V.nos.includes(start) ? start : V.nos[0]);
}

async function show(no) {
  V.cur = no;
  $('#vnum').value = no ?? '';
  const n = V.nos.length;
  $('#vinfo').textContent = no ? `第 ${no} 张 / 共 ${n} 张` + (TOUCH ? ' · 左右滑翻页，点照片看原尺寸' : '') : '';
  const box = $('#vphoto');
  box.textContent = '';
  if (V.url) { URL.revokeObjectURL(V.url); V.url = ''; }
  const blob = no ? await S.st.get('photos', `${V.run.id}/${no}`) : null;
  if (blob) {
    V.url = URL.createObjectURL(blob);
    const img = new Image();
    img.src = V.url;
    img.alt = `第 ${no} 张`;
    box.appendChild(img);
  } else {
    box.appendChild(Object.assign(document.createElement('div'), { className: 'none', textContent: '这一张没有编号照片（没认成）' }));
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
  if (!recs.length) { p.append(add('h3', '', `No. ${no}`), add('div', 'dim', '表里没有这一号的记录。')); return; }
  const labels = V.run.cat === C.BUILTIN ? C.FIELDS.map((f) => C.LABEL[f]) : (V.run.columns || []);
  const keys = V.run.cat === C.BUILTIN ? C.FIELDS : (V.run.columns || []);
  recs.forEach((rec, k) => {
    const wrap = add('div', 'rec', '');
    wrap.appendChild(add('h3', '', `No. ${no}` + (recs.length > 1 ? `　第 ${k + 1} 条` : '')));
    if (rec.kind === 'blank') { wrap.appendChild(add('div', 'note', rec.note)); p.appendChild(wrap); return; }
    const dl = document.createElement('dl');
    const red = new Set(rec.red), orange = new Set(rec.orange), human = new Set(rec.human || []);
    keys.forEach((f, i) => {
      dl.appendChild(add('dt', '', labels[i]));
      const v = C.showValue(rec.values[f]);
      const look = red.has(f) ? 'red' : orange.has(f) ? 'fixed' : human.has(f) ? 'human' : '';
      const dd = add('dd', ('edit ' + look).trim(), v || '—');
      dd.tabIndex = 0;                               // 核对时直接改：点哪格改哪格，表跟着改
      dd.setAttribute('role', 'button');
      dd.dataset.k = String(k);
      dd.dataset.f = f;
      dd.title = '点一下改';
      dd.onclick = () => openCell(dl, dd, rec, k, f, labels[i]);
      dd.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dd.click(); } };
      dl.appendChild(dd);
    });
    wrap.appendChild(dl);
    if (rec.notes) wrap.appendChild(add('div', rec.notes === C.HUMAN_NOTE ? 'note ok' : 'note', rec.notes));
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
    ['enterkeyhint', 'done'], ['aria-label', `改 ${label}`]]) input.setAttribute(a, v);
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
    const ok = Object.assign(document.createElement('button'), { type: 'button', className: 'pill', textContent: '对的' });
    ok.onclick = () => saveCell(rec, k, f, label, undefined);
    btns.appendChild(ok);
  }
  const save = Object.assign(document.createElement('button'), { type: 'button', className: 'pill primary', textContent: '改好了' });
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

async function saveCell(rec, k, f, label, text) {
  const before = C.showValue(rec.values[f]);
  C.checkCell(rec, f, { text, cat: V.run.cat, today: runDay(V.run) });
  const after = C.showValue(rec.values[f]);
  try { await S.st.put('runs', V.run.id, V.run); } catch (e) { $('#vinfo').textContent = `✗ 存不下：${e.message}`; return; }
  const still = (rec.red || []).includes(f);
  let msg = still ? `${label} ${after || '空'} 还不对：${rec.notes.split('；').pop()}`
    : text === undefined || after === before ? `${label} 核过了` : `${label} 改成 ${after || '空'}`;
  try { if (await feedRow(rec, k)) msg += '，这条核完进了样板资料'; } catch (e) { /* 样板资料存不下，不耽误改表 */ }
  fillPanel(rec.no);
  $('#vinfo').textContent = msg + (still ? '' : '，表跟着改了');
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
    const t = $('#vnum').value.trim();
    if (!/^\d+$/.test(t) || !V.nos.includes(+t)) {
      $('#vinfo').textContent = t ? `没有第 ${t} 张（这批是 ${V.nos[0]}–${V.nos[V.nos.length - 1]}）` : '先输入编号';
      return;
    }
    show(+t);
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
  $('#vphoto').title = '点一下看原尺寸；←→ 翻页';
  const turn = async (cw) => {
    const key = `${V.run.id}/${V.cur}`;
    const blob = await S.st.get('photos', key);
    if (!blob) return;
    try { await S.st.put('photos', key, await I.rotate(blob, cw)); } catch (e) { $('#vinfo').textContent = `转不了：${e.message}`; return; }
    show(V.cur);
  };
  $('#vccw').onclick = () => turn(false);
  $('#vcw').onclick = () => turn(true);
  $('#vxlsx').onclick = () => downloadXlsx(V.run);
  $('#vcopy').onclick = async () => {
    const [text, n] = B.tsv(V.run);
    if (!n) { $('#vinfo').textContent = '这批没有认出来的记录'; return; }
    await copyText(text, dlg);
    $('#vinfo').textContent = `复制好了：${n} 行（认失败的不算）。到公司的表里点第一个空格子，粘贴`;
  };
  $('#vzip').onclick = async () => {
    const run = V.run;
    $('#vinfo').textContent = '正在打包…';
    try {
      const JSZip = await I.loadScript(JSZIP_LIB, 'JSZip');
      const zip = new JSZip();
      for (const no of [...run.photos].sort((a, b) => a - b)) {
        const blob = await S.st.get('photos', `${run.id}/${no}`);
        if (blob) zip.file(`${String(no).padStart(run.width || 2, '0')}.jpg`, blob);
      }
      zip.file(run.xlsx, await B.xlsx(run));
      save(await zip.generateAsync({ type: 'blob' }), run.xlsx.replace(/\.xlsx$/, '.zip'));
      $('#vinfo').textContent = `打包好了：编号照片 ${run.photos.length} 张 + 表格`;
    } catch (e) {
      $('#vinfo').textContent = `✗ 打包不了：${e.message}`;
    }
  };
  $('#vdel').onclick = async () => {
    const run = V.run;
    const yes = await ask('删掉这批？', `${runLabel(run)}：表格和编号照片从这个浏览器里删掉，找不回来。要留着的话先点「编号照片」打包下载。\n干过的记录还在，这批照片以后再放进来还是会跳过。`, '删掉');
    if (!yes) return;
    for (const no of run.photos) await S.st.del('photos', `${run.id}/${no}`);
    await S.st.del('runs', run.id);
    if (S.cfg.lastRun === run.id) { delete S.cfg.lastRun; saveCfg(true); }
    log(`删掉了 ${runLabel(run)}`);
    openViewer();
  };
}

// ---------------------------------------------------------------- 开机
async function boot() {
  S.st = await ST.openStore();
  await loadCfg();
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
    if (!run) { log('还没有结果：先选照片，点「开始工作」干一批'); return; }
    if (await downloadXlsx(run)) log(`✓ 下载了 ${run.xlsx}（${runLabel(run)}）。别的批次在「核对」里下载`);
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
  window.addEventListener('beforeunload', (e) => { if (S.busy) { e.preventDefault(); e.returnValue = ''; } });
  document.addEventListener('visibilitychange', () => { if (S.busy) keepAwake(true); });
  refreshQueue();
  if (S.st.kind === 'memory') log('⚠ 这个浏览器不让存东西（无痕窗口？）：这次能用，关掉页面数据库、结果就没了');
  if (!S.cfg.key1 && !S.cfg.key2) log('第一次用：先填钥匙（点「免费领钥匙」看怎么领），再选照片，点「开始工作」。');
  await refreshCategory(true);
}

boot().catch((e) => { log(`✗ 打不开：${e.name || 'Error'}：${e.message}`); console.error(e); });
