// 照片：读进来、缩小、第二遍拉对比度锐化、算指纹、按标题转正、印编号（跟电脑版 engine.prepare_image / stamp_number 一个意思）
import { MAX_SIDE, JPEG_Q, exifTime } from './core.js';
import './strings.js';

const t = (k, v) => globalThis.LURU_I18N.t(k, v);

export const STAMP_SIDE = 2560;            // 编号照片最长边（够放大看手写）
export const IMG_RE = /\.(jpe?g|png|webp|heic|heif|bmp|gif|tiff?|avif)$/i;
const HEIC_LIB = new URL('./vendor/heic2any.min.js', import.meta.url).href;

export function isImage(file) {
  return (file.type && file.type.startsWith('image/')) || IMG_RE.test(file.name || '');
}
function looksHeic(file, head) {
  if (/\.(heic|heif)$/i.test(file.name || '') || /heic|heif/i.test(file.type || '')) return true;
  const brand = String.fromCharCode(...head.slice(8, 12));
  return String.fromCharCode(...head.slice(4, 8)) === 'ftyp' && /^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(brand);
}

let libs = {};
export function loadScript(src, global) {
  if (globalThis[global]) return Promise.resolve(globalThis[global]);
  if (!libs[src]) {
    libs[src] = new Promise((ok, bad) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => (globalThis[global] ? ok(globalThis[global]) : bad(new Error(t('img.libMissing', { g: global }))));
      s.onerror = () => { delete libs[src]; bad(new Error(t('img.libOffline', { f: src.split('/').pop() }))); };
      document.head.appendChild(s);
    });
  }
  return libs[src];
}

async function imgFrom(blob) {
  // 163：iPhone 的 Safari 上，decoding='async' 的大图 load 一到就画，还没解完码，画出来整张白（模拟器里复现了）。
  // 现在 load 完再等 decode()；页面看不见时（锁屏、切后台）decode() 可能一直不回来，最多等 4 秒（看不见时 1 秒），过了照画。
  // <img> 按 EXIF 方向转正（跟电脑版 exif_transpose 一样）。网址等这张图没人用了再收（画之前收掉，Safari 可能重解码时拿不到）
  const url = URL.createObjectURL(blob);
  const img = new Image();
  try {
    await new Promise((ok, bad) => { img.onload = () => ok(); img.onerror = () => bad(new Error(t('img.cantOpen'))); img.src = url; });
  } catch (e) { URL.revokeObjectURL(url); throw e; }
  if (img.decode) await Promise.race([img.decode().catch(() => {}), sleep(document.hidden ? 1000 : 4000)]);
  if (urls) urls.register(img, url); else setTimeout(() => URL.revokeObjectURL(url), 60000);
  return img;
}
const urls = typeof FinalizationRegistry === 'function' ? new FinalizationRegistry((u) => URL.revokeObjectURL(u)) : null;

async function imgFromOld(blob) {                 // 1.13.3 的原样（诊断页对照用）：load、decode 谁先到用谁
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    const loaded = new Promise((ok, bad) => { img.onload = () => ok(); img.onerror = () => bad(new Error(t('img.cantOpen'))); });
    img.src = url;
    const decoded = img.decode();
    for (const p of [loaded, decoded]) p.catch(() => {});
    await Promise.race([loaded, decoded]);
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

// 打开一张照片 -> 能画的东西（<img>）。HEIC 浏览器自己不认（除了苹果的 Safari），就现借个解码器转成 JPG
export async function openImage(file) {
  try {
    return await imgFrom(file);
  } catch (e) {
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    if (!looksHeic(file, head)) throw new Error(t('img.notPhoto'));
    let heic2any;
    try { heic2any = await loadScript(HEIC_LIB, 'heic2any'); } catch (err) { throw new Error(t('img.heicLib')); }
    let out;
    try { out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.95 }); } catch (err) { throw new Error(t('img.heicBad')); }
    return imgFrom(Array.isArray(out) ? out[0] : out);
  }
}

function sizeOf(img) { return [img.naturalWidth || img.width, img.naturalHeight || img.height]; }

export function canvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined' && !globalThis.__noOffscreen) return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

export function draw(img, side) {           // 缩到最长边 side，透明的地方垫白底
  const [w, h] = sizeOf(img);
  const s = Math.min(1, side / Math.max(w, h));
  const W = Math.max(1, Math.round(w * s)), H = Math.max(1, Math.round(h * s));
  const c = canvas(W, H);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, W, H);
  return c;
}

export async function toBlob(c, q) {
  if (c.convertToBlob) return c.convertToBlob({ type: 'image/jpeg', quality: q });
  return new Promise((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error(t('img.cantSave')))), 'image/jpeg', q));
}

export function b64(blob) {
  return new Promise((ok, bad) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(',')[1] || '');
    r.onerror = () => bad(r.error);
    r.readAsDataURL(blob);
  });
}

// ---------------------------------------------------------------- 第二遍用的图：拉对比度（掐掉两头各 1%）+ 锐化一点
export function autocontrast(d) {
  const n = d.length / 4, cut = Math.floor(n * 0.01);
  for (let ch = 0; ch < 3; ch++) {
    const h = new Uint32Array(256);
    for (let i = ch; i < d.length; i += 4) h[d[i]]++;
    let lo = 0, hi = 255, acc = 0;
    for (; lo < 255; lo++) { acc += h[lo]; if (acc > cut) break; }
    acc = 0;
    for (; hi > 0; hi--) { acc += h[hi]; if (acc > cut) break; }
    if (hi <= lo) continue;
    const lut = new Uint8ClampedArray(256), sc = 255 / (hi - lo);
    for (let v = 0; v < 256; v++) lut[v] = (v - lo) * sc;
    for (let i = ch; i < d.length; i += 4) d[i] = lut[d[i]];
  }
}

function boxBlur(src, dst, w, h, r, horizontal) {
  const len = horizontal ? w : h, lines = horizontal ? h : w;
  const step = horizontal ? 4 : w * 4, span = 2 * r + 1;
  for (let ln = 0; ln < lines; ln++) {
    const base = horizontal ? ln * w * 4 : ln * 4;
    for (let ch = 0; ch < 3; ch++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += src[base + Math.min(len - 1, Math.max(0, k)) * step + ch];
      for (let i = 0; i < len; i++) {
        dst[base + i * step + ch] = sum / span;
        const out = Math.max(0, i - r), inn = Math.min(len - 1, i + r + 1);
        sum += src[base + inn * step + ch] - src[base + out * step + ch];
      }
    }
  }
}

export function unsharp(d, w, h, percent = 80, threshold = 3) {   // 高斯模糊半径 2 ≈ 三次方框模糊（1、1、2）
  let a = new Float32Array(d), b = new Float32Array(d.length);
  for (const r of [1, 1, 2]) {
    boxBlur(a, b, w, h, r, true);
    boxBlur(b, a, w, h, r, false);
  }
  const k = percent / 100;
  for (let i = 0; i < d.length; i++) {
    if ((i & 3) === 3) continue;
    const diff = d[i] - a[i];
    if (Math.abs(diff) > threshold) d[i] = d[i] + diff * k;
  }
}

// 送去认的那份：最长边 2048 的 JPG（base64）。enhance=true 是第二遍用的，让两遍看到的不完全一样，错不到一块去
export async function prepare(img, enhance = false) {
  const c = draw(img, MAX_SIDE);
  if (enhance) {
    const ctx = c.getContext('2d');
    const im = ctx.getImageData(0, 0, c.width, c.height);
    autocontrast(im.data);
    unsharp(im.data, c.width, c.height);
    ctx.putImageData(im, 0, 0);
  }
  return b64(await toBlob(c, JPEG_Q));
}

// ---------------------------------------------------------------- 指纹、拍摄时间
export async function sha256(file) {             // 照片，或者已经读出来的 ArrayBuffer
  const buf = await crypto.subtle.digest('SHA-256', file instanceof ArrayBuffer ? file : await file.arrayBuffer());
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export async function shotTime(file) {       // 先看照片里的 EXIF（拍照那一刻），没有就用文件时间
  try {
    const t = exifTime(await file.slice(0, 512 * 1024).arrayBuffer());
    if (t) return t;
  } catch (e) { /* 读不到 */ }
  return file.lastModified || 0;
}

// ---------------------------------------------------------------- 转正、印编号（只给人看：送去认的永远是原图）
export function upright(src, side) {         // 标题在右边就逆时针转 90°，在左边顺时针 90°，在下边转 180°
  if (!['right', 'left', 'bottom'].includes(side)) return src;
  const w = src.width, h = src.height;
  const c = side === 'bottom' ? canvas(w, h) : canvas(h, w);
  const ctx = c.getContext('2d');
  if (side === 'right') { ctx.translate(0, w); ctx.rotate(-Math.PI / 2); }
  else if (side === 'left') { ctx.translate(h, 0); ctx.rotate(Math.PI / 2); }
  else { ctx.translate(w, h); ctx.rotate(Math.PI); }
  ctx.drawImage(src, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);         // 转完复位：后面印编号要按正的坐标画
  return c;
}

function busy(ctx, x, y, w, h) {             // 这一块有多乱（灰度的标准差）
  const d = ctx.getImageData(x, y, w, h).data;
  let s = 0, s2 = 0;
  const n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    s += g; s2 += g * g;
  }
  const m = s / n;
  return Math.round(Math.sqrt(Math.max(0, s2 / n - m * m)));
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// 在照片最空的那个角写上大红编号（白底红框）；四个角都有字就在顶上加一条白边写
export async function stamp(img, no, side = '') {
  let c = upright(draw(img, STAMP_SIDE), side);
  let ctx = c.getContext('2d');
  const w = c.width, h = c.height, short = Math.min(w, h);
  const text = String(no);
  const size = Math.max(28, Math.floor(short * 0.11));
  const font = `bold ${size}px Arial, "Helvetica Neue", "DejaVu Sans", sans-serif`;
  ctx.font = font;
  const mt = ctx.measureText(text);
  const l = mt.actualBoundingBoxLeft || 0, asc = mt.actualBoundingBoxAscent || size * 0.72;
  const tw = (mt.actualBoundingBoxRight || mt.width) + l, th = asc + (mt.actualBoundingBoxDescent || 0);
  const pad = Math.max(8, Math.floor(th * 0.35));
  const bw = Math.ceil(tw + 2 * pad), bh = Math.ceil(th + 2 * pad);
  const m = Math.max(6, Math.floor(short * 0.02));
  const spots = [[w - bw - m, m], [m, m], [w - bw - m, h - bh - m], [m, h - bh - m]];   // 右上、左上、右下、左下
  let best = null;
  spots.forEach(([x, y], i) => {
    if (x < 0 || y < 0) return;
    const sc = busy(ctx, x, y, bw, bh);
    if (!best || sc < best[0]) best = [sc, i, x, y];
  });
  if (!best) best = [999, 0, m, m];
  let [score, , x, y] = best;
  if (score > 30) {                          // 四个角都不空：顶上加一条白边
    const band = bh + 2 * m;
    const c2 = canvas(w, h + band);
    const x2 = c2.getContext('2d');
    x2.fillStyle = '#fff';
    x2.fillRect(0, 0, w, h + band);
    x2.drawImage(c, 0, band);
    c = c2; ctx = x2; x = m; y = m;
    ctx.font = font;
  }
  roundRect(ctx, x, y, bw, bh, Math.max(4, Math.floor(pad / 2)));
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.lineWidth = Math.max(3, Math.floor(short / 250));
  ctx.strokeStyle = 'rgb(200,0,0)';
  ctx.stroke();
  ctx.fillStyle = 'rgb(200,0,0)';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, x + pad + l, y + pad + asc);
  return toBlob(c, 0.88);
}

// 核对时自动转正转错了：编号照片转 90°（原图不动）
export async function rotate(blob, clockwise) {
  const img = await imgFrom(blob);
  const [w, h] = sizeOf(img);
  const c = canvas(h, w);
  const ctx = c.getContext('2d');
  if (clockwise) { ctx.translate(h, 0); ctx.rotate(Math.PI / 2); } else { ctx.translate(0, w); ctx.rotate(-Math.PI / 2); }
  ctx.drawImage(img, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return toBlob(c, 0.9);
}

// ---------------------------------------------------------------- 163：白纸、几种画法、照片的底细
// iPhone 上「拍照」当场交给网页的那张，老画法（<img> load 一到就往 OffscreenCanvas 上画）画出来整张白；相册里选的没事。
// 每种画法都能单独叫（诊断页挨个画）；paint() 按顺序画，第一条画出来不白的就用它。

export const FLAT = 1.5;                        // 缩成 48 像素看灰度标准差：真照片 45 往上，只印了细线的空表 3.6，画坏的白纸 0
function plain(w, h) {                          // 普通 <canvas>（没有 document 的地方才用 OffscreenCanvas）
  if (typeof document === 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}
export function flatness(src, n = 48) {        // 这张图有多「平」：灰度标准差
  let [w, h] = sizeOf(src);
  if (!w || !h) return 0;
  // 一步缩到 48 像素，浏览器只隔行取点，细线整条被跳过（量出来是平的）：一半一半地缩，每步都是 2×2 求平均
  let cur = src;
  while (Math.max(w, h) > 2 * n) {
    const W2 = Math.max(1, Math.round(w / 2)), H2 = Math.max(1, Math.round(h / 2));
    const c2 = plain(W2, H2), x2 = c2.getContext('2d');
    x2.fillStyle = '#fff';
    x2.fillRect(0, 0, W2, H2);
    x2.imageSmoothingEnabled = true;
    x2.imageSmoothingQuality = 'high';
    x2.drawImage(cur, 0, 0, W2, H2);
    if (cur !== src) cur.width = cur.height = 1;
    cur = c2; w = W2; h = H2;
  }
  const s = Math.min(1, n / Math.max(w, h));
  const W = Math.max(1, Math.round(w * s)), H = Math.max(1, Math.round(h * s));
  const c = plain(W, H), ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cur, 0, 0, W, H);
  if (cur !== src) cur.width = cur.height = 1;
  const d = ctx.getImageData(0, 0, W, H).data;
  let s1 = 0, s2 = 0;
  const k = d.length / 4;
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    s1 += g; s2 += g * g;
  }
  const m = s1 / k;
  return Math.round(Math.sqrt(Math.max(0, s2 / k - m * m)) * 10) / 10;
}
export const isBlank = (src) => flatness(src) < FLAT;

export async function blobFlatness(blob) {     // 压好的 JPG 解开再量（量的是真要发出去的那份）
  if (typeof createImageBitmap === 'function') {
    try { const b = await createImageBitmap(blob); try { return flatness(b); } finally { if (b.close) b.close(); } } catch (e) { /* 退回 <img> */ }
  }
  const { img, url } = await viaImg(blob);
  try { return flatness(img); } finally { URL.revokeObjectURL(url); }
}

export function thumb(src, side = 160, q = 0.72) {   // 小图（data: 网址），手机上一眼看出白不白
  const [w, h] = sizeOf(src);
  const s = Math.min(1, side / Math.max(w, h));
  const c = plain(Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s)));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL ? c.toDataURL('image/jpeg', q) : '';
}

// JPEG 的底细：EXIF 方向、没转过的宽高、有没有 HDR 增益图（苹果的 / ISO 21496 / Ultra HDR）
export function jpegInfo(buf) {
  const v = new DataView(buf), out = { jpeg: false, orient: 0, w: 0, h: 0, mpf: false, gain: [] };
  try {
    if (v.getUint16(0) !== 0xffd8) return out;
    out.jpeg = true;
    let off = 2;
    while (off + 4 < v.byteLength) {
      const marker = v.getUint16(off), len = v.getUint16(off + 2);
      if ((marker & 0xff00) !== 0xff00) break;
      if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) {
        const t0 = off + 10, le = v.getUint16(t0) === 0x4949;
        const p = t0 + v.getUint32(t0 + 4, le), n = v.getUint16(p, le);
        for (let i = 0; i < n; i++) {
          const e = p + 2 + i * 12;
          if (v.getUint16(e, le) === 0x0112) out.orient = v.getUint16(e + 8, le);
        }
      }
      if (marker === 0xffe2 && v.getUint32(off + 4) === 0x4d504600) out.mpf = true;   // 'MPF\0'：后面还挂着别的图（增益图、深度图）
      if (marker >= 0xffc0 && marker <= 0xffcf && ![0xffc4, 0xffc8, 0xffcc].includes(marker)) {
        out.h = v.getUint16(off + 5); out.w = v.getUint16(off + 7);
        break;
      }
      off += 2 + len;
    }
  } catch (e) { /* 读到哪算哪 */ }
  const s = new TextDecoder('latin1').decode(new Uint8Array(buf, 0, Math.min(buf.byteLength, 4 << 20)));
  for (const [k, name] of [['HDRGainMap', 'apple'], ['urn:iso:std:iso:ts:21496', 'iso'], ['hdrgm:', 'ultrahdr']]) if (s.includes(k)) out.gain.push(name);
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function viaImg(blob) {                  // <img>：load 完了再等 decode()（页面在后台 decode() 可能不回来：最多等 4 秒，过了照画，画白了 paint() 换下一种）
  const url = URL.createObjectURL(blob);
  const img = new Image();
  try {
    await new Promise((ok, bad) => { img.onload = ok; img.onerror = () => bad(new Error(t('img.cantOpen'))); img.src = url; });
    if (img.decode) await Promise.race([img.decode().catch(() => {}), sleep(document.hidden ? 1000 : 4000)]);
  } catch (e) { URL.revokeObjectURL(url); throw e; }
  return { img, url };
}

const EXIF_FIX = {                             // 解出来没按 EXIF 转：自己转（方向 -> 画原图之前的变换）
  2: (w, h) => [-1, 0, 0, 1, w, 0], 3: (w, h) => [-1, 0, 0, -1, w, h], 4: (w, h) => [1, 0, 0, -1, 0, h],
  5: () => [0, 1, 1, 0, 0, 0], 6: (w, h) => [0, 1, -1, 0, h, 0], 7: (w, h) => [0, -1, -1, 0, h, w], 8: (w) => [0, -1, 1, 0, 0, w],
};
function drawPlain(src, side, orient = 1, mk = plain) {   // 画到一张新画布上，最长边 side；orient≠1 时自己转
  const [w, h] = sizeOf(src);
  const swap = orient >= 5;
  const ow = swap ? h : w, oh = swap ? w : h;
  const s = Math.min(1, side / Math.max(ow, oh));
  const W = Math.max(1, Math.round(ow * s)), H = Math.max(1, Math.round(oh * s));
  const c = mk(W, H), ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.scale(W / ow, H / oh);
  if (EXIF_FIX[orient]) ctx.transform(...EXIF_FIX[orient](w, h));
  ctx.drawImage(src, 0, 0, w, h);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return c;
}
export function scaled(c, side) { return drawPlain(c, side); }   // 要缩小：画布画画布，不再从原图重画

async function bitmapOf(blob, opts, info) {    // createImageBitmap；没按 EXIF 转（宽高跟原图一样、方向又要换宽高）就自己转
  const b = opts ? await createImageBitmap(blob, opts) : await createImageBitmap(blob);
  let orient = 1;
  if (info && info.orient >= 5 && info.w !== info.h && b.width === info.w && b.height === info.h) orient = info.orient;
  return { b, orient };
}

// 几种画法：都返回一张画好的画布（最长边 side）
export const WAYS = ['img', 'bitmap', 'bitmapRaw', 'offscreen'];
export async function paintWith(way, blob, side, info) {
  if (way === 'img' || way === 'imgOff') {     // <img> 等解完码 -> 普通画布（imgOff：画到 OffscreenCanvas，诊断用）
    const { img, url } = await viaImg(blob);
    try { return drawPlain(img, side, 1, way === 'imgOff' ? canvas : plain); } finally { URL.revokeObjectURL(url); }
  }
  if (way === 'bitmap' || way === 'bitmapRaw') {
    if (typeof createImageBitmap !== 'function') throw new Error('no createImageBitmap');
    const { b, orient } = await bitmapOf(blob, way === 'bitmap' ? { imageOrientation: 'from-image' } : null, info);
    try { return drawPlain(b, side, orient); } finally { if (b.close) b.close(); }
  }
  if (way === 'offscreen') return draw(await imgFrom(blob), side);   // 网页版认字用的那条：openImage() 的 <img>（等解完码）画到 OffscreenCanvas
  throw new Error(`no way ${way}`);
}

// 按顺序画，第一条不白的就用它 -> {canvas|null, way, tried:[{way, flat|err, ms}], info}
export async function paint(blob, side, ways = WAYS) {
  let info = null;
  try { info = jpegInfo(await blob.slice(0, 4 << 20).arrayBuffer()); } catch (e) { /* 不是 JPG 也照画 */ }
  const tried = [];
  for (const way of ways) {
    const t0 = performance.now();
    try {
      const c = await paintWith(way, blob, side, info);
      const flat = flatness(c);
      tried.push({ way, flat, ms: Math.round(performance.now() - t0) });
      if (flat >= FLAT) return { canvas: c, way, tried, info };
      c.width = c.height = 1;                  // 白的：画布先还给手机
    } catch (e) {
      tried.push({ way, err: e.message || String(e), ms: Math.round(performance.now() - t0) });
    }
  }
  return { canvas: null, way: '', tried, info };
}

// paint() 都打不开（不是白，是报错）：可能是 Safari 以外的浏览器碰上 HEIC，走老路转成 JPG 再画
export async function paintAny(file, side) {
  const r = await paint(file, side);
  if (r.canvas || r.tried.some((x) => x.err === undefined)) return r;
  const img = await openImage(file);           // 还打不开就让它报「这不是照片」
  const c = drawPlain(img, side);
  const flat = flatness(c);
  r.tried.push({ way: 'heic', flat });
  return flat >= FLAT ? { ...r, canvas: c, way: 'heic' } : r;
}
export const legacyImg = imgFromOld;            // 诊断页照 1.13.3 原样画一遍用

// 传图页用的：画一次、压到 limit 以内 -> {blob|null（白的）, look（小图）, flat（压完那份的平整度）, way, tried, info}
// 原图只画一次；压不够小先降质量（拿同一张画布重新压），还不够再缩小（画布画画布，不再从原图重画）
export async function squeeze(file, side = 2560, limit = 1_800_000) {
  const r = await paintAny(file, side);
  if (!r.canvas) return { ...r, blob: null, look: '', flat: null };
  const full = r.canvas;
  let s = side, q = 0.86, blob, c = full;
  for (;;) {
    blob = await toBlob(c, q);
    if (blob.size <= limit || s <= 1400) break;
    if (q > 0.62) q -= 0.12;
    else {
      s = Math.round(s * 0.8); q = 0.8;
      if (c !== full) c.width = c.height = 1;
      c = scaled(full, s);
    }
  }
  const look = thumb(c);
  const flat = await blobFlatness(blob);
  if (c !== full) c.width = c.height = 1;
  full.width = full.height = 1;                // 画布还给手机（iPhone 的画布内存有上限）
  return { ...r, canvas: null, blob: flat >= FLAT ? blob : null, look, flat };
}              // 诊断页照 1.13.3 原样画一遍用
