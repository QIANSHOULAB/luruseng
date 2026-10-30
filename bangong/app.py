"""录入僧 窗口：选文件夹、填钥匙、点「开始工作」，其余自己干。"""
from __future__ import annotations

import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
import tkinter as tk
from datetime import datetime
from tkinter import filedialog
from tkinter import font as tkfont

from . import autopilot, engine, settings, sheets, tables, updater
from . import macui as ui


def config_dir() -> str:
    base = os.environ.get('APPDATA') or os.path.join(os.path.expanduser('~'), '.config')
    d = os.path.join(base, engine.APP_NAME)
    old = os.path.join(base, engine.OLD_NAME)
    if not os.path.isdir(d) and os.path.isfile(os.path.join(old, 'config.json')):
        try:                                   # 改名前的配置（文件夹、钥匙、模型）原样搬过来，不用重填
            os.makedirs(d, exist_ok=True)
            with open(os.path.join(old, 'config.json'), encoding='utf-8') as f:
                cfg = json.load(f)
            cfg.pop('shortcut_for', None)          # 让新名字的快捷方式重新放一遍
            fo = cfg.get('folder', '').replace('/', '\\')
            seg = '\\' + engine.OLD_NAME
            if seg + '\\' in fo or fo.endswith(seg):      # ...\搬工\待识别 → ...\录入僧\待识别
                cfg['folder'] = fo.replace(seg, '\\' + engine.APP_NAME, 1)
            with open(os.path.join(d, 'config.json'), 'w', encoding='utf-8') as f:
                json.dump(cfg, f, ensure_ascii=False, indent=1)
        except Exception:
            pass
    os.makedirs(d, exist_ok=True)
    return d


CONFIG = os.path.join(config_dir(), 'config.json')


def default_folder() -> str:
    """照片文件夹默认就在 exe 旁边：exe 放在哪，「待识别」就在哪（Song 的是 F:\\songchengmin\\录入僧\\待识别）。"""
    if getattr(sys, 'frozen', False):
        return os.path.join(app_dir(), '待识别')
    return os.path.join(os.path.expanduser('~'), engine.APP_NAME, '待识别')


def app_dir() -> str:
    if getattr(sys, 'frozen', False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def kb_path() -> str:
    """数据库跟 录入僧.exe 放在一起（公司记录，只在本机，不上 GitHub）。"""
    from .kb import DB_FILE
    return os.path.join(app_dir(), DB_FILE)


def feed_dir() -> str:
    """投喂文件夹：丢进去的表，每次开工前自动吃一遍（改过的会重吃）。"""
    from .kb import FEED_DIR
    d = os.path.join(app_dir(), FEED_DIR)
    try:
        os.makedirs(d, exist_ok=True)
    except OSError:
        pass
    return d


def names_path() -> str:
    """名单.txt 跟 录入僧.exe 放在一起，一行一个「工号/名字」，用记事本就能改。"""
    return os.path.join(app_dir(), engine.NAMES_FILE)


PHOTO_TYPES = [('照片', ' '.join(f'*{e}' for e in sorted(engine.IMG_EXT))), ('所有文件', '*.*')]


def copy_lines(r, folder: str = '待识别') -> list[str]:
    """「选照片…」复制完，日志里说一声。"""
    out = []
    if r.copied:
        out.append(f'✓ 复制了 {len(r.copied)} 张进「{os.path.basename(os.path.normpath(folder))}」，原照片还在老地方。点「开始工作」')
    if r.already:
        out.append(f'↷ {len(r.already)} 张「{os.path.basename(os.path.normpath(folder))}」里已经有了，没再复制')
    if r.done:
        names = '、'.join(n for n, _ in r.done[:5]) + ('…' if len(r.done) > 5 else '')
        out.append(f'↷ {len(r.done)} 张以前干过，没再复制：{names}')
    for name, why in r.bad[:5]:
        out.append(f'✗ {name}：{why}')
    if len(r.bad) > 5:
        out.append(f'✗ 还有 {len(r.bad) - 5} 个也没复制')
    return out


def load_config() -> dict:
    """读设置，并补齐 ⚙ 里的开关：这台电脑用过录入僧（有设置文件）就全开照旧，新装的用新默认值。"""
    cfg, existed = {}, False
    try:
        with open(CONFIG, encoding='utf-8') as f:
            cfg = json.load(f)
        existed = isinstance(cfg, dict) and bool(cfg)
    except Exception:
        pass
    if not isinstance(cfg, dict):
        cfg = {}
    return settings.upgrade(cfg, existed)


def save_config(cfg: dict):
    with open(CONFIG, 'w', encoding='utf-8') as f:
        json.dump(cfg, f, ensure_ascii=False, indent=1)


def open_path(p: str):
    try:
        if os.name == 'nt':
            os.startfile(p)  # type: ignore[attr-defined]
        elif sys.platform == 'darwin':
            subprocess.Popen(['open', p])
        else:
            subprocess.Popen(['xdg-open', p])
    except Exception:
        pass


def retire(path: str) -> str:
    """不再用的快捷方式不直接删，挪进「待删除」（见 autopilot.bin_dir）。"""
    try:
        bin_ = autopilot.bin_dir(app_dir())
        os.makedirs(bin_, exist_ok=True)
        dst = os.path.join(bin_, os.path.basename(path))
        n = 1
        while os.path.exists(dst):
            n += 1
            dst = os.path.join(bin_, f'{n}_' + os.path.basename(path))
        os.replace(path, dst)
        return '快捷方式挪到：' + dst
    except OSError as e:
        return f'快捷方式没挪动：{path}（{e}）'


def migrate_old_home(new_dir: str | None = None) -> list[str]:
    """改名：exe 在 ...\\录入僧 里时，把旁边旧的 ...\\搬工 里的东西（名单、数据库、投喂的表、
    待识别里的照片和结果）搬过来，然后把旧文件夹整个挪进上一级的「待删除」（不直接删）。"""
    new_dir = new_dir or app_dir()
    parent = os.path.dirname(new_dir)
    old_dir = os.path.join(parent, engine.OLD_NAME)
    if os.path.basename(new_dir) != engine.APP_NAME or not os.path.isdir(old_dir):
        return []
    done = []
    try:
        from .kb import DB_FILE, FEED_DIR
        for name in (engine.NAMES_FILE, DB_FILE):
            src, dst = os.path.join(old_dir, name), os.path.join(new_dir, name)
            if os.path.isfile(src) and not os.path.exists(dst):
                os.replace(src, dst)
                done.append('搬过来：' + name)
        for sub in (FEED_DIR, '待识别'):
            so, sn = os.path.join(old_dir, sub), os.path.join(new_dir, sub)
            if not os.path.isdir(so):
                continue
            os.makedirs(sn, exist_ok=True)
            for e in os.listdir(so):
                src, dst = os.path.join(so, e), os.path.join(sn, e)
                if not os.path.exists(dst):
                    os.replace(src, dst)
                    done.append(f'搬过来：{sub}\\{e}')
        bin_ = os.path.join(parent, '待删除')
        os.makedirs(bin_, exist_ok=True)
        dst = os.path.join(bin_, engine.OLD_NAME)
        n = 1
        while os.path.exists(dst):
            n += 1
            dst = os.path.join(bin_, f'{engine.OLD_NAME}_{n}')
        import time
        for i in range(20):                       # 旧 exe 刚交接完可能还占着文件，等它退出
            try:
                os.replace(old_dir, dst)
                break
            except OSError:
                if i == 19:
                    raise
                time.sleep(0.5)
        done.append('旧文件夹挪到：' + dst)
    except OSError as e:
        done.append(f'旧文件夹没搬完：{e}')
    return done


def shortcut_folders() -> dict[str, str]:
    """{'desktop'/'programs'/'startup': 文件夹}，只在 Windows 上有。"""
    from win32com.shell import shell, shellcon
    return {k: shell.SHGetFolderPath(0, c, None, 0) for k, c in (
        ('desktop', shellcon.CSIDL_DESKTOPDIRECTORY), ('programs', shellcon.CSIDL_PROGRAMS),
        ('startup', shellcon.CSIDL_STARTUP))}


def sync_shortcuts(cfg: dict) -> list[str]:
    """按 ⚙ 里的开关摆快捷方式：「桌面和开始菜单图标」管桌面 + 开始菜单，「开机自动启动」管开机启动那个
    （带 --background，开机后收在任务栏）。开着的没有就放、exe 换了地方就重放；关了的挪进「待删除」。
    顺手把改名前的「搬工」快捷方式挪走。用 Windows 自带的 Unicode 版 IShellLink，中文路径不会变问号。"""
    if os.name != 'nt' or not getattr(sys, 'frozen', False):
        return []
    lines = []
    want = {'desktop': cfg.get('shortcuts', True), 'programs': cfg.get('shortcuts', True),
            'startup': cfg.get('startup', False)}
    moved = cfg.get('shortcut_for') != sys.executable
    try:
        import pythoncom
        from win32com.shell import shell
        pythoncom.CoInitialize()
        try:
            for kind, d in shortcut_folders().items():
                target = os.path.join(d, engine.APP_NAME + '.lnk')
                old = os.path.join(d, engine.OLD_NAME + '.lnk')
                if os.path.exists(old):
                    lines.append(retire(old))
                if not want[kind]:
                    if os.path.exists(target):
                        lines.append(retire(target))
                    continue
                if os.path.exists(target) and not moved:
                    continue
                os.makedirs(d, exist_ok=True)
                link = pythoncom.CoCreateInstance(shell.CLSID_ShellLink, None,
                                                  pythoncom.CLSCTX_INPROC_SERVER, shell.IID_IShellLink)
                link.SetPath(sys.executable)
                if kind == 'startup':                      # 开机自己在后台挂着（窗口收在任务栏）
                    link.SetArguments('--background')
                link.SetWorkingDirectory(os.path.dirname(sys.executable))
                link.SetIconLocation(sys.executable, 0)
                link.SetDescription('刀具破损记录照片识别成 Excel')
                link.QueryInterface(pythoncom.IID_IPersistFile).Save(target, 0)
                lines.append('已放：' + target)
        finally:
            pythoncom.CoUninitialize()
        cfg['shortcut_for'] = sys.executable
        cfg.pop('shortcut_ver', None)
        save_config(cfg)
    except Exception as e:
        lines.append(f'{type(e).__name__}: {e}')
    try:
        with open(os.path.join(config_dir(), 'shortcut.log'), 'w', encoding='utf-8') as f:
            f.write('\n'.join(lines) + '\n')
    except OSError:
        pass
    return lines


ensure_shortcuts = sync_shortcuts        # 旧名字（main.py --shortcuts 在用）


class App:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.q: queue.Queue = queue.Queue()
        self.stop = threading.Event()
        self.worker: threading.Thread | None = None
        self.last_xlsx = ''
        self.last_photos = ''
        self.viewer = None
        self.settings_win = None
        self.dialog = None
        cfg = load_config()
        self.cfg = cfg
        ui.init_scale(root)                     # 屏幕放大 125%/150%：所有尺寸跟着放大，字和图才清楚

        root.title(engine.TITLE)                # 标题栏只写山门偈语（Song 定的）
        root.after(50, lambda: ui.tint_titlebar(root))
        root.bind_class('Toplevel', '<Map>', lambda e: ui.tint_titlebar(e.widget), add='+')
        try:
            base = getattr(sys, '_MEIPASS', os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
            root.iconbitmap(os.path.join(base, 'assets', 'bangong.ico'))
        except Exception:
            pass
        sw, sh = root.winfo_screenwidth(), root.winfo_screenheight()     # 小屏幕、放大 150% 的笔记本也放得下
        px = ui.px
        root.geometry(f'{min(px(1120), sw - px(40))}x{min(px(700), sh - px(90))}')
        root.minsize(min(px(1040), sw - px(40)), min(px(600), sh - px(90)))
        root.configure(bg=ui.BG)
        fam = ui.family(root)
        size = 11
        root.option_add('*Font', (fam, size))
        ui.style_ttk(root, fam, size)
        bf = (fam, size)

        f = tk.Frame(root, bg=ui.BG)
        f.pack(fill='both', expand=True, padx=9, pady=(12, 6))      # 卡片自带影子的边，看着还是离窗口边 14
        f.columnconfigure(0, weight=1)

        # ---- 左边大卡片：标题、设置、按钮
        card = ui.Card(f, pad=18, radius=14)
        card.grid(row=0, column=0, sticky='nsew')
        g = card.body
        g.columnconfigure(1, weight=1)

        head = tk.Frame(g, bg=ui.CARD)
        head.grid(row=0, column=0, columnspan=3, sticky='w', pady=(0, 14))
        tk.Label(head, text=engine.APP_NAME, font=(fam, 24, 'bold'), bg=ui.CARD, fg=ui.TEXT).pack(side='left')
        tk.Frame(head, bg=ui.FIELD_LINE, width=ui.hairline(), height=px(26)).pack(side='left', padx=20)
        tk.Label(head, text=engine.SUBTITLE, font=(fam, 13), bg=ui.CARD, fg=ui.GREY).pack(side='left')

        def label(r, text):
            tk.Label(g, text=text, bg=ui.CARD, fg=ui.TEXT, font=bf, anchor='w').grid(
                row=r, column=0, sticky='w', padx=(0, 16), pady=5)

        label(1, '类别')
        cats = tables.names(app_dir())
        self.category = tk.StringVar(value=cfg.get('category') if cfg.get('category') in cats else tables.BUILTIN)
        crow = tk.Frame(g, bg=ui.CARD)
        crow.grid(row=1, column=1, columnspan=2, sticky='ew', pady=5)
        self.cat_combo = ui.Combo(crow, self.category, cats, font=bf, width=280)
        self.cat_combo.box.configure(state='readonly')
        self.cat_combo.box.bind('<<ComboboxSelected>>', lambda e: self.on_category())
        self.cat_combo.pack(side='left')
        ui.Pill(crow, '＋ 新建类别', command=self.new_category, font=bf, bg=ui.CARD, height=38, radius=8,
                padx=14).pack(side='left', padx=(10, 0))
        self.cat_hint = tk.StringVar(value='')
        tk.Label(crow, textvariable=self.cat_hint, bg=ui.CARD, fg=ui.GREY, font=(fam, size - 1)).pack(
            side='left', padx=(14, 0))

        label(2, '图片文件夹')
        self.folder = tk.StringVar(value=cfg.get('folder') or default_folder())
        ui.Field(g, self.folder, font=bf).grid(row=2, column=1, sticky='ew', pady=5)
        key_w = tkfont.Font(font=bf).measure('免费领钥匙') + int(px(38) * 0.5) + px(10) + 2 * px(14)   # 右边一列按钮一样宽
        self.pick_btn = ui.Pill(g, '选照片…', command=self.pick, font=bf, bg=ui.CARD, height=38, radius=8,
                                minwidth=key_w)
        self.pick_btn.grid(row=2, column=2, padx=(10, 0))         # 挑照片，自己复制进图片文件夹；换文件夹在框里改

        self.key1 = tk.StringVar(value=cfg.get('key1', ''))
        self.key2 = tk.StringVar(value=cfg.get('key2', ''))
        label(3, '钥匙 1')
        ui.Field(g, self.key1, show='•', font=bf).grid(row=3, column=1, sticky='ew', pady=5)
        label(4, '钥匙 2（可空）')
        ui.Field(g, self.key2, show='•', font=bf).grid(row=4, column=1, sticky='ew', pady=5)
        # 钥匙框后面：点了打开网站上的教程页（怎么免费领钥匙；第二把为什么要换个项目）
        self.key_btns = []
        for r, text, url in ((3, '免费领钥匙', updater.KEY_URL), (4, '再领一把', updater.KEY_URL + '#key2')):
            b = ui.Pill(g, text, command=lambda u=url: open_path(u), font=bf, bg=ui.CARD, height=38, radius=8,
                        padx=14, minwidth=key_w, icon='key', link=True)
            b.grid(row=r, column=2, padx=(10, 0))
            self.key_btns.append(b)

        label(5, '模型')
        self.model = tk.StringVar(value=cfg.get('model') or engine.DEFAULT_MODEL)
        self.auto = tk.BooleanVar(value=cfg.get('auto', False))
        mrow = tk.Frame(g, bg=ui.CARD)
        mrow.grid(row=5, column=1, columnspan=2, sticky='ew', pady=5)
        ui.Combo(mrow, self.model, engine.MODELS, font=bf, width=280).pack(side='left')
        chk = ui.Check(mrow, self.auto, command=self.save)
        chk.pack(side='left', padx=(24, 10))
        for txt, color, fnt in (('来图就干', ui.TEXT, bf), ('（文件夹里一有新照片就自己开工）', ui.GREY, (fam, size - 1))):
            lab = tk.Label(mrow, text=txt, bg=ui.CARD, fg=color, font=fnt, cursor='hand2')
            lab.pack(side='left')
            lab.bind('<Button-1>', chk.toggle)

        ui.separator(g).grid(row=6, column=0, columnspan=3, sticky='ew', pady=(16, 16))

        bar = tk.Frame(g, bg=ui.CARD)
        bar.grid(row=7, column=0, columnspan=3, sticky='w')
        btn = dict(font=bf, bg=ui.CARD, height=44, radius=8, padx=14)
        self.start_btn = ui.Pill(bar, '开始工作', command=self.start, primary=True, icon='play', **btn)
        self.start_btn.pack(side='left')
        self.stop_btn = ui.Pill(bar, '停止', command=self.halt, state='disabled', icon='stop', **btn)
        self.stop_btn.pack(side='left', padx=(8, 0))
        ui.Pill(bar, '最新结果', command=self.open_latest, icon='table', **btn).pack(side='left', padx=(8, 0))
        ui.Pill(bar, '所有结果', command=self.open_all, icon='folder', **btn).pack(side='left', padx=(8, 0))
        ui.Pill(bar, '核对', command=self.check, icon='doc', **btn).pack(side='left', padx=(8, 0))
        self.feed_btn = ui.Pill(bar, '放入样板资料', command=self.feed, icon='db', **btn)
        self.feed_btn.pack(side='left', padx=(8, 0))

        # ---- 右边小卡片：任务状态
        side = ui.Card(f, pad=18, radius=14, stretch=True)
        side.configure(width=px(300))                             # 看着 290 宽，两边各 5 是影子
        side.grid(row=0, column=1, sticky='ns', padx=(4, 0))
        s_ = side.body
        hrow = tk.Frame(s_, bg=ui.CARD)
        hrow.pack(fill='x')
        tk.Label(hrow, text='任务状态', bg=ui.CARD, fg=ui.TEXT, font=(fam, 12)).pack(side='left')
        ui.Pill(hrow, '', command=self.open_settings, icon='gear', font=bf, bg=ui.CARD, height=32, radius=16,
                padx=8).pack(side='right')
        self.update_pill = ui.Pill(hrow, '新版本', command=self.reopen_update, primary=True, font=(fam, 9, 'bold'),
                                   bg=ui.CARD, height=28, radius=14, padx=10)      # 有新版才露出来
        ui.separator(s_).pack(fill='x', pady=(10, 10))
        self.status = tk.StringVar(value='')
        ui.BigStatus(s_, self.status, fam, size=20).pack(fill='x')
        self.pb = ui.Bar(s_, bg=ui.CARD, height=14)
        self.pb.pack(fill='x', pady=(10, 0))
        ui.separator(s_).pack(fill='x', pady=(28, 14))
        self.names_head = tk.StringVar()
        self.names_path = tk.StringVar()
        tk.Label(s_, textvariable=self.names_head, bg=ui.CARD, fg=ui.TEXT, font=(fam, 12), anchor='w',
                 justify='left', wraplength=px(260)).pack(anchor='w')
        tk.Label(s_, textvariable=self.names_path, bg=ui.CARD, fg=ui.GREY, font=(fam, size - 1), anchor='w',
                 justify='left', wraplength=px(260)).pack(anchor='w', pady=(4, 0))
        self.names_btn = ui.Pill(s_, '编辑名单', command=self.edit_names, font=(fam, size - 1), bg=ui.CARD, height=32,
                                 radius=8, padx=12)
        self.names_btn.pack(anchor='w', pady=(10, 0))           # 名单在窗口里改，不用去找 名单.txt

        # ---- 下面：日志
        logcard = ui.Card(f, pad=14, radius=14, stretch=True)
        logcard.grid(row=1, column=0, columnspan=2, sticky='nsew', pady=(4, 0))
        f.rowconfigure(1, weight=1)
        lb = logcard.body
        self._logicon = ui.glyph('doc', px(26), '#8E8E93')
        tk.Label(lb, image=self._logicon, bg=ui.CARD, bd=0).pack(side='left', anchor='n', padx=(14, 4), pady=(10, 0))
        self.text = tk.Text(lb, height=4, wrap='word', state='disabled', relief='flat', bd=0,
                            highlightthickness=0, background=ui.CARD, foreground=ui.TEXT, font=bf,
                            spacing1=px(6), spacing3=px(6), padx=px(10))
        self.text.pack(side='left', fill='both', expand=True)
        self._rules: list = []
        self.text.bind('<Configure>', self._fit_rules)

        if getattr(sys, 'frozen', False):
            for line in migrate_old_home():
                self.write(line)
        self.refresh_count()
        self.refresh_category(announce=True)
        threading.Thread(target=sync_shortcuts, args=(cfg,), daemon=True).start()
        root.protocol('WM_DELETE_WINDOW', self.on_close)
        root.after(150, self.pump)

        # 自动驾驶：来图就干、自己换新版
        self.auto_run = False
        self.watcher = autopilot.Watcher()
        self.settle = autopilot.FileSettle()
        self.updating = False
        self.started_at = datetime.now().isoformat(timespec='seconds')
        self.last_run: dict = {}
        self.next_canon = 0.0
        self.feeding = False
        self.checking = False
        self.next_update = time.time() + 60          # 打开 1 分钟后查第一次新版，之后每 6 小时
        self.downloaded = ''                         # 下载好的新版本号
        self.update_asap = False                     # 人点了「现在更新」：下好就换，不等两分钟
        self.update_dismissed = ''                   # 点了「以后再说」的版本：这次开着不再弹卡片
        self.offered = ''                            # 网站上有、还没换的新版本号（右上角蓝色小按钮）
        self.update_skip = ''                        # 换失败的版本：这次开着就别再下它了
        self.last_input = time.time()
        root.bind_all('<KeyPress>', self._touched, add='+')
        root.bind_all('<ButtonPress>', self._touched, add='+')
        args = autopilot.startup_args()
        if '--after-update' in args:
            self.write(f'✓ 换上新版 v{engine.VERSION}')
            threading.Thread(target=autopilot.retire_update_file, args=(app_dir(),), daemon=True).start()
        if self.auto.get():
            self.write('来图就干：开着。往文件夹里放照片，30 秒内放完它就自己开工。')
        root.after(3000, self.tick)
        if '--background' in args:
            root.after(200, root.iconify)

    # ---------- UI 动作
    def pick(self):
        """「选照片…」：挑照片（可以多选），复制进图片文件夹（默认 待识别，没有就当场建），原照片原地不动。
        复制完还是人点「开始工作」（Song 定的）；开着「来图就干」的话它自己会开工。"""
        paths = filedialog.askopenfilenames(title='选照片（可以多选）', initialdir=self.cfg.get('pick_dir') or None,
                                            filetypes=PHOTO_TYPES)
        if not paths:
            return
        folder = self.folder.get().strip() or default_folder()
        self.folder.set(folder)
        self.cfg['pick_dir'] = os.path.dirname(paths[0])
        self.save()
        self.status.set('正在复制…')

        def work():
            try:
                r = engine.copy_in(paths, folder)
            except OSError as e:
                self.log(f'✗ 复制不进 {folder}：{e}')
            else:
                for line in copy_lines(r, folder):
                    self.log(line)
            self.q.put(('call', self.refresh_count))

        threading.Thread(target=work, daemon=True).start()

    def refresh_count(self):
        try:
            n = len(engine.scan(self.folder.get())) if os.path.isdir(self.folder.get()) else 0
            self.status.set(f'待识别 {n} 张')
        except Exception:
            self.status.set('')

    def save(self):
        self.cfg.update({'folder': self.folder.get(), 'model': self.model.get().strip(),
                         'auto': bool(self.auto.get()), 'category': self.category.get()})
        if self.cfg.get('remember_keys', True):
            self.cfg.update({'key1': self.key1.get().strip(), 'key2': self.key2.get().strip()})
        else:                                       # 不记钥匙：只在这次开着时有效，不写进电脑
            self.cfg.pop('key1', None)
            self.cfg.pop('key2', None)
        save_config(self.cfg)

    def log(self, msg: str):
        self.q.put(('log', msg))

    def start(self, auto: bool = False):
        if self.worker and self.worker.is_alive() or self.updating:
            return
        self.auto_run = auto
        k1, k2 = self.key1.get().strip(), self.key2.get().strip()
        if not k1 and not k2:
            self.write('✗ 先填钥匙。还没有？点钥匙框后面的「免费领钥匙」，两分钟的事，一分钱不花')
            return
        if k1 and k1 == k2:
            self.write('✗ 两个钥匙填的是同一把（额度按项目算，同一把没意义）')
            return
        if auto:
            self.write('▶ 来图就干：发现新照片，自己开工')
        self.save()
        self.stop.clear()
        self.start_btn.config(state='disabled')
        self.stop_btn.config(state='normal')
        self.pb.config(value=0)
        cat = self.category.get()
        common = dict(log=self.log, progress=lambda d, t: self.q.put(('prog', (d, t))), stop=self.stop,
                      keep_originals=self.cfg.get('keep_originals', True))
        if cat == tables.BUILTIN:                    # 刀单：专门的那一套
            eng = engine.Engine(self.folder.get(), [k1, k2], self.model.get(), names_path=names_path(),
                                kb_path=kb_path(), feed_dir=feed_dir(), **common)
        else:                                        # 自建类别：用它自己的数据库，跟刀单互不串味
            spec = tables.TableSpec(cat, tables.db_path(app_dir(), cat), tables.feed_path(app_dir(), cat))
            eng = engine.Engine(self.folder.get(), [k1, k2], self.model.get(), spec=spec, **common)

        def work():
            try:
                res = eng.run()
            except Exception as e:  # 兜底
                self.log(f'✗ 程序出错：{type(e).__name__}：{e}')
                res = None
            self.q.put(('done', res))

        self.worker = threading.Thread(target=work, daemon=True)
        self.worker.start()

    def halt(self):
        self.stop.set()
        self.status.set('正在停…（等手上这几张回来）')

    def open_out(self):
        d = os.path.join(self.folder.get(), engine.OUT_DIR)
        open_path(d if os.path.isdir(d) else self.folder.get())

    def open_latest(self):
        """最新结果：直接打开最新那一批的表，不用去文件夹里挑。"""
        from .viewer import list_results
        runs = list_results(self.folder.get())
        if not runs:
            self.write('还没有结果：先点「选照片…」，再点「开始工作」干一批')
            return
        open_path(runs[0]['xlsx'])

    def open_all(self):
        """所有结果：每一批列出来，点哪批开哪批的表、核对哪批。"""
        self._dialog(ResultsCard)

    def edit_names(self):
        self._dialog(NamesCard)

    def feed(self):
        """放入样板资料：先选放进哪个类别（刀单 / 自建的 / ＋新建），再选表。"""
        self._dialog(FeedCard)

    def do_feed(self, cat: str, paths):
        """把表放进某个类别的数据库（后台干，不卡窗口）。刀单只吃像刀单的表；自建类别第一本的表头定成它的列。"""
        self.feed_btn.config(state='disabled')
        self.feeding = True
        self.write(f'开始把 {len(paths)} 本表放进「{cat}」的数据库…')

        def work():
            try:
                if cat == tables.BUILTIN:
                    from .kb import KnowledgeBase
                    kb = KnowledgeBase(kb_path())
                    for p in paths:
                        self.log(kb.feed(p).line())
                    self.log(kb.summary())
                else:
                    db = tables.TableDB(tables.db_path(app_dir(), cat))
                    for p in paths:
                        fr = db.feed(p)
                        self.log(fr.line())
                        if getattr(fr, 'new_columns', None):
                            self.log(f'「{cat}」多了这些列：' + '、'.join(fr.new_columns))
                    self.log(db.summary(cat))
            except Exception as e:
                self.log(f'✗ 放入样板资料出错：{type(e).__name__}：{e}')
            self.q.put(('fed', None))

        threading.Thread(target=work, daemon=True).start()

    def _dialog(self, cls, *args):
        """同一时间只开一个小卡片（放入样板资料 / 新建类别）。"""
        if self.dialog is not None and self.dialog.winfo_exists():
            self.dialog.destroy()
        self.dialog = cls(self, *args)
        return self.dialog

    def new_category(self, then=None):
        def made(name):
            self.cat_combo.box.configure(values=tables.names(app_dir()))
            self.category.set(name)
            self.on_category()
            if then:
                then(name)
        self._dialog(NewCategoryCard, made)

    def on_category(self):
        self.save()
        self.refresh_category(announce=True)

    def refresh_category(self, announce: bool = False):
        """按选中的类别更新：类别旁边的小字、右边卡片下半截；announce 时在日志里说一句这个类别的数据库。"""
        cat = self.category.get()
        try:
            if cat == tables.BUILTIN:
                from .kb import KnowledgeBase
                n = len(engine.load_names(names_path()))
                self.cat_hint.set('内置 · 专属优化')
                self.names_head.set(f'名单：{n} 人' if n else '没有名单')
                self.names_path.set('' if n else '没有也能用，SETTER 就照单子抄')
                if not self.names_btn.winfo_manager():
                    self.names_btn.pack(anchor='w', pady=(10, 0))
                line = KnowledgeBase(kb_path()).summary() + f'（也可以把表丢进：{feed_dir()}）'
            else:
                db = tables.TableDB(tables.db_path(app_dir(), cat))
                cols, n = db.columns(), db.count()
                self.cat_hint.set(f'自建 · {len(cols)} 列 · {n} 条记录' if cols else '自建 · 还没放过表')
                self.names_head.set(f'「{cat}」数据库：{n} 条' if cols else f'「{cat}」还没放过表')
                self.names_path.set(('列：' + '、'.join(cols)) if cols else
                                    '先认全部内容，改对了点「放入样板资料」，表头就定成它的列')
                self.names_btn.pack_forget()                    # 名单只给刀单用
                line = db.summary(cat) + f'（也可以把表丢进：{tables.feed_path(app_dir(), cat)}）'
        except Exception as e:
            line = f'「{cat}」的数据库打不开：{type(e).__name__}：{e}'
        if announce:
            self.write(line)

    def check(self, run_dir: str | None = None):
        """核对窗口：编号照片一张一张看，第一张就是 1，←→ 翻页，输入编号直接跳。"""
        from .viewer import Viewer
        if self.viewer is not None and self.viewer.winfo_exists():
            self.viewer.destroy()
        self.viewer = Viewer(self.root, self.folder.get(), run_dir or self.last_photos or None)

    def on_close(self):
        self.save()
        if self.auto.get() and self.cfg.get('hide_on_close', True):   # 来图就干开着：× 只是收起来，后台照样盯着
            self.write('窗口收起来了，后台照样盯着文件夹。真要退出：去掉「来图就干」的勾再点 ×'
                       '（或者在右上角 ⚙ 里关掉「点 × 只收起」）。')
            self.root.iconify()
            return
        self.stop.set()
        self.root.destroy()

    # ---------- 自动驾驶
    def busy(self) -> bool:
        return bool(self.worker and self.worker.is_alive()) or self.updating

    def tick(self):
        try:
            self._tick()
        except Exception as e:                      # 自动驾驶出错不能把窗口带崩
            self.write(f'自动驾驶出错：{type(e).__name__}：{e}')
        self.root.after(10_000, self.tick)

    def _tick(self):
        d = app_dir()
        if autopilot.take_show_request(d):          # 又双击了一次图标：把窗口亮出来
            self.root.deiconify()
            self.root.lift()
            self.root.focus_force()
        autopilot.write_status(d, started=self.started_at, auto=bool(self.auto.get()), running=self.busy(),
                               folder=self.folder.get(), last_run=self.last_run)
        if self.busy():
            return
        upd = os.path.join(d, autopilot.UPDATE_NAME)
        if getattr(sys, 'frozen', False) and os.path.exists(upd) and self.settle.ready(upd):
            if autopilot.same_file(upd, sys.executable):
                threading.Thread(target=autopilot.retire_update_file, args=(d, 5), daemon=True).start()
            elif self.quiet() or (self.update_asap and not self.feeding):   # 空闲才换；点了「现在更新」就不等
                self.updating = True
                threading.Thread(target=self._update, args=(upd,), daemon=True).start()
                return
        if getattr(sys, 'frozen', False) and time.time() >= self.next_canon:
            self.next_canon = time.time() + 300
            if self._canonicalize(d):
                return
        if getattr(sys, 'frozen', False) and not self.checking and time.time() >= self.next_update:
            self.next_update = time.time() + updater.CHECK_EVERY
            self.check_update()                     # 自动更新开着：自己下、空闲时换；关着：只提醒
        if self.auto.get() and (self.key1.get().strip() or self.key2.get().strip()):
            snap = autopilot.image_snapshot(self.folder.get())
            if self.watcher.poll(snap):
                self.watcher.started(snap)
                self.start(auto=True)

    def _canonicalize(self, d: str) -> bool:
        """正名：从「录入僧测试版.exe」之类的别名跑起来时，等 录入僧.exe 没人占着了，就把自己抄过去、从正名重开。
        已经是正名的：把旁边的别名 exe 挪进 待删除。"""
        canon = autopilot.canonical_exe(d)
        me = os.path.abspath(sys.executable)
        if os.path.normcase(me) == os.path.normcase(os.path.abspath(canon)):
            for p in autopilot.stray_exes(d, me):
                if not autopilot.is_locked(p):
                    threading.Thread(target=autopilot.retire_file, args=(p,), daemon=True).start()
            return False
        if os.path.basename(me) == autopilot.UPDATE_NAME or autopilot.is_locked(canon):
            return False
        self.updating = True
        autopilot.log_update(d, f'从 {os.path.basename(me)} 正名回 {os.path.basename(canon)}')
        args = ['--background', '--after-update'] if self.root.state() == 'iconic' else ['--after-update']

        def go():
            try:
                autopilot.install_update(me, canon, wait=20, args=args)
                self.q.put(('quit', None))
            except Exception as e:
                autopilot.log_update(d, f'正名没成：{type(e).__name__}：{e}')
                self.updating = False
        threading.Thread(target=go, daemon=True).start()
        return True

    def _update(self, upd: str):
        ver = autopilot.probe_version(upd)
        if not ver:
            autopilot.log_update(app_dir(), f'新版 {autopilot.UPDATE_NAME} 打不开，没换')
            self.log(f'✗ 新版 {autopilot.UPDATE_NAME} 打不开，没换')
            self.update_skip = self.downloaded              # 这次开着就别再下它了
            self.update_asap = False
            try:
                os.replace(upd, upd + '.坏的')
            except OSError:
                pass
            self.updating = False
            return
        autopilot.log_update(app_dir(), f'v{engine.VERSION} → v{ver}：开始换')
        self.log(f'发现新版 v{ver}，换上后自己重开')
        subprocess.Popen([upd, '--install-update', sys.executable], cwd=app_dir())
        self.q.put(('quit', None))

    def _fit_rules(self, e=None):
        w = max(self.text.winfo_width() - ui.px(24), ui.px(10))
        self._rules = [r for r in self._rules if r.winfo_exists()]
        for r in self._rules:
            r.configure(width=w)

    def _touched(self, _e=None):
        self.last_input = time.time()

    def quiet(self) -> bool:
        """能不能现在换新版（换的时候窗口会关掉重开）：没在核对、没在投喂、没开着设置、两分钟没人碰。"""
        open_ = [w for w in (self.viewer, self.settings_win, self.dialog) if w is not None and w.winfo_exists()]
        return not self.feeding and not open_ and time.time() - self.last_input >= 120

    def check_update(self, report=None, manual: bool = False):
        """去网站查新版（后台线程，不卡窗口）。自动更新开着：有就下载，空闲时换上（Song 的电脑）。
        关着（别人的电脑默认）：只弹卡片告诉他有新版、更新了啥，他点了才换。report(一句话) 给设置卡片显示结果。"""
        if self.checking:
            return
        self.checking = True
        auto = self.cfg.get('auto_update', False)

        def go():
            try:
                if not getattr(sys, 'frozen', False):
                    msg = f'网站上最新是 v{updater.latest_version()}（这是开发版，不下载）'
                elif auto:
                    v = updater.check(app_dir(), log=self.log, skip=self.update_skip)
                    if v:
                        self.downloaded = v
                    msg = f'新版 v{v} 下载好了，空闲时自己换上' if v else f'已经是最新版 v{engine.VERSION}'
                else:
                    remote = updater.latest_version()
                    if updater.is_newer(remote) and remote != self.update_skip:
                        msg = f'有新版本 v{remote}'
                        if manual or remote != self.update_dismissed:
                            text = updater.notes()
                            self.q.put(('call', lambda: self.offer_update(remote, text)))
                        else:
                            self.q.put(('call', lambda: self.show_update_pill(remote)))
                    else:
                        msg = f'已经是最新版 v{engine.VERSION}'
            except Exception as e:
                msg = f'查不到新版：{type(e).__name__}：{e}'
                if getattr(sys, 'frozen', False):
                    autopilot.log_update(app_dir(), msg)
            finally:
                self.checking = False
            if report:
                self.q.put(('call', lambda: report(msg)))

        threading.Thread(target=go, daemon=True).start()

    def show_update_pill(self, remote: str):
        self.offered = remote
        self.update_pill.config(text=f'新版本 v{remote}')
        if not self.update_pill.winfo_ismapped():
            self.update_pill.pack(side='right', padx=(0, 8))

    def offer_update(self, remote: str, text: str = ''):
        """有新版：右上角留一个蓝色小按钮，再弹一张卡片（更新了啥 + 现在更新 / 以后都自动更新 / 以后再说）。"""
        self.show_update_pill(remote)
        if self.updating or self.update_asap:
            return
        self._dialog(UpdateCard, remote, text)

    def reopen_update(self):
        if self.offered:
            self._dialog(UpdateCard, self.offered, '')

    def update_now(self, remote: str, card=None):
        """人点了「现在更新」：下载新版（显示进度），下好就换（正在干活的话干完这批再换）。"""
        def say(t):
            self.q.put(('call', lambda: card is not None and card.winfo_exists() and card.status.set(t)))

        def go():
            dst = os.path.join(app_dir(), autopilot.UPDATE_NAME)
            try:
                if not os.path.exists(dst):
                    say('正在下载…')
                    updater.download(f'{updater.LATEST}/{updater.EXE_ASSET}', dst,
                                     progress=lambda n, t: say(f'正在下载… {n // 1048576} / {max(t, n) // 1048576} MB'))
                self.downloaded = remote
                self.update_asap = True
                autopilot.log_update(app_dir(), f'点了「现在更新」：下载好新版 v{remote}')
                self.log(f'新版 v{remote} 下载好了，马上换上（正在干活的话干完这批再换）')
                self.q.put(('call', lambda: card is not None and card.winfo_exists() and card.destroy()))
            except Exception as e:
                say(f'下载失败：{type(e).__name__}：{e}（过一会儿再点一次）')
                self.q.put(('call', lambda: card is not None and card.winfo_exists() and card.enable()))

        if not getattr(sys, 'frozen', False):
            say('这是开发版，不下载')
            return
        threading.Thread(target=go, daemon=True).start()

    def open_settings(self):
        if self.settings_win is not None and self.settings_win.winfo_exists():
            self.settings_win.lift()
            self.settings_win.focus_force()
            return
        self.settings_win = SettingsCard(self)

    def setting_changed(self, key: str, value: bool):
        self.cfg[key] = value
        self.save()
        if key in ('startup', 'shortcuts'):
            threading.Thread(target=sync_shortcuts, args=(self.cfg,), daemon=True).start()
        if key == 'auto_update' and value:
            self.next_update = min(self.next_update, time.time() + 5)

    def write(self, msg: str):
        self.text.config(state='normal')
        if self.text.get('1.0', 'end-1c'):              # 上一条和这一条之间画一道细线
            rule = tk.Frame(self.text, bg=ui.LINE, height=ui.hairline(),
                            width=max(self.text.winfo_width() - ui.px(24), ui.px(10)))
            self._rules.append(rule)
            self.text.window_create('end', window=rule)
            self.text.insert('end', '\n')
        self.text.insert('end', msg + '\n')
        self.text.see('end')
        self.text.config(state='disabled')

    def pump(self):
        try:
            while True:
                kind, val = self.q.get_nowait()
                if kind == 'log':
                    self.write(val)
                elif kind == 'prog':
                    d, t = val
                    self.pb.config(maximum=max(t, 1), value=d)
                    self.status.set(f'{d}/{t} 张')
                elif kind == 'call':
                    val()
                elif kind == 'fed':
                    self.feeding = False
                    self.feed_btn.config(state='normal')
                    self.refresh_category()
                elif kind == 'quit':                    # 换新版：保存设置后退出，让新版接手
                    self.save()
                    self.root.destroy()
                    return
                elif kind == 'done':
                    self.start_btn.config(state='normal')
                    self.stop_btn.config(state='disabled')
                    if val and val.xlsx:
                        self.last_xlsx = val.xlsx
                        self.last_photos = val.photos_dir
                        self.status.set(f'干完：成功 {val.ok} · 失败 {val.failed}')
                        self.last_run = {'xlsx': val.xlsx, 'ok': val.ok, 'failed': val.failed, 'requests': val.requests,
                                         'stopped': val.stopped_reason, 'auto': self.auto_run,
                                         'at': datetime.now().isoformat(timespec='seconds')}
                        if val.ok and not self.stop.is_set() and not self.auto_run and self.cfg.get('auto_open', True):
                            open_path(val.xlsx)                 # 表和核对窗口一起打开，对着核（自动开工的不弹，没人看）
                            if val.photos_dir and os.path.isdir(val.photos_dir):
                                self.check(val.photos_dir)
                    else:
                        self.refresh_count()
        except queue.Empty:
            pass
        self.root.after(150, self.pump)


class SettingsCard(tk.Toplevel):
    """⚙ 设置：一排拨动开关，拨了马上生效、马上存。底下落款「千手院方丈释手」，千手院总舵、方丈邮箱、查新版。"""

    def __init__(self, app: App):
        super().__init__(app.root)
        self.app = app
        self.title('设置')
        self.configure(bg=ui.BG)
        self.transient(app.root)
        self.resizable(False, False)
        fam = ui.family(self)
        bf = (fam, 11)
        self.card = card = ui.Card(self, pad=20, radius=14)
        card.configure(width=ui.px(730))                         # 看着 720 宽，两边各 5 是影子
        card.pack(fill='both', expand=True, padx=9, pady=(12, 6))
        g = card.body
        tk.Label(g, text='设置', font=(fam, 16, 'bold'), bg=ui.CARD, fg=ui.TEXT).pack(anchor='w')
        ui.separator(g).pack(fill='x', pady=(10, 0))
        self.vars = {}
        for i, (key, title, desc) in enumerate(settings.ROWS):
            row = tk.Frame(g, bg=ui.CARD)
            row.pack(fill='x', pady=4)
            v = tk.BooleanVar(value=bool(app.cfg.get(key)))
            ui.Switch(row, v, command=lambda k=key, var=v: app.setting_changed(k, bool(var.get()))).pack(
                side='right', padx=(18, 0))
            left = tk.Frame(row, bg=ui.CARD)
            left.pack(side='left', fill='x', expand=True)
            tk.Label(left, text=title, font=bf, bg=ui.CARD, fg=ui.TEXT, anchor='w').pack(anchor='w')
            tk.Label(left, text=desc, font=(fam, 9), bg=ui.CARD, fg=ui.GREY, anchor='w', justify='left',
                     wraplength=ui.px(560)).pack(anchor='w', pady=(1, 0))
            self.vars[key] = v
            if i < len(settings.ROWS) - 1:
                ui.separator(g).pack(fill='x')
        ui.separator(g).pack(fill='x', pady=(0, 12))
        foot = tk.Frame(g, bg=ui.CARD)
        foot.pack(fill='x')
        info = tk.Frame(foot, bg=ui.CARD)
        info.pack(side='left')
        tk.Label(info, text=f'{engine.APP_NAME} v{engine.VERSION}', font=(fam, 10), bg=ui.CARD, fg=ui.GREY,
                 anchor='w').pack(anchor='w')
        tk.Label(info, text='千手院方丈释手', font=(fam, 9), bg=ui.CARD, fg=ui.GREY,
                 anchor='w').pack(anchor='w')
        btn = dict(font=(fam, 10), bg=ui.CARD, height=34, radius=8, padx=14)
        ui.Pill(foot, '完成', command=self.destroy, primary=True, **btn).pack(side='right')
        self.check_btn = ui.Pill(foot, '检查新版', command=self.check, **btn)
        self.check_btn.pack(side='right', padx=8)
        ui.Pill(foot, '方丈邮箱', command=self.mail, **btn).pack(side='right')
        ui.Pill(foot, '千手院总舵', command=lambda: open_path(updater.HUB_URL), **btn).pack(side='right', padx=(0, 8))
        self.note = tk.StringVar(value='')
        tk.Label(g, textvariable=self.note, font=(fam, 9), bg=ui.CARD, fg=ui.GREY, anchor='e').pack(
            fill='x', pady=(6, 0))
        self.bind('<Escape>', lambda e: self.destroy())
        self.after(30, self._center)

    def _center(self):
        try:
            self.update_idletasks()
            self.card._fit()                    # 先撑到真高度再摆位置，不然会往屏幕下面长出去
            self.update_idletasks()
            r = self.app.root
            w, h = self.winfo_reqwidth(), self.winfo_reqheight()
            x = r.winfo_rootx() + max((r.winfo_width() - w) // 2, 0)
            y = r.winfo_rooty() + max((r.winfo_height() - h) // 2 - ui.px(20), 0)
            self.geometry(f'+{x}+{y}')
        except tk.TclError:
            pass

    def mail(self):
        """方丈邮箱：邮箱先复制好，再打开写邮件（电脑没设邮件程序的话，粘贴到常用的邮箱里发就行）。"""
        import urllib.parse
        self.copy_mail()
        subject = urllib.parse.quote(f'录入僧 v{engine.VERSION} 建议')
        open_path(f'mailto:{updater.CONTACT}?subject={subject}')
        self.note.set(f'邮箱已复制：{updater.CONTACT}。没弹出写邮件的窗口，就粘贴到你常用的邮箱里发')

    def copy_mail(self):
        self.clipboard_clear()
        self.clipboard_append(updater.CONTACT)

    def check(self):
        self.note.set('正在查…')
        self.check_btn.config(state='disabled')

        def done(msg):
            if self.winfo_exists():
                self.note.set(msg)
                self.check_btn.config(state='normal')
        self.app.check_update(report=done, manual=True)


def handoff_target(here: str | None = None) -> str:
    """从改名前的「搬工」文件夹被打开（旧快捷方式）时，旁边有新的 录入僧\\录入僧.exe 就交给它。"""
    here = here or app_dir()
    if os.path.basename(here) != engine.OLD_NAME:
        return ''
    new = os.path.join(os.path.dirname(here), engine.APP_NAME, engine.APP_NAME + '.exe')
    return new if os.path.isfile(new) else ''


class CardDialog(tk.Toplevel):
    """小卡片窗口（放入样板资料、新建类别）：标题、内容、底下一排按钮，样子跟 ⚙ 设置一样。"""

    def __init__(self, app: App, title: str, width: int = 560):
        super().__init__(app.root)
        self.app = app
        self.title(title)
        self.configure(bg=ui.BG)
        self.transient(app.root)
        self.resizable(False, False)
        self.fam = ui.family(self)
        self.bf = (self.fam, 11)
        self.card = ui.Card(self, pad=20, radius=14)
        self.card.configure(width=ui.px(width + 10))              # 两边各 5 是影子
        self.card.pack(fill='both', expand=True, padx=9, pady=(12, 6))
        self.body = self.card.body
        tk.Label(self.body, text=title, font=(self.fam, 16, 'bold'), bg=ui.CARD, fg=ui.TEXT).pack(anchor='w')
        ui.separator(self.body).pack(fill='x', pady=(10, 14))
        self.bind('<Escape>', lambda e: self.destroy())
        self.after(30, self._center)

    def footer(self) -> tk.Frame:
        ui.separator(self.body).pack(fill='x', pady=(16, 12))
        f = tk.Frame(self.body, bg=ui.CARD)
        f.pack(fill='x')
        return f

    def button(self, parent, text: str, cmd, primary: bool = False):
        p = ui.Pill(parent, text, command=cmd, primary=primary, font=(self.fam, 10, 'bold' if primary else 'normal'),
                    bg=ui.CARD, height=34, radius=8, padx=16)
        p.pack(side='right', padx=(8, 0))
        return p

    def _center(self):
        try:
            self.update_idletasks()
            self.card._fit()
            self.update_idletasks()
            r = self.app.root
            w, h = self.winfo_reqwidth(), self.winfo_reqheight()
            x = r.winfo_rootx() + max((r.winfo_width() - w) // 2, 0)
            y = r.winfo_rooty() + max((r.winfo_height() - h) // 2 - ui.px(40), 0)
            self.geometry(f'+{x}+{y}')
            self.lift()
            self.focus_force()
        except tk.TclError:
            pass


class NewCategoryCard(CardDialog):
    """新建类别：起个名字，建一个文件夹（它自己的数据库、投喂文件夹都在里面）。"""

    def __init__(self, app: App, on_done):
        super().__init__(app, '新建类别', 520)
        self.on_done = on_done
        b = self.body
        tk.Label(b, text='名字', font=self.bf, bg=ui.CARD, fg=ui.TEXT).pack(anchor='w')
        self.name = tk.StringVar()
        self.field = ui.Field(b, self.name, font=self.bf)
        self.field.pack(fill='x', pady=(6, 0))
        ui.Para(b, tk.StringVar(value=f'比如「质检单」「送货单」。建好会多一个文件夹 {tables.root(app_dir())}\\<名字>，'
                                      '它自己的数据库和投喂文件夹都在里面，跟刀单互不串味。'),
                font=(self.fam, 9), width_px=470).pack(fill='x', pady=(8, 0))
        self.err = tk.StringVar()
        tk.Label(b, textvariable=self.err, font=(self.fam, 10), bg=ui.CARD, fg='#C0392B', anchor='w').pack(
            anchor='w', pady=(6, 0))
        f = self.footer()
        self.button(f, '建好', self.ok, primary=True)
        self.button(f, '取消', self.destroy)
        self.field.entry.bind('<Return>', lambda e: self.ok())
        self.after(80, self.field.entry.focus_set)

    def ok(self):
        name = self.name.get().strip()
        why = tables.check_name(name, app_dir())
        if why:
            self.err.set(why)
            return
        try:
            tables.create(app_dir(), name)
        except OSError as e:
            self.err.set(f'建不了：{e}')
            return
        self.destroy()
        self.on_done(name)


class NamesCard(CardDialog):
    """编辑名单：在窗口里直接写，存成 录入僧.exe 旁边的 名单.txt（记事本照样能改）。"""

    def __init__(self, app: App):
        super().__init__(app, '名单', 520)
        b = self.body
        self.box = ui.TextArea(b, font=(self.fam, 11), height=240)
        self.box.pack(fill='x')
        try:
            with open(names_path(), 'rb') as fh:
                self.box.set(sheets._decode(fh.read()).replace('\r\n', '\n').rstrip('\n'))
        except OSError:
            self.box.set('')
        ui.Para(b, tk.StringVar(value='一行一个「工号/名字」，比如 639/Lee Ah Kow。只帮它认潦草的工号，SETTER 还是照单子抄。没有也能用。'),
                font=(self.fam, 9), width_px=470).pack(fill='x', pady=(8, 0))
        self.err = tk.StringVar()
        tk.Label(b, textvariable=self.err, font=(self.fam, 10), bg=ui.CARD, fg='#C0392B', anchor='w').pack(anchor='w')
        f = self.footer()
        self.button(f, '存好', self.ok, primary=True)
        self.button(f, '取消', self.destroy)
        self.after(80, self.box.text.focus_set)

    def ok(self):
        text = '\n'.join(ln.rstrip() for ln in self.box.get().splitlines()).strip()
        try:
            with open(names_path(), 'w', encoding='utf-8-sig', newline='\r\n') as fh:   # 带 BOM：老记事本也认
                fh.write(text + ('\n' if text else ''))
        except OSError as e:
            self.err.set(f'存不了：{e}')
            return
        n = len(engine.load_names(names_path()))
        self.destroy()
        self.app.write(f'✓ 名单存好了：{n} 人' if n else '名单是空的：没有也能用，SETTER 就照单子抄')
        self.app.refresh_category()


class ResultsCard(CardDialog):
    """所有结果：每一批一行（时间、类别、几张），点「打开表」开那批的表，点「核对」看那批的编号照片。"""

    SHOW = 12

    def __init__(self, app: App):
        from .viewer import list_results
        super().__init__(app, '所有结果', 600)
        b = self.body
        self.runs = list_results(app.folder.get())
        if not self.runs:
            ui.Para(b, tk.StringVar(value='还没有结果：先点「选照片…」，再点「开始工作」干一批。'),
                    font=(self.fam, 10), width_px=540).pack(fill='x')
        for i, r in enumerate(self.runs[:self.SHOW]):
            if i:
                ui.separator(b).pack(fill='x')
            row = tk.Frame(b, bg=ui.CARD)
            row.pack(fill='x', pady=6)
            d = datetime.strptime(r['run'], '%Y%m%d_%H%M%S')
            tk.Label(row, text=f'{d:%m-%d %H:%M}', font=(self.fam, 11), bg=ui.CARD, fg=ui.TEXT).pack(side='left')
            tag = f"{r['cat']} · {r['photos']} 张" + ('　最新' if i == 0 else '')
            tk.Label(row, text=tag, font=(self.fam, 10), bg=ui.CARD, fg=ui.BLUE if i == 0 else ui.GREY).pack(
                side='left', padx=(12, 0))
            pill = dict(font=(self.fam, 10), bg=ui.CARD, height=30, radius=8, padx=12)
            ui.Pill(row, '核对', command=lambda r=r: self.check(r), state='normal' if r['photos'] else 'disabled',
                    **pill).pack(side='right', padx=(8, 0))
            ui.Pill(row, '打开表', command=lambda r=r: open_path(r['xlsx']), icon='table', **pill).pack(side='right')
        if len(self.runs) > self.SHOW:
            ui.Para(b, tk.StringVar(value=f'更早的 {len(self.runs) - self.SHOW} 批在结果文件夹里。'),
                    font=(self.fam, 9), width_px=540).pack(fill='x', pady=(8, 0))
        f = self.footer()
        self.button(f, '完成', self.destroy, primary=True)
        self.button(f, '打开结果文件夹', app.open_out)

    def check(self, r):
        self.destroy()
        self.app.check(r['dir'])


class FeedCard(CardDialog):
    """放入样板资料：先选放进哪个类别（刀单 / 自建的 / ＋新建），再选表（Song 定的叫法；说明里不提公司）。"""

    def __init__(self, app: App, preselect: str | None = None):
        super().__init__(app, '放入样板资料', 600)
        b = self.body
        row = tk.Frame(b, bg=ui.CARD)
        row.pack(fill='x')
        tk.Label(row, text='放进', font=self.bf, bg=ui.CARD, fg=ui.TEXT).pack(side='left', padx=(0, 12))
        cats = tables.names(app_dir())
        self.cat = tk.StringVar(value=preselect if preselect in cats else app.category.get())
        combo = ui.Combo(row, self.cat, cats, font=self.bf, bg=ui.CARD, width=260)
        combo.box.configure(state='readonly')
        combo.box.bind('<<ComboboxSelected>>', lambda e: self.describe())
        combo.pack(side='left')
        ui.Pill(row, '＋ 新建类别', command=self.new, font=self.bf, bg=ui.CARD, height=38, radius=8,
                padx=14).pack(side='left', padx=(10, 0))
        self.desc = tk.StringVar()
        ui.Para(b, self.desc, font=(self.fam, 10), width_px=540).pack(fill='x', pady=(14, 0))
        f = self.footer()
        self.button(f, '选表放进去', self.choose, primary=True)
        self.button(f, '取消', self.destroy)
        self.describe()

    def describe(self):
        cat = self.cat.get()
        if cat == tables.BUILTIN:
            t = ('改对的刀单表，人工录的、录入僧认完改好的都行，一次能塞好几本。\n'
                 'Excel（.xlsx、.xls）、CSV 都行。\n'
                 '不像刀单的表（没有 DATE、MACHINE 表头）一条都不吃，免得别的单子串进来。\n'
                 f'也可以把表直接丢进 {feed_dir()}，每次开工前自动吃。')
        else:
            try:
                cols = tables.TableDB(tables.db_path(app_dir(), cat)).columns()
            except Exception:
                cols = []
            head = (f'现在的列：{"、".join(cols)}。表里多出来的列会接在后面。' if cols
                    else f'第一本的表头会定成「{cat}」的列。')
            t = (f'认完、改对了的「{cat}」结果表（录入僧出的那本就行），可以一次选好几本。\n'
                 f'Excel（.xlsx、.xls）、CSV 都行。\n{head}\n'
                 f'也可以把表直接丢进 {tables.feed_path(app_dir(), cat)}，每次开工前自动吃。')
        self.desc.set(t)

    def new(self):
        app = self.app
        app.new_category(then=lambda name: app._dialog(FeedCard, name))

    def choose(self):
        cat = self.cat.get()
        paths = filedialog.askopenfilenames(parent=self, title=f'选要放进「{cat}」的表（可以多选）',
                                            filetypes=sheets.FILETYPES)
        if not paths:
            return
        self.destroy()
        self.app.do_feed(cat, paths)


def pretty_notes(text: str) -> str:
    """更新说明给人看：只跨了一版就不写版本号那行；「- 」换成「• 」。"""
    lines = [ln for ln in (text or '').splitlines() if ln.strip()]
    heads = [ln for ln in lines if re.fullmatch(r'v\d+(?:\.\d+)+', ln.strip())]
    if len(heads) == 1:
        lines = [ln for ln in lines if ln not in heads]
    return '\n'.join(('• ' + ln.strip()[2:]) if ln.strip().startswith('- ') else ln for ln in lines)


class UpdateCard(CardDialog):
    """有新版：告诉他出了哪一版、更新了啥；他自己点「现在更新」，也可以点「以后都自动更新」。"""

    def __init__(self, app: App, remote: str, text: str = ''):
        # 话是 Song 定的（2026-10-30）：不打官腔
        super().__init__(app, f'录入僧 v{remote} 搞出来了', 560)
        self.remote = remote
        b = self.body
        tk.Label(b, text=f'（你那 v{engine.VERSION} 该淘汰了）', font=(self.fam, 10), bg=ui.CARD, fg=ui.GREY,
                 anchor='w').pack(anchor='w')
        tk.Label(b, text='这次弄了点啥：', font=(self.fam, 11, 'bold'), bg=ui.CARD, fg=ui.TEXT, anchor='w').pack(
            anchor='w', pady=(14, 4))
        self.notes = tk.StringVar(value=pretty_notes(text) if text else '正在拿更新说明…')
        ui.Para(b, self.notes, font=(self.fam, 10), fg=ui.TEXT, width_px=500).pack(fill='x')
        ui.Para(b, tk.StringVar(value='放心，换版本不会动你的设置、数据库和照片。更新完自己重启一下。\n'
                                      '如果想要什么新花样，或者觉得哪里反人类，直接发邮件找我算账：'),
                font=(self.fam, 9), width_px=500).pack(fill='x', pady=(14, 0))
        mail = tk.Label(b, text=updater.CONTACT, font=(self.fam, 9, 'underline'), bg=ui.CARD, fg=ui.BLUE,
                        cursor='hand2', anchor='w')
        mail.pack(anchor='w')
        mail.bind('<Button-1>', lambda e: self.mail())
        self.status = tk.StringVar(value='')
        tk.Label(b, textvariable=self.status, font=(self.fam, 10), bg=ui.CARD, fg=ui.BLUE, anchor='w').pack(
            anchor='w', pady=(8, 0))
        f = self.footer()
        self.btns = [self.button(f, '现在更新', self.now, primary=True),
                     self.button(f, '以后都自动更新', self.always),
                     self.button(f, '以后再说', self.later)]
        if not text:
            def go():
                t = updater.notes()
                app.q.put(('call', lambda: self.winfo_exists() and self.notes.set(pretty_notes(t) or '这次没写更新说明。')))
            threading.Thread(target=go, daemon=True).start()

    def mail(self):
        import urllib.parse
        self.clipboard_clear()
        self.clipboard_append(updater.CONTACT)
        open_path(f'mailto:{updater.CONTACT}?subject=' + urllib.parse.quote(f'录入僧 v{engine.VERSION} 建议'))
        self.status.set(f'邮箱已复制：{updater.CONTACT}')

    def enable(self, on: bool = True):
        for btn in self.btns:
            btn.config(state='normal' if on else 'disabled')

    def now(self):
        self.enable(False)
        self.app.update_now(self.remote, self)

    def always(self):
        self.app.setting_changed('auto_update', True)
        self.app.write('自动更新打开了：以后有新版自己下载、空闲时换上（⚙ 里可以关）')
        self.now()

    def later(self):
        self.app.update_dismissed = self.remote
        self.destroy()


def go_home() -> bool:
    """exe 不在自己的「录入僧」文件夹里（比如直接在「下载」里双击）：在旁边建「录入僧」文件夹，把自己抄进去，
    从那里开（数据、照片、表格都在那个文件夹里，不撒一地）。家里已经有一样新的，就直接开家里那个。
    -> True = 交给家里那个了，自己退出。"""
    try:
        action, target = autopilot.home_plan(sys.executable)
        if not action:
            return False
        bg = [a for a in autopilot.startup_args() if a == '--background']
        if action == 'open':
            autopilot.start(target, bg)
            return True
        os.makedirs(os.path.dirname(target), exist_ok=True)
        autopilot.log_update(os.path.dirname(target), f'从 {sys.executable} 搬进来')
        autopilot.install_update(sys.executable, target, wait=10, args=bg)
        return True
    except Exception:
        return False                                  # 搬不了（比如没权限）：就在原地开


def run_gui():
    if getattr(sys, 'frozen', False):
        new = handoff_target()
        if new:
            subprocess.Popen([new], cwd=os.path.dirname(new))
            return
    args = autopilot.startup_args()
    if getattr(sys, 'frozen', False) and '--after-update' not in args and go_home():
        return
    if not autopilot.claim_single(wait=30 if '--after-update' in args else 0):
        if '--background' not in args:              # 已经开着一个：叫它把窗口亮出来，自己退出
            autopilot.ask_running_to_show(app_dir())
        return
    ui.dpi_aware()                              # 先告诉 Windows「放大我自己来」，再建窗口：字和图标才清楚
    root = tk.Tk()
    App(root)
    root.mainloop()
