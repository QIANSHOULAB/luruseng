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

// ---------------------------------------------------------------- 一张一张纸（148：只剩两三张时别按十字硬切）
// 纸是一块块白的，中间隔着底：先把每一张找出来。找得出像样的几张，就照它们决定十字的哪几条胳膊要、哪几条不要；
// 纸挨在一起分不开（连成一大块、形状不像一张纸）就返回 null，照旧按十字缝切。
const MIN_SHEET = 0.03;                  // 一张纸至少占照片这么多
const TILT = 20;                         // 摆歪最多认这么多度

/** 连成一片的亮块（从照片四边往里灌「底」，灌不到的都算纸：纸里的表格线、大字）-> 够大的几块 {size, edge: 边上的点, first, labels} */
function blobs(mask, w, h, min) {
  const n = w * h, bg = new Uint8Array(n), stack = new Int32Array(n);
  let sp = 0;
  const seed = (i) => { if (!mask[i] && !bg[i]) { bg[i] = 1; stack[sp++] = i; } };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
  while (sp) {
    const i = stack[--sp], x = i % w;
    if (x) seed(i - 1);
    if (x < w - 1) seed(i + 1);
    if (i >= w) seed(i - w);
    if (i < n - w) seed(i + w);
  }
  const seen = new Uint8Array(n), found = [];
  for (let start = 0; start < n; start++) {
    if (bg[start] || seen[start]) continue;
    seen[start] = 1;
    sp = 0;
    stack[sp++] = start;
    const mine = [], edge = [];
    while (sp) {
      const i = stack[--sp], x = i % w, y = (i - x) / w;
      mine.push(i);
      let rim = false;
      for (const [ok, j] of [[x > 0, i - 1], [x < w - 1, i + 1], [y > 0, i - w], [y < h - 1, i + w]]) {
        if (!ok || bg[j]) { rim = true; continue; }
        if (!seen[j]) { seen[j] = 1; stack[sp++] = j; }
      }
      if (rim) edge.push(x, y);
    }
    if (mine.length < n * min) continue;
    const labels = new Uint8Array(n);
    for (const i of mine) labels[i] = 1;
    found.push({ size: mine.length, edge, first: start, labels });
  }
  return found;
}

/** -> [{area, fill, aspect, box: [x0, y0, x1, y1], poly: 转正的外框（往外放一点）, pts: 纸边往里一点取的一圈点}]，坐标都是占照片的比例；认不准 -> null */
export function sheets(a) {
  if (!a.byPaper) return null;
  let split = false;                                                    // 有哪一块其实是两张（缝太窄，补框线时粘上了）
  const w = a.w >> 1, h = a.h >> 1, n = w * h;                          // 找整张纸用不着那么细：长宽各减半，快四倍
  const half = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = 2 * y * a.w + 2 * x;
      half[y * w + x] = a.paper[i] + a.paper[i + 1] + a.paper[i + a.w] + a.paper[i + a.w + 1] >= 2 ? 1 : 0;
    }
  }
  const shut = erode(dilate(half, w, h, 2), w, h, 2);                   // 粗框线补上：不然纸边一窄，「底」顺着框线灌进纸里
  const open = dilate(erode(shut, w, h, 1), w, h, 1);                    // 花布上的亮点、细毛边去掉
  const found = blobs(open, w, h, MIN_SHEET);
  if (!found.length || found.length > 4) return null;
  const bare = blobs(half, w, h, MIN_SHEET);                             // 不补线再数一遍：一块里露出两大片，是两张挨得很近
  if (found.length > 1) for (const f of found) {                      // 只有一块的下面另有判法（单子自己的粗框会把里头分开）
    const parts = bare.filter((b) => b.size > f.size * 0.3 && f.labels[b.first]);
    if (parts.length > 1) split = true;
  }
  if (split) return null;
  const out = found.map(({ size, edge }) => {
    let best = null;
    for (let d = -TILT; d <= TILT; d++) {                              // 转到哪个角度外框最小，那就是它摆歪的角度
      const r = (d * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (let k = 0; k < edge.length; k += 2) {
        const u = edge[k] * c + edge[k + 1] * s, v = edge[k + 1] * c - edge[k] * s;
        if (u < u0) u0 = u;
        if (u > u1) u1 = u;
        if (v < v0) v0 = v;
        if (v > v1) v1 = v;
      }
      const area = (u1 - u0 + 1) * (v1 - v0 + 1);
      if (!best || area < best.area) best = { area, c, s, u0, u1, v0, v1 };
    }
    const { c, s, u0, u1, v0, v1 } = best;
    const point = (u, v) => [(u * c - v * s) / w, (u * s + v * c) / h];
    const du = u1 - u0, dv = v1 - v0, pad = Math.max(du, dv) * 0.03;
    const poly = [point(u0 - pad, v0 - pad), point(u1 + pad, v0 - pad), point(u1 + pad, v1 + pad), point(u0 - pad, v1 + pad)]
      .map(([x, y]) => [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))]);
    const pts = [];
    for (const fu of [0.04, 0.5, 0.96]) for (const fv of [0.04, 0.5, 0.96]) pts.push(point(u0 + du * fu, v0 + dv * fv));
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    return { area: size / n, fill: size / best.area, aspect: Math.max(du, dv) / Math.max(1, Math.min(du, dv)),
      box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], poly, pts };
  });
  const areas = out.map((o) => o.area);
  if (out.some((o) => o.fill < (out.length > 1 ? 0.78 : 0.65))) return null;   // 形状不像纸：几张挨成一团了（只有一块时花布粘边，放宽点）
  if (out.length > 1 && (out.some((o) => o.aspect > 2.4) || Math.max(...areas) > Math.min(...areas) * 1.9)) return null;   // 有一块顶别的两张大
  return out;
}

/** 只找出一块纸色：是一张纸，还是几张挨在一起？挨着的纸之间有一条笔画一点不沾的直道；一张单子里横着有、竖着穿不过表格线。
 *  -> 'cross'（照十字缝切）、'sides'（左右两张）、'stack'（上下两张）、'one' */
function joined(a, p) {
  const [x0, y0, x1, y1] = p.box;
  const clear = (vertical) => {
    const len = vertical ? a.h : a.w, from = vertical ? y0 : x0, to = vertical ? y1 : x1;
    const r = scan(a, a.ink, a.dark, vertical, Math.round(from * len), Math.round(to * len));
    return r && r.cost <= INK_OK ? r : null;
  };
  const v = clear(true), h = clear(false), wide = ((x1 - x0) * a.w) / ((y1 - y0) * a.h);
  if (v && h) return { how: 'cross' };
  if (v && wide > 1.6) return { how: 'sides', line: v.line };
  if (h && wide < 1 / 1.6) return { how: 'stack', line: h.line };
  return { how: 'one' };
}

export function inside(poly, x, y) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

const WHOLE = { top: false, bottom: false, left: false, right: false };
const MERGE = {                          // 去掉一条胳膊，它两边那两格合成一块
  top: [0, 1], bottom: [2, 3], left: [0, 2], right: [1, 3],
};

/** 照现在的十字（off：哪几条胳膊不要）分成几块 -> [{ids: 占哪几格（0 左上 1 右上 2 左下 3 右下）, poly}] */
export function regions(cross, off = WHOLE) {
  const group = [0, 1, 2, 3];
  const root = (i) => (group[i] === i ? i : root(group[i]));
  for (const [arm, [i, j]] of Object.entries(MERGE)) if (off[arm]) group[Math.max(root(i), root(j))] = Math.min(root(i), root(j));
  const q = quads(cross), [vt, vb] = cross.v, [hl, hr] = cross.h;
  const union = {
    '0,1': () => [[0, 0], [1, 0], [1, hr[1]], meet(vt, hr), meet(vt, hl), [0, hl[0]]],
    '2,3': () => [[0, hl[0]], meet(vb, hl), meet(vb, hr), [1, hr[1]], [1, 1], [0, 1]],
    '0,2': () => [[0, 0], [vt[0], 0], meet(vt, hl), meet(vb, hl), [vb[1], 1], [0, 1]],
    '1,3': () => [[vt[0], 0], [1, 0], [1, 1], [vb[1], 1], meet(vb, hr), meet(vt, hr)],
    '0,1,2,3': () => [[0, 0], [1, 0], [1, 1], [0, 1]],
  };
  const out = [];
  for (let i = 0; i < 4; i++) {
    if (root(i) !== i) continue;
    const ids = [0, 1, 2, 3].filter((k) => root(k) === i);
    out.push({ ids, poly: ids.length === 1 ? q[i] : (union[ids.join(',')] || union['0,1,2,3'])() });
  }
  return out;
}

/** 一块的外框 [x0, y0, x1, y1] */
export function frame(poly) {
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** 认出一整张纸在里头、可纸只占这块一小片的（两三张时合起来的大块）：只抠纸那一圈（留宽边），不然缩小以后字太小。
 *  给这样的块记上 tight = [x0, y0, x1, y1] */
export function tighten(list, papers) {
  return list.map((g) => {
    const mine = (papers || []).filter((p) => p.pts.every(([x, y]) => inside(g.poly, x, y)));
    if (g.empty || mine.length !== 1) return g;
    const [x0, y0, x1, y1] = frame(mine[0].poly), pad = 0.06 * Math.max(x1 - x0, y1 - y0), r = frame(g.poly);
    const t = [Math.max(r[0], x0 - pad), Math.max(r[1], y0 - pad), Math.min(r[2], x1 + pad), Math.min(r[3], y1 + pad)];
    return (t[2] - t[0]) * (t[3] - t[1]) < 0.6 * (r[2] - r[0]) * (r[3] - r[1]) ? { ...g, tight: t } : g;
  });
}

/** 每张纸整个落在某一块里、每一块最多装一张 -> 每块装的是第几张（没装 -1）；不然 -> null */
function holds(list, papers) {
  const owner = list.map(() => -1);
  for (const [k, p] of papers.entries()) {
    const at = list.findIndex((r) => p.pts.every(([x, y]) => inside(r.poly, x, y)));
    if (at < 0 || owner[at] >= 0) return null;
    owner[at] = k;
  }
  return owner;
}

/** 十字缝找得不对时，照纸摆的位置重摆：先按一整条横缝分上下排（不行再按竖缝分左右列），每排两张的中间才有那条胳膊。-> [cross, off] 的候选 */
function byPapers(papers, found) {
  const tries = [];
  for (const across of [true, false]) {                                  // across：主缝是横的
    const lo = across ? 1 : 0, other = across ? 0 : 1;
    const order = [...papers].sort((p, q) => (p.box[lo] + p.box[lo + 2]) - (q.box[lo] + q.box[lo + 2]));
    let split = null;
    for (let k = 1; k < order.length; k++) {
      const end = Math.max(...order.slice(0, k).map((p) => p.box[lo + 2])), begin = Math.min(...order.slice(k).map((p) => p.box[lo]));
      if (begin - end > -0.015 && (!split || begin - end > split.gap)) split = { k, gap: begin - end, at: (end + begin) / 2 };
    }
    const groups = split ? [order.slice(0, split.k), order.slice(split.k)] : [order, []];
    if (!split && order.length > 2) continue;
    const main = split ? [split.at, split.at] : [0.5, 0.5];
    const subs = [], missing = [];
    let ok = true;
    for (const g of groups) {
      if (g.length > 2) { ok = false; break; }
      if (g.length < 2) { subs.push(null); continue; }
      const [p, q] = [...g].sort((x, y) => (x.box[other] + x.box[other + 2]) - (y.box[other] + y.box[other + 2]));
      if (q.box[other] - p.box[other + 2] < -0.015) { ok = false; break; }
      const m = (p.box[other + 2] + q.box[other]) / 2;
      subs.push([m, m]);
    }
    if (!ok) continue;
    for (const i of [0, 1]) missing.push(!subs[i]);
    const one = subs[0] || subs[1] || [0.5, 0.5];
    const flat = [subs[0] || one, subs[1] || one];
    const mains = [main, main];
    // 没分出两排（全在一排）：主缝整条不要
    const off = across ? { top: missing[0], bottom: split ? missing[1] : missing[0], left: !split, right: !split }
      : { left: missing[0], right: split ? missing[1] : missing[0], top: !split, bottom: !split };
    if (!split) {
      const both = across ? { top: false, bottom: false } : { left: false, right: false };
      if (order.length === 2) Object.assign(off, both);                  // 并排两张：中间那条整条都要
    }
    const secondary = !split && order.length === 2 ? [flat[0], flat[0]] : flat;
    const plain = across ? { v: secondary, h: mains } : { v: mains, h: secondary };
    if (found) {                                                         // 原来找到的缝（会跟着纸斜）能用就用它的
      tries.push([across ? { v: plain.v, h: found.h } : { v: found.v, h: plain.h }, off]);
      tries.push([across ? { v: found.v, h: plain.h } : { v: plain.v, h: found.h }, off]);
      tries.push([found, off]);
    }
    tries.push([plain, off]);
  }
  return tries;
}

/** 缩小图 -> 怎么切。{cross, off, boxes, sure, count, regions: [{ids, poly, empty}], a}
 *  cross 模式：十字（off 里的胳膊不要）；boxes 模式（只有一张、或者摆法十字装不下）：一张纸一个框，不能拖。 */
export function layout(image) {
  const a = analyze(image);
  const found = findIn(a), papers = sheets(a);
  const result = (cross, off, owner) => {
    const empty = emptyIn(a, cross);
    const list = tighten(regions(cross, off).map((r, i) => ({ ...r, empty: (!owner || owner[i] < 0) && r.ids.every((q) => empty[q]) })), owner && papers);
    return { cross, off, boxes: null, sure: found.sure || !!owner, count: list.filter((r) => !r.empty).length, regions: list, a, papers: owner ? papers : null };
  };
  if (!papers) return result(found.cross, { ...WHOLE }, null);         // 分不开：照十字缝切
  if (papers.length === 1) {
    const j = joined(a, papers[0]);
    if (j.how === 'cross') return result(found.cross, { ...WHOLE }, null);
    if (j.how !== 'one') {                                              // 两张挨着：只切中间那一刀
      const mid = [[0.5, 0.5], [0.5, 0.5]], line = [j.line, j.line], side = j.how === 'sides';
      const cross = side ? { v: line, h: mid } : { v: mid, h: line };
      return result(cross, { top: !side, bottom: !side, left: side, right: side }, [0, 0]);
    }
  } else {
    const whole = holds(regions(found.cross), papers);
    if (found.sure && whole) return result(found.cross, { ...WHOLE }, whole);
    for (const [cross, off] of byPapers(papers, found.cross)) {
      const owner = holds(regions(cross, off), papers);
      if (owner && owner.filter((k) => k >= 0).length === papers.length) return result(cross, off, owner);
    }
    if (whole) return result(found.cross, { ...WHOLE }, whole);
  }
  const order = [...papers].sort((p, q) => {                            // 先上后下、一排里先左后右
    const dy = (p.box[1] + p.box[3] - q.box[1] - q.box[3]) / 2;
    return Math.abs(dy) > 0.2 ? dy : p.box[0] - q.box[0];
  });
  return { cross: found.cross, off: { ...WHOLE }, boxes: order.map((p) => p.poly), sure: true, count: order.length,
    regions: order.map((p, i) => ({ ids: [i], poly: p.poly, empty: false })), a };
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
