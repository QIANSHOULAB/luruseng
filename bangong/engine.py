"""搬工 — 文件夹里的图片 5 张一批送 Gemini，全部内容转成表格，边干边写 Excel。"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import re
import shutil
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from PIL import Image, ImageOps

try:
    import pillow_heif  # iPhone 的 HEIC
    pillow_heif.register_heif_opener()
except Exception:  # pragma: no cover
    pass

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side

VERSION = '1.0.0'
API_BASE = os.environ.get('BANGONG_API', 'https://generativelanguage.googleapis.com/v1beta').rstrip('/')
DEFAULT_MODEL = 'gemini-3.5-flash-lite'
MODELS = ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-pro']
IMG_EXT = {'.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.bmp', '.tif', '.tiff'}
BATCH = 5
MAX_SIDE = 2048
JPEG_Q = 92
DONE_DIR = '已识别'
OUT_DIR = '识别结果'
LEDGER = '.搬工账本.json'
MINUTE_WAIT = 60
TIMEOUT = 180
RETRY_WAITS = [10, 30, 60]          # 5xx / 断网重试间隔
MAX_MINUTE_WAITS = 30               # 同一张连续撞每分钟上限的次数上限

PROMPT = """你是表格转写引擎。把图片里的全部文字（印刷体和手写都要）按原件版面转写成表格行。
规则：
- 原件里有表格：表格的每一行输出为一行，每个格子是一个单元格，从左到右；合并格只写一次，被合并掉的位置填空字符串，保证列对齐。
- 表格以外的文字（标题、说明、页眉页脚、备注）：每一行文字单独输出为一行，只占一个单元格。
- 从上到下、从左到右按阅读顺序输出。
- 原样照抄，不翻译、不纠错、不补全、不总结；中英双语都保留。
- 手写内容照抄；实在看不清的字用 □ 代替；打勾写 √，打叉写 ×；空格子写空字符串。
- 被划掉（删除线、涂黑、圈掉作废）的内容不要。
- 图片歪斜或横着拍的，按正确方向阅读。
- 只输出 JSON：{"rows": [["格1", "格2"], ["下一行"]]}，不要任何解释。"""

SCHEMA = {
    'type': 'OBJECT',
    'properties': {'rows': {'type': 'ARRAY', 'items': {'type': 'ARRAY', 'items': {'type': 'STRING'}}}},
    'required': ['rows'],
}


# ---------------------------------------------------------------- 错误
class ApiError(Exception):
    def __init__(self, status: int, message: str, detail: str = ''):
        super().__init__(message)
        self.status, self.message, self.detail = status, message, detail

    def raw(self) -> str:
        return f'HTTP {self.status}：{self.message}' if self.status else self.message


class Fatal(Exception):
    """整轮停工（钥匙无效、模型不存在、预付余额用完、全部钥匙都不能用）。"""


class Stopped(Exception):
    pass


# ---------------------------------------------------------------- 时间
def _nth_sunday(year: int, month: int, n: int) -> datetime:
    d = datetime(year, month, 1)
    d += timedelta(days=(6 - d.weekday()) % 7)
    return d + timedelta(weeks=n - 1)


def pacific_offset(utc: datetime) -> timedelta:
    """美国太平洋时间偏移（夏令时 3 月第二个周日 2:00 至 11 月第一个周日 2:00）。不依赖 tzdata。"""
    y = utc.year
    start = _nth_sunday(y, 3, 2).replace(hour=10)   # 2:00 PST = 10:00 UTC
    end = _nth_sunday(y, 11, 1).replace(hour=9)     # 2:00 PDT = 09:00 UTC
    naive = utc.replace(tzinfo=None)
    return timedelta(hours=-7) if start <= naive < end else timedelta(hours=-8)


def next_pacific_midnight(now: float) -> float:
    utc = datetime.fromtimestamp(now, timezone.utc)
    off = pacific_offset(utc)
    local = (utc + off).replace(tzinfo=None)
    midnight = datetime(local.year, local.month, local.day) + timedelta(days=1)
    # 午夜那一刻的偏移（跨夏令时切换日也对）
    guess = midnight - off
    off2 = pacific_offset(guess.replace(tzinfo=timezone.utc))
    return (midnight - off2).replace(tzinfo=timezone.utc).timestamp() + 30   # 多等 30 秒，免得卡在边上


# ---------------------------------------------------------------- 钥匙
class Keys:
    def __init__(self, keys: list[str], clock):
        self.keys = [k.strip() for k in keys if k and k.strip()]
        self.dead_until = [0.0] * len(self.keys)
        self.used = [0] * len(self.keys)
        self.lock = threading.Lock()
        self.clock = clock

    def pick(self):
        """返回 (序号, 钥匙)；都在冷却就返回 (None, 最早恢复时间)。"""
        with self.lock:
            now = self.clock()
            for i, k in enumerate(self.keys):
                if self.dead_until[i] <= now:
                    return i, k
            return None, min(self.dead_until)

    def park(self, i: int, until: float):
        with self.lock:
            self.dead_until[i] = max(self.dead_until[i], until)


# ---------------------------------------------------------------- 图片
def file_hash(path: str) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def prepare_image(path: str) -> bytes:
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im)
        if im.mode in ('RGBA', 'LA', 'P'):
            im = im.convert('RGBA')
            bg = Image.new('RGB', im.size, 'white')
            bg.paste(im, mask=im.split()[-1])
            im = bg
        elif im.mode != 'RGB':
            im = im.convert('RGB')
        w, h = im.size
        if max(w, h) > MAX_SIDE:
            s = MAX_SIDE / max(w, h)
            im = im.resize((max(1, round(w * s)), max(1, round(h * s))), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, 'JPEG', quality=JPEG_Q, optimize=True)
        return buf.getvalue()


# ---------------------------------------------------------------- API
def model_name(m: str) -> str:
    return re.sub(r'^models/', '', (m or '').strip()) or DEFAULT_MODEL


def build_body(jpeg: bytes, model: str) -> dict:
    gen = {'temperature': 0.1, 'responseMimeType': 'application/json', 'responseSchema': SCHEMA}
    if re.match(r'^gemini-2\.5-flash(?!-lite)', model):
        gen['thinkingConfig'] = {'thinkingBudget': 0}
    return {
        'systemInstruction': {'parts': [{'text': PROMPT}]},
        'contents': [{'role': 'user', 'parts': [
            {'text': '把这张图片的全部内容转写成表格行。'},
            {'inline_data': {'mime_type': 'image/jpeg', 'data': base64.b64encode(jpeg).decode()}},
        ]}],
        'generationConfig': gen,
    }


def call_api(model: str, key: str, body: dict) -> dict:
    """Key 只走 URL 参数 ?key=。报错原样带回 HTTP 状态码和谷歌的 error.message。"""
    url = f'{API_BASE}/models/{urllib.parse.quote(model)}:generateContent?key={urllib.parse.quote(key)}'
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'}, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            raw = r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        raw = e.read().decode('utf-8', 'replace')
        msg, detail = raw[:500] or (e.reason or ''), ''
        try:
            err = json.loads(raw).get('error', {})
            msg = err.get('message') or msg
            detail = json.dumps(err.get('details', ''), ensure_ascii=False)
        except Exception:
            pass
        raise ApiError(e.code, msg, detail) from None
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise ApiError(0, f'网络错误：{getattr(e, "reason", e)}') from None
    try:
        return json.loads(raw)
    except Exception:
        raise ApiError(0, '返回的不是 JSON：' + raw[:300]) from None


def parse_rows(data: dict) -> list[list[str]]:
    cands = data.get('candidates') or []
    if not cands:
        br = (data.get('promptFeedback') or {}).get('blockReason')
        raise ValueError(f'promptFeedback.blockReason = {br}' if br else '返回里没有 candidates')
    c = cands[0]
    text = ''.join(p.get('text', '') for p in (c.get('content') or {}).get('parts', []) if not p.get('thought'))
    finish = c.get('finishReason', '')
    t = text.strip()
    t = re.sub(r'^```(?:json)?\s*|\s*```$', '', t)
    try:
        obj = json.loads(t)
    except Exception:
        raise ValueError(f'finishReason = {finish}，JSON 解析不了：{text[:200]}')
    rows = obj.get('rows') if isinstance(obj, dict) else obj
    if not isinstance(rows, list):
        raise ValueError('JSON 里没有 rows：' + text[:200])
    out = []
    for r in rows:
        if isinstance(r, list):
            out.append(['' if v is None else str(v) for v in r])
        elif isinstance(r, dict):
            out.append([str(v) for v in r.values()])
        else:
            out.append([str(r)])
    while out and not any(c.strip() for c in out[-1]):
        out.pop()
    return out


def classify_429(e: ApiError) -> str:
    s = f'{e.message} {e.detail}'
    if re.search(r'prepay', s, re.I):
        return 'prepay'
    if re.search(r'PerDay|per day|daily', s, re.I):
        return 'day'
    return 'minute'


# ---------------------------------------------------------------- Excel
THIN = Side(style='thin', color='BBBBBB')
BOX = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
TITLE_FILL = PatternFill('solid', fgColor='DDEBF7')
WRAP = Alignment(wrap_text=True, vertical='top')


class Book:
    """边干边写：每批干完就存一次盘。"""

    def __init__(self, path: str):
        self.path = path
        self.wb = Workbook()
        self.main = self.wb.active
        self.main.title = '识别结果'
        self.listing = self.wb.create_sheet('清单')
        self.listing.append(['序号', '文件名', '状态', '行数', '说明', '时间'])
        for c in self.listing[1]:
            c.font = Font(bold=True)
        for col, w in zip('ABCDEF', [6, 34, 8, 6, 60, 20]):
            self.listing.column_dimensions[col].width = w
        self.maxcols = 1
        self.n = 0

    def add(self, name: str, rows: list[list[str]] | None, error: str = ''):
        self.n += 1
        ws = self.main
        r0 = ws.max_row + (2 if ws.max_row > 1 else 0)
        title = ws.cell(row=r0, column=1, value=f'第 {self.n} 张　{name}' + ('　✗ 识别失败' if rows is None else ''))
        title.font = Font(bold=True, size=12, color='9C0006' if rows is None else '1F3864')
        width = max([len(r) for r in rows] + [1]) if rows else 1
        for c in range(1, width + 1):
            ws.cell(row=r0, column=c).fill = TITLE_FILL
        if rows is None:
            ws.cell(row=r0 + 1, column=1, value=error).alignment = WRAP
        else:
            for i, row in enumerate(rows, start=1):
                for j, v in enumerate(row, start=1):
                    cell = ws.cell(row=r0 + i, column=j, value=v)
                    cell.alignment = WRAP
                    cell.border = BOX
        self.maxcols = max(self.maxcols, width)
        for j in range(1, self.maxcols + 1):
            letter = ws.cell(row=1, column=j).column_letter
            ws.column_dimensions[letter].width = 34 if j == 1 else 18
        self.listing.append([self.n, name, '成功' if rows is not None else '失败',
                             len(rows) if rows is not None else 0, error, datetime.now().strftime('%Y-%m-%d %H:%M:%S')])
        for c in self.listing[self.listing.max_row]:
            c.alignment = WRAP

    def save(self):
        tmp = self.path + '.tmp'
        self.wb.save(tmp)
        for _ in range(5):
            try:
                os.replace(tmp, self.path)
                return
            except PermissionError:      # Excel 正开着这个文件
                time.sleep(2)
        alt = self.path.replace('.xlsx', f'_{datetime.now():%H%M%S}.xlsx')
        os.replace(tmp, alt)
        self.path = alt


# ---------------------------------------------------------------- 主流程
@dataclass
class Result:
    ok: int = 0
    failed: int = 0
    skipped: int = 0
    requests: int = 0
    xlsx: str = ''
    stopped_reason: str = ''
    errors: list = field(default_factory=list)


def scan(folder: str) -> list[str]:
    out = []
    for name in os.listdir(folder):
        p = os.path.join(folder, name)
        if os.path.isfile(p) and os.path.splitext(name)[1].lower() in IMG_EXT and os.path.getsize(p) > 0:
            out.append(p)
    out.sort(key=lambda p: (os.path.getmtime(p), os.path.basename(p).lower()))
    return out


def unique_dest(d: str, name: str) -> str:
    base, ext = os.path.splitext(name)
    p, k = os.path.join(d, name), 1
    while os.path.exists(p):
        p = os.path.join(d, f'{base}_{k}{ext}')
        k += 1
    return p


class Engine:
    def __init__(self, folder: str, keys: list[str], model: str = DEFAULT_MODEL,
                 log=print, progress=None, stop: threading.Event | None = None,
                 clock=time.time, sleep=None):
        self.folder = folder
        self.model = model_name(model)
        self.log = log
        self.progress = progress or (lambda done, total: None)
        self.stop = stop or threading.Event()
        self.clock = clock
        self._sleep = sleep
        self.keys = Keys(keys, clock)
        self.lock = threading.Lock()
        self.res = Result()
        self.fatal: str = ''

    # 可被「停止」打断的等待
    def wait(self, seconds: float):
        if self._sleep:
            self._sleep(seconds)
            if self.stop.is_set():
                raise Stopped()
            return
        end = time.time() + seconds
        while time.time() < end:
            if self.stop.wait(min(1.0, end - time.time())):
                raise Stopped()

    def wait_until(self, ts: float, why: str):
        secs = max(0.0, ts - self.clock())
        if secs > 90:
            back = datetime.fromtimestamp(ts).strftime('%m-%d %H:%M')
            self.log(f'⏸ {why}，等到 {back} 额度刷新后接着干（约 {secs / 3600:.1f} 小时）')
        elif secs > 0:
            self.log(f'⏸ {why}，等 {int(secs)} 秒')
        self.wait(secs)

    def recognize(self, path: str) -> list[list[str]]:
        try:
            return self._recognize(path)
        except Fatal as e:
            if not self.fatal:
                self.fatal = str(e)
            self.stop.set()          # 同批其他几张别再傻等
            raise

    def _recognize(self, path: str) -> list[list[str]]:
        body = build_body(prepare_image(path), self.model)
        minute_hits = 0
        net_tries = 0
        while True:
            if self.stop.is_set():
                raise Stopped()
            if self.fatal:
                raise Fatal(self.fatal)
            i, key = self.keys.pick()
            if i is None:
                self.wait_until(key, '所有钥匙额度都用完了' if key - self.clock() > 120 else '每分钟次数到顶')
                continue
            try:
                with self.lock:
                    self.res.requests += 1
                data = call_api(self.model, key, body)
                self.keys.used[i] += 1
                return parse_rows(data)
            except ApiError as e:
                if e.status == 429:
                    kind = classify_429(e)
                    if kind == 'prepay':
                        raise Fatal(f'钥匙{i + 1} · {e.raw()}（账单账户预付余额用完，等也没用）')
                    if kind == 'day':
                        until = next_pacific_midnight(self.clock())
                        self.keys.park(i, until)
                        self.log(f'钥匙{i + 1} 今天的额度用完了 · {e.raw()}')
                    else:
                        minute_hits += 1
                        if minute_hits > MAX_MINUTE_WAITS:
                            raise
                        self.keys.park(i, self.clock() + MINUTE_WAIT)
                    continue
                if e.status in (400, 401, 403) and re.search(r'API key|API_KEY|permission|PERMISSION', f'{e.message} {e.detail}'):
                    raise Fatal(f'钥匙{i + 1} · {e.raw()}')
                if e.status == 404:
                    raise Fatal(f'{self.model} · {e.raw()}')
                if e.status == 0 or e.status >= 500:
                    if net_tries < len(RETRY_WAITS):
                        w = RETRY_WAITS[net_tries]
                        net_tries += 1
                        self.log(f'{os.path.basename(path)} · {e.raw()} · {w} 秒后重试')
                        self.wait(w)
                        continue
                raise

    def run(self) -> Result:
        res = self.res
        if not self.keys.keys:
            res.stopped_reason = '没填钥匙'
            self.log('✗ 没填钥匙')
            return res
        os.makedirs(self.folder, exist_ok=True)
        out_dir = os.path.join(self.folder, OUT_DIR)
        done_dir = os.path.join(self.folder, DONE_DIR)
        os.makedirs(out_dir, exist_ok=True)
        os.makedirs(done_dir, exist_ok=True)
        logfile = os.path.join(out_dir, '搬工日志.txt')
        outer = self.log

        def log(msg):
            outer(msg)
            try:
                with open(logfile, 'a', encoding='utf-8') as fh:
                    fh.write(f'{datetime.now():%Y-%m-%d %H:%M:%S}  {msg}\n')
            except OSError:
                pass
        self.log = log
        ledger_path = os.path.join(out_dir, LEDGER)
        try:
            ledger = json.load(open(ledger_path, encoding='utf-8'))
        except Exception:
            ledger = {}

        files = scan(self.folder)
        todo = []
        for p in files:
            h = file_hash(p)
            if h in ledger:          # 干过的（改了名也认得出）
                os.replace(p, unique_dest(done_dir, os.path.basename(p)))
                res.skipped += 1
                self.log(f'↷ {os.path.basename(p)} 以前干过，跳过')
            else:
                todo.append((p, h))
        total = len(todo)
        if not total:
            self.log('文件夹里没有新图片，收工。')
            return res
        self.log(f'▶ 开工：{total} 张，每批 {BATCH} 张，模型 {self.model}')
        res.xlsx = os.path.join(out_dir, f'识别结果_{datetime.now():%Y%m%d_%H%M%S}.xlsx')
        book = Book(res.xlsx)
        done = 0
        self.progress(0, total)

        def one(item):
            p, h = item
            try:
                return p, h, self.recognize(p), ''
            except (Stopped, Fatal):
                raise
            except ApiError as e:
                return p, h, None, e.raw()
            except Exception as e:
                return p, h, None, f'{type(e).__name__}：{e}'

        try:
            with ThreadPoolExecutor(BATCH) as pool:
                for b in range(0, total, BATCH):
                    batch = todo[b:b + BATCH]
                    futures = [pool.submit(one, it) for it in batch]
                    outcomes, halt = [], None
                    for f in futures:
                        try:
                            outcomes.append(f.result())
                        except (Stopped, Fatal) as e:
                            halt = halt or e
                    for p, h, rows, err in outcomes:     # 原顺序写入
                        name = os.path.basename(p)
                        book.add(name, rows, err)
                        if rows is not None:
                            res.ok += 1
                            ledger[h] = {'file': name, 'xlsx': os.path.basename(book.path), 'at': datetime.now().isoformat(timespec='seconds')}
                            os.replace(p, unique_dest(done_dir, name))
                            self.log(f'✓ {name} · {len(rows)} 行')
                        else:
                            res.failed += 1
                            res.errors.append((name, err))
                            self.log(f'✗ {name} · {err}')
                        done += 1
                    book.save()
                    with open(ledger_path, 'w', encoding='utf-8') as fh:
                        json.dump(ledger, fh, ensure_ascii=False, indent=1)
                    self.progress(done, total)
                    if halt:
                        raise halt
        except Fatal as e:
            res.stopped_reason = str(e)
            self.log(f'■ 停工：{e}')
        except Stopped:
            if self.fatal:
                res.stopped_reason = self.fatal
                self.log(f'■ 停工：{self.fatal}')
            else:
                res.stopped_reason = '手动停止'
                self.log('■ 已停止，没干完的下次接着干')
        if book.n == 0:
            try:
                os.remove(res.xlsx)
            except OSError:
                pass
            res.xlsx = ''
        used = ' · '.join(f'钥匙{i + 1}×{n}' for i, n in enumerate(self.keys.used) if n)
        self.log(f'{"✓" if not res.failed and not res.stopped_reason else "⚠"} 成功 {res.ok} 张 · 失败 {res.failed} 张 · '
                 f'{res.requests} 次请求{" · " + used if used else ""}' + (f'\n结果：{res.xlsx}' if res.xlsx else ''))
        return res
