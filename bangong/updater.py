"""自动更新：去网站（GitHub Releases）看有没有新版，有就下载成「录入僧.new.exe」放在 exe 旁边。

真正换版本的还是 autopilot 那一套：主程序空闲时看到「录入僧.new.exe」，先让它报一下版本号（打不开就不换），
再交给它把自己抄过去、重开。这里只管「查」和「下」，下载到一半断了不会留下半个 exe。
"""
from __future__ import annotations

import os
import re
import urllib.request

from . import autopilot, engine

REPO = 'oilsongchengmin-svg/luruseng'
SITE_URL = 'https://oilsongchengmin-svg.github.io/luruseng/'          # 录入僧的网站：下载、怎么用
KEY_URL = SITE_URL + 'key.html'                                         # 怎么免费领钥匙（钥匙框后面那个按钮）
RELEASES_URL = f'https://github.com/{REPO}/releases'
LATEST = os.environ.get('BANGONG_UPDATE', f'https://github.com/{REPO}/releases/latest/download').rstrip('/')
EXE_ASSET = 'luruseng.exe'
VERSION_ASSET = 'version.txt'
CHANGES_ASSET = 'changes.md'           # 更新说明：每个版本一段「## 1.9.1」
CONTACT = 'oilsongchengmin@gmail.com'  # 制作人：修改建议、想要的功能
CHECK_EVERY = 6 * 3600                  # 每 6 小时查一次
MIN_SIZE = 5 * 1024 * 1024              # 正经的 exe 起码这么大；小于这个就是下坏了（或者下到一张网页）


def _open(url: str, timeout: float):
    req = urllib.request.Request(url, headers={'User-Agent': f'luruseng/{engine.VERSION}'})
    return urllib.request.urlopen(req, timeout=timeout)


def latest_version(timeout: float = 15) -> str:
    """网站上最新版的版本号，比如 '1.8.0'。查不到就抛异常。"""
    with _open(f'{LATEST}/{VERSION_ASSET}', timeout) as r:
        v = r.read(64).decode('utf-8', 'replace').strip().lstrip('﻿')
    if not autopilot.vtuple(v):
        raise ValueError(f'网站上的版本号看不懂：{v[:20]!r}')
    return v


def is_newer(remote: str, local: str = engine.VERSION) -> bool:
    r, l_ = autopilot.vtuple(remote), autopilot.vtuple(local)
    return bool(r) and r > l_


def download(url: str, dst: str, timeout: float = 60, progress=None) -> int:
    """下载到 dst.part，下完、大小对了再改名成 dst。返回字节数。"""
    part = dst + '.part'
    n = 0
    try:
        with _open(url, timeout) as r, open(part, 'wb') as f:
            total = int(r.headers.get('Content-Length') or 0)
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
                n += len(chunk)
                if progress:
                    progress(n, total)
        if total and n != total:
            raise IOError(f'只下了 {n}/{total} 字节')
        if n < MIN_SIZE:
            raise IOError(f'下下来只有 {n} 字节，不像是程序')
        os.replace(part, dst)
        return n
    finally:
        if os.path.exists(part):
            try:
                os.remove(part)                     # 半截的不留
            except OSError:
                pass


def notes_since(text: str, since: str = engine.VERSION, limit: int = 40) -> str:
    """从更新说明里挑出比 since 新的那几段：「v1.9.1」一行，下面是那一版的条目。"""
    out, keep = [], False
    for line in (text or '').splitlines():
        m = re.match(r'^#{1,6}\s*v?(\d+(?:\.\d+)+)\s*$', line.strip())
        if m:
            keep = autopilot.vtuple(m.group(1)) > autopilot.vtuple(since)
            if keep:
                out.append(f'v{m.group(1)}')
            continue
        if keep and line.strip():
            out.append(line.rstrip())
    return '\n'.join(out[:limit])


def notes(since: str = engine.VERSION, timeout: float = 15) -> str:
    """网站上的更新说明里，比 since 新的部分。拿不到就是 ''（不耽误更新）。"""
    try:
        with _open(f'{LATEST}/{CHANGES_ASSET}', timeout) as r:
            text = r.read(200_000).decode('utf-8', 'replace').lstrip('\ufeff')
        return notes_since(text, since)
    except Exception:
        return ''


def check(app_dir: str, log=lambda m: None, skip: str = '') -> str:
    """查一次。有比自己新的（并且不是上次换失败的 skip 那个版本）就下载成「录入僧.new.exe」。
    -> 下好了的新版本号；已经最新就是 ''。网络不通等错误照常抛出，由调用的人决定说不说。"""
    remote = latest_version()
    if not is_newer(remote) or remote == skip:
        return ''
    dst = os.path.join(app_dir, autopilot.UPDATE_NAME)
    if os.path.exists(dst):                         # 已经下好了，等着空闲时换
        return remote
    log(f'发现新版 v{remote}，正在下载…')
    size = download(f'{LATEST}/{EXE_ASSET}', dst)
    autopilot.log_update(app_dir, f'下载好新版 v{remote}（{size // 1024 // 1024} MB），空闲时换上')
    log(f'新版 v{remote} 下载好了，空闲时自己换上')
    return remote
