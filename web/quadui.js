// 「一张拍四份」：照片进来先切开（最多四张；只摆了两三张就切两三张），给人看切出来的小图和那道十字（能拖），再进列表照常认。
// 找纸、找缝在 quad.js（只看像素）；列表、开工还是 app.js 管，这里只通过 host 跟它打交道。
import './strings.js';
import * as Q from './quad.js';
import * as I from './image.js';

const t = (k, v) => globalThis.LURU_I18N.t(k, v);
export const HOLD = 3000;                  // 来图就干：切好以后等这么久（碰了十字就从放手那刻重新数）
const VIEW_SIDE = 800;                     // 预览、小图用的缩小图（手机上一批十几张，别吃太多内存）
const CUT_SIDE = 2560;                     // 切出来那张最长边（手机 1200 万像素拍的，一块本来就两千上下）
const BLEED = 0.006;                       // 沿缝多留一丝：缝认偏一点点也不切到字
const AT = ['quad.tl', 'quad.tr', 'quad.bl', 'quad.br'];
const PAIR = { '0,1': 'quad.top', '2,3': 'quad.bottom', '0,2': 'quad.left', '1,3': 'quad.right' };     // 少一条胳膊，两格合成一块
const where = (ids) => t(ids.length === 1 ? AT[ids[0]] : PAIR[ids.join(',')]);
const full = (s) => s.regions.filter((r) => !r.empty).length;
const ARMS = ['top', 'bottom', 'left', 'right', 'center'];
const SVG = 'http://www.w3.org/2000/svg';

/** 从原图上把一块多边形（比例坐标）抠出来：外面垫白，隔壁那张纸漏不进来。tight：只要这一框里头的 */
export async function cutOut(img, poly, file, tight) {
  const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
  const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length, cy = poly.reduce((s, p) => s + p[1], 0) / poly.length;
  const grow = (v, c) => Math.min(1, Math.max(0, v + (v > c ? BLEED : -BLEED)));
  const pts = poly.map(([x, y]) => [grow(x, cx) * W, grow(y, cy) * H]);
  let [x0, y0, x1, y1] = Q.frame(pts);
  if (tight) [x0, y0, x1, y1] = [Math.max(x0, tight[0] * W), Math.max(y0, tight[1] * H), Math.min(x1, tight[2] * W), Math.min(y1, tight[3] * H)];
  [x0, y0, x1, y1] = [Math.floor(x0), Math.floor(y0), Math.ceil(x1), Math.ceil(y1)];
  const sw = Math.max(1, x1 - x0), sh = Math.max(1, y1 - y0), k = Math.min(1, CUT_SIDE / Math.max(sw, sh));
  const c = I.canvas(Math.max(1, Math.round(sw * k)), Math.max(1, Math.round(sh * k)));
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  g.beginPath();
  pts.forEach(([x, y], i) => g[i ? 'lineTo' : 'moveTo']((x - x0) * k, (y - y0) * k));
  g.closePath();
  g.clip();
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, x0, y0, sw, sh, 0, 0, c.width, c.height);
  const blob = await I.toBlob(c, 0.95);
  return new File([blob], file.name, { type: 'image/jpeg', lastModified: file.lastModified });
}

export class Quad {
  /** host：
   *  log(话) · auto(sheet) 这张切好了会不会自己开工 · put(files, sheet) 进列表 -> 列表里那几项 ·
   *  swap(sheet, files) 拖过十字，换掉那几项 · go(sheet) 等够了，开工 · keep(sheet) / unkeep(sheet) 原图先存一份、切完删掉 */
  constructor(root, host) {
    this.root = root;
    this.host = host;
    this.sheets = [];
    this.cur = null;
    this.keeping = new Set();                // 原图还存着的（没切完）
    this.chain = Promise.resolve();
    this.last = 0;                          // 上一张原图用掉的时间戳：切出来的按它排号
    this.gen = 0;                           // 点过「清空」：还在切的那些作废
    this.build();
  }

  // ------------------------------------------------------------ 进来一张
  add(file, meta) {
    const gen = this.gen, sheet = { ...meta, file, name: file.name, items: [], cross: null, regions: [], holding: false, busy: 0, timer: 0, left: 0 };
    this.keeping.add(sheet);
    const kept = this.host.keep(sheet);                 // 原图先存进浏览器：切到一半页面被手机杀了也丢不了
    this.chain = this.chain.then(() => (gen === this.gen ? this.split(sheet, gen) : null)).catch((e) => { console.error(e); });
    return kept;
  }

  unkeep(sheet) { this.keeping.delete(sheet); this.host.unkeep(sheet); }

  /** 还在切的都切完 */
  async settled() { let p; do { p = this.chain; await p; } while (p !== this.chain); }

  async split(sheet, gen) {
    const t0 = performance.now();
    let img;
    try {
      img = await I.openImage(sheet.file);
      sheet.view = I.draw(img, VIEW_SIDE);
      if (I.isBlank(sheet.view)) {                      // 163 白纸：不切、不认、不查重
        if (gen === this.gen) { this.host.blank(sheet, I.flatness(sheet.view)); this.unkeep(sheet); }
        return;
      }
      const small = I.draw(sheet.view, Q.FIND_SIDE);
      const r = Q.layout(small.getContext('2d').getImageData(0, 0, small.width, small.height));
      const { w, h, V, dark, top } = r.a;                 // 拖十字时重看哪块空着，只要这几样
      Object.assign(sheet, { cross: r.cross, off: r.off, boxes: r.boxes, papers: r.papers, sure: r.sure, regions: r.regions, pixels: { w, h, V, dark, top } });
    } catch (e) {
      if (gen === this.gen) this.whole(sheet, e);
      return;
    }
    if (gen !== this.gen) return;
    sheet.holding = this.host.auto(sheet);
    sheet.busy = 1;                                     // 四张图还没做好：先别开工
    this.sheets.push(sheet);
    this.cur = sheet;
    this.render();
    sheet.shownMs = Math.round(performance.now() - t0);     // 从拿到照片到四块小图、十字摆出来用了多久
    this.root.dataset.shownMs = String(sheet.shownMs);
    if (!this.root.hidden && this.root.getBoundingClientRect().bottom > innerHeight) this.root.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    await new Promise((ok) => setTimeout(ok, 0));       // 让浏览器先画出来，再慢慢做大图
    if (!sheet.sure) this.host.log(t('log.quadUnsure', { name: sheet.name }));
    for (const g of sheet.regions) if (g.empty) this.host.log(t('log.quadEmpty', { name: sheet.name, where: where(g.ids) }));
    if (sheet.regions.length < 4) this.host.log(t('log.quadFound', { name: sheet.name, n: full(sheet) }));
    let shot = await I.shotTime(sheet.file);
    shot = Math.max(shot || Date.now(), this.last + 10);
    this.last = sheet.shot = shot;
    let files;
    try { files = await this.files(sheet, img); } catch (e) { if (gen === this.gen) this.whole(sheet, e); return; }
    if (gen !== this.gen) return;
    sheet.items = this.host.put(files, sheet);
    sheet.busy--;
    this.unkeep(sheet);
    this.arm(sheet);
    this.render();
  }

  /** 打不开、切不了（内存不够之类）：整张照旧进列表，认的时候该报什么报什么。照片不能因为切不开就没了 */
  whole(sheet, e) {
    this.host.log(t('log.quadBad', { name: sheet.name, e: e.message }));
    this.remove(sheet);
    sheet.holding = false;
    sheet.busy = 0;
    sheet.items = this.host.put([sheet.file], sheet);
    this.unkeep(sheet);
    this.host.go(sheet);
  }

  /** 照现在的切法切出要认的那几张（空块不要）：原名_1…_4 = 左上、右上、左下、右下（合起来的一块用它靠前的那个号） */
  async files(sheet, img) {
    const dot = sheet.name.lastIndexOf('.'), stem = dot > 0 ? sheet.name.slice(0, dot) : sheet.name;
    const out = [];
    for (const { ids, poly, empty, tight } of sheet.regions) {
      if (!empty) out.push(await cutOut(img, poly, { name: `${stem}_${ids[0] + 1}.jpg`, lastModified: sheet.shot + ids[0] }, tight));
    }
    return out;
  }

  // ------------------------------------------------------------ 等一等再开工
  arm(sheet) {
    clearInterval(sheet.timer);
    if (!sheet.holding || sheet.busy || !this.sheets.includes(sheet)) return;
    const until = performance.now() + HOLD;
    sheet.left = Math.ceil(HOLD / 1000);
    sheet.timer = setInterval(() => {
      const rest = until - performance.now();
      if (rest <= 0) { this.release(sheet); return; }
      const s = Math.ceil(rest / 1000);
      if (s !== sheet.left) { sheet.left = s; this.note(); }
    }, 100);
    this.note();
  }

  release(sheet) {
    clearInterval(sheet.timer);
    if (!sheet.holding) return;
    sheet.holding = false;
    this.host.go(sheet);
    this.render();
  }

  /** 人点了「开始工作」：等着的都不用等了 */
  releaseAll() {
    for (const s of this.sheets) {
      clearInterval(s.timer);
      s.holding = false;
      for (const q of s.items) q.hold = false;
    }
    this.render();
  }

  /** 这张的四块还能不能拖：都还在列表里、没被哪一批拿走 */
  free(sheet) { return !sheet.items.length || sheet.items.every((q) => !q.taken && !q.gone); }

  /** 列表里少了一项（认完了、查重掉了）：一张原图的几块都没了就从预览里撤掉 -> 撤掉了没有 */
  gone(sheet) {
    if (!sheet.items.length || !sheet.items.every((q) => q.gone) || sheet.busy) return false;
    this.remove(sheet);
    return true;
  }

  remove(sheet) {
    clearInterval(sheet.timer);
    const i = this.sheets.indexOf(sheet);
    if (i < 0) return;
    this.sheets.splice(i, 1);
    if (this.cur === sheet) this.cur = this.sheets[Math.min(i, this.sheets.length - 1)] || null;
    this.render();
  }

  clear() {
    this.gen++;
    for (const s of this.sheets) clearInterval(s.timer);
    for (const s of [...this.keeping]) this.unkeep(s);
    this.sheets = [];
    this.cur = null;
    this.grab = null;
    this.render();
  }

  // ------------------------------------------------------------ 画面
  build() {
    const el = (tag, cls, parent, text) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text) e.textContent = text;
      if (parent) parent.appendChild(e);
      return e;
    };
    const head = el('div', 'qhead', this.root);
    this.title = el('span', 'qtitle', head);
    this.pager = el('span', 'qpager', head);
    this.prev = el('button', 'pill small', this.pager, '◀');
    this.num = el('span', 'qnum', this.pager);
    this.next = el('button', 'pill small', this.pager, '▶');
    for (const [b, d] of [[this.prev, -1], [this.next, 1]]) {
      b.type = 'button';
      b.onclick = () => {
        const i = this.sheets.indexOf(this.cur) + d;
        if (this.sheets[i]) { this.cur = this.sheets[i]; this.render(); }
      };
    }
    this.stage = el('div', 'qstage', this.root);
    this.canvas = el('canvas', '', this.stage);
    this.svg = document.createElementNS(SVG, 'svg');
    this.svg.setAttribute('preserveAspectRatio', 'none');
    this.stage.appendChild(this.svg);
    this.handles = Object.fromEntries(ARMS.map((a) => {
      const h = el('div', `qarm q-${a}`, this.stage);
      h.dataset.arm = a;
      el('i', '', h);
      h.addEventListener('pointerdown', (e) => this.down(e, a));
      h.addEventListener('pointermove', (e) => this.move(e));
      for (const up of ['pointerup', 'pointercancel']) h.addEventListener(up, (e) => this.up(e));
      return [a, h];
    }));
    this.thumbs = el('div', 'qthumbs', this.root);
    this.cells = AT.map(() => {
      const f = el('figure', '', this.thumbs);
      const c = el('canvas', '', f);
      return { f, c, cap: el('figcaption', '', f) };
    });
    this.line = el('div', 'qnote', this.root);
    new ResizeObserver(() => this.place()).observe(this.stage);
  }

  render() {
    const s = this.cur;
    this.root.hidden = !s;
    if (!s) return;
    const i = this.sheets.indexOf(s), v = s.view;
    this.title.textContent = t('quad.title', { name: s.name, n: full(s) });
    this.pager.hidden = this.sheets.length < 2;
    this.num.textContent = `${i + 1}/${this.sheets.length}`;
    this.prev.disabled = i <= 0;
    this.next.disabled = i >= this.sheets.length - 1;
    this.prev.setAttribute('aria-label', t('quad.prev'));
    this.next.setAttribute('aria-label', t('quad.next'));
    if (this.drawn !== s) {
      this.drawn = s;
      this.canvas.width = v.width;
      this.canvas.height = v.height;
      this.canvas.getContext('2d').drawImage(v, 0, 0);
      this.stage.style.aspectRatio = `${v.width} / ${v.height}`;
      this.stage.style.maxWidth = `calc(46vh * ${(v.width / v.height).toFixed(4)})`;
      this.svg.setAttribute('viewBox', `0 0 ${v.width} ${v.height}`);
    }
    this.place();
    this.small();
    this.note();
  }

  note() {
    const s = this.cur;
    if (!s) return;
    const box = s.boxes ? 'Box' : '';                  // 一张纸一个框的：没有十字可拖
    const text = !this.free(s) ? (s.items.some((q) => q.taken) ? t('quad.locked') : '')
      : s.holding ? (s.busy ? t('quad.cutting') : t(box ? 'quad.waitBox' : 'quad.wait', { s: s.left }))
        : t(box ? 'quad.manualBox' : 'quad.manual');
    if (this.line.textContent !== text) this.line.textContent = text;
  }

  place() {                                 // 线和抓手摆到十字现在的位置上
    const s = this.cur;
    if (!s || this.root.hidden) return;
    const { width: W, height: H } = s.view, free = this.free(s);
    this.svg.textContent = '';
    const add = (tag, attrs) => {
      const e = document.createElementNS(SVG, tag);
      for (const [k, val] of Object.entries(attrs)) e.setAttribute(k, val);
      this.svg.appendChild(e);
      return e;
    };
    const points = (p) => p.map(([x, y]) => `${x * W},${y * H}`).join(' ');
    for (const g of s.regions) if (g.empty) add('polygon', { class: 'qoff', points: points(g.poly) });
    const arms = Q.arms(s.cross), off = s.off;
    const [vt, vb] = s.cross.v, [hl, hr] = s.cross.h;
    const ends = [];
    if (!s.boxes) {
      if (!off.top) ends.push([[vt[0], 0], Q.meet(vt, hl)]);
      if (!off.bottom) ends.push([Q.meet(vb, hl), [vb[1], 1]]);
      if (!off.left) ends.push([[0, hl[0]], Q.meet(vt, hl)]);
      if (!off.right) ends.push([Q.meet(vt, hr), [1, hr[1]]]);
      // 上下（左右）错开时中间有一小截台阶：沿着另一道缝把两头连上
      if (!off.left || !off.right) ends.push([Q.meet(vt, hl), Q.meet(vt, hr)], [Q.meet(vb, hl), Q.meet(vb, hr)]);
      if (!off.top || !off.bottom) ends.push([Q.meet(vt, hl), Q.meet(vb, hl)], [Q.meet(vt, hr), Q.meet(vb, hr)]);
    }
    for (const cls of ['qhalo', 'qline']) {
      for (const [[x1, y1], [x2, y2]] of ends) add('line', { class: cls, x1: x1 * W, y1: y1 * H, x2: x2 * W, y2: y2 * H });
      if (s.boxes) for (const g of s.regions) add('polygon', { class: cls, points: points(g.poly) });
    }
    for (const g of s.regions) {
      const x = (g.poly.reduce((a, q) => a + q[0], 0) / g.poly.length) * W, y = (g.poly.reduce((a, q) => a + q[1], 0) / g.poly.length) * H;
      add('text', { class: g.empty ? 'qno off' : 'qno', x, y }).textContent = g.empty ? t('empty') : String(g.ids[0] + 1);
    }
    const box = this.stage.getBoundingClientRect(), bw = box.width, bh = box.height;
    const cut = { v: !off.top || !off.bottom, h: !off.left || !off.right };
    for (const a of ARMS) {
      const h = this.handles[a];
      h.hidden = !free || !!s.boxes || (a === 'center' ? !(cut.v && cut.h) : off[a]);
      if (a === 'center') { h.style.left = `${arms.center[0] * 100}%`; h.style.top = `${arms.center[1] * 100}%`; continue; }
      const [[x1, y1], [x2, y2]] = arms[a];
      const dx = (x2 - x1) * bw, dy = (y2 - y1) * bh;
      h.style.left = `${((x1 + x2) / 2) * 100}%`;
      h.style.top = `${((y1 + y2) / 2) * 100}%`;
      h.style.width = `${Math.hypot(dx, dy)}px`;
      h.style.transform = `translate(-50%, -50%) rotate(${Math.atan2(dy, dx)}rad)`;
    }
  }

  small() {                                 // 切出来的小图
    const s = this.cur;
    this.cells.forEach(({ f, c, cap }, i) => {
      const g0 = s.regions[i];
      f.hidden = !g0;
      if (!g0) return;
      const { ids, poly, empty, tight } = g0;
      const W = s.view.width, H = s.view.height, [px0, py0, px1, py1] = Q.frame(poly), [a0, b0, a1, b1] = tight || [0, 0, 1, 1];
      const x0 = Math.max(px0, a0) * W, y0 = Math.max(py0, b0) * H;
      const sw = Math.max(1, Math.min(px1, a1) * W - x0), sh = Math.max(1, Math.min(py1, b1) * H - y0);
      const k = Math.min(1, 240 / Math.max(sw, sh));
      c.width = Math.max(1, Math.round(sw * k));
      c.height = Math.max(1, Math.round(sh * k));
      const g = c.getContext('2d');
      g.beginPath();
      poly.forEach(([x, y], n) => g[n ? 'lineTo' : 'moveTo']((x * W - x0) * k, (y * H - y0) * k));
      g.closePath();
      g.clip();
      g.drawImage(s.view, x0, y0, sw, sh, 0, 0, c.width, c.height);
      f.classList.toggle('off', empty);
      cap.textContent = s.boxes ? t('quad.nth', { n: i + 1 })
        : empty ? t('quad.off', { n: ids[0] + 1, where: where(ids) }) : `${ids[0] + 1} ${where(ids)}`;
    });
  }

  // ------------------------------------------------------------ 手拖
  recount(s) {                              // 十字挪了：哪几块、哪块空着重新算
    const empty = Q.emptyIn(s.pixels, s.cross);
    s.regions = Q.tighten(Q.regions(s.cross, s.off).map((g) => ({ ...g, empty: g.ids.every((q) => empty[q]) })), s.papers);
  }

  down(e, arm) {
    const s = this.cur;
    if (!s || this.grab || !this.free(s) || (s.busy && !s.items.length)) return;
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* 老浏览器 */ }
    clearInterval(s.timer);
    this.grab = { s, arm, id: e.pointerId, x: e.clientX, y: e.clientY, cross: s.cross, moved: false };
    s.busy++;                               // 手没放开、没切完：不开工
    for (const q of s.items) q.hold = true;
    this.note();
  }

  move(e) {
    const g = this.grab;
    if (!g || e.pointerId !== g.id) return;
    const box = this.stage.getBoundingClientRect();
    const dx = (e.clientX - g.x) / box.width, dy = (e.clientY - g.y) / box.height;
    if (!g.moved && Math.hypot(e.clientX - g.x, e.clientY - g.y) < 3) return;
    g.moved = true;
    g.s.cross = Q.drag(g.cross, g.arm, dx, dy);
    this.recount(g.s);
    this.place();
    this.small();
  }

  up(e) {
    const g = this.grab;
    if (!g || e.pointerId !== g.id) return;
    this.grab = null;
    const s = g.s;
    if (!g.moved) {                          // 只是碰了一下
      s.busy--;
      if (!s.holding && !s.busy) for (const q of s.items) q.hold = false;
      this.arm(s);
      this.note();
      return;
    }
    if (!this.free(s)) {                     // 手还按着，那边已经点了开始：认的是原来的切法，十字放回去
      s.cross = g.cross;
      this.recount(s);
      s.busy--;
      this.render();
      return;
    }
    this.recount(s);
    this.place();
    this.small();
    const gen = this.gen;
    this.chain = this.chain.then(async () => {
      if (gen !== this.gen || !this.free(s)) return;
      const files = await this.files(s, await I.openImage(s.file));
      if (gen !== this.gen) return;
      s.items = this.host.swap(s, files);
      this.host.log(t('log.quadRecut', { name: s.name, n: files.length }));
    }).catch((err) => { this.host.log(t('log.quadBad', { name: s.name, e: err.message })); })
      .finally(() => {
        s.busy--;
        if (!s.holding && !s.busy) for (const q of s.items) q.hold = false;
        this.arm(s);
        this.render();
      });
  }
}
