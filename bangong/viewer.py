"""核对窗口：一张一张看编号照片（第一张就是 1），右边列出表里同一号的记录，红的就是要看的。"""
from __future__ import annotations

import os
import re
import subprocess
import sys
import tkinter as tk
from datetime import datetime


from openpyxl import load_workbook
from PIL import Image, ImageTk

from . import engine
from . import macui as ui

LABELS = ['DATE', 'MACHINE', 'PART NUMBER', 'MO', 'OPR NO.', 'T NO.', 'DESCRIPTION', 'BTMP',
          'TOTAL SCREENED', 'PASSED', 'FAILED', 'SHIFT', 'SETTER']
RUN_RE = re.compile(r'\d{8}_\d{6}')


# ---------------------------------------------------------------- 数据（不碰 Tk，方便测试）
def load_photos(run_dir: str) -> dict[int, str]:
    out = {}
    if os.path.isdir(run_dir):
        for f in os.listdir(run_dir):
            m = re.fullmatch(r'(\d+)\.jpg', f, re.I)
            if m:
                out[int(m.group(1))] = os.path.join(run_dir, f)
    return out


def find_xlsx(folder: str, run_id: str) -> str:
    od = os.path.join(folder, engine.OUT_DIR)
    if not os.path.isdir(od):
        return ''
    c = sorted(f for f in os.listdir(od) if f.startswith(f'识别结果_{run_id}') and f.endswith('.xlsx'))
    return os.path.join(od, c[0]) if c else ''


def list_runs(folder: str) -> list[tuple[str, str, str]]:
    """[(批次号, 编号照片文件夹, 那一批的 Excel)]，新的在前。"""
    done = os.path.join(folder, engine.DONE_DIR)
    out = []
    if os.path.isdir(done):
        for name in sorted(os.listdir(done), reverse=True):
            d = os.path.join(done, name)
            if os.path.isdir(d) and RUN_RE.fullmatch(name) and load_photos(d):
                out.append((name, d, find_xlsx(folder, name)))
    return out


def fmt(v) -> str:
    if isinstance(v, datetime):
        return f'{v.day}-{v.strftime("%b")}'
    return '' if v is None else str(v)


def load_rows(xlsx: str) -> dict[int, list[dict]]:
    """{编号: [{'labels': 列名, 'values': 各列, 'red': 标红的列下标, 'fixed': 按库改过的, 'note': 核对提示}]}
    刀单那本（TOOL BROKEN RECORD，第 4 行起）和自建类别的表（第 2 行表头，第 3 行起）都认。"""
    rows: dict[int, list[dict]] = {}
    if not xlsx or not os.path.isfile(xlsx):
        return rows
    try:
        ws = load_workbook(xlsx).worksheets[0]
    except Exception:
        return rows
    if str(ws.cell(row=1, column=1).value or '').strip() == 'TOOL BROKEN RECORD':
        labels, first, start, note_col = LABELS, 2, 4, 15
    else:                                           # 自建类别：第 2 行是表头，最后一列是核对提示
        heads = []
        c = 2
        while c <= ws.max_column:
            h = ws.cell(row=2, column=c).value
            if h is None or str(h).startswith('核对提示'):
                break
            heads.append(str(h))
            c += 1
        labels, first, start, note_col = heads, 2, 3, 2 + len(heads)
    for r in range(start, ws.max_row + 1):
        no = ws.cell(row=r, column=1).value
        if not isinstance(no, int):
            continue
        vals, red, fixed = [], set(), set()
        for i in range(len(labels)):
            cell = ws.cell(row=r, column=first + i)
            vals.append(fmt(cell.value))
            rgb = cell.fill.fgColor.rgb if cell.fill is not None and cell.fill.fill_type == 'solid' else ''
            if isinstance(rgb, str) and rgb.upper().endswith('FFC7CE'):
                red.add(i)
            elif isinstance(rgb, str) and rgb.upper().endswith('FCE4D6'):
                fixed.add(i)
        note = ws.cell(row=r, column=note_col).value
        rows.setdefault(no, []).append({'labels': labels, 'values': vals, 'red': red, 'fixed': fixed,
                                        'note': '' if note is None else str(note)})
    return rows


def rotate_photo(path: str, clockwise: bool) -> None:
    """自动转正万一转错了：把这张编号照片在硬盘上转 90°（原图不动）。"""
    with Image.open(path) as im:
        im = im.convert('RGB').transpose(Image.Transpose.ROTATE_270 if clockwise else Image.Transpose.ROTATE_90)
    im.save(path, 'JPEG', quality=90)


def run_label(run_id: str, n: int) -> str:
    d = datetime.strptime(run_id, '%Y%m%d_%H%M%S')
    return f'{d:%Y-%m-%d %H:%M} 这批（{n} 张）'


def _open(p: str):
    try:
        if os.name == 'nt':
            os.startfile(p)  # type: ignore[attr-defined]
        else:
            subprocess.Popen(['xdg-open' if sys.platform != 'darwin' else 'open', p])
    except Exception:
        pass


# ---------------------------------------------------------------- 窗口
class Viewer(tk.Toplevel):
    def __init__(self, master, folder: str, run_dir: str | None = None, start: int | None = None):
        super().__init__(master)
        self.folder = folder
        self.geometry('1100x720')
        self.minsize(640, 420)
        self.runs = list_runs(folder)
        self.photos: dict[int, str] = {}
        self.nos: list[int] = []
        self.rows: dict[int, list[dict]] = {}
        self.cur = 0
        self._pil = None
        self._tk = None
        self._after = None
        self.configure(bg=ui.BG)
        fam = ui.family(self)
        bf = (fam, 10)
        if not self.runs:
            self.title('核对')
            tk.Label(self, text='还没有编号照片：先点「开始工作」干一批。', bg=ui.BG, fg=ui.TEXT, font=bf,
                     padx=30, pady=30).pack()
            return

        bar = ui.Card(self, pad=10, radius=14)
        bar.pack(fill='x', padx=14, pady=(14, 12))
        top = bar.body
        self.run_var = tk.StringVar()
        holder = ui.Combo(top, self.run_var, [run_label(r, len(load_photos(d))) for r, d, _ in self.runs],
                          font=bf, bg=ui.CARD, width=260)
        holder.pack(side='left')
        self.run_box = holder.box
        self.run_box.configure(state='readonly')
        self.run_box.bind('<<ComboboxSelected>>', lambda e: self.load_run(self.run_box.current()))
        ui.Pill(top, radius=8, bg=ui.CARD, height=38, padx=16, text='◀ 上一张', command=lambda: self.step(-1), font=bf).pack(side='left', padx=(12, 6))
        self.num = tk.StringVar()
        box = ui.Field(top, self.num, font=bf, bg=ui.CARD)
        box.configure(width=64)
        box.pack(side='left')
        self.entry = box.entry
        self.entry.configure(justify='center')
        self.entry.bind('<Return>', lambda e: self.jump())
        ui.Pill(top, radius=8, bg=ui.CARD, height=38, padx=16, text='看', command=self.jump, primary=True, font=(fam, 10, 'bold')).pack(side='left', padx=6)
        ui.Pill(top, radius=8, bg=ui.CARD, height=38, padx=16, text='下一张 ▶', command=lambda: self.step(1), font=bf).pack(side='left')
        ui.Pill(top, radius=8, bg=ui.CARD, height=38, padx=16, text='↺', command=lambda: self.turn(False), font=bf).pack(side='left', padx=(12, 6))
        ui.Pill(top, radius=8, bg=ui.CARD, height=38, padx=16, text='↻', command=lambda: self.turn(True), font=bf).pack(side='left')
        self.info = tk.StringVar()
        tk.Label(top, textvariable=self.info, bg=ui.CARD, fg=ui.GREY, font=(fam, 9)).pack(side='left', padx=12)

        body = tk.Frame(self, bg=ui.BG, padx=14, pady=0)
        body.pack(fill='both', expand=True, pady=(0, 14))
        body.columnconfigure(0, weight=1)
        body.rowconfigure(0, weight=1)
        self.img = tk.Label(body, background='#1C1C1E', cursor='hand2', bd=0)
        self.img.grid(row=0, column=0, sticky='nsew')
        self.img.bind('<Configure>', lambda e: self._later_render())
        self.img.bind('<Double-Button-1>', lambda e: self.cur in self.photos and _open(self.photos[self.cur]))
        side = ui.Card(body, pad=10, stretch=True)
        side.configure(width=360)
        side.grid(row=0, column=1, sticky='ns', padx=(12, 0))
        self.panel = tk.Text(side.body, width=40, wrap='word', relief='flat', bd=0, highlightthickness=0,
                             background=ui.CARD, foreground=ui.TEXT, padx=6, pady=4, font=bf, tabs=(130,))
        self.panel.pack(fill='both', expand=True)
        self.panel.tag_configure('h', font=(fam, 12, 'bold'))
        self.panel.tag_configure('k', foreground=ui.GREY)
        self.panel.tag_configure('red', foreground='#9C0006', background='#FFC7CE')
        self.panel.tag_configure('fixed', foreground='#833C0B', background='#FCE4D6')
        self.panel.tag_configure('note', foreground='#9C0006')
        self.panel.tag_configure('dim', foreground='#8E8E93')
        for key in ('<Left>', '<Prior>'):
            self.bind(key, lambda e: self._key(-1))
        for key in ('<Right>', '<Next>'):
            self.bind(key, lambda e: self._key(1))

        i = 0
        if run_dir:
            for k, (_, d, _) in enumerate(self.runs):
                if os.path.normcase(os.path.abspath(d)) == os.path.normcase(os.path.abspath(run_dir)):
                    i = k
        self.load_run(i, start)
        self.focus_set()

    # ---------- 动作
    def _key(self, d: int):
        if self.focus_get() is not self.entry:
            self.step(d)

    def load_run(self, i: int, start: int | None = None):
        run_id, d, xlsx = self.runs[i]
        self.run_box.current(i)
        self.photos = load_photos(d)
        self.nos = sorted(self.photos)
        self.rows = load_rows(xlsx)
        self.show(start if start in self.photos else self.nos[0])

    def step(self, delta: int):
        if not self.nos:
            return
        i = self.nos.index(self.cur) if self.cur in self.photos else 0
        self.show(self.nos[max(0, min(len(self.nos) - 1, i + delta))])

    def jump(self):
        t = self.num.get().strip()
        if not t.isdigit() or int(t) not in self.photos:
            self.info.set(f'没有第 {t} 张（这批是 {self.nos[0]}–{self.nos[-1]}）' if t else '先输入编号')
            return
        self.show(int(t))
        self.focus_set()

    def show(self, no: int):
        self.cur = no
        self.num.set(str(no))
        self.title(f'核对 · 第 {no} 张 / 共 {len(self.nos)} 张')
        self.info.set(f'第 {no} 张 / 共 {len(self.nos)} 张　←→ 翻页，双击照片看原尺寸')
        try:
            with Image.open(self.photos[no]) as im:
                self._pil = im.convert('RGB')
        except Exception as e:
            self._pil = None
            self.info.set(f'第 {no} 张打不开：{e}')
        self.render()
        self.fill_panel(no)

    def turn(self, clockwise: bool):
        """这张转得不对：转 90° 存回去，下次打开也是转好的。"""
        if self.cur in self.photos:
            try:
                rotate_photo(self.photos[self.cur], clockwise)
            except Exception as e:
                self.info.set(f'转不了：{e}')
                return
            self.show(self.cur)

    def _later_render(self):
        if self._after:
            self.after_cancel(self._after)
        self._after = self.after(80, self.render)

    def render(self):
        self._after = None
        if self._pil is None:
            self.img.configure(image='')
            return
        w = max(50, self.img.winfo_width() - 4)
        h = max(50, self.img.winfo_height() - 4)
        im = self._pil.copy()
        im.thumbnail((w, h), Image.LANCZOS)
        self._tk = ImageTk.PhotoImage(im)
        self.img.configure(image=self._tk)

    def fill_panel(self, no: int):
        p = self.panel
        p.configure(state='normal')
        p.delete('1.0', 'end')
        recs = self.rows.get(no, [])
        if not recs:
            p.insert('end', f'No. {no}\n\n', 'h')
            p.insert('end', '表里没有这一号的记录。\n', 'dim')
        for k, rec in enumerate(recs, start=1):
            p.insert('end', f'No. {no}' + (f'　第 {k} 条' if len(recs) > 1 else '') + '\n', 'h')
            if not any(rec['values']):
                p.insert('end', rec['note'] + '\n\n', 'note')
                continue
            for i, (lab, val) in enumerate(zip(rec.get('labels', LABELS), rec['values'])):
                p.insert('end', lab + '\t', 'k')
                tag = 'red' if i in rec['red'] else ('fixed' if i in rec.get('fixed', ()) else ())
                p.insert('end', (val or '—') + '\n', tag)
            if rec['note']:
                p.insert('end', '\n' + rec['note'] + '\n', 'note')
            p.insert('end', '\n')
        p.configure(state='disabled')
