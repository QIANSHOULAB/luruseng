"""自动驾驶：来图就干、自己换新版、开机后台挂着、只开一个。

人不在电脑前也能用：往「待识别」丢照片，它自己开工；往 exe 旁边丢一个「录入僧.new.exe」，它自己换上重启。
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime

from . import engine

UPDATE_NAME = engine.APP_NAME + '.new.exe'      # 丢在 exe 旁边就会自己换上
STATUS_NAME = '.录入僧状态.json'                 # 活着没有、哪个版本、在不在干活（给远程看）
SHOW_NAME = '.录入僧-显示窗口'                   # 第二次双击图标时留的条子：叫已经开着的那个把窗口亮出来
UPDATE_LOG = '更新日志.txt'
BIN_DIR = r'F:\songchengmin\待删除'
STABLE_SECS = 30                                # 照片 30 秒内没再变，才算放完了


def image_snapshot(folder: str) -> dict[str, tuple[int, float]]:
    """文件夹里的照片：{文件名: (大小, 修改时间)}。"""
    out = {}
    try:
        for name in os.listdir(folder):
            p = os.path.join(folder, name)
            if os.path.splitext(name)[1].lower() in engine.IMG_EXT and os.path.isfile(p):
                st = os.stat(p)
                if st.st_size > 0:
                    out[name] = (st.st_size, st.st_mtime)
    except OSError:
        pass
    return out


class Watcher:
    """来图就干：有没见过的照片，并且 STABLE_SECS 秒内没再变化（放完了），就该开工。
    开工那一刻文件夹里有的都记成「见过」：认失败留在原地的不会被反复重试，等有新照片进来再一起干。"""

    def __init__(self, stable: float = STABLE_SECS, clock=time.time):
        self.stable, self.clock = stable, clock
        self.seen: dict = {}
        self.pending: dict | None = None
        self.since = 0.0

    def poll(self, snap: dict) -> bool:
        new = {k: v for k, v in snap.items() if self.seen.get(k) != v}
        if not new:
            self.pending = None
            return False
        if new != self.pending:
            self.pending, self.since = new, self.clock()
            return False
        return self.clock() - self.since >= self.stable

    def started(self, snap: dict):
        self.seen = dict(snap)
        self.pending = None


class FileSettle:
    """一个文件（新版 exe）大小 STABLE 秒内不变，才算传完。"""

    def __init__(self, stable: float = 20, clock=time.time):
        self.stable, self.clock = stable, clock
        self.sig = None
        self.since = 0.0

    def ready(self, path: str) -> bool:
        try:
            st = os.stat(path)
            sig = (st.st_size, st.st_mtime)
        except OSError:
            self.sig = None
            return False
        if sig != self.sig:
            self.sig, self.since = sig, self.clock()
            return False
        return self.clock() - self.since >= self.stable


def same_file(a: str, b: str) -> bool:
    try:
        return os.path.getsize(a) == os.path.getsize(b) and engine.file_hash(a) == engine.file_hash(b)
    except OSError:
        return False


def log_update(app_dir: str, line: str):
    """更新日志.txt：给记事本看，第一次建文件时带 BOM。"""
    path = os.path.join(app_dir, UPDATE_LOG)
    enc = 'utf-8' if os.path.exists(path) else 'utf-8-sig'
    try:
        with open(path, 'a', encoding=enc, newline='') as f:
            f.write(f'{datetime.now():%Y-%m-%d %H:%M:%S}  {line}\r\n')
    except OSError:
        pass


def probe_version(exe: str, timeout: float = 120) -> str:
    """让新版自己报版本号（写进一个临时文件）。打不开、报不出来就是坏的，不换。"""
    out = exe + '.version.txt'
    try:
        os.remove(out)
    except OSError:
        pass
    try:
        p = subprocess.run([exe, '--write-version', out], timeout=timeout,
                           creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if p.returncode != 0:
            return ''
        with open(out, encoding='utf-8') as f:
            return f.read().strip()
    except Exception:
        return ''
    finally:
        try:
            os.remove(out)
        except OSError:
            pass


def install_update(src: str, target: str, launch: bool = True, wait: float = 90) -> str:
    """新版（src，正在运行的就是它）把自己抄到 target 上。旧版刚退出可能还占着文件，抄不进去就等一会儿再试。"""
    tmp = target + '.tmp'
    deadline = time.time() + wait
    while True:
        try:
            shutil.copyfile(src, tmp)
            os.replace(tmp, target)
            break
        except OSError:
            if time.time() > deadline:
                raise
            time.sleep(1)
    log_update(os.path.dirname(target), f'换上 v{engine.VERSION}')
    if launch and not os.environ.get('BANGONG_NO_LAUNCH'):
        subprocess.Popen([target, '--background', '--after-update'], cwd=os.path.dirname(target))
    return target


def retire_update_file(app_dir: str, wait: float = 60) -> str:
    """换完新版后，把用过的「录入僧.new.exe」挪进 待删除（不直接删）；刚交接完可能还被占着，等一会儿。"""
    src = os.path.join(app_dir, UPDATE_NAME)
    if not os.path.exists(src):
        return ''
    bin_ = BIN_DIR if os.path.isdir(os.path.dirname(BIN_DIR)) else os.path.join(app_dir, '待删除')
    deadline = time.time() + wait
    while True:
        try:
            os.makedirs(bin_, exist_ok=True)
            dst = os.path.join(bin_, engine.APP_NAME + '更新包.exe')     # 只留最近一个更新包
            os.replace(src, dst)
            return dst
        except OSError:
            if time.time() > deadline:
                return ''
            time.sleep(2)


def write_status(app_dir: str, **info):
    info = {'version': engine.VERSION, 'pid': os.getpid(), 'tick': datetime.now().isoformat(timespec='seconds'), **info}
    path = os.path.join(app_dir, STATUS_NAME)
    try:
        with open(path + '.tmp', 'w', encoding='utf-8') as f:
            json.dump(info, f, ensure_ascii=False, indent=1)
        os.replace(path + '.tmp', path)
    except OSError:
        pass


# ---------------------------------------------------------------- 只开一个
_MUTEX = None


def claim_single(wait: float = 0) -> bool:
    """Windows 命名互斥量：拿到了就是唯一的那个。wait>0 时（刚换完新版，旧的还没退干净）多等一会儿。"""
    global _MUTEX
    if os.name != 'nt':
        return True
    import ctypes
    k32 = ctypes.windll.kernel32
    deadline = time.time() + wait
    while True:
        h = k32.CreateMutexW(None, False, 'Local\\LuRuSengSingleInstance')
        if h and k32.GetLastError() != 183:             # 183 = ERROR_ALREADY_EXISTS
            _MUTEX = h
            return True
        if h:
            k32.CloseHandle(h)
        if time.time() >= deadline:
            return False
        time.sleep(0.5)


def ask_running_to_show(app_dir: str):
    try:
        with open(os.path.join(app_dir, SHOW_NAME), 'w', encoding='utf-8') as f:
            f.write(str(os.getpid()))
    except OSError:
        pass


def take_show_request(app_dir: str) -> bool:
    p = os.path.join(app_dir, SHOW_NAME)
    if os.path.exists(p):
        try:
            os.remove(p)
        except OSError:
            pass
        return True
    return False


def canonical_exe(app_dir: str) -> str:
    return os.path.join(app_dir, engine.APP_NAME + '.exe')


def is_locked(path: str) -> bool:
    """别的进程（比如还没退干净的旧版）占着这个文件吗。"""
    try:
        with open(path, 'r+b'):
            return False
    except FileNotFoundError:
        return False
    except OSError:
        return True


def stray_exes(app_dir: str, me: str) -> list[str]:
    """exe 旁边别的「录入僧xxx.exe」（测试版之类）：正名之后挪进 待删除。"""
    out = []
    for name in os.listdir(app_dir):
        p = os.path.join(app_dir, name)
        if (name.lower().endswith('.exe') and name.startswith(engine.APP_NAME) and name != engine.APP_NAME + '.exe'
                and name != UPDATE_NAME and os.path.normcase(os.path.abspath(p)) != os.path.normcase(os.path.abspath(me))):
            out.append(p)
    return out


def retire_file(path: str, wait: float = 30) -> str:
    bin_ = BIN_DIR if os.path.isdir(os.path.dirname(BIN_DIR)) else os.path.join(os.path.dirname(path), '待删除')
    deadline = time.time() + wait
    while True:
        try:
            os.makedirs(bin_, exist_ok=True)
            base, ext = os.path.splitext(os.path.basename(path))
            dst = os.path.join(bin_, base + ext)
            n = 1
            while os.path.exists(dst):
                n += 1
                dst = os.path.join(bin_, f'{base}_{n}{ext}')
            os.replace(path, dst)
            return dst
        except OSError:
            if time.time() > deadline:
                return ''
            time.sleep(2)


def startup_args() -> list[str]:
    return [a for a in sys.argv[1:] if a in ('--background', '--after-update')]
