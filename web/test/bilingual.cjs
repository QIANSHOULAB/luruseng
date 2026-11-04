// 中英两套在真浏览器里各走一遍（v1.11.3）：介绍页、领钥匙页、网页版（选照片 → 开始 → 核对里改一格 → ⚙）、手机传图页。
// 查：默认英文、右上角切了记住、<html lang>/标题/简介跟着换、零报错、英文按钮不被撑破、手机 390 不横向滚动、英文界面没漏中文。
// 截图（手机 390、电脑 1280 × 空状态、结果 × 中英）放 docs/shots-bi/。假的谷歌：页面里拦下请求，回一条刀单记录。
// 跑：node web/test/bilingual.cjs [截图放哪]
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SHOTS = process.argv[2] || path.join(ROOT, 'docs', 'shots-bi');
const CJK = /[一-鿿]/;
const KEEP = ['录入僧', '待识别', '中文', '刀单'];            // 英文界面里允许的中文：文件夹名、语言开关、存着的类别名
const errors = [];
const checks = [];
let failed = 0;
function ok(cond, what) {
  checks.push(what);
  if (!cond) { failed++; console.log(`  ✗ ${what}`); }
}

function serve() {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.png': 'image/png',
    '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.svg': 'image/svg+xml', '.css': 'text/css' };
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

function jpegWidth(b64) {                            // 照片多宽（每张宽度不一样，拿它认是第几张：两遍认的同一张回一样的）
  const b = Buffer.from(b64, 'base64');
  for (let i = 2; i < b.length - 9;) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return b.readUInt16BE(i + 7);
    i += 2 + b.readUInt16BE(i + 2);
  }
  return 0;
}

async function gemini(route) {                       // 假的谷歌：一张一条记录；单号的照片说机台拿不准（标红，核对里有得改）
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
  if (route.request().method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: cors }); return; }
  const body = JSON.parse(route.request().postData() || '{}');
  const part = body.contents[0].parts.find((p) => p.inline_data);
  const no = Math.max(1, (jpegWidth(part.inline_data.data) % 10) + 1);
  const rec = { date: '28/10', machine: 'VM-07', part_number: 'TD-524613-5', mo: String(82664580 + no), opr_no: '150', t_no: `T${no + 3}`,
    description: 'EM2.5', btmp: '1', total_screened: '1', passed: '1', failed: '0', shift: 'D', setter: '639/Lee Ah Kow',
    unsure: no % 2 ? ['machine'] : [] };
  const text = JSON.stringify({ title_side: 'top', records: [rec] });
  await route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' },
    body: JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] }) });
}

async function offline(ctx) {                        // 别的外网一概不碰；GitHub 查版本给个假的
  await ctx.route('https://**', (r) => r.abort());
  await ctx.route('https://api.github.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ name: '录入僧 v1.11.3（build 99）', published_at: '2026-11-04T08:00:00Z', assets: [{ name: 'luruseng.exe', size: 31457280 }] }) }));
  await ctx.route('https://generativelanguage.googleapis.com/**', gemini);
}

function watch(page, tag) {
  page.on('pageerror', (e) => errors.push(`${tag} pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED/.test(m.text())) errors.push(`${tag} console: ${m.text()}`); });
}

async function photos(page, n) {                     // 画几张像单子的照片（宽度各不一样）
  const out = [];
  for (let i = 0; i < n; i++) {
    const b64 = await page.evaluate(async (i) => {
      const c = document.createElement('canvas');
      c.width = 900 + i; c.height = 650;
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = '#222'; g.font = 'bold 34px sans-serif'; g.fillText('TOOL REQUEST FORM', 60, 70);
      g.font = '24px sans-serif';
      ['M/C No.  VM-07', 'Part Number  TD-524613-5', `MO Number  ${82664581 + i}`, 'Opr No.  150', 'Setter  639'].forEach((t, k) => g.fillText(t, 60, 150 + k * 70));
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (let k = 0; k < buf.length; k += 0x8000) s += String.fromCharCode(...buf.subarray(k, k + 0x8000));
      return btoa(s);
    }, i);
    out.push({ name: `form_${i + 1}.jpg`, mimeType: 'image/jpeg', buffer: Buffer.from(b64, 'base64') });
  }
  return out;
}

async function layout(page, lang, where) {           // 不横向滚动；能看见的按钮字都放得下；英文界面没漏中文
  const r = await page.evaluate(({ lang, KEEP }) => {
    const vis = (el) => { const s = getComputedStyle(el); const b = el.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && b.width > 0 && b.height > 0; };
    const out = { scroll: document.documentElement.scrollWidth - innerWidth, clipped: [], chinese: [], lang: document.documentElement.lang };
    for (const el of document.querySelectorAll('button, .pill, a.dl, a.web, .lang button')) {
      if (!vis(el) || el.closest('dialog:not([open])')) continue;
      if (el.scrollWidth > el.clientWidth + 1) out.clipped.push(el.textContent.trim().slice(0, 40));
    }
    if (lang === 'en') {
      const sel = 'button, label, h1, h2, h3, .hint, .foot, .sub, .tag, #status, #slogan, #cathint, #nhead, #npath, #vinfo, .para, .d, .t, .lead, .card p, .facts li, footer, .tip, .st, .pc, .snote, .contact, .left, .empty';
      for (const el of document.querySelectorAll(sel)) {
        if (!vis(el) || el.closest('dialog:not([open])') || el.closest('#vpanel')) continue;
        let t = el.innerText || '';
        for (const k of KEEP) t = t.split(k).join('');
        if (/[一-鿿]/.test(t)) out.chinese.push(t.slice(0, 60));
      }
    }
    return out;
  }, { lang, KEEP });
  ok(r.scroll <= 0, `${where}: no horizontal scroll (${r.scroll})`);
  ok(!r.clipped.length, `${where}: buttons fit ${JSON.stringify(r.clipped)}`);
  ok(!r.chinese.length, `${where}: no stray Chinese ${JSON.stringify(r.chinese.slice(0, 5))}`);
  ok(r.lang === (lang === 'zh' ? 'zh-CN' : 'en'), `${where}: <html lang> is ${r.lang}`);
}

async function shot(page, name) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(SHOTS, name) });
}

async function webRun(ctx, base, lang, w) {           // 网页版：空着 → 选照片开始 → 核对里改一格 → ⚙
  const page = await ctx.newPage();
  watch(page, `web-${w}-${lang}`);
  await page.goto(`${base}web/`);
  await page.waitForFunction(() => document.querySelectorAll('#log p').length >= 2);
  const head = await page.evaluate(() => ({ title: document.title, desc: document.querySelector('meta[name=description]').content,
    start: document.querySelector('#start').innerText.trim(), mani: document.querySelector('#manifest').getAttribute('href') }));
  ok(lang === 'en' ? head.title === 'Luru Web · Photo Typist' && head.start === 'Start' && head.mani === 'manifest.webmanifest'
    : head.title.startsWith('录入僧网页版') && head.start === '开始工作' && head.mani === 'manifest.zh.webmanifest', `web ${w} ${lang}: title/meta/manifest/buttons in ${lang} (${head.title} | ${head.start})`);
  ok(lang === 'en' ? !CJK.test(head.desc) : CJK.test(head.desc), `web ${w} ${lang}: meta description in ${lang}`);
  await layout(page, lang, `web ${w} ${lang} empty`);
  await shot(page, `web-${w}-empty-${lang}.png`);

  await page.fill('#key1', 'AIzaMOCK_bilingual');
  await page.setInputFiles('#files', await photos(page, w === 1280 ? 3 : 2));
  await page.click('#start');
  await page.waitForSelector('#dlg-view[open]', { timeout: 60000 });
  await page.waitForFunction(() => !document.querySelector('#start').disabled, null, { timeout: 60000 });
  await page.waitForSelector('#vpanel dd.red');
  await layout(page, lang, `web ${w} ${lang} review`);
  await shot(page, `web-${w}-result-${lang}.png`);
  await page.click('#vpanel dd.red');
  const before = await page.innerText('#vinfo');
  await page.click('#vpanel .cell-ed .btns .pill:not(.primary)');    // 「对的」/ Correct
  await page.waitForFunction((b) => document.querySelector('#vinfo').innerText !== b, before);
  const info = await page.innerText('#vinfo');
  ok(lang === 'en' ? /confirmed/.test(info) && !CJK.test(info) : /核过了/.test(info), `web ${w} ${lang}: confirming a red cell says so (${info})`);
  await page.click('#vclose');
  const status = await page.innerText('#status');
  ok(lang === 'en' ? /^Done: \d+ ok · \d+ failed$/.test(status.replace(/\n/g, '')) : /^干完：成功/.test(status), `web ${w} ${lang}: status (${status.replace(/\n/g, '')})`);
  await layout(page, lang, `web ${w} ${lang} done`);
  if (w === 1280) {
    await shot(page, `web-1280-done-${lang}.png`);
    await page.click('#gear');
    await page.waitForSelector('#dlg-set[open]');
    const set = await page.innerText('#dlg-set');
    ok(lang === 'en' ? /Remember keys/.test(set) && /carrier pigeon/.test(set) : /记住钥匙/.test(set) && /飞鸽传书/.test(set), `web ${lang}: settings text`);
    await layout(page, lang, `web ${lang} settings`);
    await shot(page, `web-1280-settings-${lang}.png`);
    await page.keyboard.press('Escape');
  }
  return page;
}

async function landing(ctx, base, lang, w) {
  const page = await ctx.newPage();
  watch(page, `site-${w}-${lang}`);
  await page.goto(base);
  await page.waitForFunction(() => !document.documentElement.classList.contains('i18n-wait'));
  const t = await page.evaluate(() => ({ title: document.title, h1: document.querySelector('h1').innerText, sub: document.querySelector('.tagline').innerText,
    desc: document.querySelector('meta[name=description]').content, ver: document.querySelector('#ver').innerText }));
  ok(lang === 'en' ? t.title === 'Luru · Photo Typist' && t.h1 === 'Luru · Photo Typist' && t.sub === 'Snap the forms. Skip the typing.' && !CJK.test(t.desc)
    : t.h1 === '录入僧' && t.sub === '施主去玩，贫僧填表' && CJK.test(t.desc), `site ${w} ${lang}: name, subtitle, title, description (${t.title})`);
  ok(/v1\.11\.3/.test(t.ver) && (lang === 'en' ? /updated 2026-11-04/.test(t.ver) : /2026-11-04 更新/.test(t.ver)), `site ${lang}: version line (${t.ver})`);
  await layout(page, lang, `site ${w} ${lang}`);
  await shot(page, `site-${w}-${lang}.png`);
  const key = await ctx.newPage();
  watch(key, `key-${w}-${lang}`);
  await key.goto(`${base}key.html`);
  await key.waitForFunction(() => !document.documentElement.classList.contains('i18n-wait'));
  const kt = await key.evaluate(() => document.title);
  ok(lang === 'en' ? kt === 'Get a free API key · Luru' : kt === '免费领取钥匙 · 录入僧', `key ${w} ${lang}: title (${kt})`);
  await layout(key, lang, `key ${w} ${lang}`);
  if (w === 390) await shot(key, `key-390-${lang}.png`);
  await key.close();
  return page;
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const srv = await serve();
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch();
  try {
    for (const lang of ['en', 'zh']) {
      console.log(`— ${lang}`);
      const desk = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'zh-CN' });   // 中文浏览器：照样默认英文
      const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'zh-CN' });
      for (const c of [desk, phone]) await offline(c);
      const site = await landing(desk, base, 'en', 1280);              // 没选过：英文，哪怕浏览器是中文
      if (lang === 'zh') {                                               // 右上角点「中文」：马上换，再打开还是中文
        await site.click('.lang button[data-lang=zh]');
        const now = await site.evaluate(() => [document.documentElement.lang, document.title, localStorage.getItem('luruseng.lang')]);
        ok(now[0] === 'zh-CN' && now[1].startsWith('录入僧') && now[2] === 'zh', `toggle → 中文 switches and remembers (${now})`);
        await site.reload();
        await site.waitForFunction(() => !document.documentElement.classList.contains('i18n-wait'));
        ok((await site.evaluate(() => document.documentElement.lang)) === 'zh-CN', 'reload stays 中文');
        await phone.addInitScript(() => { try { localStorage.setItem('luruseng.lang', 'zh'); } catch (e) { /* */ } });
        await landing(desk, base, 'zh', 1280);
      }
      await site.close();
      await landing(phone, base, lang, 390);
      await webRun(desk, base, lang, 1280);
      await webRun(phone, base, lang, 390);
      const send = await phone.newPage();                               // 手机传图页（没配对）
      watch(send, `send-${lang}`);
      await send.goto(`${base}web/send.html`);
      await send.waitForSelector('#nopair:not([hidden])');
      const st = await send.innerText('#nopair');
      ok(lang === 'en' ? /Not paired yet/.test(st) : /还没配对/.test(st), `send ${lang}: unpaired text`);
      await layout(send, lang, `send 390 ${lang}`);
      await shot(send, `send-390-${lang}.png`);
      if (lang === 'en') {                                               // 网页版右上角也能切，切了记住
        const p = await desk.newPage();
        watch(p, 'web-toggle');
        await p.goto(`${base}web/`);
        await p.waitForFunction(() => document.querySelectorAll('#log p').length >= 1 && document.querySelector('#cathint').textContent);
        await p.click('.lang button[data-lang=zh]');
        await p.waitForFunction(() => document.querySelector('#start').innerText.trim() === '开始工作');
        ok((await p.evaluate(() => [document.title.startsWith('录入僧'), localStorage.getItem('luruseng.lang')])).join() === 'true,zh', 'web toggle → 中文 switches title and remembers');
        await p.click('.lang button[data-lang=en]');
        await p.waitForFunction(() => document.querySelector('#start').innerText.trim() === 'Start');
        await p.close();
      }
      await desk.close();
      await phone.close();
    }
  } finally {
    await browser.close();
    srv.close();
  }
  ok(!errors.length, `zero page errors ${JSON.stringify(errors.slice(0, 5))}`);
  console.log(failed ? `✗ ${failed} of ${checks.length} checks failed` : `全过：${checks.length} checks · shots in ${SHOTS}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
