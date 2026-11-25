// 一张照片里十字摆着四张单子：找中间那道十字缝，按缝分成左上、右上、左下、右下四块。
// 这里只看像素、不碰页面：浏览器（quadui.js）和单测（test/quad.test.mjs）用的是同一份。
//
// 缝不一定在正中间，纸也可能摆斜：每道缝是一条能斜一点的直线；另一个方向上下（或左右）两半各找各的，可以错开。
//   cross = { v: [上半那道竖缝, 下半那道竖缝], h: [左半那道横缝, 右半那道横缝] }
//   竖缝 [x(y=0), x(y=1)]，横缝 [y(x=0), y(x=1)]，都是占照片宽、高的比例；是一整条直线的话两半一样。
//
// 怎么认缝，两样看法：
//   一、纸和桌面分得开（桌面深、有颜色、花布）：缝是「几乎没有纸」的一条道。
//   二、分不开（白桌面、纸挨着纸）：缝是「几乎没有笔画」的一条道。
// 两样都找不着像样的，就切正中间。

export const FIND_SIDE = 800;            // 找缝用的缩小图最长边
const SPAN = [0.22, 0.78];               // 缝只在照片中间这一段找
const DEG = 10, STEP = 0.5;              // 最多斜 10°
const PAPER_OK = 0.30;                   // 第一样：这条道上纸占不到三成才算缝
const INK_OK = 0.02;                     // 第二样：这条道上笔画占不到 2% 才算缝
export const CENTER = () => ({ v: [[0.5, 0.5], [0.5, 0.5]], h: [[0.5, 0.5], [0.5, 0.5]] });

// ---------------------------------------------------------------- 像素
function otsu(hist, n) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let wB = 0, sumB = 0, best = -1, t0 = 128, t1 = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const d = sumB / wB - (sum - sumB) / wF, score = wB * wF * d * d;
    if (score > best + 1e-6) { best = score; t0 = t1 = i; } else if (score > best - 1e-6) t1 = i;
  }
  return Math.round((t0 + t1) / 2);
}

function box(src, w, h, r) {             // 半径 r 的方框和（积分图）-> 每个点周围的平均
  const sum = new Float64Array((w + 1) * (h + 1)), W = w + 1;
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) { row += src[y * w + x]; sum[(y + 1) * W + x + 1] = sum[y * W + x + 1] + row; }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      out[y * w + x] = (sum[y1 * W + x1] - sum[y0 * W + x1] - sum[y1 * W + x0] + sum[y0 * W + x0]) / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}

function over(a, cut) {                   // 大于 cut 的记 1（Uint8Array.from 带函数的写法慢好几倍）
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] > cut ? 1 : 0;
  return out;
}
const dilate = (m, w, h, r) => over(box(m, w, h, r), 1e-4);
const erode = (m, w, h, r) => over(box(m, w, h, r), 1 - 1e-4);

/** {data: RGBA, width, height} -> 看过一遍的像素：哪儿像纸、哪儿有笔画 */
export function analyze({ data, width: w, height: h }) {
  const n = w * h, L = new Float32Array(n), V = new Uint8Array(n), hist = new Uint32Array(256);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = data[j], g = data[j + 1], b = data[j + 2];
    const l = (r * 299 + g * 587 + b * 114) / 1000;
    L[i] = l;
    const white = Math.max(0, Math.min(255, Math.round(l - 0.6 * (Math.max(r, g, b) - Math.min(r, g, b)))));   // 又亮又没颜色 = 像纸
    V[i] = white;
    hist[white]++;
  }
  let acc = 0, top = 255;
  for (; top > 0; top--) { acc += hist[top]; if (acc >= n * 0.03) break; }     // 照片里最像纸的那一档
  const cut = otsu(hist, n);
  let hi = 0, lo = 0, nHi = 0;
  for (let i = 0; i < 256; i++) { if (i > cut) { hi += i * hist[i]; nHi += hist[i]; } else lo += i * hist[i]; }
  const apart = nHi && nHi < n ? hi / nHi - lo / (n - nHi) : 0;                // 亮的那堆和暗的那堆差多少
  const paper = erode(dilate(over(V, cut), w, h, 1), w, h, 1);                 // 纸上的细字、表格线算纸
  const mean = box(L, w, h, 7), around = box(V, w, h, 7);
  const dark = new Uint8Array(n);                                             // 笔画：亮底上比周围暗一截的点
  let strokes = 0;
  for (let i = 0; i < n; i++) if (L[i] < mean[i] - 22 && around[i] > top * 0.64) { dark[i] = 1; strokes++; }
  const ink = dilate(dark, w, h, 2);
  // 照片里得真有纸那么亮的东西：不然只是一张桌面，花纹深浅不能当纸和缝
  return { w, h, top: Math.max(1, top), V, paper, ink, dark, byPaper: top >= 120 && apart >= 45, byInk: top >= 120 && strokes > n * 0.004 };
}

// ---------------------------------------------------------------- 找一道缝
// vertical：竖缝。缝顺着走的方向叫「长」（竖缝是 y），横着挪的方向叫「宽」（竖缝是 x）。只看长在 [from, to) 的那一段。
function scan(a, mask, mass, vertical, from, to) {
  const A = vertical ? a.w : a.h, sa = vertical ? a.w : 1, sc = vertical ? 1 : a.w;
  const cum = new Float64Array(A + 1);                                         // 缝两边都得有东西（纸或者字）
  for (let p = 0; p < A; p++) {
    let s = 0;
    for (let l = from; l < to; l += 2) s += mass[l * sa + p * sc];
    cum[p + 1] = cum[p] + s;
  }
  const total = cum[A];
  if (!total) return null;
  const lo = Math.round(SPAN[0] * A), hi = Math.round(SPAN[1] * A), mid = (from + to) / 2;
  const cost = new Float32Array(hi - lo + 1);
  const runs = [];
  for (let d = -DEG; d <= DEG + 1e-9; d += STEP) {
    const k = Math.tan((d * Math.PI) / 180), off = [];
    for (let l = from; l < to; l += 2) off.push(Math.round((l - mid) * k));
    let low = Infinity;
    for (let p = lo; p <= hi; p++) {
      if (Math.min(cum[p], total - cum[p]) < total * 0.12) { cost[p - lo] = Infinity; continue; }
      let s = 0;
      for (let i = 0, l = from; l < to; l += 2, i++) {
        const q = p + off[i];
        if (q >= 0 && q < A) s += mask[l * sa + q * sc];
      }
      const c = s / off.length;
      cost[p - lo] = c;
      if (c < low) low = c;
    }
    if (low === Infinity) continue;
    let best = null;                                                           // 差不多一样干净的几条里：挑最宽、最靠中间的那一片的正中
    for (let i = 0; i < cost.length; i++) {
      if (!(cost[i] <= low + 0.012)) continue;
      let j = i;
      while (j + 1 < cost.length && cost[j + 1] <= low + 0.012) j++;
      const p = lo + (i + j) / 2, width = j - i + 1;
      const score = width - 0.15 * Math.abs(p - A / 2) - 0.8 * Math.abs(d);
      if (!best || score > best.score) best = { p, d, low, width, score, k };
      i = j;
    }
    runs.push(best);
  }
  if (!runs.length) return null;
  const least = Math.min(...runs.map((r) => r.low));
  const pick = runs.filter((r) => r.low <= least + 0.01).sort((x, y) => y.score - x.score)[0];
  const len = vertical ? a.h : a.w;
  const at = (l) => (pick.p + (l - mid) * pick.k) / A;
  return { line: [at(0), at(len)], cost: pick.low, p: pick.p, deg: pick.d };
}

/** 一段里最像缝的那条；两样看法都不像 -> null。rank 越小越靠得住 */
function seam(a, vertical, from, to) {
  const first = a.byPaper ? scan(a, a.paper, a.paper, vertical, from, to) : null;
  if (first && first.cost <= PAPER_OK) return { ...first, rank: first.cost };
  const second = a.byInk ? scan(a, a.ink, a.dark, vertical, from, to) : null;
  if (second && second.cost <= INK_OK) return { ...second, rank: 1 + second.cost };
  return null;
}

const at = (line, t) => line[0] + (line[1] - line[0]) * t;

/** -> {cross, sure}：sure=false 是有一道没找准，那一道按正中间切 */
export function findIn(a) {
  const fv = seam(a, true, 0, a.h), fh = seam(a, false, 0, a.w);
  const mainV = !!fv && (!fh || fv.rank < fh.rank - 0.01);                    // 哪个方向更像一整条，就拿它当主缝
  const main = mainV ? fv : fh;
  const mainLine = main ? main.line : [0.5, 0.5];
  const subVertical = !mainV;
  const len = subVertical ? a.h : a.w;
  const split = Math.round(Math.min(0.8, Math.max(0.2, at(mainLine, 0.5))) * len);
  const halves = [seam(a, subVertical, 0, split), seam(a, subVertical, split, len)];
  const full = subVertical ? fv : fh;
  let sure = !!main;
  let subs;
  const [x, y] = halves;
  if (x && y) {
    const t = split / len;
    const same = Math.abs(at(x.line, t) - at(y.line, t)) < 0.012 && Math.abs(x.deg - y.deg) <= 1;
    subs = same && full && full.cost <= Math.max(x.cost, y.cost) + 0.03 ? [full.line, full.line] : [x.line, y.line];
  } else if (x || y) {
    subs = [(x || y).line, (x || y).line];                                     // 半边只有一张纸（另一块空着）：照另一半的缝
  } else if (full) {
    subs = [full.line, full.line];
  } else {
    subs = [[0.5, 0.5], [0.5, 0.5]];
    sure = false;
  }
  const round = (l) => l.map((n) => Math.round(n * 10000) / 10000);
  const m = [round(mainLine), round(mainLine)], s = subs.map(round);
  return { cross: mainV ? { v: m, h: s } : { v: s, h: m }, sure };
}

// ---------------------------------------------------------------- 四块
/** 竖缝和横缝交在哪儿 -> [x, y] */
export function meet(v, h) {
  const dv = v[1] - v[0], dh = h[1] - h[0];
  const x = (v[0] + dv * h[0]) / (1 - dv * dh);
  return [x, h[0] + dh * x];
}

/** 四块各是哪个四边形（比例坐标），顺序：左上、右上、左下、右下 */
export function quads(cross) {
  const [vt, vb] = cross.v, [hl, hr] = cross.h;
  return [
    [[0, 0], [vt[0], 0], meet(vt, hl), [0, hl[0]]],
    [[vt[0], 0], [1, 0], [1, hr[1]], meet(vt, hr)],
    [[0, hl[0]], meet(vb, hl), [vb[1], 1], [0, 1]],
    [meet(vb, hr), [1, hr[1]], [1, 1], [vb[1], 1]],
  ];
}

/** 四块里哪块是空的（没纸，只有桌面）-> [bool×4]。拿不准就当有纸：漏认比多认糟 */
export function emptyIn(a, cross) {
  const [vt, vb] = cross.v, [hl, hr] = cross.h, pad = 0.025;                   // 贴着缝的一窄条不看：隔壁的纸边会伸过来
  const bar = a.top * 0.55;
  const out = [0, 1, 2, 3].map((q) => {
    const top = q < 2, left = q % 2 === 0;
    const v = top ? vt : vb, h = left ? hl : hr;
    let n = 0, bright = 0, strokes = 0;
    for (let y = 0; y < a.h; y += 2) {
      const vx = (at(v, (y + 0.5) / a.h) + (left ? -pad : pad)) * a.w;
      const x0 = left ? 0 : Math.max(0, Math.ceil(vx)), x1 = left ? Math.min(a.w, Math.floor(vx)) : a.w;
      for (let x = x0; x < x1; x += 2) {
        const sy = (y + 0.5) / a.h - at(h, (x + 0.5) / a.w);
        if ((top ? -sy : sy) < pad) continue;
        const i = y * a.w + x;
        n++;
        if (a.V[i] > bar) bright++;
        strokes += a.dark[i];
      }
    }
    return a.top < 120 ? false : !n || bright / n < 0.08 || strokes / n < 0.0025;
  });
  return out.every(Boolean) ? [false, false, false, false] : out;              // 四块全说空：八成是看错了，照认
}

/** 缩小图 -> {cross, sure, empty, a} */
export function findCross(image) {
  const a = analyze(image);
  const { cross, sure } = findIn(a);
  return { cross, sure, empty: emptyIn(a, cross), a };
}

// ---------------------------------------------------------------- 手拖
const clamp = (n) => Math.min(0.92, Math.max(0.08, n));
const sameLine = (p, q) => Math.abs(p[0] - q[0]) < 1e-6 && Math.abs(p[1] - q[1]) < 1e-6;
const near = (n) => Math.round(n * 1e6) / 1e6;
const shift = (line, d) => { const mid = (line[0] + line[1]) / 2, k = clamp(mid + d) - mid; return [near(line[0] + k), near(line[1] + k)]; };

/** 拖 'top' / 'bottom'（竖缝）、'left' / 'right'（横缝）、'center'（整个十字）挪了 (dx, dy) -> 新的 cross。
 *  拖的那道是一整条直线就整条挪；上下（左右）错开的只挪拖的这半。 */
export function drag(cross, which, dx, dy) {
  const v = cross.v.map((l) => [...l]), h = cross.h.map((l) => [...l]);
  const move = (lines, i, d) => {
    if (sameLine(lines[0], lines[1])) { lines[0] = shift(lines[0], d); lines[1] = [...lines[0]]; } else lines[i] = shift(lines[i], d);
  };
  if (which === 'center') return { v: v.map((l) => shift(l, dx)), h: h.map((l) => shift(l, dy)) };
  if (which === 'top') move(v, 0, dx);
  else if (which === 'bottom') move(v, 1, dx);
  else if (which === 'left') move(h, 0, dy);
  else if (which === 'right') move(h, 1, dy);
  return { v, h };
}

/** 四条胳膊：从照片边到十字中心的那一截（画线、放手指抓的地方用） */
export function arms(cross) {
  const [vt, vb] = cross.v, [hl, hr] = cross.h;
  const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  const c = [meet(vt, hl), meet(vt, hr), meet(vb, hl), meet(vb, hr)];
  return {
    top: [[vt[0], 0], mid(c[0], c[1])],
    bottom: [mid(c[2], c[3]), [vb[1], 1]],
    left: [[0, hl[0]], mid(c[0], c[2])],
    right: [mid(c[1], c[3]), [1, hr[1]]],
    center: mid(mid(c[0], c[3]), mid(c[1], c[2])),
  };
}
