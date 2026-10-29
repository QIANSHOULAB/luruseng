"""录入僧 窗口：选文件夹、填钥匙、点「开始工作」，其余自己干。"""
from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import tkinter as tk
from tkinter import filedialog, ttk

from . import engine


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
            fo = cfg.get('folder', '')
            if fo.replace('/', '\\').lower().startswith('f:\\songchengmin\\' + engine.OLD_NAME):
                cfg['folder'] = 'F:\\songchengmin\\' + engine.APP_NAME + fo[len('F:\\songchengmin\\' + engine.OLD_NAME):]
            with open(os.path.join(d, 'config.json'), 'w', encoding='utf-8') as f:
                json.dump(cfg, f, ensure_ascii=False, indent=1)
        except Exception:
            pass
    os.makedirs(d, exist_ok=True)
    return d


CONFIG = os.path.join(config_dir(), 'config.json')


def default_folder() -> str:
    if os.name == 'nt' and os.path.isdir('F:\\'):
        return 'F:\\songchengmin\\' + engine.APP_NAME + '\\待识别'
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


def load_config() -> dict:
    try:
        with open(CONFIG, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}


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
    """不再用的旧文件不直接删：F 盘有「待删除」就挪进去，没有就删（只用于旧快捷方式）。"""
    try:
        bin_ = 'F:\\songchengmin\\待删除'
        if os.name == 'nt' and os.path.isdir('F:\\songchengmin'):
            os.makedirs(bin_, exist_ok=True)
            dst = os.path.join(bin_, os.path.basename(path))
            n = 1
            while os.path.exists(dst):
                n += 1
                dst = os.path.join(bin_, f'{n}_' + os.path.basename(path))
            os.replace(path, dst)
            return '旧快捷方式挪到：' + dst
        os.remove(path)
        return '旧快捷方式已删：' + path
    except OSError as e:
        return f'旧快捷方式没挪动：{path}（{e}）'


def migrate_old_home(new_dir: str | None = None) -> list[str]:
    """改名：exe 在 ...\\录入僧 里时，把旁边旧的 ...\\搬工 里的东西（名单、数据库、投喂的表、
    待识别里的照片和结果）搬过来，然后把旧文件夹整个挪进 F:\\songchengmin\\待删除（不直接删）。"""
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


def ensure_shortcuts(cfg: dict):
    """打包版第一次打开时，自己在桌面和开始菜单放「录入僧」快捷方式（以后不用再找 exe），顺手把改名前的「搬工」快捷方式挪走。
    用 Windows 自带的 Unicode 版 IShellLink，中文文件名、中文路径都不会变问号。"""
    if os.name != 'nt' or not getattr(sys, 'frozen', False) or cfg.get('shortcut_for') == sys.executable:
        return
    log = os.path.join(config_dir(), 'shortcut.log')
    lines = []
    try:
        import pythoncom
        from win32com.shell import shell, shellcon
        pythoncom.CoInitialize()
        try:
            for csidl in (shellcon.CSIDL_DESKTOPDIRECTORY, shellcon.CSIDL_PROGRAMS):
                d = shell.SHGetFolderPath(0, csidl, None, 0)
                os.makedirs(d, exist_ok=True)
                link = pythoncom.CoCreateInstance(shell.CLSID_ShellLink, None,
                                                  pythoncom.CLSCTX_INPROC_SERVER, shell.IID_IShellLink)
                link.SetPath(sys.executable)
                link.SetWorkingDirectory(os.path.dirname(sys.executable))
                link.SetIconLocation(sys.executable, 0)
                link.SetDescription('刀具破损记录照片识别成 Excel')
                target = os.path.join(d, engine.APP_NAME + '.lnk')
                link.QueryInterface(pythoncom.IID_IPersistFile).Save(target, 0)
                lines.append('已放：' + target)
                old = os.path.join(d, engine.OLD_NAME + '.lnk')
                if os.path.exists(old):
                    lines.append(retire(old))
        finally:
            pythoncom.CoUninitialize()
        cfg['shortcut_for'] = sys.executable
        save_config(cfg)
    except Exception as e:
        lines.append(f'{type(e).__name__}: {e}')
    try:
        with open(log, 'w', encoding='utf-8') as f:
            f.write('\n'.join(lines) + '\n')
    except OSError:
        pass


class App:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.q: queue.Queue = queue.Queue()
        self.stop = threading.Event()
        self.worker: threading.Thread | None = None
        self.last_xlsx = ''
        self.last_photos = ''
        self.viewer = None
        cfg = load_config()

        root.title(f'{engine.APP_NAME} —— {engine.SUBTITLE}  v{engine.VERSION}')
        try:
            base = getattr(sys, '_MEIPASS', os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
            root.iconbitmap(os.path.join(base, 'assets', 'bangong.ico'))
        except Exception:
            pass
        root.geometry('760x560')
        root.minsize(600, 420)
        try:
            ttk.Style().theme_use('vista' if os.name == 'nt' else 'clam')
        except tk.TclError:
            pass
        font = ('Microsoft YaHei UI', 10) if os.name == 'nt' else None
        if font:
            root.option_add('*Font', font)

        f = ttk.Frame(root, padding=12)
        f.pack(fill='both', expand=True)
        f.columnconfigure(1, weight=1)

        head = ttk.Frame(f)
        head.grid(row=0, column=0, columnspan=3, sticky='w', pady=(0, 8))
        big = ('Microsoft YaHei UI', 16, 'bold') if os.name == 'nt' else ('TkDefaultFont', 16, 'bold')
        small = ('Microsoft YaHei UI', 10) if os.name == 'nt' else ('TkDefaultFont', 10)
        ttk.Label(head, text=engine.APP_NAME, font=big).pack(side='left')
        ttk.Label(head, text='  —— ' + engine.SUBTITLE, font=small, foreground='#666').pack(side='left', pady=(6, 0))

        ttk.Label(f, text='图片文件夹').grid(row=1, column=0, sticky='w', pady=3)
        self.folder = tk.StringVar(value=cfg.get('folder') or default_folder())
        ttk.Entry(f, textvariable=self.folder).grid(row=1, column=1, sticky='ew', padx=6)
        ttk.Button(f, text='选择…', command=self.pick).grid(row=1, column=2)

        self.key1 = tk.StringVar(value=cfg.get('key1', ''))
        self.key2 = tk.StringVar(value=cfg.get('key2', ''))
        ttk.Label(f, text='钥匙 1').grid(row=2, column=0, sticky='w', pady=3)
        ttk.Entry(f, textvariable=self.key1, show='•').grid(row=2, column=1, columnspan=2, sticky='ew', padx=(6, 0))
        ttk.Label(f, text='钥匙 2（可空）').grid(row=3, column=0, sticky='w', pady=3)
        ttk.Entry(f, textvariable=self.key2, show='•').grid(row=3, column=1, columnspan=2, sticky='ew', padx=(6, 0))

        ttk.Label(f, text='模型').grid(row=4, column=0, sticky='w', pady=3)
        self.model = tk.StringVar(value=cfg.get('model') or engine.DEFAULT_MODEL)
        ttk.Combobox(f, textvariable=self.model, values=engine.MODELS).grid(row=4, column=1, sticky='w', padx=6)

        bar = ttk.Frame(f)
        bar.grid(row=5, column=0, columnspan=3, sticky='ew', pady=(10, 6))
        self.start_btn = ttk.Button(bar, text='开始工作', command=self.start)
        self.start_btn.pack(side='left')
        self.stop_btn = ttk.Button(bar, text='停止', command=self.halt, state='disabled')
        self.stop_btn.pack(side='left', padx=6)
        ttk.Button(bar, text='打开结果文件夹', command=self.open_out).pack(side='left')
        ttk.Button(bar, text='核对', command=self.check).pack(side='left', padx=6)
        self.feed_btn = ttk.Button(bar, text='投喂数据', command=self.feed)
        self.feed_btn.pack(side='left')
        self.status = tk.StringVar(value='')
        ttk.Label(bar, textvariable=self.status).pack(side='left', padx=10)

        self.pb = ttk.Progressbar(f, mode='determinate')
        self.pb.grid(row=6, column=0, columnspan=3, sticky='ew')

        self.text = tk.Text(f, height=16, wrap='word', state='disabled', relief='flat', background='#f6f6f6')
        self.text.grid(row=7, column=0, columnspan=3, sticky='nsew', pady=(8, 0))
        f.rowconfigure(7, weight=1)

        if getattr(sys, 'frozen', False):
            for line in migrate_old_home():
                self.write(line)
        self.refresh_count()
        n = len(engine.load_names(names_path()))
        self.write(f'名单：{n} 人（{names_path()}）' if n else f'没找到名单：{names_path()}（没有也能用，SETTER 就照单子抄）')
        try:
            from .kb import KnowledgeBase
            self.write(KnowledgeBase(kb_path()).summary() + f'（投喂文件夹：{feed_dir()}）')
        except Exception as e:
            self.write(f'数据库打不开：{type(e).__name__}：{e}')
        self.cfg = cfg
        threading.Thread(target=ensure_shortcuts, args=(cfg,), daemon=True).start()
        root.protocol('WM_DELETE_WINDOW', self.on_close)
        root.after(150, self.pump)

    # ---------- UI 动作
    def pick(self):
        d = filedialog.askdirectory(initialdir=self.folder.get() or None)
        if d:
            self.folder.set(os.path.normpath(d))
            self.refresh_count()

    def refresh_count(self):
        try:
            n = len(engine.scan(self.folder.get())) if os.path.isdir(self.folder.get()) else 0
            self.status.set(f'待识别 {n} 张')
        except Exception:
            self.status.set('')

    def save(self):
        self.cfg.update({'folder': self.folder.get(), 'key1': self.key1.get().strip(),
                         'key2': self.key2.get().strip(), 'model': self.model.get().strip()})
        save_config(self.cfg)

    def log(self, msg: str):
        self.q.put(('log', msg))

    def start(self):
        if self.worker and self.worker.is_alive():
            return
        k1, k2 = self.key1.get().strip(), self.key2.get().strip()
        if not k1 and not k2:
            self.write('✗ 先填钥匙')
            return
        if k1 and k1 == k2:
            self.write('✗ 两个钥匙填的是同一把（额度按项目算，同一把没意义）')
            return
        self.save()
        self.stop.clear()
        self.start_btn.config(state='disabled')
        self.stop_btn.config(state='normal')
        self.pb.config(value=0)
        eng = engine.Engine(self.folder.get(), [k1, k2], self.model.get(), log=self.log,
                            progress=lambda d, t: self.q.put(('prog', (d, t))), stop=self.stop,
                            names_path=names_path(), kb_path=kb_path(), feed_dir=feed_dir())

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

    def feed(self):
        """投喂数据：选公司的 TOOL BROKEN RECORD（或核对过的录入僧结果表），一次可以选好几本。"""
        paths = filedialog.askopenfilenames(title='选要喂给数据库的表（可以多选）',
                                            filetypes=[('Excel', '*.xlsx *.xlsm'), ('全部', '*.*')])
        if not paths:
            return
        self.feed_btn.config(state='disabled')
        self.write(f'开始投喂 {len(paths)} 本表…')

        def work():
            try:
                from .kb import KnowledgeBase
                kb = KnowledgeBase(kb_path())
                for p in paths:
                    self.log(kb.feed(p).line())
                self.log(kb.summary())
            except Exception as e:
                self.log(f'✗ 投喂出错：{type(e).__name__}：{e}')
            self.q.put(('fed', None))

        threading.Thread(target=work, daemon=True).start()

    def check(self, run_dir: str | None = None):
        """核对窗口：编号照片一张一张看，第一张就是 1，←→ 翻页，输入编号直接跳。"""
        from .viewer import Viewer
        if self.viewer is not None and self.viewer.winfo_exists():
            self.viewer.destroy()
        self.viewer = Viewer(self.root, self.folder.get(), run_dir or self.last_photos or None)

    def on_close(self):
        self.save()
        self.stop.set()
        self.root.destroy()

    def write(self, msg: str):
        self.text.config(state='normal')
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
                elif kind == 'fed':
                    self.feed_btn.config(state='normal')
                elif kind == 'done':
                    self.start_btn.config(state='normal')
                    self.stop_btn.config(state='disabled')
                    if val and val.xlsx:
                        self.last_xlsx = val.xlsx
                        self.last_photos = val.photos_dir
                        self.status.set(f'干完：成功 {val.ok} · 失败 {val.failed}')
                        if val.ok and not self.stop.is_set():
                            open_path(val.xlsx)                 # 表和核对窗口一起打开，对着核
                            if val.photos_dir and os.path.isdir(val.photos_dir):
                                self.check(val.photos_dir)
                    else:
                        self.refresh_count()
        except queue.Empty:
            pass
        self.root.after(150, self.pump)


def handoff_target(here: str | None = None) -> str:
    """从改名前的「搬工」文件夹被打开（旧快捷方式）时，旁边有新的 录入僧\\录入僧.exe 就交给它。"""
    here = here or app_dir()
    if os.path.basename(here) != engine.OLD_NAME:
        return ''
    new = os.path.join(os.path.dirname(here), engine.APP_NAME, engine.APP_NAME + '.exe')
    return new if os.path.isfile(new) else ''


def run_gui():
    if getattr(sys, 'frozen', False):
        new = handoff_target()
        if new:
            subprocess.Popen([new], cwd=os.path.dirname(new))
            return
    root = tk.Tk()
    App(root)
    root.mainloop()
