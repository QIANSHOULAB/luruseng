// 163 传图页诊断：网址 # 后面带 diag，或者连点大标题 5 下。拍一张（或选一张），几种画法各画一遍，
// 每种给一张小图、标「白 / 不白」，再列出这张照片的底细（名字、大小、EXIF 方向、增益图）。只看不发。
import * as I from './image.js';

const $ = (s) => document.querySelector(s);
const SIDE = 2560, LIMIT = 1_800_000;
const WAYS = [
  ['legacy', '1.13.3 的画法', '<img decoding=async> load 一到就画 → OffscreenCanvas'],
  ['img', 'img 等解码（传图页用这条）', '<img> 等 decode() → 普通 canvas'],
  ['offscreen', 'img 等解码 → Offscreen（网页版认字用这条）', 'openImage() 等 decode() → OffscreenCanvas'],
  ['bitmap', 'ImageBitmap 按方向', "createImageBitmap(file, {imageOrientation:'from-image'})"],
  ['bitmapRaw', 'ImageBitmap 默认', 'createImageBitmap(file)'],
];

async function legacy(file) {                  // 照 1.13.3 的 send.js shrink() 原样走一遍
  const img = await I.legacyImg(file);
  let side = SIDE, q = 0.86, blob, rounds = 0;
  for (;;) {
    rounds++;
    blob = await I.toBlob(I.draw(img, side), q);
    if (blob.size <= LIMIT || side <= 1400) break;
    if (q > 0.62) q -= 0.12; else { side = Math.round(side * 0.8); q = 0.8; }
  }
  return { blob, rounds, nat: `${img.naturalWidth}×${img.naturalHeight}` };
}

async function blobThumb(blob) {
  const b = await createImageBitmap(blob);
  try { return { thumb: I.thumb(b), wh: `${b.width}×${b.height}` }; } finally { if (b.close) b.close(); }
}

function row(name, how) {
  const el = document.createElement('div');
  el.className = 'drow';
  el.innerHTML = '<div class="dimg"></div><div class="dtxt"><b></b> <span class="dv">…</span><div class="dhow"></div><div class="dnum"></div></div>';
  el.querySelector('b').textContent = name;
  el.querySelector('.dhow').textContent = how;
  $('#dout').appendChild(el);
  return el;
}
function fill(el, { thumb, blank, num, err }) {
  const v = el.querySelector('.dv');
  if (err) { v.textContent = '出错'; v.className = 'dv bad'; el.querySelector('.dnum').textContent = err; return; }
  v.textContent = blank ? '白' : '不白';
  v.className = blank ? 'dv bad' : 'dv good';
  if (thumb) { const im = new Image(); im.src = thumb; el.querySelector('.dimg').appendChild(im); }
  el.querySelector('.dnum').textContent = num;
}

const lines = [];
async function run(file) {
  $('#dout').textContent = '';
  lines.length = 0;
  const say = (s) => { lines.push(s); const p = document.createElement('div'); p.className = 'dinfo'; p.textContent = s; $('#dout').appendChild(p); };
  const info = I.jpegInfo(await file.slice(0, 4 << 20).arrayBuffer());
  say(`文件：${file.name || '（没名字）'} · ${(file.size / 1e6).toFixed(2)} MB · ${file.type || '（没类型）'} · 修改时间 ${file.lastModified ? new Date(file.lastModified).toLocaleString() : '无'}`);
  say(info.jpeg ? `JPEG ${info.w}×${info.h} · EXIF 方向 ${info.orient || '无'} · MPF ${info.mpf ? '有' : '无'} · 增益图 ${info.gain.length ? info.gain.join('+') : '无'}`
    : `不是 JPEG（头 ${[...new Uint8Array(await file.slice(0, 12).arrayBuffer())].map((x) => x.toString(16).padStart(2, '0')).join('')}）`);
  say(`${navigator.userAgent}`);
  for (const [way, name, how] of WAYS) {
    const el = row(name, how);
    const t0 = performance.now();
    try {
      let blob, cf = '', extra = '', thumb, wh;
      if (way === 'legacy') {
        const r = await legacy(file);
        blob = r.blob;
        extra = ` · 画了 ${r.rounds} 遍 · img ${r.nat}`;
        ({ thumb, wh } = await blobThumb(blob));
      } else {
        const c = await I.paintWith(way, file, SIDE, info);
        cf = ` 画布 ${I.flatness(c)}`;
        wh = `${c.width}×${c.height}`;
        thumb = I.thumb(c);
        blob = await I.toBlob(c, 0.86);
        c.width = c.height = 1;
      }
      const bf = await I.blobFlatness(blob);
      const blank = bf < I.FLAT;
      const num = `${wh} · ${Math.round(performance.now() - t0)} ms · 平整度 JPG ${bf}${cf} · ${(blob.size / 1e6).toFixed(2)} MB${extra}`;
      fill(el, { thumb, blank, num });
      lines.push(`${name}：${blank ? '白' : '不白'}（${num}）`);
    } catch (e) {
      fill(el, { err: `${e.name || ''} ${e.message || e}` });
      lines.push(`${name}：出错 ${e.message || e}`);
    }
  }
  $('#dcopy').hidden = false;
}

export function open() {
  $('#nopair').hidden = true;
  $('#paired').hidden = true;
  $('#diag').hidden = false;
  $('#dpick').onclick = () => $('#dfile').click();
  $('#dfile').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    $('#dpick').disabled = true;
    try { await run(f); } finally { $('#dpick').disabled = false; }
  };
  $('#dcopy').onclick = async () => {
    try { await navigator.clipboard.writeText(lines.join('\n')); $('#dcopy').textContent = '复制好了'; } catch (e) { $('#dcopy').textContent = '复制不了，截图吧'; }
  };
}
