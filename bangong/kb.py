"""数据库：投喂公司 TOOL BROKEN RECORD（或核对过的录入僧结果表），以后认单子以它为准。

只认喂进来的表：录入僧自己认出来的东西不进库，免得认错的被学进去越学越歪。
"""
from __future__ import annotations

import hashlib
import os
import re
import sqlite3
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime

from . import sheets
from .engine import FIELDS, SHIFT_WORDS, to_int

DB_FILE = '数据库.sqlite'
FEED_DIR = '投喂'
CAT_FIELDS = ['machine', 'part_number', 'description']          # 来回就那几个值的字段
# 名字页上的清单列（公司那本 NAME 页：MACHINE、OPERATION 各一列）：拿来当准绳，里面的字不当人名
LIST_KEYS = {'MACHINE': 'machine', 'MACHINES': 'machine', 'M/C': 'machine', 'MACHINENO': 'machine',
             'OPERATION': 'opr_no', 'OPERATIONS': 'opr_no', 'OPR': 'opr_no', 'OPRNO': 'opr_no', 'OP': 'opr_no',
             'OPNO': 'opr_no'}
LIST_OTHER = {'SHIFT', 'TOOL', 'TOOLS', 'TNO', 'DESCRIPTION', 'DATE', 'MO', 'PARTNUMBER', 'PARTNO'}
LIST_SHEET = re.compile(r'NAME|EMP|LIST|名单|名字|人员|清单', re.I)
SHORT_RE = re.compile(r'^([A-Z]{1,3})(\d+(?:\.\d*)?)$')        # 公司表里刀具描述的简写：EM3、DR2.5、M4
CODE_RE = re.compile(r'^Φ?([0-9A-Z]{1,8})-M([0-9O.]{4,8})')     # 刀具编码：4FEM-M0300C-0080-04（直径 03.00）
PHI_RE = re.compile(r'^Φ(\d+(?:\.\d+)?)([A-Z]{2,6})$')          # 手写的 Φ1.5 FEM
# 手写数字里长得像的：带横的 7 跟 4 最像（Song 那张单子），其次这几对
LOOKALIKE = {frozenset(p) for p in ('47', '49', '17', '38', '56', '68', '08', '06', '09', '35', '27', '12')}
LABEL = {'date': 'DATE', 'machine': 'MACHINE', 'part_number': 'PART NUMBER', 'mo': 'MO', 'opr_no': 'OPR NO.',
         't_no': 'T NO.', 'description': 'DESCRIPTION', 'btmp': 'BTMP', 'total_screened': 'TOTAL SCREENED',
         'passed': 'PASSED', 'failed': 'FAILED', 'shift': 'SHIFT', 'setter': 'SETTER'}
HEADER_KEYS = {
    'DATE': 'date', 'MACHINE': 'machine', 'M/C': 'machine', 'MACHINENO': 'machine',
    'PARTNUMBER': 'part_number', 'PARTNO': 'part_number', 'MO': 'mo', 'MONO': 'mo', 'W/O': 'mo',
    'OPRNO': 'opr_no', 'OPR': 'opr_no', 'OPNO': 'opr_no', 'TNO': 't_no', 'TOOLNO': 't_no',
    'DESCRIPTION': 'description', 'TOOLDESCRIPTION': 'description', 'BTMP': 'btmp',
    'TOTALSCREENED': 'total_screened', 'PASSED': 'passed', 'FAILED': 'failed', 'SHIFT': 'shift', 'SETTER': 'setter',
}
# 容易看错的字：两边都换成同一个再比，比如 VM-O7 和 VM-07 就是同一个
CONFUSE = str.maketrans({'O': '0', 'Q': '0', 'D': '0', 'I': '1', 'L': '1', '|': '1', 'S': '5', 'B': '8',
                         'Z': '2', 'G': '6'})
SCHEMA = """
CREATE TABLE IF NOT EXISTS records (
    hash TEXT PRIMARY KEY, source TEXT, sheet TEXT, fed_at TEXT,
    date TEXT, machine TEXT, part_number TEXT, mo TEXT, opr_no TEXT, t_no TEXT, description TEXT,
    btmp TEXT, total_screened TEXT, passed TEXT, failed TEXT, shift TEXT, setter TEXT);
CREATE TABLE IF NOT EXISTS people (no TEXT PRIMARY KEY, name TEXT, source TEXT);
CREATE TABLE IF NOT EXISTS sources (path TEXT PRIMARY KEY, mtime REAL, size INTEGER, fed_at TEXT, added INTEGER);
CREATE TABLE IF NOT EXISTS lists (kind TEXT, value TEXT, source TEXT, PRIMARY KEY (kind, value));
"""


def label_key(v) -> str:
    return re.sub(r'[^A-Z/]', '', str(v or '').upper())


def nkey(v: str) -> str:
    """比对用的写法：大写、去空格、各种横杠统一。"""
    t = str(v or '').upper()
    t = re.sub(r'[‐-―_~]', '-', t)
    t = t.replace(',', '.')
    return re.sub(r'\s+', '', t)


def ckey(v: str) -> str:
    return nkey(v).translate(CONFUSE)


def lev1(a: str, b: str) -> bool:
    """两个字符串是否只差一个字（替换、多一个或少一个）。"""
    if a == b or abs(len(a) - len(b)) > 1:
        return False
    if len(a) == len(b):
        return sum(x != y for x, y in zip(a, b)) == 1
    if len(a) > len(b):
        a, b = b, a
    for i in range(len(b)):
        if a == b[:i] + b[i + 1:]:
            return True
    return False


def mkey(v) -> str:
    """机台比对用：VM-07、VM-7、vm7 都是同一台。"""
    k = nkey(v)
    m = re.fullmatch(r'([A-Z0-9]*?[A-Z])-?0*(\d+)', k)
    return f'{m.group(1)}-{m.group(2)}' if m else k


def skel(v) -> str:
    """零件号只看字母和数字：TD-123-456-01A 跟 TD-123-456-01-A 是同一个。"""
    return re.sub(r'[^A-Z0-9]', '', nkey(v))


def lev(a: str, b: str) -> int:
    """差几个字（替换、多、少各算一个）。"""
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def swap47(a: str, b: str) -> bool:
    """只差几个 4↔7：带横的 7 被看成 4（或者反过来）。"""
    return len(a) == len(b) and a != b and all(x == y or {x, y} == {'4', '7'} for x, y in zip(a, b))


def look_rank(read: str, cand: str) -> int:
    """候选排队：只差 4↔7 最像；其次只差一个手写易混的数字；再其次别的只差一个字。"""
    if swap47(read, cand):
        return 0
    if len(read) == len(cand):
        diff = [frozenset((x, y)) for x, y in zip(read, cand) if x != y]
        if len(diff) == 1 and diff[0] in LOOKALIKE:
            return 1
    return 2


def close_codes(read: str, pool, count=None, limit: int = 4) -> list[str]:
    """工号、工序这种数字：池子里跟认出来的只差一个字（或者只差 4↔7）的，最像的排前面。"""
    count = count or {}
    near = [c for c in pool if c != read and (swap47(read, c) or lev(read, c) == 1)]
    near.sort(key=lambda c: (look_rank(read, c), -count.get(c, 0), c))
    return near[:limit]


def is_shift_word(v) -> bool:
    return str(v or '').strip().upper() in SHIFT_WORDS


def fmt_num(x: float) -> str:
    return f'{x:.3f}'.rstrip('0').rstrip('.')


def uniq(items) -> list:
    out = []
    for x in items:
        if x not in out:
            out.append(x)
    return out


def cell_text(v) -> str:
    if v is None:
        return ''
    if isinstance(v, datetime):
        return v.date().isoformat()
    if isinstance(v, date):
        return v.isoformat()
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return re.sub(r'\s+', ' ', str(v)).strip()


def record_hash(rec: dict) -> str:
    return hashlib.sha1('|'.join(nkey(rec.get(f, '')) for f in FIELDS).encode('utf-8')).hexdigest()


SETTER_RE = re.compile(r'^\s*(\d{2,6})\s*[/／]\s*([A-Za-z][A-Za-z .\'-]*[A-Za-z])\s*$')


@dataclass
class FeedResult:
    path: str
    rows: int = 0
    added: int = 0
    people: int = 0
    sheets: list = field(default_factory=list)
    error: str = ''
    lists: dict = field(default_factory=dict)          # 这本里读到的清单：{'machine': 43, 'opr_no': 7}

    def line(self) -> str:
        name = os.path.basename(self.path)
        if self.error:
            return f'✗ {name}：{self.error}'
        got = '、'.join(f'{LIST_NAME[k]} {n} {LIST_UNIT[k]}' for k, n in self.lists.items() if n)
        return (f'✓ 吃进 {name}：读到 {self.rows} 行记录，新增 {self.added} 行（其余以前吃过）'
                + (f'，新认识 {self.people} 人' if self.people else '')
                + (f'，认得{got}' if got else '')
                + (f'（{"、".join(self.sheets)}）' if self.sheets else ''))


LIST_NAME = {'machine': '机台表', 'opr_no': '工序表'}
LIST_UNIT = {'machine': '台', 'opr_no': '道'}


# ---------------------------------------------------------------- 读表
def find_header(rows: list[tuple]) -> tuple[int, dict[int, str]] | None:
    """在前 15 行找表头：同时有 DATE 和 MACHINE 的那一行；下一行是小表头（T NO.、TOTAL SCREENED…）。"""
    for i, row in enumerate(rows[:15]):
        keys = [label_key(v) for v in row]
        if 'DATE' in keys and ('MACHINE' in keys or 'M/C' in keys):
            sub = rows[i + 1] if i + 1 < len(rows) else ()
            cols: dict[int, str] = {}
            for c in range(max(len(row), len(sub))):
                for v in ((sub[c] if c < len(sub) else None), (row[c] if c < len(row) else None)):
                    f = HEADER_KEYS.get(label_key(v))
                    if f and f not in cols.values():
                        cols[c] = f
                        break
            uses_sub = any(c < len(sub) and HEADER_KEYS.get(label_key(sub[c])) for c in cols)
            return (i + 2 if uses_sub else i + 1), cols
    return None


def read_lists(rows: list[tuple]) -> tuple[dict[str, list[str]], set[int]]:
    """名字页上的清单：前 5 行里找 MACHINE、OPERATION 这样的列头，底下一格一个值。
    返回 ({'machine': [...], 'opr_no': [...]}, 清单列的列号——这些列里的字不当人名)。"""
    for i, row in enumerate(rows[:5]):
        keys = [label_key(v) for v in row]
        kinds = {c: LIST_KEYS[k] for c, k in enumerate(keys) if k in LIST_KEYS}
        if not kinds:
            continue
        skip = {c for c, k in enumerate(keys) if k in LIST_KEYS or k in LIST_OTHER}
        start = i + 1
        out: dict[str, list[str]] = {}
        for c, kind in kinds.items():
            for r in rows[start:]:
                t = cell_text(r[c]) if c < len(r) else ''
                if not t:
                    continue
                if kind == 'opr_no':
                    n = to_int(t)
                    if n is None:
                        continue
                    t = str(n)
                if t not in out.setdefault(kind, []):
                    out[kind].append(t)
        return out, skip
    return {}, set()


def read_people(rows: list[tuple], skip: set[int] = frozenset()) -> list[tuple[str, str]]:
    """名字页：认「535/RAJ KUMAR」这种格子，或者一格工号紧跟一格名字。
    清单列（skip：机台、工序、班次…）里的字不算：不然工序 130 跟班次 NIGHT 会被凑成一个人。"""
    out = []
    for row in rows:
        cells = [cell_text(v) for v in row]
        for j, t in enumerate(cells):
            if j in skip:
                continue
            m = SETTER_RE.match(t)
            if m:
                if not is_shift_word(m.group(2)):
                    out.append((m.group(1), m.group(2).strip()))
                continue
            if re.fullmatch(r'\d{2,6}', t):
                k = next((i for i in range(j + 1, len(cells)) if cells[i]), None)
                nxt = cells[k] if k is not None and k not in skip else ''
                if (re.fullmatch(r"[A-Za-z][A-Za-z .'-]{1,60}", nxt) and len(re.sub(r'[^A-Za-z]', '', nxt)) >= 3
                        and not is_shift_word(nxt)):
                    out.append((t, nxt.strip()))
    return out


def read_workbook(path: str) -> tuple[list[tuple[str, dict]], list[tuple[str, str]], list[str], dict[str, list[str]]]:
    """返回 ([(页名, 记录)], [(工号, 名字)], [读到记录的页名], {'machine': 机台表, 'opr_no': 工序表})。"""
    recs, people, used, loose = [], [], [], []
    lists: dict[str, list[str]] = {}
    loose_lists: dict[str, list[str]] = {}
    has_header = False
    # .xlsx / .xlsm / .xls / .csv 都变成「页名 + 一行一个元组」
    for title, rows in sheets.read_sheets(path):
        hdr = find_header(rows)
        if not hdr:
            found_lists, skip = read_lists(rows)
            found = read_people(rows, skip)
            named = bool(LIST_SHEET.search(title))
            if named:
                people += found
            else:
                loose += found
            for kind, vals in found_lists.items():
                bucket = (lists if named else loose_lists).setdefault(kind, [])
                bucket += [v for v in vals if v not in bucket]
            continue
        has_header = True
        start, cols = hdr
        n = 0
        for row in rows[start:]:
            rec = {f: '' for f in FIELDS}
            for c, f in cols.items():
                if c < len(row):
                    rec[f] = cell_text(row[c])
            core = sum(bool(rec[f]) for f in ('machine', 'part_number', 'mo', 't_no', 'description', 'setter'))
            if core >= 3:
                recs.append((title, rec))
                n += 1
                m = SETTER_RE.match(rec['setter'])
                if m:
                    people.append((m.group(1), m.group(2).strip()))
        if n:
            used.append(title)
    if has_header:                       # 真是刀单本子，别的页上的工号名字、清单才算数（别的单子不往刀单里串）
        people += loose
        for kind, vals in loose_lists.items():
            bucket = lists.setdefault(kind, [])
            bucket += [v for v in vals if v not in bucket]
    return recs, people, used, lists


# ---------------------------------------------------------------- 数据库
class KnowledgeBase:
    def __init__(self, path: str):
        self.path = path
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        with self._conn() as c:
            had_lists = c.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lists'").fetchone()
            c.executescript(SCHEMA)
            old = [] if had_lists else [p for (p,) in c.execute('SELECT path FROM sources')]
            if not had_lists:            # 老库：以前把工序 130 跟班次 NIGHT 凑成过一个人，清掉
                c.execute('DELETE FROM people WHERE UPPER(TRIM(name)) IN ({})'.format(
                    ', '.join('?' * len(SHIFT_WORDS))), [w.upper() for w in SHIFT_WORDS])
        for p in old:                    # 老库没有机台表、工序表：吃过的表还在的话重吃一遍（记录不会重复）
            if os.path.isfile(p):
                try:
                    self.feed(p)
                except Exception:
                    pass

    def _conn(self):
        return sqlite3.connect(self.path, timeout=30)

    def feed(self, path: str) -> FeedResult:
        res = FeedResult(path)
        if not sheets.supported(path):
            res.error = sheets.UNSUPPORTED
            return res
        try:
            recs, people, used, lists = read_workbook(path)
        except Exception as e:
            res.error = sheets.why(e)
            return res
        if not recs and not people and not lists:
            res.error = ('这本不像刀单：没找到 DATE、MACHINE 那样的表头，一条没吃。'
                         '是别的单子的话，放进它自己的类别')
            return res
        now = datetime.now().isoformat(timespec='seconds')
        src = os.path.basename(path)
        with self._conn() as c:
            before = c.execute('SELECT COUNT(*) FROM records').fetchone()[0]
            c.executemany(
                f'INSERT OR IGNORE INTO records (hash, source, sheet, fed_at, {", ".join(FIELDS)}) '
                f'VALUES ({", ".join("?" * (4 + len(FIELDS)))})',
                [(record_hash(r), src, sheet, now, *[r[f] for f in FIELDS]) for sheet, r in recs])
            res.added = c.execute('SELECT COUNT(*) FROM records').fetchone()[0] - before
            p0 = c.execute('SELECT COUNT(*) FROM people').fetchone()[0]
            c.executemany('INSERT OR IGNORE INTO people (no, name, source) VALUES (?, ?, ?)',
                          [(n, nm, src) for n, nm in people])
            res.people = c.execute('SELECT COUNT(*) FROM people').fetchone()[0] - p0
            c.executemany('INSERT OR IGNORE INTO lists (kind, value, source) VALUES (?, ?, ?)',
                          [(k, v, src) for k, vals in lists.items() for v in vals])
            res.lists = {k: len(vals) for k, vals in lists.items()}
            st = os.stat(path)
            c.execute('INSERT OR REPLACE INTO sources (path, mtime, size, fed_at, added) VALUES (?, ?, ?, ?, ?)',
                      (os.path.abspath(path), st.st_mtime, st.st_size, now, res.added))
        res.rows, res.sheets = len(recs), used
        return res

    def put_checked(self, source: str, rec: dict | None) -> bool:
        """核对里核完的那条（红格子全处理完）当样板放进来：同一条（source 认人）先拿掉上次放的，
        rec 是 None（又改红了）就只拿掉。调试员的工号名字顺手记进名单。返回这回新放进去没有。"""
        now = datetime.now().isoformat(timespec='seconds')
        with self._conn() as c:
            c.execute('DELETE FROM records WHERE source = ?', (source,))
            if rec is None:
                return False
            r = {f: str(rec.get(f) or '') for f in FIELDS}
            cur = c.execute(f'INSERT OR IGNORE INTO records (hash, source, sheet, fed_at, {", ".join(FIELDS)}) '
                            f'VALUES ({", ".join("?" * (4 + len(FIELDS)))})',
                            (record_hash(r), source, '核对', now, *[r[f] for f in FIELDS]))
            m = SETTER_RE.match(r['setter'])
            if m:
                c.execute('INSERT OR IGNORE INTO people (no, name, source) VALUES (?, ?, ?)',
                          (m.group(1), m.group(2).strip(), source))
            return cur.rowcount > 0

    def feed_folder(self, folder: str) -> list[FeedResult]:
        """投喂文件夹：新放进来的、或者改过的表才吃。"""
        if not folder or not os.path.isdir(folder):
            return []
        with self._conn() as c:
            seen = {p: (m, s) for p, m, s in c.execute('SELECT path, mtime, size FROM sources')}
        out = []
        for name in sorted(os.listdir(folder)):
            p = os.path.abspath(os.path.join(folder, name))
            if not sheets.touch_ok(name) or not os.path.isfile(p):
                continue
            st = os.stat(p)
            if seen.get(p) == (st.st_mtime, st.st_size):
                continue
            out.append(self.feed(p))
        return out

    def summary(self) -> str:
        with self._conn() as c:
            n = c.execute('SELECT COUNT(*) FROM records').fetchone()[0]
            if not n:
                return '数据库还是空的：点「放入样板资料」喂几本改对的刀单表，喂得越多它越不瞎'
            m = c.execute('SELECT COUNT(DISTINCT part_number), COUNT(DISTINCT description) FROM records').fetchone()
            machines = {mkey(v) for (v,) in c.execute("SELECT machine FROM records WHERE machine != ''")}
            machines |= {mkey(v) for (v,) in c.execute("SELECT value FROM lists WHERE kind = 'machine'")}
            p = c.execute('SELECT COUNT(*) FROM people').fetchone()[0]
        return f'数据库：{n} 条记录 · 机台 {len(machines)} 台 · 零件 {m[0]} 种 · 刀具描述 {m[1]} 种 · 认识 {p} 人'

    def load(self) -> 'Snapshot':
        with self._conn() as c:
            rows = c.execute(f'SELECT {", ".join(FIELDS)} FROM records').fetchall()
            people = c.execute('SELECT no, name FROM people').fetchall()
            lists: dict[str, list[str]] = {}
            for kind, value in c.execute('SELECT kind, value FROM lists'):
                lists.setdefault(kind, []).append(value)
        return Snapshot([dict(zip(FIELDS, r)) for r in rows], people, lists)


# ---------------------------------------------------------------- 拿数据库当准绳
class Snapshot:
    def __init__(self, records: list[dict], people: list[tuple[str, str]], lists: dict | None = None):
        self.n = len(records)
        self.people = [(str(no), str(nm)) for no, nm in people if not is_shift_word(nm)]
        self.count = {f: Counter() for f in CAT_FIELDS}
        spell = {f: defaultdict(Counter) for f in CAT_FIELDS}
        for r in records:
            for f in CAT_FIELDS:
                if r.get(f):
                    spell[f][nkey(r[f])][r[f]] += 1
        # 每个值取最常见的写法当标准写法
        self.canon = {f: {k: c.most_common(1)[0][0] for k, c in spell[f].items()} for f in CAT_FIELDS}
        for f in CAT_FIELDS:
            for k, c in spell[f].items():
                self.count[f][self.canon[f][k]] = sum(c.values())
        self.by_ckey = {f: defaultdict(set) for f in CAT_FIELDS}
        for f in CAT_FIELDS:
            for k, v in self.canon[f].items():
                self.by_ckey[f][ckey(k)].add(v)
        self.by_skel = defaultdict(set)                  # 零件号去掉横杠以后的样子
        for v in self.canon['part_number'].values():
            self.by_skel[skel(v)].add(v)
        lists = lists or {}
        # 机台：公司记录里出现过的 + 名字页上的机台表；VM-07 跟 VM-7 算一台，猜的时候写机台表上的写法
        mc = Counter(r['machine'] for r in records if r.get('machine'))
        self.machines: dict[str, str] = {}
        for v, _ in mc.most_common():
            self.machines.setdefault(mkey(v), v)
        listed = [v for v in lists.get('machine', ()) if v]
        for v in listed:
            self.machines[mkey(v)] = v
        self.listed_machines = uniq([self.machines[mkey(v)] for v in listed])
        self.mcount = Counter()
        for v, c in mc.items():
            self.mcount[self.machines[mkey(v)]] += c
        self.mk_index = defaultdict(set)                 # 易混字统一以后（VM-O7 → VM-7）对到哪台
        for v in self.machines.values():
            self.mk_index[mkey(ckey(v))].add(v)
        self.check_machine = bool(listed) or self.n >= 100   # 有机台表，或者记录够多，才拿公司的机台把关
        self.part_machines = defaultdict(Counter)        # 这个零件以前上过哪几台机
        for r in records:
            if r.get('part_number') and r.get('machine'):
                self.part_machines[skel(r['part_number'])][self.machines[mkey(r['machine'])]] += 1
        # 工序：有工序表才把关；表上没有、记录里出现过两回以上的也算公司有
        self.opr_count = Counter()
        for r in records:
            k = to_int(r.get('opr_no') or '')
            if k is not None:
                self.opr_count[str(k)] += 1
        listed_ops = {str(k) for k in (to_int(v) for v in lists.get('opr_no', ())) if k is not None}
        self.oprs = (listed_ops | {k for k, c in self.opr_count.items() if c >= 2}) if listed_ops else set()
        # 调试员：名单上的人 + 公司记录里出现过两回以上的工号（只有工号、没写名字的也算）
        self.setter_count = Counter()
        for r in records:
            m = re.match(r'\s*(\d{2,6})(?!\d)', r.get('setter') or '')
            if m:
                self.setter_count[m.group(1)] += 1
        self.setter_ids = {no for no, _ in self.people} | {k for k, c in self.setter_count.items() if c >= 2}
        # 刀具描述：公司表里大多是简写（EM3、DR2.5）就照它的写；简写用过哪几种刀（两个字母以上的）
        tc = Counter()
        for v, c in self.count['description'].items():
            m = SHORT_RE.match(nkey(v))
            if m:
                tc[m.group(1)] += c
        total = sum(self.count['description'].values())
        self.desc_types = {t for t in tc if len(t) >= 2}
        self.short_desc = total >= 5 and sum(tc.values()) >= 0.6 * total

    def roster(self) -> list[tuple[str, str]]:
        return list(self.people)

    def hints(self, max_parts: int = 200) -> str:
        if not self.n and not self.machines and not self.oprs:
            return ''
        lines = []
        machines = [v for v, _ in self.count['machine'].most_common(100)]
        seen = {mkey(v) for v in machines}
        for v in self.listed_machines:
            if mkey(v) not in seen:
                machines.append(v)
                seen.add(mkey(v))
        if machines:
            lines.append('MACHINE：' + '、'.join(machines))
        if self.oprs:
            lines.append('OPR NO.：' + '、'.join(sorted(self.oprs, key=lambda x: (len(x), x))))
        for f, lim in (('description', 150), ('part_number', max_parts)):
            vals = [v for v, _ in self.count[f].most_common(lim)]
            if vals:
                lines.append(f'{LABEL[f]}：' + '、'.join(vals))
        return ('公司记录里出现过的值（数据库 {} 条记录）：单子上的字跟其中某个很像时，一律以这里的写法为准；'
                '明显不一样的（新机台、新零件、新刀）照单子原样抄。\n'.format(self.n) + '\n'.join(lines))

    def _snap(self, f: str, v: str) -> str | None:
        k = nkey(v)
        cands = self.by_ckey[f].get(ckey(v), set())
        if len(cands) == 1:
            return next(iter(cands))
        if len(k) >= 4:
            near = {c for kk, c in self.canon[f].items() if lev1(kk, k)}
            if len(near) == 1:
                c = next(iter(near))
                if self.count[f][c] >= 2:
                    return c
        return self._snap_part(v) if f == 'part_number' else None

    def _snap_part(self, v: str) -> str | None:
        """零件号再宽一点：去掉横杠比（TD-123-456-01A 就是 TD-123-456-01-A）；B 被看成 13（A13-1234567B）；
        去掉横杠以后只差一个字（AB51234567B）。后两种库里得出现过两回以上。"""
        s = skel(v)
        if len(s) < 4:
            return None
        same = self.by_skel.get(s, set())
        if same:
            return next(iter(same)) if len(same) == 1 else None
        tries = {s[:i] + 'B' + s[i + 2:] for i in range(len(s) - 1) if s[i:i + 2] == '13'}
        hit = {c for t in tries for c in self.by_skel.get(t, ())}
        if not hit:
            hit = {c for sk, cs in self.by_skel.items() if lev1(sk, s) for c in cs}
        if len(hit) == 1:
            c = next(iter(hit))
            if self.count['part_number'][c] >= 2:
                return c
        return None

    # ---------------------------------------------------------------- 机台
    def known_machine(self, x: str) -> str | None:
        """公司有这台机就返回该写的写法（只差易混字的 VM-O7 也算），没有返回 None。"""
        k = nkey(x)
        if k in self.canon['machine']:
            return self.canon['machine'][k]
        if mkey(x) in self.machines:
            return self.machines[mkey(x)]
        hits = self.mk_index.get(mkey(ckey(x)), set())
        return next(iter(hits)) if len(hits) == 1 else None

    def guess_machine(self, v: str, part: str = '') -> tuple[str, list[str]]:
        """公司就那么几台机床，看起来像的就猜（Song 2026-11-01）。返回 (猜的, 猜不准时的候选)。
        只差一个字的只有一台就是它；有好几台，这个零件以前只上过其中一台就是那台；都不行就不猜。"""
        x = mkey(ckey(v))
        pm = self.part_machines.get(skel(part), Counter()) if part else Counter()
        scored = sorted((lev(x, mkey(ckey(m))), -pm.get(m, 0), -self.mcount.get(m, 0), m)
                        for m in set(self.machines.values()))
        if not scored:
            return '', []
        best = scored[0][0]
        top = [s[3] for s in scored if s[0] == best]
        if best <= 1:
            if len(top) == 1:
                return top[0], []
            hist = [m for m in top if pm.get(m)]
            if len(hist) == 1:
                return hist[0], top[:4]
            return '', top[:4]
        return '', [s[3] for s in sorted(scored, key=lambda s: (s[1], s[0], s[2], s[3]))[:4]]

    def _machine(self, rec, disputed, unsure, fixed, flags, alts, ctx):
        v = rec.get('machine', '')
        if not v:
            return
        k = nkey(v)
        if not self.check_machine:               # 公司的机台还认不全：照老规矩，像的改、拿不准的才标
            if k in self.canon['machine']:
                rec['machine'] = self.canon['machine'][k]
                return
            c = self._snap('machine', v)
            if c:
                fixed['machine'] = (v, c, '按数据库改')
                rec['machine'] = c
            elif 'machine' in unsure:
                flags['machine'] = f'MACHINE 数据库里没见过，模型也拿不准：{v}'
            return
        reads = uniq([x for x in (disputed.get('machine') or [v]) if x and x != '空']) or [v]
        good = uniq([m for m in (self.known_machine(x) for x in reads) if m])
        if len(good) == 1:
            g = good[0]
            if len(reads) > 1:
                fixed['machine'] = (v, g, f'几遍认得不一样：{" / ".join(reads)}，公司只有 {g}')
                disputed.pop('machine', None)
            elif g != v:
                fixed['machine'] = (v, g, '按数据库改')
            rec['machine'] = g
            return
        if len(good) > 1:                        # 几遍认的都是公司有的机台：还红着，候选只列这几台
            disputed['machine'] = good
            alts['machine'] = good
            rec['machine'] = self.known_machine(v) or good[0]
            return
        disputed.pop('machine', None)            # 一个都不是公司的机台：看起来像的就猜，实在没法猜才标红
        guess, cands = self.guess_machine(v, rec.get('part_number', ''))
        ctx['machine'] = {'read': v, 'guess': guess, 'cands': cands}
        if guess:
            fixed['machine'] = (v, guess, f'公司没有 {v}，按长得像猜的')
            rec['machine'] = guess
        else:
            flags['machine'] = f'MACHINE {v} 公司没有这台机' + (f'，可能是：{" / ".join(cands)}' if cands else '')
            alts['machine'] = cands

    # ---------------------------------------------------------------- 工序
    def _opr(self, rec, disputed, fixed, flags, alts):
        v = rec.get('opr_no', '')
        if not self.oprs or not v:
            return

        def key(x):
            n = to_int(x)
            return str(n) if n is not None else nkey(x)
        reads = uniq([x for x in (disputed.get('opr_no') or [v]) if x and x != '空']) or [v]
        good = uniq([key(x) for x in reads if key(x) in self.oprs])
        if len(good) == 1:
            if len(reads) > 1:
                fixed['opr_no'] = (v, good[0], f'几遍认得不一样：{" / ".join(reads)}，公司只有 {good[0]}')
                disputed.pop('opr_no', None)
                rec['opr_no'] = good[0]
            return
        if len(good) > 1:
            disputed['opr_no'] = good
            alts['opr_no'] = good
            return
        disputed.pop('opr_no', None)
        cands = uniq([c for x in reads for c in close_codes(key(x), self.oprs, self.opr_count)])[:4]
        flags['opr_no'] = (f'OPR_NO {v} 公司没有这道工序' + (f'（几遍认的：{" / ".join(reads)}）' if len(reads) > 1 else '')
                           + (f'，可能是：{" / ".join(cands)}' if cands else ''))
        alts['opr_no'] = cands

    # ---------------------------------------------------------------- 刀具描述
    def _desc_type(self, letters: str) -> str | None:
        for i in range(len(letters) - 1):        # 最长的、公司表里用过的简写（至少两个字母）：4FEM → EM、CZSD → SD
            if letters[i:] in self.desc_types:
                return letters[i:]
        return None

    def desc_parse(self, x: str) -> tuple[str | None, str | None, str] | None:
        """拆成 (刀的简写, 直径, 哪种写法)：4FEM-M0300C-0080-04 → ('EM', '3', 'code')；Φ1.5 FEM → ('EM', '1.5', 'phi')；
        已经是简写的 EM8 → ('EM', '8', 'short')；别的样子返回 None。"""
        t = nkey(x)
        m = CODE_RE.match(t)
        if m:
            letters = re.search(r'[A-Z]+$', m.group(1))
            digits = m.group(2).replace('O', '0').replace('.', '')
            dia = (fmt_num(int(digits[:2]) + int(digits[2:]) / 10 ** (len(digits) - 2))
                   if digits.isdigit() and 4 <= len(digits) <= 6 else None)
            return self._desc_type(letters.group(0) if letters else ''), dia, 'code'
        m = PHI_RE.match(t)
        if m:
            return self._desc_type(m.group(2)), fmt_num(float(m.group(1))), 'phi'
        m = SHORT_RE.match(t)
        if m and m.group(1) in self.desc_types:
            return m.group(1), fmt_num(float(m.group(2).rstrip('.') or 0)), 'short'
        return None

    def _short(self, rec, disputed, fixed, flags, alts) -> bool:
        """单子上的刀具编码照公司的简写写（Song 2026-11-01 定的：4FEM-M0300C-0080-04 写成 EM3，原编码写进核对提示）。
        几遍认的编码前面几个字母不一样（HRDR、HL2DR、HZDP）也不要紧：拆出来是同一种刀、同一个直径就算对上。"""
        v = rec['description']
        p = self.desc_parse(v)
        if not p or p[2] == 'short':
            return False                         # 不是编码、本来就是简写：照老规矩
        reads = uniq([x for x in (disputed.get('description') or [v]) if x and x != '空']) or [v]
        parsed = [q for q in (self.desc_parse(x) for x in reads) if q]
        types = {q[0] for q in parsed if q[0]}
        dias = {q[1] for q in parsed if q[1]}
        if len(types) == 1 and len(dias) == 1 and all(q[1] for q in parsed):
            short = next(iter(types)) + next(iter(dias))
            short = self.canon['description'].get(nkey(short), short)
            fixed['description'] = (v, short, '照公司简写')
            rec['description'] = short
            disputed.pop('description', None)
            return True
        opts = uniq([q[0] + q[1] for q in parsed if q[0] and q[1]])
        if not opts:
            return False
        if p[0] and p[1]:
            rec['description'] = self.canon['description'].get(nkey(p[0] + p[1]), p[0] + p[1])
        disputed.pop('description', None)
        flags['description'] = f'DESCRIPTION 几遍认得不一样：{" / ".join(opts)}（单子上的编码：{" / ".join(reads)}）'
        alts['description'] = opts
        return True

    def fix(self, rec: dict, unsure=()) -> tuple[dict, dict, dict, dict]:
        """返回 (改好的记录, {字段: (原来, 改成, 原因)}, {字段: 标红原因}, {'alts': {字段: 候选}, 'ctx': 等这批认完再看的})。
        零件号、刀具描述：跟库里某个只差容易看错的字，就改成库里的写法；刀具编码照公司的简写写。
        机台、工序：公司表里压根没有的，机台看起来像的就猜，工序标红列出像的（Song 2026-11-01 定的）。
        几遍认得不一样、只有一个是公司有的：就是它。
        不按零件对历史标红（Song 定的：零件、刀、MO 之间的老关系不拿来标红；没见过的零件也不标红）。"""
        rec = dict(rec)
        fixed, flags, alts, ctx = {}, {}, {}, {}
        extra = {'alts': alts, 'ctx': ctx}
        if not self.n and not self.machines and not self.oprs:
            return rec, fixed, flags, extra
        had = 'disputed' in rec
        disputed = dict(rec.get('disputed') or {})
        for f in ('part_number', 'description'):
            v = rec.get(f, '')
            if not v:
                continue
            if f == 'description' and self.short_desc and self._short(rec, disputed, fixed, flags, alts):
                continue
            k = nkey(v)
            if k in self.canon[f]:
                rec[f] = self.canon[f][k]
                continue
            c = self._snap(f, v)
            if c:
                fixed[f] = (v, c, '按数据库改')
                rec[f] = c
            elif f != 'part_number' and f in unsure:
                flags[f] = f'{LABEL[f]} 数据库里没见过，模型也拿不准：{v}'
        self._machine(rec, disputed, unsure, fixed, flags, alts, ctx)
        self._opr(rec, disputed, fixed, flags, alts)
        if had or disputed:
            rec['disputed'] = disputed
        return rec, fixed, flags, extra
