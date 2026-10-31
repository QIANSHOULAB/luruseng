"""发数据给方丈：⚙ 里「发数据给方丈」开着时，每批认完，把这批怎么认的、照片、后来人改过哪些格子，
送到方丈的网盘（录入僧回传接口），方丈拿去对答案，把准确率拉上来。默认关；关着什么都不记、什么都不发。

先落在本机，再慢慢发（断网、关机都不丢，下次接着发）：
  识别结果\\.回传\\<批次>\\记录.json   每张认了几遍、每遍认成什么、表里最后写了什么、哪些格子红/橙、花了多久
  识别结果\\.回传\\<批次>\\原样.xlsx   刚认完时的表：以后跟人改过、存过盘的表一比，哪格改了就知道
  识别结果\\.回传\\<批次>\\图\\07.jpg   模型看到的那张照片（缩到 1600 像素），发完就删
  识别结果\\.回传\\<批次>\\改过的格子_<时间>.json   表存盘以后跟原样比出来的改动
  识别结果\\.回传\\样板资料\\*.json    「放入样板资料」吃进去的表（人改对的答案）

接口只收不给：谁拿到网址，也只能往方丈网盘的「录入僧回传」里放东西，看不到、删不掉；一天最多收 100MB。
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import platform
import re
import shutil
import time
import urllib.request
import uuid
from dataclasses import dataclass
from datetime import datetime

from PIL import ImageFilter, ImageStat

from . import engine

URL = os.environ.get('LURUSENG_REPORT_URL', 'https://script.google.com/macros/s/'
                     'AKfycbwzeAYFK78lIJ092xl63VcTxvEsAY3fkLR2FjLQTcqlfxToRmi4YWriUwYIhBcJp85X/exec')
TOKEN = 'qslab-luruseng-1'
HOME = '.回传'
PICS = '图'
REPORT = '记录.json'
PRISTINE = '原样.xlsx'
SENT = '已发.txt'
STATE = '比过.json'
SAMPLES = '样板资料'
FIX_PREFIX = '改过的格子_'
SIDE = 1600                     # 发出去的照片最长边：手写字看得清，又不占网盘
QUALITY = 85
MAX_FILE = 6 * 1024 * 1024      # 一份最多这么大（接口一次收 8MB，base64 还要胀三分之一）
PHOTO_ROOM = 500 * 1024 * 1024  # 发不出去的照片在本机最多攒这么多，再多就只记文字不存图
WATCH_DAYS = 45                 # 盯多少天以内的表有没有被人改过
SETTLE = 60                     # 表存盘以后等一分钟再比（别撞上 Excel 存到一半）
TIMEOUT = 60


# ---------------------------------------------------------------- 本机落地
def _hide(p: str):
    if os.name == 'nt':
        try:
            import ctypes
            ctypes.windll.kernel32.SetFileAttributesW(p, 0x02)   # 隐藏：同事翻结果文件夹时不碍眼
        except Exception:
            pass


def home(folder: str) -> str:
    d = os.path.join(folder, engine.OUT_DIR, HOME)
    if not os.path.isdir(d):
        os.makedirs(d, exist_ok=True)
        _hide(d)
    return d


def run_dir(folder: str, run: str) -> str:
    d = os.path.join(home(folder), run)
    os.makedirs(d, exist_ok=True)
    return d


def machine(cfg: dict) -> str:
    """回传时这台电脑叫什么：电脑名 + 一串只属于这台的短号（两台电脑同名也分得开）。第一次用时生成，存进设置。"""
    if not cfg.get('report_id'):
        cfg['report_id'] = uuid.uuid4().hex[:6]
    name = os.environ.get('COMPUTERNAME') or platform.node() or 'PC'
    name = re.sub(r'[^\w.-]+', '_', name)[:30] or 'PC'
    return f'{name}_{cfg["report_id"]}'


def _dump(path: str, obj):
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=1, default=str)
    os.replace(tmp, path)                       # 写完才换上：发送那边永远读不到半个文件


def _load(path: str):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def snapshot(path: str) -> tuple[dict, bytes]:
    """照片本身怎么样（多大、亮不亮、糊不糊，拿去跟认错的格子对着找规律），外加一份缩到 1600 像素的 JPEG。"""
    im = engine._load_rgb(path)
    w, h = im.size
    g = engine._shrink(im, 512).convert('L')
    st = ImageStat.Stat(g)
    sharp = ImageStat.Stat(g.filter(ImageFilter.FIND_EDGES)).mean[0]
    info = {'w': w, 'h': h, 'bytes': os.path.getsize(path), 'light': round(st.mean[0], 1),
            'contrast': round(st.stddev[0], 1), 'sharp': round(sharp, 2)}
    buf = io.BytesIO()
    engine._shrink(im, SIDE).save(buf, 'JPEG', quality=QUALITY, optimize=True)
    return info, buf.getvalue()


def room(folder: str, limit: int | None = None) -> bool:
    """本机攒着没发出去的照片还没超过上限（网一直不通也不至于把硬盘塞满）。"""
    limit = PHOTO_ROOM if limit is None else limit
    total = 0
    h = os.path.join(folder, engine.OUT_DIR, HOME)
    for run in (os.listdir(h) if os.path.isdir(h) else []):
        d = os.path.join(h, run, PICS)
        if os.path.isdir(d):
            for f in os.listdir(d):
                try:
                    total += os.path.getsize(os.path.join(d, f))
                except OSError:
                    pass
    return total < limit


def table_rows(xlsx: str) -> dict[int, list[dict]]:
    """表里每个编号写了什么：{编号: [{'values': {列名: 值}, 'red': [标红的列], 'fixed': [按数据库改过的列], 'note': 核对提示}]}"""
    from .viewer import load_rows
    out: dict[int, list[dict]] = {}
    for no, rows in load_rows(xlsx).items():
        out[no] = [{'values': dict(zip(r['labels'], r['values'])),
                    'red': [r['labels'][i] for i in sorted(r['red'])],
                    'fixed': [r['labels'][i] for i in sorted(r['fixed'])],
                    'note': r['note']} for r in rows]
    return out


def finish_run(eng, items, xlsx: str, started: float, kb_line: str = '') -> str:
    """一批干完：写「记录.json」，再抄一份刚认完时的表当「原样」。返回这批的回传文件夹。"""
    d = run_dir(eng.folder, eng.run_name)
    rows = table_rows(xlsx)
    photos = []
    for no, p, h in items:
        t = eng.trace.get(p, {})
        one = {'no': no, 'file': os.path.basename(p), 'hash': h}
        for k in ('look', 'side', 'ms', 'error'):
            if t.get(k) not in (None, ''):
                one[k] = t[k]
        one['reads'] = t.get('reads', [])
        one['table'] = rows.get(no, [])
        photos.append(one)
    res = eng.res
    data = {
        'app': engine.APP_NAME, 'version': engine.VERSION, 'run': eng.run_name,
        'category': eng.spec.name if eng.spec else '刀单',
        'columns': list(eng.spec.columns) if eng.spec else list(engine.FIELDS),
        'model': eng.model, 'reads_per_photo': eng.reads, 'schema': eng.use_schema,
        'names': len(eng.names), 'kb': kb_line, 'xlsx': os.path.basename(xlsx),
        'started': datetime.fromtimestamp(started).isoformat(timespec='seconds'),
        'finished': datetime.now().isoformat(timespec='seconds'),
        'seconds': round(time.time() - started, 1),
        'result': {'ok': res.ok, 'failed': res.failed, 'records': res.records, 'requests': res.requests,
                   'skipped': res.skipped, 'stopped': res.stopped_reason},
        'photos': photos,
    }
    _dump(os.path.join(d, REPORT), data)
    shutil.copy2(xlsx, os.path.join(d, PRISTINE))
    _dump(os.path.join(d, STATE), {'mtime': os.path.getmtime(xlsx), 'sig': ''})
    return d


def queue_sample(folder: str, path: str, category: str) -> str:
    """「放入样板资料」吃进去的表也留一份等着发：那是人改对的答案。同一本表（内容一样）只留一份。"""
    try:
        size = os.path.getsize(path)
        if size > MAX_FILE * 3 // 4:
            return ''
        with open(path, 'rb') as f:
            raw = f.read()
    except OSError:
        return ''
    sha = hashlib.sha1(raw).hexdigest()[:10]
    stem = re.sub(r'[\\/:*?"<>|\s]+', '_', os.path.basename(path))[:40]
    p = os.path.join(run_dir(folder, SAMPLES), f'样板_{sha}_{stem}.json')
    if not os.path.exists(p):
        _dump(p, {'file': os.path.basename(path), 'category': category, 'size': size,
                  'fed_at': datetime.now().isoformat(timespec='seconds'),
                  'b64': base64.b64encode(raw).decode()})
    return p


# ---------------------------------------------------------------- 人改过的格子
def _norm(v) -> str:
    return re.sub(r'\s+', ' ', str(v or '')).strip()


def diff(before: dict, after: dict) -> dict:
    """刚认完时的表 vs 人存过盘的表：哪格从什么改成了什么，多了哪条、少了哪条。
    顺便数一下：标红的格子改了几个（红得对不对）、没标红的改了几个（漏网的错）。"""
    changes, added, removed = [], [], []
    cells = red = changed_red = changed_fixed = 0
    for no in sorted(set(before) | set(after)):
        b, a = before.get(no, []), after.get(no, [])
        for k in range(max(len(b), len(a))):
            if k >= len(b):
                added.append({'no': no, 'values': a[k]['values']})
                continue
            if k >= len(a):
                removed.append({'no': no, 'values': b[k]['values']})
                continue
            for f, was in b[k]['values'].items():
                cells += 1
                is_red, is_fixed = f in b[k]['red'], f in b[k]['fixed']
                red += is_red
                now = a[k]['values'].get(f, '')
                if _norm(was) != _norm(now):
                    changes.append({'no': no, 'k': k, 'field': f, 'was': was, 'now': now,
                                    'red': is_red, 'fixed': is_fixed})
                    changed_red += is_red
                    changed_fixed += is_fixed
    return {'changes': changes, 'added': added, 'removed': removed,
            'count': {'cells': cells, 'red': red, 'changed': len(changes), 'changed_red': changed_red,
                      'changed_not_red': len(changes) - changed_red, 'changed_fixed': changed_fixed,
                      'added': len(added), 'removed': len(removed)}}


def scan_corrections(folder: str, now: float | None = None) -> int:
    """盯着最近 45 天的表：人存过盘、跟刚认完时不一样了，就把改动记成一份「改过的格子」等着发。返回新记了几份。"""
    now = time.time() if now is None else now
    h = os.path.join(folder, engine.OUT_DIR, HOME)
    if not os.path.isdir(h):
        return 0
    made = 0
    for run in sorted(os.listdir(h)):
        d = os.path.join(h, run)
        rep, orig, state_p = (os.path.join(d, n) for n in (REPORT, PRISTINE, STATE))
        if not (os.path.isfile(rep) and os.path.isfile(orig)):
            continue
        try:
            if now - os.path.getmtime(orig) > WATCH_DAYS * 86400:
                continue
            xlsx = os.path.join(folder, engine.OUT_DIR, _load(rep).get('xlsx', ''))
            if not os.path.isfile(xlsx):
                continue
            mtime = os.path.getmtime(xlsx)
            state = _load(state_p) if os.path.isfile(state_p) else {}
            if mtime == state.get('mtime') or now - mtime < SETTLE:
                continue
            after = table_rows(xlsx)
            if not after:                           # 读不出来（存到一半、被改坏了）：下次再说，别当成全删了
                continue
            got = diff(table_rows(orig), after)
            sig = hashlib.sha1(json.dumps(got, ensure_ascii=False, sort_keys=True, default=str).encode()).hexdigest()
            if (got['changes'] or got['added'] or got['removed']) and sig != state.get('sig'):
                stamp = datetime.fromtimestamp(mtime).strftime('%Y%m%d_%H%M%S')
                got.update(run=run, xlsx=os.path.basename(xlsx), saved_at=datetime.fromtimestamp(mtime).isoformat(timespec='seconds'))
                _dump(os.path.join(d, f'{FIX_PREFIX}{stamp}.json'), got)
                made += 1
                state['sig'] = sig
            state['mtime'] = mtime
            _dump(state_p, state)
        except Exception:
            continue                                # 一批坏了不耽误别的批
    return made


# ---------------------------------------------------------------- 发
def _sent(d: str) -> set[str]:
    try:
        with open(os.path.join(d, SENT), encoding='utf-8') as f:
            return {ln.strip() for ln in f if ln.strip()}
    except OSError:
        return set()


def _mark(d: str, name: str):
    with open(os.path.join(d, SENT), 'a', encoding='utf-8') as f:
        f.write(name + '\n')


def pending(folder: str) -> list[tuple[str, str, str]]:
    """还没发的：[(批次, 文件名, 路径)]。每批先发记录，再发照片，再发改过的格子；样板资料排最后。"""
    h = os.path.join(folder, engine.OUT_DIR, HOME)
    if not os.path.isdir(h):
        return []
    out = []
    for run in sorted(os.listdir(h)):
        d = os.path.join(h, run)
        if not os.path.isdir(d):
            continue
        sent = _sent(d)
        files = sorted(os.listdir(d))
        if run == SAMPLES:
            names = [(f, os.path.join(d, f)) for f in files if f.endswith('.json')]
        else:
            names = [(REPORT, os.path.join(d, REPORT))] if REPORT in files else []
            pics = os.path.join(d, PICS)
            if os.path.isdir(pics):
                names += [(f, os.path.join(pics, f)) for f in sorted(os.listdir(pics)) if f.lower().endswith('.jpg')]
            names += [(f, os.path.join(d, f)) for f in files if f.startswith(FIX_PREFIX) and f.endswith('.json')]
        out += [(run, n, p) for n, p in names if n not in sent]
    return out


def post(obj: dict, url: str | None = None, timeout: float = TIMEOUT) -> dict:
    """POST 一份给接口。谷歌那边先回 302 再给结果，urllib 会自己跟过去（改用 GET 取结果，正合适）。"""
    data = json.dumps(obj, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(url or URL, data=data, method='POST',
                                 headers={'Content-Type': 'text/plain; charset=utf-8',
                                          'User-Agent': f'luruseng/{engine.VERSION}'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read().decode('utf-8', 'replace')
    try:
        return json.loads(raw)
    except ValueError:
        raise IOError('接口回的不是 JSON：' + raw[:120]) from None


@dataclass
class Sent:
    sent: int = 0
    left: int = 0
    error: str = ''


def send(folder: str, who: str, limit_s: float = 120, poster=None, clock=time.time) -> Sent:
    """把还没发的一份一份发出去，最多忙 limit_s 秒。发完的照片从本机删掉（那是专门为发才存的副本）。
    出错就停：网络不通、接口不收，交给调用的人过一阵再来。"""
    poster = poster or post
    t0 = clock()
    todo = pending(folder)
    out = Sent(left=len(todo))
    for run, name, path in todo:
        if clock() - t0 > limit_s:
            break
        d = os.path.join(folder, engine.OUT_DIR, HOME, run)
        try:
            if os.path.getsize(path) > MAX_FILE:
                _mark(d, name)                      # 太大，接口不收：跳过，别天天重试
                out.left -= 1
                continue
            if name.lower().endswith('.jpg'):
                with open(path, 'rb') as f:
                    body = {'kind': 'photo', 'data': base64.b64encode(f.read()).decode()}
            else:
                body = {'kind': 'json', 'payload': _load(path)}
        except (OSError, ValueError):
            _mark(d, name)                          # 坏文件：跳过
            out.left -= 1
            continue
        body.update(token=TOKEN, machine=who, run=run, name=name)
        try:
            r = poster(body)
        except Exception as e:
            out.error = f'网络：{getattr(e, "reason", e)}'
            return out
        err = '' if r.get('ok') else str(r.get('error') or '接口没说为什么')
        if err and err != 'size':
            out.error = err
            return out
        _mark(d, name)
        out.left -= 1
        if not err:
            out.sent += 1
        if name.lower().endswith('.jpg'):
            try:
                os.remove(path)
            except OSError:
                pass
    return out
