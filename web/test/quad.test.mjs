// 147 一张拍四份：找缝。跑：node --test web/test/quad.test.mjs
// 假的四联图自己画（桌面 + 四张带表格线和字的纸），知道每张纸在哪儿：切出来的四块要把各自那张纸整个装下。
import test from 'node:test';
import assert from 'node:assert/strict';
import { FIND_SIDE, findCross, layout, quads, regions, inside, drag, arms, meet, CENTER } from '../quad.js';

let seed = 1;
const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
const noise = (v, n) => Math.max(0, Math.min(255, v + (rnd() - 0.5) * n));

const DESKS = {
  dark: () => () => [noise(58, 14), noise(56, 14), noise(60, 14)],
  wood: () => (x, y) => {
    const g = 18 * Math.sin(y / 7 + 3 * Math.sin(x / 90)) + 10 * Math.sin(y / 2.3);
    return [noise(150 + g, 16), noise(105 + g * 0.8, 16), noise(66 + g * 0.5, 16)];
  },
  flowers: () => {                                  // 花桌布：深底上一堆大小、颜色不一的花
    const f = Array.from({ length: 260 }, () => ({ x: rnd() * 900, y: rnd() * 900, r: 4 + rnd() * 22,
      c: [[200, 60, 80], [240, 190, 60], [70, 130, 190], [90, 160, 90], [235, 225, 215], [150, 80, 160]][Math.floor(rnd() * 6)] }));
    return (x, y) => {
      for (const o of f) if ((x - o.x) ** 2 + (y - o.y) ** 2 < o.r * o.r) return o.c.map((v) => noise(v, 20));
      return [noise(70, 20), noise(50, 20), noise(55, 20)];
    };
  },
  white: () => () => [noise(236, 6), noise(235, 6), noise(232, 6)],
};

/** papers：[{cx, cy, w, h, deg}]（比例坐标按图宽高）；null = 那一块没纸 */
function picture({ w = FIND_SIDE, h = 600, desk = 'dark', papers, s = 1 }) {
  seed = s;
  const data = new Uint8ClampedArray(w * h * 4), bg = DESKS[desk]();
  const sheets = papers.map((p) => {
    if (!p) return null;
    const a = ((p.deg || 0) * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
    const lines = 7 + Math.floor(rnd() * 5);
    const words = Array.from({ length: lines * 6 }, (_, i) => ({ r: Math.floor(i / 6), c: i % 6, len: 0.3 + rnd() * 0.6, on: rnd() < 0.75 }));
    return { ...p, cos, sin, W: p.w * w, H: p.h * h, X: p.cx * w, Y: p.cy * h, lines, words };
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let c = bg(x, y);
      for (const p of sheets) {
        if (!p) continue;
        const dx = x - p.X, dy = y - p.Y;
        const u = (dx * p.cos + dy * p.sin) / p.W + 0.5, v = (-dx * p.sin + dy * p.cos) / p.H + 0.5;
        if (u < 0 || u > 1 || v < 0 || v > 1) continue;
        let g = noise(245, 7);
        if (u > 0.07 && u < 0.93 && v > 0.1 && v < 0.92) {            // 表格 + 字
          const row = ((v - 0.1) / 0.82) * p.lines, col = ((u - 0.07) / 0.86) * 6;
          if ((row % 1) * (0.82 * p.H / p.lines) < 1.2 || (col % 1) * (0.86 * p.W / 6) < 1.1) g = 90;
          const word = p.words[Math.floor(row) * 6 + Math.floor(col)];
          const fu = col % 1, fv = row % 1;
          if (word && word.on && fv > 0.35 && fv < 0.75 && fu > 0.15 && fu < 0.15 + word.len * 0.75
              && Math.sin((x + y * 0.3) * 2.1) + Math.sin(y * 1.7) > 0.2) g = 45;
        }
        c = [g, g, g - 2];
      }
      const i = (y * w + x) * 4;
      data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h, sheets };
}

/** 十字摆：缝在 (x, y)，缝宽 gap（占宽/高的比例），四张纸大小 pw × ph，整个转 deg 度，each：每张自己再歪多少，shiftTop/Bottom：上下两排各自左右错开 */
function four({ x = 0.5, y = 0.5, gap = 0.05, pw = 0.4, ph = 0.4, deg = 0, each = [0, 0, 0, 0], top = 0, bottom = 0, w = FIND_SIDE, h = 600, skip = [] } = {}) {
  const a = (deg * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  return [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([i, j], n) => {
    if (skip.includes(n)) return null;
    const dx = (i * (gap / 2 + pw / 2) + (j < 0 ? top : bottom)) * w, dy = j * (gap / 2 + ph / 2) * h;
    return { cx: x + (dx * cos - dy * sin) / w, cy: y + (dx * sin + dy * cos) / h, w: pw, h: ph, deg: deg + each[n] };
  });
}

/** 一张纸有多少落在这个多边形里（在照片外面的不算）。part：只看纸的这一部分（[左, 右, 上, 下]） */
function coveredBy(img, p, poly, part = [0, 1, 0, 1]) {
  let all = 0, ok = 0;
  for (let i = 0; i <= 80; i++) {
    for (let j = 0; j <= 80; j++) {
      const dx = (part[0] + (i / 80) * (part[1] - part[0]) - 0.5) * p.W, dy = (part[2] + (j / 80) * (part[3] - part[2]) - 0.5) * p.H;
      const x = (p.X + dx * p.cos - dy * p.sin) / img.width, y = (p.Y + dx * p.sin + dy * p.cos) / img.height;
      if (x < 0 || x > 1 || y < 0 || y > 1) continue;
      all++;
      if (inside(poly, x, y)) ok++;
    }
  }
  return ok / all;
}

/** 每张纸有多少落在自己那一格里 */
function covered(img, cross, part) {
  const q = quads(cross);
  return img.sheets.map((p, n) => (p ? coveredBy(img, p, q[n], part) : null));
}

/** 148 页面用的切法 layout()：认的块数 = 纸数，每张纸整个在某一块里，一块只装一张 */
function whole(img, l, name, touching = false) {
  const live = l.regions.filter((g) => !g.empty);
  const sheets = img.sheets.filter(Boolean);
  assert.equal(live.length, sheets.length, `${name}：切成 ${live.length} 块 ${JSON.stringify(l.regions.map((g) => [g.ids, g.empty]))}`);
  const used = new Set();
  for (const [n, p] of img.sheets.entries()) {
    if (!p) continue;
    const part = touching ? [0.07, 0.93, 0.1, 0.92] : [0.01, 0.99, 0.01, 0.99];
    // 收紧到纸边的块（tight）：纸也得整个在那个框里
    const crop = (g) => (g.tight ? Math.min(coveredBy(img, p, g.poly, part), coveredBy(img, p, [[g.tight[0], g.tight[1]], [g.tight[2], g.tight[1]],
      [g.tight[2], g.tight[3]], [g.tight[0], g.tight[3]]], part)) : coveredBy(img, p, g.poly, part));
    const best = live.map((g, i) => [crop(g), i]).sort((x, y) => y[0] - x[0])[0];
    assert.ok(best[0] >= (touching ? 0.999 : 0.985), `${name}：第 ${n + 1} 张只装下 ${(best[0] * 100).toFixed(1)}%（切开了）${JSON.stringify(l.cross)} ${JSON.stringify(l.off)}`);
    assert.ok(!used.has(best[1]), `${name}：两张纸装进了同一块`);
    used.add(best[1]);
  }
}

const CASES = [
  ['正的', { desk: 'dark' }, {}],
  ['斜 5°', { desk: 'dark', h: 800 }, { deg: 5, h: 800, pw: 0.37, ph: 0.37, gap: 0.06 }],
  ['斜 -5°，木桌', { desk: 'wood' }, { deg: -5, pw: 0.37, ph: 0.37, gap: 0.06 }],
  ['缝窄', { desk: 'dark' }, { gap: 0.008, pw: 0.44, ph: 0.44 }],
  ['缝宽', { desk: 'wood' }, { gap: 0.16, pw: 0.36, ph: 0.36 }],
  ['背景花', { desk: 'flowers' }, { gap: 0.06, pw: 0.39, ph: 0.39 }],
  ['缝不在正中间', { desk: 'dark' }, { x: 0.41, y: 0.59, gap: 0.03, pw: 0.36, ph: 0.36 }],
  ['各歪各的', { desk: 'wood' }, { gap: 0.09, pw: 0.37, ph: 0.37, each: [4, -3, -5, 3] }],
  ['上下两排错开', { desk: 'dark' }, { gap: 0.04, pw: 0.34, ph: 0.42, top: -0.09, bottom: 0.09 }],
  ['白桌面', { desk: 'white' }, { gap: 0.07, pw: 0.4, ph: 0.4 }],
  ['纸挨着纸', { desk: 'dark' }, { gap: 0, pw: 0.45, ph: 0.45 }],
  ['竖着拍', { desk: 'flowers', w: 600, h: 800 }, { w: 600, h: 800, x: 0.54, y: 0.47, gap: 0.04, pw: 0.38, ph: 0.41, deg: 3 }],
  ['缝窄又斜', { desk: 'wood' }, { gap: 0.015, pw: 0.41, ph: 0.41, deg: 4 }],
];

for (const [name, desk, lay] of CASES) {
  test(`找缝：${name}`, () => {
    for (const s of [1, 7, 23]) {                       // 同一种摆法换三套花纹、字
      seed = s * 100;
      const img = picture({ ...desk, papers: four(lay), s });
      const r = findCross(img);
      // 挨着的两张之间没有缝，切在两张的白边正中间：白边切掉一丝不要紧，表格和字一点不能切到
      const c = lay.gap === 0 ? covered(img, r.cross, [0.07, 0.93, 0.1, 0.92]) : covered(img, r.cross);
      assert.ok(r.sure, `${name} #${s} 说没找准：${JSON.stringify(r.cross)}`);
      for (const [n, v] of c.entries()) assert.ok(v >= (lay.gap === 0 ? 1 : 0.985), `${name} #${s} 第 ${n + 1} 张只装下 ${(v * 100).toFixed(1)}%：${JSON.stringify(r.cross)}`);
      assert.deepEqual(r.empty, [false, false, false, false], `${name} #${s} 说有空块`);
      const l = layout(img);                            // 页面实际走的是这个：四张照样一张一块
      whole(img, l, `${name} #${s}`, lay.gap === 0);
    }
  });
}

for (const desk of ['dark', 'wood', 'flowers', 'white']) {
  for (const gone of [0, 1, 2, 3]) {
    test(`空的那块会跳过：${desk} 少第 ${gone + 1} 张`, () => {
      const img = picture({ desk, papers: four({ gap: 0.06, pw: 0.39, ph: 0.39, skip: [gone] }), s: gone + 3 });
      const r = findCross(img);
      for (const [n, v] of covered(img, r.cross).entries()) if (v !== null) assert.ok(v >= 0.985, `第 ${n + 1} 张只装下 ${v}：${JSON.stringify(r.cross)}`);
      const want = [0, 1, 2, 3].map((n) => n === gone);
      if (desk === 'flowers') {                          // 花桌布上的空块认不准没关系（认了也是「没认出」），有纸的绝不能跳
        r.empty.forEach((e, n) => { if (n !== gone) assert.equal(e, false); });
      } else assert.deepEqual(r.empty, want);
    });
  }
}

// ---------------------------------------------------------------- 148 最后只剩两三张（照 Song 那几张拼图的摆法）
const at = (cx, cy, deg = 0, w = 0.38, h = 0.4) => ({ cx, cy, w, h, deg });
const FEW = [
  ['二联：左右并排摆在上下正中（C）', [at(0.27, 0.5, 1.5), at(0.73, 0.5, -2), null, null], 2],
  ['二联：上下叠摆在左右正中', [at(0.5, 0.27, -2), null, at(0.5, 0.74, 1), null], 2],
  ['二联：斜对角', [at(0.27, 0.27, 2), null, null, at(0.74, 0.73, -1.5)], 2],
  ['三联：三格，右下空着（D）', [at(0.27, 0.27, 1), at(0.73, 0.27, -2), at(0.27, 0.73, 2), null], 3],
  ['三联：上两张，下一张摆在左右正中（F）', [at(0.26, 0.27, -1), at(0.74, 0.27, 2), at(0.5, 0.74, 1), null], 3],
  ['三联：上一张摆在正中，下两张', [at(0.5, 0.26, 2), null, at(0.26, 0.74, -1), at(0.74, 0.73, 1.5)], 3],
  ['三联：左两张，右一张摆在上下正中', [at(0.26, 0.26, 1), at(0.74, 0.5, -2), at(0.26, 0.74, -1), null], 3],
  ['只剩一张，摆在正中', [at(0.5, 0.5, 3, 0.5, 0.55), null, null, null], 1],
  ['只剩一张，拍得近', [at(0.5, 0.5, -2, 0.8, 0.82), null, null, null], 1],
];
for (const desk of ['dark', 'wood', 'flowers']) {
  for (const [name, papers, n] of FEW) {
    test(`少几张：${desk} · ${name}`, () => {
      for (const s of [2, 9]) {
        const img = picture({ desk, papers, s });
        const l = layout(img);
        assert.equal(l.count, n);
        whole(img, l, `${desk} ${name} #${s}`);
      }
    });
  }
}

test('两张挨在一起、分不开：沿着中间那一刀切成两张', () => {
  const img = picture({ desk: 'dark', papers: [at(0.29, 0.5, 0, 0.42, 0.45), at(0.71, 0.5, 0, 0.42, 0.45), null, null], s: 4 });
  const l = layout(img);
  whole(img, l, '挨着两张', true);
});

test('少几张时的十字：没用的胳膊不画不拖，合起来的块盖满整张照片', () => {
  const cross = { v: [[0.5, 0.5], [0.5, 0.5]], h: [[0.5, 0.5], [0.5, 0.5]] };
  const area = (p) => Math.abs(p.reduce((a, [x, y], i) => { const [x2, y2] = p[(i + 1) % p.length]; return a + x * y2 - x2 * y; }, 0)) / 2;
  for (const off of [{ bottom: true }, { top: true }, { left: true }, { right: true }, { left: true, right: true }, { top: true, bottom: true }]) {
    const g = regions(cross, off);
    assert.equal(g.length, Object.keys(off).length === 2 ? 2 : 3, JSON.stringify(off));
    assert.ok(Math.abs(g.reduce((a, r) => a + area(r.poly), 0) - 1) < 1e-9, JSON.stringify(off));
  }
  assert.deepEqual(regions(cross).map((g) => g.ids), [[0], [1], [2], [3]]);
});

test('只有桌面、没有缝：切正中间，说没找准，不把四块全跳过', () => {
  const r = findCross(picture({ desk: 'wood', papers: [null, null, null, null] }));
  assert.equal(r.sure, false);
  assert.deepEqual(r.cross, CENTER());
  assert.deepEqual(r.empty, [false, false, false, false]);
});

test('四块拼起来正好是整张照片', () => {
  const cross = { v: [[0.4, 0.45], [0.55, 0.6]], h: [[0.5, 0.52], [0.5, 0.52]] };
  const area = (p) => Math.abs(p.reduce((s, [x, y], i) => { const [x2, y2] = p[(i + 1) % p.length]; return s + x * y2 - x2 * y; }, 0)) / 2;
  const total = quads(cross).reduce((s, p) => s + area(p), 0);
  assert.ok(Math.abs(total - 1) < 0.01, String(total));
  const [x, y] = meet(cross.v[0], cross.h[0]);
  assert.ok(Math.abs(x - (0.4 + 0.05 * y)) < 1e-9 && Math.abs(y - (0.5 + 0.02 * x)) < 1e-9);
});

test('手拖：整条的缝整条挪；错开的只挪拖的那半；拖中间两道一起；拖不出照片', () => {
  const one = CENTER();
  const a = drag(one, 'top', 0.1, 0.3);
  assert.deepEqual(a.v, [[0.6, 0.6], [0.6, 0.6]]);
  assert.deepEqual(a.h, one.h);
  const two = { v: [[0.4, 0.4], [0.6, 0.6]], h: [[0.5, 0.5], [0.5, 0.5]] };
  const b = drag(two, 'bottom', -0.05, 0);
  assert.deepEqual(b.v.map((l) => l.map((n) => +n.toFixed(3))), [[0.4, 0.4], [0.55, 0.55]]);
  assert.deepEqual(drag(two, 'right', 0.2, 0.1).h.map((l) => +l[0].toFixed(3)), [0.6, 0.6]);
  const c = drag(two, 'center', 0.1, -0.1);
  assert.deepEqual([c.v[0][0], c.v[1][0], c.h[0][0]].map((n) => +n.toFixed(3)), [0.5, 0.7, 0.4]);
  assert.equal(drag(one, 'left', 0, 5).h[0][0], 0.92);
  assert.equal(drag(one, 'center', -5, -5).v[0][0], 0.08);
  assert.deepEqual(arms(one).center, [0.5, 0.5]);
});
