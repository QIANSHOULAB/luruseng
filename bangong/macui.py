"""苹果风的几样零件：圆角卡片、圆角输入框、药丸按钮、拨动开关。

Tk 在 Windows 上画圆角会有锯齿，所以圆角底图都用 Pillow 放大 4 倍画好再缩小（自带抗锯齿），
字还是 Tk 自己写（系统字体渲染）。只管长相，不管业务：按钮照样 config(state=...)，开关照样绑 BooleanVar。

清楚不清楚：程序告诉 Windows「放大我自己来」（dpi_aware），屏幕放大 125%/150% 时，所有像素数照 S 放大
（px），字号是「点」，Tk 自己跟着放大。代码里的数照 100% 写就行。
"""
from __future__ import annotations

import os
import sys
import tkinter as tk
from tkinter import font as tkfont, ttk

from PIL import Image, ImageDraw, ImageFilter, ImageTk

# 苹果浅色模式那一套：浅灰底、纯白卡片、细灰线，蓝色只给主按钮和数字
BG = '#F2F2F7'          # 窗口底色（iPhone 设置页那种浅灰）
CARD = '#FFFFFF'        # 卡片
LINE = '#E5E5EA'        # 分隔线
FIELD = '#FFFFFF'       # 输入框底
FIELD_LINE = '#D1D1D6'  # 输入框边
TEXT = '#1D1D1F'
GREY = '#6E6E73'
BLUE = '#0071E3'        # 苹果官网的按钮蓝
BLUE_HOVER = '#0077ED'
BLUE_DOWN = '#006EDB'
BLUE_OFF = '#A6CBF3'
LINK = '#0066CC'        # 蓝字链接
FILL = '#F2F2F7'        # 次要按钮：浅灰底、不描边
FILL_HOVER = '#E9E9EE'
FILL_DOWN = '#E0E0E5'
SW_OFF = '#E9E9EA'
GREEN = '#34C759'       # 开关打开是绿色（跟 iPhone 一样）
LIFT = (2, 5, 8)        # 卡片底下垫的影子要的边：上、左右、下（100% 时的像素）

_SS = 4                 # 抗锯齿：放大几倍画
_cache: dict = {}
_cache_root = None

S = 1.0                 # 屏幕放大倍数（125% → 1.25）


def px(n):
    """照 100% 写的像素数，换成这块屏幕上的像素数。"""
    return int(round(n * S)) if n else n


def hairline() -> int:
    """细线：放大 200% 以下都是 1 像素。"""
    return max(1, int(S))


def dpi_aware():
    """Windows：告诉系统「放大我自己来」，不然它把整个窗口当照片拉大，字和图标都糊。建主窗口之前调。"""
    if sys.platform != 'win32':
        return
    try:
        import ctypes
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(1)        # 跟着系统的放大倍数
        except Exception:
            ctypes.windll.user32.SetProcessDPIAware()             # 老 Windows
    except Exception:
        pass


def init_scale(root):
    """建好主窗口马上调：定下 S。测试、截图可以用环境变量 LURUSENG_SCALE=1.5 假装在放大的屏幕上。"""
    global S
    s = None
    env = os.environ.get('LURUSENG_SCALE')
    if env:
        try:
            s = float(env)
        except ValueError:
            s = None
    if s is None and sys.platform == 'win32':
        try:
            s = root.winfo_fpixels('1i') / 96.0                   # 没开 dpi_aware 时这里是 1.0，照旧
        except tk.TclError:
            s = None
    S = round(s, 2) if s and s > 0 else 1.0
    if env or sys.platform == 'win32':
        root.tk.call('tk', 'scaling', S * 96 / 72)               # 字号是「点」：跟着 S 放大
    if S != 1.0:
        _scale_geometry()
    _cache.clear()


def _scale_geometry():
    """pack / grid / place 的边距（padx、pady、ipadx、ipady）一律照 S 放大，代码里照 100% 写。"""
    def scaled(v):
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            return px(v)
        if isinstance(v, (tuple, list)):
            return tuple(px(x) if isinstance(x, (int, float)) else x for x in v)
        return v

    def wrap(orig):
        def f(self, cnf={}, **kw):
            kw = dict(cnf or {}, **kw)
            for k in ('padx', 'pady', 'ipadx', 'ipady'):
                if k in kw:
                    kw[k] = scaled(kw[k])
            return orig(self, **kw)
        f._scaled = True
        return f

    for cls, names in ((tk.Pack, ('pack', 'pack_configure')), (tk.Grid, ('grid', 'grid_configure')),
                       (tk.Place, ('place', 'place_configure'))):
        orig = getattr(cls, names[1])
        if getattr(orig, '_scaled', False):
            continue
        new = wrap(orig)
        for n in names:
            setattr(cls, n, new)


def tint_titlebar(win, bg: str = BG, fg: str = TEXT):
    """Windows 11：标题栏染成窗口的底色，跟下面连成一整块（Windows 10 不认，什么都不变）。"""
    if sys.platform != 'win32':
        return
    try:
        import ctypes
        win.update_idletasks()
        hwnd = ctypes.windll.user32.GetParent(win.winfo_id())
        for attr, color in ((35, bg), (36, fg)):                # DWMWA_CAPTION_COLOR、DWMWA_TEXT_COLOR
            r, g, b = int(color[1:3], 16), int(color[3:5], 16), int(color[5:7], 16)
            v = ctypes.c_int(r | (g << 8) | (b << 16))
            ctypes.windll.dwmapi.DwmSetWindowAttribute(hwnd, attr, ctypes.byref(v), ctypes.sizeof(v))
    except Exception:
        pass


def _fresh():
    """图片是挂在 Tk 窗口上的：换了一个 Tk（测试里一个接一个开）旧图就不能用了，清掉重画。"""
    global _cache_root
    if tk._default_root is not _cache_root:
        _cache.clear()
        _cache_root = tk._default_root


def family(root) -> str:
    have = set(tkfont.families(root))
    for f in ('Microsoft YaHei UI', 'Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC', 'Noto Sans SC'):
        if f in have:
            return f
    return 'TkDefaultFont'


def rounded(w: int, h: int, r: int, fill: str, bg: str, outline: str | None = None, width: int = 1):
    """圆角矩形的图（抗锯齿），四个角外面填 bg。"""
    _fresh()
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


def card_image(w: int, h: int, r: int, fill: str, bg: str):
    """白卡片不描边，底下垫一层很淡的影子（苹果那种轻轻托起来）。影子要的边（LIFT）都画在图里。"""
    _fresh()
    t, sd, b = (px(v) for v in LIFT)
    w, h = max(int(w), 2 * sd + 2), max(int(h), t + b + 2)
    key = ('card', w, h, r, fill, bg, t, sd, b)
    img = _cache.get(key)
    if img is None:
        # 影子是糊的，1 倍大小画就够了：往下挪 2 像素、糊开、只留一成黑
        mask = Image.new('L', (w, h), 0)
        ImageDraw.Draw(mask).rounded_rectangle((sd, t + px(2), w - sd - 1, h - b + px(2) - 1), r, fill=255)
        mask = mask.filter(ImageFilter.GaussianBlur(max(1, px(4)))).point(lambda v: v * 0.11)
        base = Image.composite(Image.new('RGB', (w, h), '#000000'), Image.new('RGB', (w, h), bg), mask)
        big = base.resize((w * _SS, h * _SS), Image.BILINEAR)
        ImageDraw.Draw(big).rounded_rectangle((sd * _SS, t * _SS, (w - sd) * _SS - 1, (h - b) * _SS - 1), r * _SS,
                                              fill=fill)
        img = ImageTk.PhotoImage(big.resize((w, h), Image.LANCZOS))
        if len(_cache) > 400:
            _cache.clear()
        _cache[key] = img
    return img


class Card(tk.Canvas):
    """白色圆角卡片。往 .body 里放东西。stretch=True 时卡片高度跟着格子走（日志框用）。
    四周有一圈给影子留的边（LIFT），摆卡片时外面的空隙要扣掉这一圈。"""

    def __init__(self, master, pad=14, radius=12, stretch=False, bg=BG):
        super().__init__(master, bg=bg, highlightthickness=0, bd=0, height=10)
        self.pad, self.radius, self.stretch, self.outer = px(pad), px(radius), stretch, bg
        self.lift = tuple(px(v) for v in LIFT)
        t, sd, _ = self.lift
        self.body = tk.Frame(self, bg=CARD)
        self._img = self.create_image(0, 0, anchor='nw')
        self._win = self.create_window(sd + self.pad, t + self.pad, window=self.body, anchor='nw')
        self.bind('<Configure>', self._layout)
        if not stretch:
            self._fit()

    def _fit(self):
        """卡片高度跟着里面的东西走（Tk 不会自己告诉画布，隔一会儿看一眼，很便宜）。"""
        try:
            h = self.body.winfo_reqheight()
            t, _, b = self.lift
            want = h + 2 * self.pad + t + b
            if int(self.cget('height')) != want:
                self.configure(height=want)
                self.itemconfigure(self._win, height=h)
            self.after(300, self._fit)
        except tk.TclError:                    # 窗口关了
            pass

    def _layout(self, e):
        w, h = e.width, e.height
        t, sd, b = self.lift
        self.itemconfigure(self._img, image=card_image(w, h, self.radius, CARD, self.outer))
        kw = {'width': max(w - 2 * (sd + self.pad), 1)}
        if self.stretch:
            kw['height'] = max(h - 2 * self.pad - t - b, 1)
        self.itemconfigure(self._win, **kw)


class Field(tk.Canvas):
    """圆角输入框：浅灰底，点进去有一圈蓝色光环（macOS 的 focus ring）。"""

    def __init__(self, master, textvariable, show=None, font=None, bg=CARD, height=38):
        height = px(height)
        super().__init__(master, bg=bg, highlightthickness=0, bd=0, height=height, width=px(120))
        self.outer, self.focused = bg, False
        self.entry = tk.Entry(self, textvariable=textvariable, relief='flat', bd=0, highlightthickness=0,
                              bg=FIELD, fg=TEXT, insertbackground=TEXT, font=font,
                              selectbackground='#B3D7FF', selectforeground=TEXT)
        if show:
            self.entry.configure(show=show)
        self._img = self.create_image(0, 0, anchor='nw')
        self._win = self.create_window(px(12), height // 2, window=self.entry, anchor='w')
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
            img = rounded(w, h, px(8), FIELD, self.outer, BLUE, px(2))
        else:
            img = rounded(w, h, px(8), FIELD, self.outer, FIELD_LINE, hairline())
        self.itemconfigure(self._img, image=img)
        self.coords(self._win, px(12), h // 2)
        self.itemconfigure(self._win, width=max(w - px(24), 1))


class Pill(tk.Canvas):
    """药丸按钮。primary=True 是蓝底白字（每个窗口只放一个），其余是白底灰边；link=True 白底蓝字（点了去网页）。
    跟 ttk.Button 一样认 config(state='disabled'/'normal')、config(text=...)。"""

    def __init__(self, master, text, command=None, primary=False, font=None, bg=BG, state='normal', height=36,
                 radius=None, padx=18, minwidth=0, icon=None, link=False):
        self.font = tkfont.Font(font=font) if font else tkfont.nametofont('TkDefaultFont')
        self.text, self.command, self.primary, self.outer, self.link = text, command, primary, bg, link
        height = px(height)
        self.state, self.hover, self.down, self.h = state, False, False, height
        self.radius = height // 2 if radius is None else px(radius)
        self.padx, self.minwidth, self.icon = px(padx), minwidth, icon        # minwidth 已经是屏幕像素（照字量出来的）
        self.gap = px(10)
        self.isz = int(height * 0.5) if icon else 0
        super().__init__(master, bg=bg, highlightthickness=0, bd=0, height=height, width=self._pw(),
                         cursor='hand2')
        self._img = self.create_image(0, 0, anchor='nw')
        self._ico = self.create_image(0, height // 2, anchor='w')
        self._txt = self.create_text(0, height // 2, text=text, font=self.font)
        self.bind('<Enter>', lambda e: self._set(hover=True))
        self.bind('<Leave>', lambda e: self._set(hover=False, down=False))
        self.bind('<ButtonPress-1>', lambda e: self._set(down=True))
        self.bind('<ButtonRelease-1>', self._click)
        self._draw()

    def _pw(self):
        return max(self._cw() + 2 * self.padx, self.minwidth)

    def _cw(self):
        return self.font.measure(self.text) + ((self.isz + (self.gap if self.text else 0)) if self.icon else 0)

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
            fill = BLUE_OFF if off else (BLUE_DOWN if self.down else (BLUE_HOVER if self.hover else BLUE))
            img, fg = rounded(w, h, self.radius, fill, self.outer), '#FFFFFF'
        else:
            if off:                                   # 灰掉：更淡的底、浅字
                img, fg = rounded(w, h, self.radius, '#F5F5F7', self.outer), '#C7C7CC'
            else:                                     # 浅灰底、不描边（苹果的次要按钮）
                fill = FILL_DOWN if self.down else (FILL_HOVER if self.hover else FILL)
                img, fg = rounded(w, h, self.radius, fill, self.outer), LINK if self.link else TEXT
        self.configure(width=w, cursor='arrow' if off else 'hand2')
        self.itemconfigure(self._img, image=img)
        x0 = (w - self._cw()) // 2
        if self.icon:
            self.itemconfigure(self._ico, image=glyph(self.icon, self.isz, fg))
            self.coords(self._ico, x0, h // 2)
            x0 += self.isz + (self.gap if self.text else 0)
        self.coords(self._txt, x0, h // 2)
        self.itemconfigure(self._txt, text=self.text, fill=fg, anchor='w')

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

    def __init__(self, master, variable: tk.BooleanVar, command=None, bg=CARD):
        self.W, self.H = px(40), px(24)
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
        m = px(2)
        k = self.H - 2 * m
        knob = _knob(k, GREEN if on else SW_OFF)
        self.itemconfigure(self._knob, image=knob)
        self.coords(self._knob, (self.W - k - m) if on else m, m)


def _knob(d: int, bg: str):
    """开关上的白色圆钮：透明底（不然方角会盖住轨道的圆头），带一点点影子。"""
    _fresh()
    key = ('knob', d)
    img = _cache.get(key)
    if img is None:
        big = Image.new('RGBA', (d * _SS, d * _SS), (0, 0, 0, 0))
        dr = ImageDraw.Draw(big)
        dr.ellipse((0, _SS, d * _SS - 1, d * _SS - 1), fill=(0, 0, 0, 40))     # 一点点影子
        dr.ellipse((0, 0, d * _SS - 1, d * _SS - 1 - _SS), fill=(255, 255, 255, 255))
        img = ImageTk.PhotoImage(big.resize((d, d), Image.LANCZOS))
        _cache[key] = img
    return img


def separator(master, bg=CARD):
    return tk.Frame(master, bg=LINE, height=hairline())


def style_ttk(root, fam: str, size: int):
    """模型下拉框、进度条：换成 clam 主题再染成苹果的颜色。"""
    s = ttk.Style(root)
    try:
        s.theme_use('clam')
    except tk.TclError:
        return
    s.configure('Mac.TCombobox', fieldbackground=FIELD, background=FIELD, foreground=TEXT,
                bordercolor=FIELD, lightcolor=FIELD, darkcolor=FIELD, arrowcolor=GREY,
                
                selectbackground=FIELD, selectforeground=TEXT, padding=(px(8), px(4)), arrowsize=px(14))
    s.map('Mac.TCombobox', fieldbackground=[('readonly', FIELD)], bordercolor=[('focus', FIELD)],
          selectbackground=[('focus', FIELD)], selectforeground=[('focus', TEXT)])
    root.option_add('*TCombobox*Listbox.font', (fam, size))
    root.option_add('*TCombobox*Listbox.background', CARD)
    root.option_add('*TCombobox*Listbox.foreground', TEXT)
    root.option_add('*TCombobox*Listbox.selectBackground', BLUE)
    root.option_add('*TCombobox*Listbox.selectForeground', '#FFFFFF')
    root.option_add('*TCombobox*Listbox.borderWidth', 0)
    # 核对窗口还用默认的 ttk 控件：给它们一个干净的浅色底
    s.configure('.', background=BG, foreground=TEXT, font=(fam, size))
    s.configure('TButton', background=FILL, bordercolor=FILL, lightcolor=FILL,
                darkcolor=FILL, padding=(px(10), px(4)))
    s.map('TButton', background=[('active', FILL_HOVER), ('pressed', FILL_DOWN)])


class Bar(tk.Canvas):
    """细进度条（6 像素高、圆头）。跟 ttk.Progressbar 一样认 config(maximum=..., value=...)。"""

    def __init__(self, master, bg=BG, height=12):
        height = px(height)
        super().__init__(master, bg=bg, highlightthickness=0, bd=0, height=height)
        self.outer, self.h, self.maximum, self.value = bg, height, 100.0, 0.0
        self._trough = self.create_image(0, 0, anchor='nw')
        self._fill = self.create_image(0, 0, anchor='nw')
        self.bind('<Configure>', lambda e: self._draw())

    def _draw(self):
        w = self.winfo_width()
        if w < 4:
            return
        self.itemconfigure(self._trough, image=rounded(w, self.h, self.h // 2, LINE, self.outer))
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
        height, width = px(height), px(width)
        super().__init__(master, bg=bg, highlightthickness=0, bd=0, height=height, width=width)
        self.outer = bg
        self.box = ttk.Combobox(self, textvariable=textvariable, values=values, style='Mac.TCombobox', font=font)
        self._img = self.create_image(0, 0, anchor='nw')
        self._win = self.create_window(px(4), height // 2, window=self.box, anchor='w')
        self.bind('<Configure>', self._draw)

    def _draw(self, _e=None):
        w, h = self.winfo_width(), self.winfo_height()
        if w < 4:
            return
        self.itemconfigure(self._img, image=rounded(w, h, px(8), FIELD, self.outer, FIELD_LINE, hairline()))
        self.coords(self._win, px(4), h // 2)
        self.itemconfigure(self._win, width=max(w - px(8), 1), height=max(h - px(8), 1))


class Tag(tk.Canvas):
    """灰色圆角小牌子（右边的「待识别 0 张」），绑一个 StringVar，字变了牌子跟着变宽。"""

    def __init__(self, master, textvariable, font=None, bg=CARD, height=36):
        height = px(height)
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
        w = max(self.font.measure(t) + px(44), px(120))
        self.configure(width=w)
        self.itemconfigure(self._img, image=rounded(w, self.h, px(8), FILL, self.outer))
        self.coords(self._txt, w // 2, self.h // 2)
        self.itemconfigure(self._txt, text=t)


def app_icon(size: int, bg: str = BG):
    """蓝色圆角方块里一张白纸三道线（标题旁边那个图标），Pillow 画的，不用另带图片。"""
    _fresh()
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



def glyph(kind: str, size: int, color: str):
    """按钮上的小图标（透明底，Pillow 画）：play 开始、stop 停止、folder 文件夹、doc 文件、db 数据库、key 钥匙。"""
    _fresh()
    key = ('glyph', kind, size, color)
    img = _cache.get(key)
    if img is not None:
        return img
    S = size * _SS
    big = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    lw = max(int(S * 0.09), 1)
    if kind == 'play':
        d.polygon([(S * 0.18, S * 0.08), (S * 0.18, S * 0.92), (S * 0.9, S * 0.5)], fill=color)
    elif kind == 'stop':
        d.rounded_rectangle((S * 0.12, S * 0.12, S * 0.88, S * 0.88), int(S * 0.12), fill=color)
    elif kind == 'folder':
        d.line([(S * 0.06, S * 0.84), (S * 0.06, S * 0.16), (S * 0.38, S * 0.16), (S * 0.48, S * 0.28),
                (S * 0.94, S * 0.28), (S * 0.94, S * 0.84), (S * 0.06, S * 0.84)], fill=color, width=lw, joint='curve')
        d.line([(S * 0.06, S * 0.42), (S * 0.94, S * 0.42)], fill=color, width=lw)
    elif kind == 'doc':
        d.line([(S * 0.16, S * 0.04), (S * 0.6, S * 0.04), (S * 0.86, S * 0.3), (S * 0.86, S * 0.96),
                (S * 0.16, S * 0.96), (S * 0.16, S * 0.04)], fill=color, width=lw, joint='curve')
        d.line([(S * 0.58, S * 0.04), (S * 0.58, S * 0.32), (S * 0.86, S * 0.32)], fill=color, width=lw)
        for y in (0.52, 0.68, 0.84):
            d.line([(S * 0.32, S * y), (S * (0.7 if y < 0.8 else 0.56), S * y)], fill=color, width=lw)
    elif kind == 'gear':
        import math
        c, ro, ri, teeth = S / 2, S * 0.48, S * 0.36, 8
        pts = []
        for i in range(teeth * 4):
            a = 2 * math.pi * i / (teeth * 4) - math.pi / 2
            r = ro if (i % 4) in (0, 1) else ri
            pts.append((c + r * math.cos(a), c + r * math.sin(a)))
        d.polygon(pts, fill=color)
        d.ellipse((c - ri, c - ri, c + ri, c + ri), fill=color)
        h = S * 0.15
        d.ellipse((c - h, c - h, c + h, c + h), fill=(0, 0, 0, 0))
    elif kind == 'db':
        t, b, l, r, eh = S * 0.06, S * 0.94, S * 0.1, S * 0.9, S * 0.24
        d.ellipse((l, t, r, t + eh), outline=color, width=lw)
        for y in (S * 0.38, S * 0.62):
            d.arc((l, y - eh / 2, r, y + eh / 2), 0, 180, fill=color, width=lw)
        d.arc((l, b - eh, r, b), 0, 180, fill=color, width=lw)
        d.line([(l + lw / 2, t + eh / 2), (l + lw / 2, b - eh / 2)], fill=color, width=lw)
        d.line([(r - lw / 2, t + eh / 2), (r - lw / 2, b - eh / 2)], fill=color, width=lw)
    elif kind == 'key':
        r, cy = S * 0.22, S * 0.5
        d.ellipse((S * 0.04, cy - r, S * 0.04 + 2 * r, cy + r), outline=color, width=int(lw * 1.25))
        d.line([(S * 0.04 + 2 * r, cy), (S * 0.96, cy)], fill=color, width=lw)
        for x, dy in ((0.8, 0.2), (0.93, 0.15)):
            d.line([(S * x, cy), (S * x, cy + S * dy)], fill=color, width=lw)
    elif kind == 'table':                                   # 表格：圆角框 + 表头线 + 一横一竖
        l, t, r, b = S * 0.06, S * 0.12, S * 0.94, S * 0.88
        d.rounded_rectangle((l, t, r, b), int(S * 0.1), outline=color, width=lw)
        d.line([(l, S * 0.38), (r, S * 0.38)], fill=color, width=lw)
        d.line([(l, S * 0.63), (r, S * 0.63)], fill=color, width=lw)
        d.line([(S * 0.38, S * 0.38), (S * 0.38, b)], fill=color, width=lw)
    img = ImageTk.PhotoImage(big.resize((size, size), Image.LANCZOS))
    _cache[key] = img
    return img


class Check(tk.Canvas):
    """方形勾选框（蓝底白勾），绑一个 BooleanVar；点它或点旁边的字都能勾，勾了就调 command。"""

    def __init__(self, master, variable: tk.BooleanVar, command=None, bg=CARD):
        self.S = px(22)
        super().__init__(master, bg=bg, highlightthickness=0, bd=0, width=self.S, height=self.S, cursor='hand2')
        self.var, self.command, self.outer = variable, command, bg
        self._img = self.create_image(0, 0, anchor='nw')
        self.bind('<Button-1>', self.toggle)
        variable.trace_add('write', lambda *a: self._draw())
        self._draw()

    def toggle(self, _e=None):
        self.var.set(not self.var.get())
        if self.command:
            self.command()

    def _draw(self):
        on = bool(self.var.get())
        _fresh()
        key = ('check', on, self.outer, self.S)
        img = _cache.get(key)
        if img is None:
            S = self.S * _SS
            big = Image.new('RGB', (S, S), self.outer)
            d = ImageDraw.Draw(big)
            if on:
                d.rounded_rectangle((0, 0, S - 1, S - 1), int(S * 0.24), fill=BLUE)
                d.line([(S * 0.26, S * 0.52), (S * 0.43, S * 0.69), (S * 0.75, S * 0.33)], fill='#FFFFFF',
                       width=int(S * 0.11), joint='curve')
            else:
                d.rounded_rectangle((0, 0, S - 1, S - 1), int(S * 0.24), fill='#C7C7CC')
                k = int(S * 0.06)
                d.rounded_rectangle((k, k, S - 1 - k, S - 1 - k), int(S * 0.2), fill='#FFFFFF')
            img = ImageTk.PhotoImage(big.resize((self.S, self.S), Image.LANCZOS))
            _cache[key] = img
        self.itemconfigure(self._img, image=img)


class BigStatus(tk.Canvas):
    """右边「任务状态」的大字：绑 StringVar，数字（含 4/10 这种）是蓝色，其余黑色；太长就自动缩小字号。"""

    def __init__(self, master, textvariable, family_: str, size=24, bg=CARD, height=56):
        height = px(height)
        super().__init__(master, bg=bg, highlightthickness=0, bd=0, height=height, width=px(200))
        self.var, self.fam, self.size, self.h = textvariable, family_, size, height
        textvariable.trace_add('write', lambda *a: self._draw())
        self.bind('<Configure>', lambda e: self._draw())

    def _draw(self):
        import re
        self.delete('all')
        t = self.var.get()
        w = max(self.winfo_width(), px(50))
        parts = [p for p in re.split(r'(\d+(?:/\d+)?)', t) if p]
        size = self.size
        while size > 11:
            f_txt = tkfont.Font(family=self.fam, size=size, weight='bold')
            f_num = tkfont.Font(family=self.fam, size=int(size * 1.35), weight='bold')
            total = sum((f_num if re.fullmatch(r'\d+(?:/\d+)?', p) else f_txt).measure(p) + px(6) for p in parts)
            if total <= w:
                break
            size -= 2
        x = 0
        for p in parts:
            num = bool(re.fullmatch(r'\d+(?:/\d+)?', p))
            f = f_num if num else f_txt
            self.create_text(x, self.h // 2, text=p.strip() if num else p, font=f, anchor='w',
                             fill=BLUE if num else TEXT)
            x += f.measure(p) + px(6)


class TextArea(tk.Canvas):
    """多行的圆角输入框（名单这种一行一条的），样子跟 Field 一样：点进去一圈蓝色光环。"""

    def __init__(self, master, font=None, bg=CARD, height=220):
        super().__init__(master, bg=bg, highlightthickness=0, bd=0, height=px(height), width=px(200))
        self.outer, self.focused = bg, False
        self.text = tk.Text(self, relief='flat', bd=0, highlightthickness=0, bg=FIELD, fg=TEXT, insertbackground=TEXT,
                            font=font, wrap='none', undo=True, selectbackground='#B3D7FF', selectforeground=TEXT,
                            padx=px(2), pady=px(2))
        self._img = self.create_image(0, 0, anchor='nw')
        self._win = self.create_window(px(10), px(8), window=self.text, anchor='nw')
        self.bind('<Configure>', self._draw)
        self.bind('<Button-1>', lambda e: self.text.focus_set())
        self.text.bind('<FocusIn>', lambda e: self._focus(True), add='+')
        self.text.bind('<FocusOut>', lambda e: self._focus(False), add='+')

    def _focus(self, on):
        self.focused = on
        self._draw()

    def _draw(self, _e=None):
        w, h = self.winfo_width(), self.winfo_height()
        if w < px(24) or h < px(20):
            return
        self.itemconfigure(self._win, width=w - px(20), height=h - px(16))
        img = rounded(w, h, px(8), FIELD, self.outer, BLUE if self.focused else FIELD_LINE,
                      px(2) if self.focused else hairline())
        self.itemconfigure(self._img, image=img)

    def get(self) -> str:
        return self.text.get('1.0', 'end-1c')

    def set(self, value: str):
        self.text.delete('1.0', 'end')
        self.text.insert('1.0', value)
        self.text.edit_reset()


class Para(tk.Text):
    """一段会自己折行的灰字。Label 只会在空格处折行，中文没空格就折得乱七八糟；这个按字折，高度跟着内容走。"""

    def __init__(self, master, textvariable: tk.StringVar, font=None, fg=GREY, bg=CARD, width_px: int = 520):
        super().__init__(master, wrap='char', relief='flat', bd=0, highlightthickness=0, bg=bg, fg=fg, font=font,
                         height=1, width=1, padx=0, pady=0, cursor='arrow', takefocus=0, spacing3=px(3))
        width_px = px(width_px)
        self.var, self.width_px = textvariable, width_px
        self.configure(width=max(10, width_px // max(1, tkfont.Font(font=font).measure('0'))))
        textvariable.trace_add('write', lambda *a: self._fill())
        self.bind('<Configure>', lambda e: self._fit())
        self._fill()

    def _fill(self):
        self.configure(state='normal')
        self.delete('1.0', 'end')
        self.insert('1.0', self.var.get())
        self.configure(state='disabled')
        self.after_idle(self._fit)

    def _fit(self):
        try:
            n = self.count('1.0', 'end', 'displaylines')
            n = n[0] if isinstance(n, tuple) else n
            if n and int(self.cget('height')) != n:
                self.configure(height=n)
        except tk.TclError:
            pass
