"""搬工 窗口：选文件夹、填钥匙、点「开始工作」，其余自己干。"""
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
    d = os.path.join(base, '搬工')
    os.makedirs(d, exist_ok=True)
    return d


CONFIG = os.path.join(config_dir(), 'config.json')


def default_folder() -> str:
    if os.name == 'nt' and os.path.isdir('F:\\'):
        return 'F:\\songchengmin\\搬工\\待识别'
    return os.path.join(os.path.expanduser('~'), '搬工', '待识别')


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


def ensure_shortcuts(cfg: dict):
    """打包版第一次打开时，自己在桌面和开始菜单放「搬工」快捷方式（以后不用再找 exe）。"""
    if os.name != 'nt' or not getattr(sys, 'frozen', False) or cfg.get('shortcut_for') == sys.executable:
        return
    exe = sys.executable.replace("'", "''")
    work = os.path.dirname(sys.executable).replace("'", "''")
    script = os.path.join(config_dir(), 'make_shortcut.ps1')
    log = os.path.join(config_dir(), 'shortcut.log')
    ps = f"""$ErrorActionPreference = 'Stop'
$ws = New-Object -ComObject WScript.Shell
$made = 0
foreach ($name in @('Desktop', 'Programs')) {{
  $d = [Environment]::GetFolderPath($name)
  if (-not $d) {{ Write-Output "$name 没有路径"; continue }}
  if (-not (Test-Path -LiteralPath $d)) {{ New-Item -ItemType Directory -Force -Path $d | Out-Null }}
  $l = $ws.CreateShortcut((Join-Path $d '搬工.lnk'))
  $l.TargetPath = '{exe}'
  $l.WorkingDirectory = '{work}'
  $l.IconLocation = '{exe},0'
  $l.Description = '图片识别成 Excel'
  $l.Save()
  Write-Output "已放：$d\\搬工.lnk"
  $made++
}}
if ($made -eq 0) {{ exit 3 }}
"""
    try:
        with open(script, 'w', encoding='utf-8-sig') as f:      # PowerShell 5.1 认中文要带 BOM
            f.write(ps)
        r = subprocess.run(['powershell', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
                           creationflags=0x08000000, timeout=60, capture_output=True, stdin=subprocess.DEVNULL)
        with open(log, 'wb') as f:
            f.write(r.stdout + b'\r\n' + r.stderr + f'\r\nexit {r.returncode}'.encode())
        if r.returncode == 0:
            cfg['shortcut_for'] = sys.executable
            save_config(cfg)
    except Exception as e:
        try:
            with open(log, 'a', encoding='utf-8') as f:
                f.write(f'{type(e).__name__}: {e}\n')
        except OSError:
            pass


class App:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.q: queue.Queue = queue.Queue()
        self.stop = threading.Event()
        self.worker: threading.Thread | None = None
        self.last_xlsx = ''
        cfg = load_config()

        root.title(f'搬工 · 图片转 Excel  v{engine.VERSION}')
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

        ttk.Label(f, text='图片文件夹').grid(row=0, column=0, sticky='w', pady=3)
        self.folder = tk.StringVar(value=cfg.get('folder') or default_folder())
        ttk.Entry(f, textvariable=self.folder).grid(row=0, column=1, sticky='ew', padx=6)
        ttk.Button(f, text='选择…', command=self.pick).grid(row=0, column=2)

        self.key1 = tk.StringVar(value=cfg.get('key1', ''))
        self.key2 = tk.StringVar(value=cfg.get('key2', ''))
        ttk.Label(f, text='钥匙 1').grid(row=1, column=0, sticky='w', pady=3)
        ttk.Entry(f, textvariable=self.key1, show='•').grid(row=1, column=1, columnspan=2, sticky='ew', padx=(6, 0))
        ttk.Label(f, text='钥匙 2（可空）').grid(row=2, column=0, sticky='w', pady=3)
        ttk.Entry(f, textvariable=self.key2, show='•').grid(row=2, column=1, columnspan=2, sticky='ew', padx=(6, 0))

        ttk.Label(f, text='模型').grid(row=3, column=0, sticky='w', pady=3)
        self.model = tk.StringVar(value=cfg.get('model') or engine.DEFAULT_MODEL)
        ttk.Combobox(f, textvariable=self.model, values=engine.MODELS).grid(row=3, column=1, sticky='w', padx=6)

        bar = ttk.Frame(f)
        bar.grid(row=4, column=0, columnspan=3, sticky='ew', pady=(10, 6))
        self.start_btn = ttk.Button(bar, text='开始工作', command=self.start)
        self.start_btn.pack(side='left')
        self.stop_btn = ttk.Button(bar, text='停止', command=self.halt, state='disabled')
        self.stop_btn.pack(side='left', padx=6)
        ttk.Button(bar, text='打开结果文件夹', command=self.open_out).pack(side='left')
        self.status = tk.StringVar(value='')
        ttk.Label(bar, textvariable=self.status).pack(side='left', padx=10)

        self.pb = ttk.Progressbar(f, mode='determinate')
        self.pb.grid(row=5, column=0, columnspan=3, sticky='ew')

        self.text = tk.Text(f, height=16, wrap='word', state='disabled', relief='flat', background='#f6f6f6')
        self.text.grid(row=6, column=0, columnspan=3, sticky='nsew', pady=(8, 0))
        f.rowconfigure(6, weight=1)

        self.refresh_count()
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
                            progress=lambda d, t: self.q.put(('prog', (d, t))), stop=self.stop)

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
                elif kind == 'done':
                    self.start_btn.config(state='normal')
                    self.stop_btn.config(state='disabled')
                    if val and val.xlsx:
                        self.last_xlsx = val.xlsx
                        self.status.set(f'干完：成功 {val.ok} · 失败 {val.failed}')
                        if val.ok and not self.stop.is_set():
                            open_path(val.xlsx)
                    else:
                        self.refresh_count()
        except queue.Empty:
            pass
        self.root.after(150, self.pump)


def run_gui():
    root = tk.Tk()
    App(root)
    root.mainloop()
