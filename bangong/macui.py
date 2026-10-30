"""苹果风的几样零件：圆角卡片、圆角输入框、药丸按钮、拨动开关。

Tk 在 Windows 上画圆角会有锯齿，所以圆角底图都用 Pillow 放大 4 倍画好再缩小（自带抗锯齿），
字还是 Tk 自己写（系统字体渲染）。只管长相，不管业务：按钮照样 config(state=...)，开关照样绑 BooleanVar。
"""
from __future__ import annotations

import os
import sys
import tkinter as tk
from tkinter import font as tkfont, ttk

from PIL import Image, ImageDraw, ImageTk

# macOS 浅色模式的几种颜色
BG = '#F2F4F7'          # 窗口底色（带一点点蓝的浅灰）
CARD = '#FAFBFC'        # 卡片
LINE = '#E3E6EB'        # 卡片边、分隔线
FIELD = '#FFFFFF'       # 输入框底
FIELD_LINE = '#D5D9E0'
TEXT = '#1D1D1F'
GREY = '#6E6E73'
BLUE = '#007AFF'
BLUE_DOWN = '#0062CC'
BLUE_OFF = '#99C9FF'
SW_OFF = '#E5E5EA'
GREEN = '#34C759'       # 开关打开是绿色（跟 iPhone/Mac 一样）

_SS = 4                 # 抗锯齿：放大几倍画
_cache: dict = {}


def family(root) -> str:
    have = set(tkfont.families(root))
    for f in ('PingFang SC', 'Microsoft YaHei UI', 'Microsoft YaHei', 'Noto Sans CJK SC', 'Noto Sans SC'):
        if f in have:
            return f
    return 'TkDefaultFont'


def rounded(w: int, h: int, r: int, fill: str, bg: str, outline: str | None = None, width: int = 1):
    """圆角矩形的图（抗锯齿），四个角外面填 bg。"""
    w, h = max(int(w), 2), max(int(h), 2)
    key = (w, h, r, fill, bg, outline, width)
    img = _cache.get(key)
    if img is None:
        big = Image.new('RGB', (w * _SS, h * _SS), bg)
        d = ImageDraw.Draw(big)
        rr = min(r, h // 2, w // 2) * _SS
        if outline:
            d.rounded_rectangle((0, 0, w * _SS - 1, h * _SS - 1), rr, fill=outline)
            k = width * _SS
            if w * _SS - 1 - k > k and h * _SS - 1 - k > k:       # 太小（刚建还没撑开）就只画边
                d.rounded_rectangle((k, k, w * _SS - 1 - k, h * _SS - 1 - k), max(rr - k, 0), fill=fill)
        else:
            d.rounded_rectangle((0, 0, w * _SS - 1, h * _SS - 1), rr, fill=fill)
        img = ImageTk.PhotoImage(big.resize((w, h), Image.LANCZOS))
        if len(_cache) > 400:
            _cache.clear()
        _cache[key] = img
    return img


class Card(tk.Canvas):
    """白色圆角卡片。往 .body 里放东西。stretch=True 时卡片高度跟着格子走（日志框用）。"""

    def __init__(self, master, pad=14, radius=12, stretch=False, bg=BG):
        super().__init__(master, bg=bg, highlightthickness=0, bd=0, height=10)
        self.pad, self.radius, self.stretch, self.outer = pad, radius, stretch, bg
        self.body = tk.Frame(self, bg=CARD)
        self._img = self.create_image(0, 0, anchor='nw')
        self._win = self.create_window(pad, pad, window=self.body, anchor='nw')
        self.bind('<Configure>', self._layout)
        if not stretch:
            self._fit()

    def _fit(self):
        """卡片高度跟着里面的东西走（Tk 不会自己告诉画布，隔一会儿看一眼，很便宜）。"""
        try:
            h = self.body.winfo_reqheight()
            if int(self.cget('height')) != h + 2 * self.pad:
                self.configure(height=h + 2 * self.pad)
                self.itemconfigure(self._win, height=h)
            self.after(300, self._fit)
        except tk.TclError:                    # 窗口关了
            pass

    def _layout(self, e):
        w, h = e.width, e.height
        self.itemconfigure(self._img, image=rounded(w, h, self.radius, CARD, self.outer, LINE))
        kw = {'width': max(w - 2 * self.pad, 1)}
        if self.stretch:
            kw['height'] = max(h - 2 * self.pad, 1)
        self.itemconfigure(self._win, **kw)


class Field(tk.Canvas):
    """圆角输入框：浅灰底，点进去有一圈蓝色光环（macOS 的 focus ring）。"""

    def __init__(self, master, textvariable, show=None, font=None, bg=CARD, height=38):
        super().__init__(master, bg=bg, highlightthickness=0, bd=0, height=height, width=120)
        self.outer, self.focused = bg, False
        self.entry = tk.Entry(self, textvariable=textvariable, relief='flat', bd=0, highlightthickness=0,
                              bg=FIELD, fg=TEXT, insertbackground=TEXT, font=font,
                              selectbackground='#B3D7FF', selectforeground=TEXT)
        if show:
            self.entry.configure(show=show)
        self._img = self.create_image(0, 0, anchor='nw')
        self._win = self.create_window(12, height // 2, window=self.entry, anchor='w')
        self.bind('<Configure>', self._draw)
        self.bind('<Button-1>', lambda e: self.entry.focus_set())
        self.entry.bind('<FocusIn>', lambda e: self._focus(True), add='+')
        self.entry.bind('<FocusOut>', lambda e: self._focus(False), add='+')

    def _focus(self, on):
        self.focused = on
        self._draw()

    def _draw(self, _e=None):
        w, h = self.winfo_width(), self.winfo_height()
        if w < 4:
            return
        if self.focused:
            img = rounded(w, h, 8, FIELD, self.outer, '#7DB8FF', 2)
        else:
            img = rounded(w, h, 8, FIELD, self.outer, FIELD_LINE, 1)
        self.itemconfigure(self._img, image=img)
        self.coords(self._win, 12, h // 2)
        self.itemconfigure(self._win, width=max(w - 24, 1))


class Pill(tk.Canvas):
    """药丸按钮。primary=True 是蓝底白字（每个窗口只放一个），其余是白底灰边。
    跟 ttk.Button 一样认 config(state='disabled'/'normal')、config(text=...)。"""

    def __init__(self, master, text, command=None, primary=False, font=None, bg=BG, state='normal', height=36,
                 radius=None, padx=18, minwidth=0):
        self.font = tkfont.Font(font=font) if font else tkfont.nametofont('TkDefaultFont')
        self.text, self.command, self.primary, self.outer = text, command, primary, bg
        self.state, self.hover, self.down, self.h = state, False, False, height
        self.radius = height // 2 if radius is None else radius
        self.padx, self.minwidth = padx, minwidth
        super().__init__(master, bg=bg, highlightthickness=0, bd=0, height=height, width=self._pw(),
                         cursor='hand2')
        self._img = self.create_image(0, 0, anchor='nw')
        self._txt = self.create_text(0, height // 2, text=text, font=self.font)
        self.bind('<Enter>', lambda e: self._set(hover=True))
        self.bind('<Leave>', lambda e: self._set(hover=False, down=False))
        self.bind('<ButtonPress-1>', lambda e: self._set(down=True))
        self.bind('<ButtonRelease-1>', self._click)
        self._draw()

    def _pw(self):
        return max(self.font.measure(self.text) + 2 * self.padx, self.minwidth)

    def _set(self, **kw):
        for k, v in kw.items():
            setattr(self, k, v)
        self._draw()

    def _click(self, e):
        inside = 0 <= e.x <= self.winfo_width() and 0 <= e.y <= self.winfo_height()
        self._set(down=False)
        if inside and self.state != 'disabled' and self.command:
            self.command()

    def _draw(self):
        w, h = self._pw(), self.h
        off = self.state == 'disabled'
        if self.primary:
            fill = BLUE_OFF if off else (BLUE_DOWN if self.down else BLUE)
            img, fg = rounded(w, h, self.radius, fill, self.outer), '#FFFFFF'
        else:
            if off:                                   # 灰掉：灰底、没边、浅字
                img, fg = rounded(w, h, self.radius, '#E4E7EC', self.outer), '#A3A8B0'
            else:
                fill = '#E8EAEE' if self.down else ('#F5F6F8' if self.hover else '#FFFFFF')
                img, fg = rounded(w, h, self.radius, fill, self.outer, '#D5D9E0'), TEXT
        self.configure(width=w, cursor='arrow' if off else 'hand2')
        self.itemconfigure(self._img, image=img)
        self.coords(self._txt, w // 2, h // 2)
        self.itemconfigure(self._txt, text=self.text, fill=fg)

    def config(self, cnf=None, **kw):          # noqa: A003  (跟 Tk 同名，好让旧代码不用改)
        kw = dict(cnf or {}, **kw)
        mine = {k: kw.pop(k) for k in ('state', 'text', 'command') if k in kw}
        if 'command' in mine:
            self.command = mine.pop('command')
        if mine:
            self._set(**mine)
        if kw:
            super().configure(**kw)

    configure = config

    def cget(self, key):
        if key in ('state', 'text', 'command'):
            return getattr(self, key)
        return super().cget(key)


class Switch(tk.Canvas):
    """拨动开关，绑一个 BooleanVar；拨了就调 command（跟 Checkbutton 一样）。"""

    W, H = 40, 24

    def __init__(self, master, variable: tk.BooleanVar, command=None, bg=CARD):
        super().__init__(master, bg=bg, highlightthickness=0, bd=0, width=self.W, height=self.H, cursor='hand2')
        self.var, self.command, self.outer = variable, command, bg
        self._track = self.create_image(0, 0, anchor='nw')
        self._knob = self.create_image(0, 0, anchor='nw')
        self.bind('<Button-1>', self._toggle)
        variable.trace_add('write', lambda *a: self._draw())
        self._draw()

    def _toggle(self, _e=None):
        self.var.set(not self.var.get())
        if self.command:
            self.command()

    def _draw(self):
        on = bool(self.var.get())
        self.itemconfigure(self._track, image=rounded(self.W, self.H, self.H // 2, GREEN if on else SW_OFF, self.outer))
        k = self.H - 4
        knob = _knob(k, GREEN if on else SW_OFF)
        self.itemconfigure(self._knob, image=knob)
        self.coords(self._knob, (self.W - k - 2) if on else 2, 2)


def _knob(d: int, bg: str):
    key = ('knob', d, bg)
    img = _cache.get(key)
    if img is None:
        big = Image.new('RGB', (d * _SS, d * _SS), bg)
        dr = ImageDraw.Draw(big)
        dr.ellipse((0, _SS, d * _SS - 1, d * _SS - 1), fill='#C7C7CC')   # 一点点影子
        dr.ellipse((0, 0, d * _SS - 1, d * _SS - 1 - _SS), fill='#FFFFFF')
        img = ImageTk.PhotoImage(big.resize((d, d), Image.LANCZOS))
        _cache[key] = img
    return img


def separator(master, bg=CARD):
    return tk.Frame(master, bg=LINE, height=1)


def style_ttk(root, fam: str, size: int):
    """模型下拉框、进度条：换成 clam 主题再染成苹果的颜色。"""
    s = ttk.Style(root)
    try:
        s.theme_use('clam')
    except tk.TclError:
        return
    s.configure('Mac.TCombobox', fieldbackground=FIELD, background=FIELD, foreground=TEXT,
                bordercolor=FIELD, lightcolor=FIELD, darkcolor=FIELD, arrowcolor=GREY,
                
                selectbackground=FIELD, selectforeground=TEXT, padding=(8, 4), arrowsize=14)
    s.map('Mac.TCombobox', fieldbackground=[('readonly', FIELD)], bordercolor=[('focus', '#7DB8FF')],
          selectbackground=[('focus', FIELD)], selectforeground=[('focus', TEXT)])
    root.option_add('*TCombobox*Listbox.font', (fam, size))
    root.option_add('*TCombobox*Listbox.background', CARD)
    root.option_add('*TCombobox*Listbox.foreground', TEXT)
    root.option_add('*TCombobox*Listbox.selectBackground', BLUE)
    root.option_add('*TCombobox*Listbox.selectForeground', '#FFFFFF')
    root.option_add('*TCombobox*Listbox.borderWidth', 0)
    # 核对窗口还用默认的 ttk 控件：给它们一个干净的浅色底
    s.configure('.', background=BG, foreground=TEXT, font=(fam, size))
    s.configure('TButton', background='#FFFFFF', bordercolor='#D2D2D7', lightcolor='#FFFFFF',
                darkcolor='#FFFFFF', padding=(10, 4))
    s.map('TButton', background=[('active', '#F2F2F7'), ('pressed', '#E8E8ED')])


class Bar(tk.Canvas):
    """细进度条（6 像素高、圆头）。跟 ttk.Progressbar 一样认 config(maximum=..., value=...)。"""

    def __init__(self, master, bg=BG, height=12):
        super().__init__(master, bg=bg, highlightthickness=0, bd=0, height=height)
        self.outer, self.h, self.maximum, self.value = bg, height, 100.0, 0.0
        self._trough = self.create_image(0, 0, anchor='nw')
        self._fill = self.create_image(0, 0, anchor='nw')
        self.bind('<Configure>', lambda e: self._draw())

    def _draw(self):
        w = self.winfo_width()
        if w < 4:
            return
        self.itemconfigure(self._trough, image=rounded(w, self.h, self.h // 2, '#E6E9EE', self.outer, '#D9DDE3'))
        k = int(w * max(0.0, min(1.0, self.value / (self.maximum or 1))))
        if k >= self.h:
            self.itemconfigure(self._fill, image=rounded(k, self.h, self.h // 2, BLUE, LINE), state='normal')
        else:
            self.itemconfigure(self._fill, state='hidden')

    def config(self, cnf=None, **kw):          # noqa: A003
        kw = dict(cnf or {}, **kw)
        for k in ('maximum', 'value'):
            if k in kw:
                setattr(self, k, float(kw.pop(k)))
        if kw:
            super().configure(**kw)
        self._draw()

    configure = config



class Combo(tk.Canvas):
    """圆角下拉框：外面一圈圆角边，里面放一个没边框的 ttk.Combobox（照样能手打模型名）。"""

    def __init__(self, master, textvariable, values, font=None, bg=CARD, height=38, width=300):
        super().__init__(master, bg=bg, highlightthickness=0, bd=0, height=height, width=width)
        self.outer = bg
        self.box = ttk.Combobox(self, textvariable=textvariable, values=values, style='Mac.TCombobox', font=font)
        self._img = self.create_image(0, 0, anchor='nw')
        self._win = self.create_window(4, height // 2, window=self.box, anchor='w')
        self.bind('<Configure>', self._draw)

    def _draw(self, _e=None):
        w, h = self.winfo_width(), self.winfo_height()
        if w < 4:
            return
        self.itemconfigure(self._img, image=rounded(w, h, 8, FIELD, self.outer, FIELD_LINE, 1))
        self.coords(self._win, 4, h // 2)
        self.itemconfigure(self._win, width=max(w - 8, 1), height=max(h - 8, 1))


class Tag(tk.Canvas):
    """灰色圆角小牌子（右边的「待识别 0 张」），绑一个 StringVar，字变了牌子跟着变宽。"""

    def __init__(self, master, textvariable, font=None, bg=CARD, height=36):
        self.font = tkfont.Font(font=font) if font else tkfont.nametofont('TkDefaultFont')
        super().__init__(master, bg=bg, highlightthickness=0, bd=0, height=height, width=40)
        self.var, self.outer, self.h = textvariable, bg, height
        self._img = self.create_image(0, 0, anchor='nw')
        self._txt = self.create_text(0, height // 2, font=self.font, fill=GREY)
        textvariable.trace_add('write', lambda *a: self._draw())
        self._draw()

    def _draw(self):
        t = self.var.get()
        if not t:
            self.configure(width=1)
            self.itemconfigure(self._img, image='')
            self.itemconfigure(self._txt, text='')
            return
        w = max(self.font.measure(t) + 44, 120)
        self.configure(width=w)
        self.itemconfigure(self._img, image=rounded(w, self.h, 8, '#EEF0F3', self.outer, '#E3E6EB'))
        self.coords(self._txt, w // 2, self.h // 2)
        self.itemconfigure(self._txt, text=t)


def app_icon(size: int, bg: str = BG):
    """蓝色圆角方块里一张白纸三道线（标题旁边那个图标），Pillow 画的，不用另带图片。"""
    key = ('icon', size, bg)
    img = _cache.get(key)
    if img is None:
        S = size * _SS
        big = Image.new('RGB', (S, S), bg)
        grad = Image.new('RGB', (S, S))
        gd = ImageDraw.Draw(grad)
        top, bot = (0x5A, 0xB4, 0xFF), (0x1E, 0x7B, 0xF2)
        for y in range(S):
            k = y / max(S - 1, 1)
            gd.line((0, y, S, y), fill=tuple(int(a + (b - a) * k) for a, b in zip(top, bot)))
        mask = Image.new('L', (S, S), 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, S - 1, S - 1), int(S * 0.24), fill=255)
        big.paste(grad, (0, 0), mask)
        d = ImageDraw.Draw(big)
        x0, y0, x1, y1 = S * 0.30, S * 0.24, S * 0.70, S * 0.76
        d.rounded_rectangle((x0, y0, x1, y1), int(S * 0.07), fill='#FFFFFF')
        lw = max(int(S * 0.045), 1)
        for i, frac in enumerate((0.38, 0.50, 0.62)):
            y = S * frac
            right = x1 - S * (0.16 if i == 2 else 0.09)
            d.rounded_rectangle((x0 + S * 0.08, y - lw / 2, right, y + lw / 2), lw // 2, fill='#2F8BF5')
        img = ImageTk.PhotoImage(big.resize((size, size), Image.LANCZOS))
        _cache[key] = img
    return img
