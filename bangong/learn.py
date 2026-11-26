"""184 录入僧越用越准（Song 11-26：「自动把人修改过的数据传回到我们的数据里面去做修改……默认打开。」
「只要他填了我的暗号，他那个数据就是自动传回来给我做产品测试的。」）。跟网页版 web/learn.js 一套。

- 只有对上暗号（089 配了大管家）的才记、才发；⚙ 里一个开关，默认开，关了一格都不记、不发（攒着的也清掉）。没配对的连开关都不露。
- 记什么：核对里人动过的每一格：改了值（edit）、点了「对的」（ok）、点了猜的值（guess）；电脑版还有一样：表在 Excel 里
  改了、存了盘，跟当初写进去的那份一比，改过的格子也算（edit）。每格带：类别、栏、认的（写进表的）、人定的、原来什么颜色、
  两遍各认成什么、谁认的（claude / butler / gemini）和模型、第几批第几张、这台叫什么、几点。
  人动过至少一格的那张，带上当时送去认的那张缩过的照片、提示词、schema，和人定完的整张答案（照认出来的 JSON 的样子）。
- 什么时候发：关了核对（这批核完）或者 10 分钟没动 → 打成一包排队；大管家不在、出错就留在这台（%APPDATA%\\录入僧\\learn\\queue），
  开程序、每 10 分钟、干完下一批再交；收到回执才删。一包 JSON 不超过 3 MB；最多攒 50 包 / 150 MB，满了扔最老的。
- 读回来：开程序、配上对时找中转站要大管家学会的「常错提醒」，存一份；认照片时三条路的提示词后面都另加一段这个类别的提醒。
  拿不到就照旧认。「不用标红」（nored）：同类别同一栏、两遍都认成那个值的，不标红。

本机落地（%APPDATA%\\录入僧\\learn）：
  list.json                  大管家学会的那份
  runs\\<批次>\\meta.json      这批：类别、表在哪、每张谁认的、两遍各认成什么、人动过的格子、哪些打过包
  runs\\<批次>\\原样.xlsx      刚认完时写进去的那本（跟人存过盘的一比，就知道 Excel 里改了哪格）
  runs\\<批次>\\img\\07.json    送去认的那张缩过的照片、提示词、schema（人没动过这张就不发，放 14 天删）
  queue\\<时间>.json          排着队等交的包
"""
from __future__ import annotations

import base64
import json
import os
import re
import secrets
import shutil
import threading
import time
from datetime import datetime, timezone

IDLE = 600            # 核对多久没动就打包（秒）
RESEND = 600          # 多久再交一次排着的
SETTLE = 60           # 表存盘以后等一分钟再比（别撞上 Excel 存到一半）
MAX_PKG = 3_000_000   # 一包 JSON 最大多少字节
MAX_QUEUE = 50
MAX_BYTES = 150_000_000
KEEP_DAYS = 14
HEAD = '常错提醒（大管家从人改过的格子里学的，是看字的提醒，不是规矩）：'
BUILTIN = '刀单'
META = ('unsure', 'disputed', 'counts', 'single')
PRISTINE = '原样.xlsx'
WHO = {'claude': 'claude', 'dagj': 'butler', 'gemini': 'gemini'}


def who(by: str) -> str:
    return WHO.get(by or '', '')


def iso(t: float) -> str:
    return datetime.fromtimestamp(t, timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def nbytes(obj) -> int:
    return len(json.dumps(obj, ensure_ascii=False).encode('utf-8'))


def rid() -> str:
    return base64.urlsafe_b64encode(secrets.token_bytes(18)).decode().rstrip('=')


def _norm(v) -> str:
    return re.sub(r'\s+', ' ', str(v if v is not None else '')).strip().upper()


def _dump(path: str, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f'{path}.{threading.get_ident()}.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, default=str)
    os.replace(tmp, path)


def _load(path: str, default=None):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


# ---------------------------------------------------------------- 读回来的那份
def hint_lines(learn: dict | None, cat: str) -> list[str]:
    lists = learn.get('lists') if isinstance(learn, dict) else None
    if not isinstance(lists, dict):
        return []
    out = []
    for k in (cat, '*'):
        for x in lists.get(k) or []:
            t = str(x if x is not None else '').strip()
            if t and t not in out:
                out.append(t)
    return out


def hint_block(learn: dict | None, cat: str) -> str:
    lines = hint_lines(learn, cat)
    return HEAD + '\n' + '\n'.join('- ' + x for x in lines) if lines else ''


def with_hints(body: dict, block: str) -> dict:
    """本来要发的请求（Gemini 的样子）-> 提示词后面另加一段的新请求（原来那个不动）。跟大管家考试一样另起一段。"""
    if not block or not isinstance(body, dict) or 'systemInstruction' not in body:
        return body
    si = dict(body['systemInstruction'])
    si['parts'] = list(si.get('parts') or []) + [{'text': block}]
    return {**body, 'systemInstruction': si}


def _col_match(rule_col, cat: str, f: str) -> bool:
    c = str(rule_col or '').strip()
    if not c:
        return False
    if cat == BUILTIN:
        from .viewer import LABELS
        from .engine import FIELDS
        label = LABELS[FIELDS.index(f)] if f in FIELDS else ''
        return c.lower() == f or c.upper() == label.upper()
    from .tables import colkey
    return colkey(c) == colkey(f)


def no_red(learn: dict | None, cat: str, f: str, reads) -> bool:
    """「不用标红」：同类别、同一栏，两遍都认成规则里那个值"""
    rules = learn.get('nored') if isinstance(learn, dict) else None
    if not rules or not isinstance(reads, (list, tuple)) or len(reads) < 2:
        return False
    for r in rules:
        if not isinstance(r, dict) or r.get('cat') not in (cat, '*') or not _col_match(r.get('col'), cat, f):
            continue
        want = _norm(r.get('value'))
        if want and _norm(reads[0]) == want and _norm(reads[1]) == want:
            return True
    return False


def _owner(piece: str, names: list[str]) -> str | None:
    best = None
    for nm in names:
        if piece.startswith(nm + ' ') and (best is None or len(nm) > len(best)):
            best = nm
    return best


def unred_book(book, n: int, cat: str, reads: list[dict], learn: dict | None) -> list[str]:
    """刚 add 进表的最后 n 条：合上「不用标红」的格子拿掉红、拿掉它的核对提示。刀单（RecordBook）、自建类别（TableBook）都认。"""
    if not learn or not learn.get('nored') or not n:
        return []
    off_all = []
    if hasattr(book, 'meta'):                       # 刀单
        from .engine import FIELDS
        names = [f.upper() for f in FIELDS]
        for m, rd in zip(book.meta[-n:], reads[-n:] if reads else []):
            off = [f for f in list(m['red']) if no_red(learn, cat, f, (rd or {}).get(f))]
            if not off:
                continue
            mine = {f.upper() for f in off}
            m['red'] = set(m['red']) - set(off)
            m['notes'] = [x for x in m['notes'] if _owner(x, names) not in mine]
            for f in off:
                (m.get('ctx') or {}).pop(f, None)
                (m.get('alts') or {}).pop(f, None)
            book._paint(m)
            off_all += off
    elif hasattr(book, 'rows'):                     # 自建类别
        rows = book.rows[-n:]
        for j, (row, rd) in enumerate(zip(rows, reads[-n:] if reads else [])):
            no, values, red, orange, note, whole = row
            off = [c for c in list(red) if no_red(learn, cat, c, (rd or {}).get(c))]
            if not off:
                continue
            red = set(red) - set(off)
            note = '；'.join(x for x in note.split('；') if x and _owner(x, list(values)) not in set(off))
            book.rows[len(book.rows) - n + j] = (no, values, red, orange, note, whole)
            off_all += off
    return off_all


def reads_of(out: list[dict], reads: list[list[dict]]) -> list[dict]:
    """每条记录每一格头两遍各认成什么"""
    cand = [r for r in reads if len(r) == len(out)][:2]
    return [{f: [str(r[i].get(f, '') or '') for r in cand] for f in rec if f not in META} for i, rec in enumerate(out)]


# ---------------------------------------------------------------- 打包
def answer_of(rows: list[dict], cat: str, page: dict) -> dict:
    """人定完的整张答案，照认出来的 JSON 的样子。rows：viewer.load_rows 那一张的几条（raw 是格子里的字）"""
    from .engine import FIELDS
    recs = [r for r in rows or [] if any(r.get('raw') or r.get('values') or [])]
    side = page.get('side') or ''
    if cat == BUILTIN:
        return {'title_side': side, 'records': [{**{f: r['raw'][i] for i, f in enumerate(FIELDS)}, 'unsure': []} for r in recs]}
    cols = page.get('cols') or (recs[0]['labels'] if recs else [])
    val = (lambda r, c: r['raw'][r['labels'].index(c)] if c in r['labels'] else '')
    if page.get('open'):
        cols = recs[0]['labels'] if recs else cols
        return {'title_side': side, 'columns': list(cols), 'records': [{'values': [val(r, c) for c in cols], 'unsure': []} for r in recs]}
    return {'title_side': side, 'records': [{**{f'c{i + 1}': val(r, c) for i, c in enumerate(cols)}, 'unsure': []} for r in recs]}


def packages(device: str, app: str, batches: list, items: list, photos: list, limit: int = MAX_PKG) -> list[dict]:
    def fresh():
        return {'v': 1, 'kind': 'learn', 'id': rid(), 'device': device, 'app': app, 'batches': batches, 'items': [], 'photos': []}
    out, cur = [], fresh()
    n = nbytes(cur)
    for key, things in (('items', items), ('photos', photos)):
        for x in things:
            b = nbytes(x) + 1
            if n + b > limit and (cur['items'] or cur['photos']):
                out.append(cur)
                cur = fresh()
                n = nbytes(cur)
            cur[key].append(x)
            n += b
    if cur['items'] or cur['photos'] or not out:
        out.append(cur)
    return out


def halve(pkg: dict):
    ph, it = pkg.get('photos') or [], pkg.get('items') or []

    def two(a, b):
        return [{**pkg, 'id': rid(), **a}, {**pkg, 'id': rid(), **b}]
    if len(ph) > 1:
        h = (len(ph) + 1) // 2
        return two({'photos': ph[:h]}, {'items': [], 'photos': ph[h:]})
    if len(it) > 1:
        h = (len(it) + 1) // 2
        return two({'items': it[:h]}, {'items': it[h:]})
    if len(ph) == 1 and it:
        return two({'photos': []}, {'items': []})
    return None


# ---------------------------------------------------------------- 记、排队、交
class Learner:
    def __init__(self, home: str, butler, app: str = 'desktop', on=lambda: True, clock=time.time, device=None):
        self.home, self.butler, self.app, self.on, self.clock = home, butler, app, on, clock
        if device is None:
            from .dagj import label
            device = label
        self.device = device
        self.lock = threading.RLock()
        self.send_lock = threading.Lock()
        self.list = _load(os.path.join(home, 'list.json'))
        self.last_send = 0.0
        self.seq = 0

    # ---------- 读回来的那份
    @property
    def paired(self) -> bool:
        return bool(self.butler is not None and self.butler.paired)

    def active(self) -> bool:
        return self.paired and bool(self.on())

    def known(self):
        return self.list if self.paired else None

    def block(self, cat: str) -> str:
        return hint_block(self.list, cat) if self.paired else ''

    def ver(self) -> int:
        try:
            return int((self.list or {}).get('ver') or 0)
        except (TypeError, ValueError):
            return 0

    def refresh(self) -> bool:
        if not self.paired:
            return False
        try:
            got = self.butler.learn_list()
        except Exception:
            got = None
        if not got:
            return False
        self.list = got.get('learn')
        try:
            _dump(os.path.join(self.home, 'list.json'), self.list)
        except OSError:
            pass
        return True

    # ---------- 一批
    def _run_dir(self, run: str) -> str:
        return os.path.join(self.home, 'runs', run)

    def _meta(self, run: str) -> dict:
        return _load(os.path.join(self._run_dir(run), 'meta.json'), None) or {
            'batch': run, 'pages': {}, 'items': {}, 'sent': {}, 'last': 0}

    def _save_meta(self, run: str, meta: dict):
        _dump(os.path.join(self._run_dir(run), 'meta.json'), meta)

    def page(self, run: str, no: int, info: dict):
        """认完一张：谁认的、两遍各认成什么；送去认的那张缩过的照片、提示词另存（开关关着什么都不存）"""
        if not self.active():
            return
        with self.lock:
            meta = self._meta(run)
            meta['pages'][str(no)] = {k: info.get(k) for k in ('by', 'model', 'side', 'reads')}
            self._save_meta(run, meta)
            if info.get('data'):
                img = {k: info.get(k) for k in ('prompt', 'ask', 'schema', 'open', 'cols', 'side')}
                img['data'] = base64.b64encode(info['data']).decode()
                _dump(os.path.join(self._run_dir(run), 'img', f'{no:03d}.json'), img)

    def end_run(self, run: str, xlsx: str, cat: str, list_ver: int):
        """一批干完：抄一份刚写进去的表当「原样」，记下表在哪、这批一共写了几格"""
        if not self.active() or not xlsx or not os.path.isfile(xlsx):
            return
        from .viewer import load_rows
        with self.lock:
            meta = self._meta(run)
            d = self._run_dir(run)
            os.makedirs(d, exist_ok=True)
            shutil.copy2(xlsx, os.path.join(d, PRISTINE))
            rows = [r for rs in load_rows(xlsx).values() for r in rs if any(r['raw'])]
            meta.update(xlsx=os.path.abspath(xlsx), cat=cat, list_ver=int(list_ver or 0), at=iso(self.clock()),
                        cells=sum(len(r['labels']) for r in rows), mtime=os.path.getmtime(xlsx))
            self._save_meta(run, meta)

    def _runs(self):
        root = os.path.join(self.home, 'runs')
        return sorted(os.listdir(root)) if os.path.isdir(root) else []

    def _run_of(self, xlsx: str) -> str | None:
        want = os.path.normcase(os.path.abspath(xlsx or ''))
        for run in self._runs():
            m = _load(os.path.join(self._run_dir(run), 'meta.json'), {}) or {}
            if m.get('xlsx') and os.path.normcase(m['xlsx']) == want:
                return run
        return None

    def _item(self, meta, run, no, k, col, before, after, act, color, at):
        page = meta['pages'].get(str(no)) or {}
        rd = (page.get('reads') or [])
        reads = (rd[k] if k < len(rd) else {}) or {}
        return {'cat': meta.get('cat', ''), 'col': col, 'before': before, 'after': after, 'act': act, 'color': color or '',
                'reads': [str(x) for x in reads.get(col, [])], 'by': page.get('by') or '', 'model': page.get('model') or '',
                'batch': run, 'page': int(no), 'row': k + 1, 'at': iso(at)}

    def touch(self, xlsx: str, no: int, k: int, col: str, before: str, after: str, act: str, color: str):
        """核对里动了一格（k：这张第几条，从 0 数）"""
        if not self.active():
            return
        with self.lock:
            run = self._run_of(xlsx)
            if not run:
                return
            meta = self._meta(run)
            self._scan_run(run, meta, float('inf'))    # 先把 Excel 里改过、还没比的记上（这一下核对存的盘也在里面，下面按核对的算）
            key = f'{no}|{k}|{col}'
            at = self.clock()
            had = meta['items'].get(key)
            if had:
                had.update(after=after, act=act, at=iso(at))
            else:
                meta['items'][key] = self._item(meta, run, no, k, col, before, after, act, color, at)
            meta['last'] = at
            self._save_meta(run, meta)

    def scan(self, now: float | None = None) -> int:
        """表在 Excel 里改了、存了盘：跟「原样」一比，改过的格子记成 edit。返回新记了几格"""
        if not self.active():
            return 0
        now = self.clock() if now is None else now
        made = 0
        for run in self._runs():
            with self.lock:
                meta = self._meta(run)
                n = self._scan_run(run, meta, now)
                if n is not None:
                    made += n
                    self._save_meta(run, meta)
        return made

    def _scan_run(self, run: str, meta: dict, now: float):
        """一批比一比（原地改 meta）；表没动过、刚存还没满一分钟、读不出来 -> None"""
        from .viewer import load_rows
        from .engine import FIELDS
        xlsx, orig = meta.get('xlsx'), os.path.join(self._run_dir(run), PRISTINE)
        if not xlsx or not os.path.isfile(xlsx) or not os.path.isfile(orig):
            return None
        try:
            mtime = os.path.getmtime(xlsx)
        except OSError:
            return None
        if mtime == meta.get('mtime') or now - mtime < SETTLE:
            return None
        after = load_rows(xlsx)
        if not after:
            return None
        before = load_rows(orig)
        builtin = meta.get('cat') == BUILTIN
        made = 0
        for no, rows in before.items():
            for k, b in enumerate(rows):
                if k >= len(after.get(no, [])) or not any(b['raw']):
                    continue
                a = after[no][k]
                for i, lab in enumerate(b['labels']):
                    col = FIELDS[i] if builtin else lab
                    j = a['labels'].index(lab) if lab in a['labels'] else -1
                    now_v = a['raw'][j] if j >= 0 else ''
                    key = f'{no}|{k}|{col}'
                    had = meta['items'].get(key)
                    if had:
                        if _norm(had['after']) != _norm(now_v):
                            had.update(after=now_v, act='edit', at=iso(mtime))
                            made += 1
                        continue
                    if _norm(b['raw'][i]) == _norm(now_v):
                        continue
                    color = 'red' if i in b['red'] else 'orange' if i in b['fixed'] else ''
                    meta['items'][key] = self._item(meta, run, no, k, col, b['raw'][i], now_v, 'edit', color, mtime)
                    made += 1
        meta['mtime'] = mtime
        if made:
            meta['last'] = max(meta.get('last') or 0, mtime)
        return made

    # ---------- 打包、排队、交
    def pack(self, force: bool = False) -> int:
        if not self.active():
            return 0
        from .viewer import load_rows
        made = 0
        with self.lock:
            for run in self._runs():
                meta = self._meta(run)
                fresh = [(key, it) for key, it in meta['items'].items()
                         if meta['sent'].get(key) != json.dumps(it, ensure_ascii=False, sort_keys=True)]
                if not fresh or (not force and self.clock() - (meta.get('last') or 0) < IDLE):
                    continue
                cat = meta.get('cat', '')
                batch = {'batch': run, 'cat': cat, 'cells': int(meta.get('cells') or 0), 'edited': len(meta['items']),
                         'list_ver': int(meta.get('list_ver') or 0), 'at': meta.get('at') or iso(self.clock())}
                now_rows = load_rows(meta.get('xlsx', '')) if meta.get('xlsx') else {}
                photos = []
                for no in sorted({it['page'] for _, it in fresh}):
                    img = _load(os.path.join(self._run_dir(run), 'img', f'{no:03d}.json'))
                    if not img or not img.get('data'):
                        continue
                    photos.append({'batch': run, 'page': no, 'cat': cat, 'mime': 'image/jpeg', 'data': img['data'],
                                   'prompt': img.get('prompt') or '', 'ask': img.get('ask') or '', 'schema': img.get('schema'),
                                   'answer': answer_of(now_rows.get(no, []), cat, img)})
                for p in packages(self.device(), self.app, [batch], [it for _, it in fresh], photos):
                    self._enqueue(p)
                    made += 1
                for key, it in fresh:
                    meta['sent'][key] = json.dumps(it, ensure_ascii=False, sort_keys=True)
                self._save_meta(run, meta)
            if made:
                self._cap()
        return made

    def _qdir(self) -> str:
        return os.path.join(self.home, 'queue')

    def _enqueue(self, pkg: dict):
        self.seq = max(self.seq + 1, int(self.clock() * 1000) * 1000)
        _dump(os.path.join(self._qdir(), f'{self.seq:020d}.json'), {'size': nbytes(pkg), 'pkg': pkg})

    def queued(self) -> list[str]:
        d = self._qdir()
        return [os.path.join(d, f) for f in sorted(os.listdir(d)) if f.endswith('.json')] if os.path.isdir(d) else []

    def _cap(self):
        q = self.queued()
        sizes = {p: os.path.getsize(p) for p in q}
        total, left = sum(sizes.values()), len(q)
        for p in q:
            if left <= MAX_QUEUE and total <= MAX_BYTES:
                break
            try:
                os.remove(p)
            except OSError:
                pass
            left -= 1
            total -= sizes[p]

    def send(self) -> dict:
        """排着的一包一包交；大管家不在、出错就停，过一阵再来"""
        out = {'sent': 0, 'left': 0, 'why': ''}
        if not self.active() or not self.send_lock.acquire(blocking=False):
            return out
        try:
            self.last_send = self.clock()
            for _ in range(8):                       # 劈开的排到最后：这一轮交完别的再来一遍
                again = False
                q = self.queued()
                out['left'] = len(q)
                for path in q:
                    if not self.active():
                        break
                    got = _load(path)
                    pkg = got.get('pkg') if isinstance(got, dict) else None
                    if not pkg:
                        self._drop(path)
                        out['left'] -= 1
                        continue
                    r = self.butler.learn(pkg)
                    if r.get('ok'):
                        self._drop(path)
                        out['sent'] += 1
                        out['left'] -= 1
                        continue
                    if r.get('split'):
                        parts = halve(pkg)
                        self._drop(path)
                        out['left'] -= 1
                        for p in parts or []:
                            self._enqueue(p)
                            out['left'] += 1
                        again = again or bool(parts)
                        continue
                    out['why'] = 'gone' if r.get('gone') else r.get('why') or 'later'
                    again = False
                    break
                if not again:
                    break
        except Exception as e:
            out['why'] = f'{type(e).__name__}: {e}'
        finally:
            self.send_lock.release()
        return out

    @staticmethod
    def _drop(path: str):
        try:
            os.remove(path)
        except OSError:
            pass

    def tick(self) -> dict | None:
        """定时：Excel 里改过的比一比、到点的打包、隔 10 分钟交一次排着的（或者刚打了新包）"""
        if not self.active():
            return None
        self.scan()
        made = self.pack(False)
        if (made or self.clock() - self.last_send >= RESEND) and self.queued():
            return self.send()
        return None

    def forget_all(self):
        """⚙ 里关了：攒着的、记着的、留着的照片全清掉"""
        with self.lock:
            for sub in ('runs', 'queue'):
                shutil.rmtree(os.path.join(self.home, sub), ignore_errors=True)

    def tidy(self):
        """放了 14 天的批次（照片、原样、记的格子）清掉；表都没了的也清掉"""
        old = self.clock() - KEEP_DAYS * 86400
        with self.lock:
            for run in self._runs():
                d = self._run_dir(run)
                meta = _load(os.path.join(d, 'meta.json'), {}) or {}
                try:
                    stale = os.path.getmtime(d) < old and (meta.get('last') or 0) < old
                except OSError:
                    stale = True
                gone = meta.get('xlsx') and not os.path.isfile(meta['xlsx'])
                if stale or gone:
                    shutil.rmtree(d, ignore_errors=True)
