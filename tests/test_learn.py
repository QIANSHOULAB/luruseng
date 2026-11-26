"""184 录入僧越用越准（bangong/learn.py、dagj.Butler.learn / learn_list、engine 加提醒、viewer 记格子）。
中转站、大管家换成假的：只换「交给中转站」那一下（dagj._post / _get），封、拆照真的来。"""
import json
import os
import sys
import time

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from openpyxl import load_workbook

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bangong import claude, dagj, engine, learn, viewer  # noqa: E402
from test_engine import K1, make_images, reset, server  # noqa: E402,F401
import mock_server  # noqa: E402

CAT = '刀单'
LIST = {'ver': 5, 'at': 1, 'lists': {CAT: ['MACHINE 手写的 Q 常被看成 0'], '*': ['7 中间带横'], '别的': ['不该出现']},
        'nored': [{'cat': CAT, 'col': 'setter', 'value': '9999'}]}
BLOCK = learn.HEAD + '\n- MACHINE 手写的 Q 常被看成 0\n- 7 中间带横'
REC = {'date': '26/11', 'machine': 'VM-07', 'part_number': 'TD-1', 'mo': '82660000', 'opr_no': '110', 't_no': 'T4',
       'description': 'EM2.5', 'btmp': '1', 'total_screened': '1', 'passed': '1', 'failed': '0', 'shift': 'D', 'setter': '9999',
       'unsure': ['setter']}


def answer(body, seen=None):
    if seen is not None:
        seen.append(body)
    text = json.dumps({'title_side': 'top', 'records': [REC]})
    return {'candidates': [{'content': {'parts': [{'text': text}]}, 'finishReason': 'STOP'}]}


class Relay:
    """假中转站 + 假大管家：/lr/learn 拆开收下回回执；mode 决定这一下怎么回"""

    def __init__(self, monkeypatch, mode=lambda n: 'ok'):
        self.key = os.urandom(32)
        self.cid = 'c' * 22
        self.mode, self.tries, self.got, self.lists = mode, 0, [], 0
        monkeypatch.setattr(dagj, '_post', self.post)
        monkeypatch.setattr(dagj, '_get', self.get)

    def seal(self, obj, aad):
        n = os.urandom(12)
        return {'ok': True, 'n': dagj.b64u(n), 'ct': dagj.b64u(AESGCM(self.key).encrypt(n, json.dumps(obj).encode(), aad))}

    def post(self, url, body, timeout):
        assert url.endswith('/lr/learn'), url
        self.tries += 1
        m = self.mode(self.tries)
        if m == 'away':
            return 503, {'off': True}
        if m == 'old':
            return 200, {'ok': False, 'forget': True}
        if m == 'big':
            return 413, {}
        if m == 'revoked':
            return 403, {'revoked': True}
        pkg = json.loads(AESGCM(self.key).decrypt(dagj.unb64u(body['n']), dagj.unb64u(body['ct']), b'luru/learn/' + body['cid'].encode()))
        self.got.append(pkg)
        return 200, self.seal({'ok': True, 'got': len(pkg['items'])}, b'luru/learned/' + body['cid'].encode())

    def get(self, url, timeout, headers=None):
        assert url.endswith('/lr/learn/list'), url
        self.lists += 1
        if (headers or {}).get('x-lr-cid') != self.cid:
            return 403, {'unknown': True}
        return 200, {'ok': True, 'learn': LIST}

    def butler(self, tmp_path, paired=True):
        b = dagj.Butler(str(tmp_path / 'cfg' / 'dagj.json'))
        if paired:
            b.pair_info = {'cid': self.cid, 'key': dagj.b64u(self.key), 'at': ''}
        return b


def learner(tmp_path, b, on=None, clock=None):
    flag = on if on is not None else {'on': True}
    return learn.Learner(str(tmp_path / 'cfg' / 'learn'), b, app='desktop 1.13.10', on=lambda: flag['on'],
                         device=lambda: '录入僧电脑版 · 测试', **({'clock': clock} if clock else {}))


# ---------------------------------------------------------------- 提醒、不用标红
def test_hint_block_and_with_hints():
    assert learn.hint_block(LIST, CAT) == BLOCK
    assert learn.hint_block(None, CAT) == '' and learn.hint_block({'lists': {}}, CAT) == ''
    plain = engine.build_body(b'x', engine.DEFAULT_MODEL)
    b = learn.with_hints(plain, BLOCK)
    assert [p['text'] for p in b['systemInstruction']['parts']][1] == BLOCK
    assert len(plain['systemInstruction']['parts']) == 1 and learn.with_hints(plain, '') is plain
    assert learn.no_red(LIST, CAT, 'setter', ['9999', '9999'])
    assert not learn.no_red(LIST, CAT, 'setter', ['9999', '9998'])
    assert not learn.no_red(LIST, '质检单', 'setter', ['9999', '9999'])
    assert not learn.no_red(LIST, CAT, 'setter', ['9999'])


def test_packages_split_and_halve():
    big = 'A' * 1_200_000
    out = learn.packages('d', 'desktop', [{'batch': 'b'}], [{'col': 'machine'}], [{'page': i, 'data': big} for i in range(1, 5)])
    assert len(out) == 2 and all(learn.nbytes(p) <= learn.MAX_PKG and p['batches'] == [{'batch': 'b'}] for p in out)
    assert [x['page'] for p in out for x in p['photos']] == [1, 2, 3, 4]
    a, b = learn.halve(out[0])
    assert len(a['photos']) + len(b['photos']) == len(out[0]['photos']) and a['id'] != b['id']
    assert learn.halve({'items': [1], 'photos': []}) is None


# ---------------------------------------------------------------- 三条路的请求里真带着提醒；「不用标红」那格真不红
@pytest.mark.parametrize('path', ['gemini', 'dagj', 'claude'])
def test_hints_in_every_path_and_nored_keeps_the_cell_white(tmp_path, monkeypatch, path):
    R = Relay(monkeypatch)
    b = R.butler(tmp_path)
    L = learner(tmp_path, b)
    assert L.refresh() and L.ver() == 5 and R.lists == 1
    seen = []
    real = engine.call_api
    monkeypatch.setattr(engine, 'call_api', lambda model, key, body: (seen.append(body), real(model, key, body))[1])
    if path == 'gemini':
        b.ready = lambda: False
    else:
        b.read = lambda body, stop=None: answer(body, seen)
    a = None
    if path == 'claude':
        msgs = []

        def call(url, cid, body=None, timeout=20):
            if url.endswith('/ai/conf'):
                return 200, {'ok': True, 'key': True, 'conf': {'luru': {}}}, {}
            msgs.append(body)
            return 200, {'type': 'message', 'model': body['model'], 'stop_reason': 'end_turn',
                         'content': [{'type': 'text', 'text': json.dumps({'title_side': 'top', 'records': [REC]})}]}, {}
        a = claude.Claude(b, call=call)
    mock_server.STATE['modes'][K1] = 'ok'
    make_images(tmp_path / 'in', 1)
    eng = engine.Engine(str(tmp_path / 'in'), [K1], log=lambda m: None, butler=b, claude=a, learner=L, reads=2)
    if path == 'gemini':                               # 假谷歌回的是它那一套（SETTER 639/…）：换成这份
        monkeypatch.setattr(engine, 'call_api', lambda model, key, body: (seen.append(body), answer(body))[1])
    res = eng.run()
    assert res.ok == 1 and eng.by and list(eng.by.values())[0] == path
    if path == 'claude':
        assert len(msgs) == 2 and all(m['system'][0]['text'].endswith('\n\n' + BLOCK) for m in msgs)
    else:
        assert len(seen) == 2 and all(x['systemInstruction']['parts'][-1]['text'] == BLOCK for x in seen)
    rows = viewer.load_rows(res.xlsx)[1]
    assert engine.FIELDS.index('setter') not in rows[0]['red'], rows[0]     # 两遍都 9999，规则说不用红
    assert 'SETTER' not in rows[0]['note']
    meta = json.load(open(os.path.join(L.home, 'runs', eng.run_name, 'meta.json'), encoding='utf-8'))
    page = meta['pages']['1']
    assert page['by'] == learn.who(path) and page['reads'][0]['setter'] == ['9999', '9999']
    assert meta['cells'] == 13 and meta['list_ver'] == 5 and os.path.isfile(os.path.join(L.home, 'runs', eng.run_name, learn.PRISTINE))
    img = json.load(open(os.path.join(L.home, 'runs', eng.run_name, 'img', '001.json'), encoding='utf-8'))
    assert img['data'] and img['prompt'].startswith('你是工厂') and learn.HEAD not in img['prompt'] and img['schema'] == engine.SCHEMA


def _batch(tmp_path, monkeypatch, R, on=None, clock=None, n=2):
    b = R.butler(tmp_path)
    L = learner(tmp_path, b, on=on, clock=clock)
    L.list = LIST
    b.read = lambda body, stop=None: answer(body)
    make_images(tmp_path / 'in', n)
    eng = engine.Engine(str(tmp_path / 'in'), [K1], log=lambda m: None, butler=b, learner=L, reads=2)
    res = eng.run()
    return L, b, res, eng


# ---------------------------------------------------------------- 核对里改、点「对的」、点猜的；Excel 里改了存盘
def test_edit_ok_guess_and_excel_edits_land_in_the_package(tmp_path, monkeypatch):
    R = Relay(monkeypatch)
    t = [time.time()]
    L, b, res, eng = _batch(tmp_path, monkeypatch, R, clock=lambda: t[0])
    rows = viewer.load_rows(res.xlsx)
    M, S, T_ = (engine.FIELDS.index(f) for f in ('machine', 'shift', 't_no'))
    viewer.edit_cell(res.xlsx, rows[1][0]['row'], M, 'QM-07')
    L.touch(res.xlsx, 1, 0, 'machine', 'VM-07', 'QM-07', 'edit', '')
    viewer.edit_cell(res.xlsx, rows[1][0]['row'], S, None)
    L.touch(res.xlsx, 1, 0, 'shift', 'D', 'D', 'ok', '')
    viewer.edit_cell(res.xlsx, rows[2][0]['row'], T_, 'T9')
    L.touch(res.xlsx, 2, 0, 't_no', 'T4', 'T9', 'guess', '')
    wb = load_workbook(res.xlsx)                                    # 有人在 Excel 里改了第 2 张的零件号，存了盘
    wb.worksheets[0].cell(row=rows[2][0]['row'], column=2 + engine.FIELDS.index('part_number')).value = 'TD-2'
    wb.save(res.xlsx)
    old = time.time() - 120
    os.utime(res.xlsx, (old, old))
    assert L.scan() == 1
    assert L.pack(False) == 0                                       # 还没闲 10 分钟
    t[0] += learn.IDLE
    assert L.pack(False) == 1
    out = L.send()
    assert out['sent'] == 1 and not L.queued()
    p = R.got[0]
    assert (p['v'], p['kind'], p['device'], p['app']) == (1, 'learn', '录入僧电脑版 · 测试', 'desktop 1.13.10')
    assert p['batches'] == [{'batch': eng.run_name, 'cat': CAT, 'cells': 26, 'edited': 4, 'list_ver': 5,
                             'at': p['batches'][0]['at']}]
    acts = {i['col']: i['act'] for i in p['items']}
    assert acts == {'machine': 'edit', 'shift': 'ok', 't_no': 'guess', 'part_number': 'edit'}, acts
    m = next(i for i in p['items'] if i['col'] == 'machine')
    assert m['before'] == 'VM-07' and m['after'] == 'QM-07' and m['by'] == 'butler' and m['reads'] == ['VM-07', 'VM-07']
    assert (m['batch'], m['page'], m['row'], m['cat']) == (eng.run_name, 1, 1, CAT)
    pn = next(i for i in p['items'] if i['col'] == 'part_number')
    assert (pn['before'], pn['after'], pn['page']) == ('TD-1', 'TD-2', 2)
    assert sorted(x['page'] for x in p['photos']) == [1, 2]
    one = next(x for x in p['photos'] if x['page'] == 1)
    assert one['answer']['title_side'] == 'top' and one['answer']['records'][0]['machine'] == 'QM-07'
    assert list(one['answer']['records'][0]) == [*engine.FIELDS, 'unsure']
    assert L.pack(True) == 0                                        # 交过的不再打


def test_switch_off_nothing_recorded_or_sent(tmp_path, monkeypatch):
    R = Relay(monkeypatch)
    on = {'on': False}
    L, b, res, eng = _batch(tmp_path, monkeypatch, R, on=on)
    assert not os.path.isdir(os.path.join(L.home, 'runs'))          # 关着：认的时候什么都没留
    L.touch(res.xlsx, 1, 0, 'machine', 'VM-07', 'QM-07', 'edit', 'red')
    assert L.pack(True) == 0 and L.send()['sent'] == 0 and R.tries == 0
    on['on'] = True
    L.touch(res.xlsx, 1, 0, 'machine', 'VM-07', 'QM-07', 'edit', 'red')   # 这批开工时关着：没这批的底，记不上
    assert L.pack(True) == 0
    L.forget_all()
    assert not L.queued()


def test_unpaired_nothing_leaves(tmp_path, monkeypatch):
    R = Relay(monkeypatch)
    b = R.butler(tmp_path, paired=False)
    L = learner(tmp_path, b)
    assert not L.active() and not L.refresh() and L.block(CAT) == ''
    make_images(tmp_path / 'in', 1)
    eng = engine.Engine(str(tmp_path / 'in'), [K1], log=lambda m: None, butler=b, learner=L)
    res = eng.run()
    L.touch(res.xlsx, 1, 0, 'machine', 'a', 'b', 'edit', 'red')
    assert L.pack(True) == 0 and L.send()['sent'] == 0
    assert (R.tries, R.lists) == (0, 0) and not os.path.exists(L.home)


def test_butler_away_then_back_old_butler_and_too_big(tmp_path, monkeypatch):
    state = {'away': True}
    R = Relay(monkeypatch, mode=lambda n: ('away' if n == 1 else 'old') if state['away'] else ('big' if n == 3 else 'ok'))
    L, b, res, eng = _batch(tmp_path, monkeypatch, R)
    for no in (1, 2):
        L.touch(res.xlsx, no, 0, 'machine', 'VM-07', 'QM-07', 'edit', 'red')
    assert L.pack(True) == 1
    assert L.send()['why'] and len(L.queued()) == 1                 # 503：留着
    assert L.send()['why'] == 'forget' and b.paired and len(L.queued()) == 1   # 老大管家回 forget：留着，配对不丢
    state['away'] = False
    out = L.send()                                                  # 回来了：太大劈两包，接着交完
    assert out['sent'] == 2 and not L.queued()
    assert sorted(len(p['photos']) for p in R.got) == [1, 1]


def test_revoked_stops_and_keeps(tmp_path, monkeypatch):
    R = Relay(monkeypatch, mode=lambda n: 'revoked')
    L, b, res, eng = _batch(tmp_path, monkeypatch, R, n=1)
    L.touch(res.xlsx, 1, 0, 'machine', 'VM-07', 'QM-07', 'edit', 'red')
    L.pack(True)
    assert L.send()['why'] == 'gone' and not b.paired and len(L.queued()) == 1
    L.send()
    assert R.tries == 1


def test_queue_cap(tmp_path, monkeypatch):
    R = Relay(monkeypatch)
    L = learner(tmp_path, R.butler(tmp_path))
    for i in range(learn.MAX_QUEUE + 3):
        L._enqueue({'v': 1, 'id': str(i), 'items': [], 'photos': [], 'batches': []})
    L._cap()
    q = L.queued()
    assert len(q) == learn.MAX_QUEUE and json.load(open(q[0], encoding='utf-8'))['pkg']['id'] == '3'


def test_window_save_cell_tells_the_learner(tmp_path, monkeypatch):
    from test_viewer import _tk_root
    R = Relay(monkeypatch)
    L, b, res, eng = _batch(tmp_path, monkeypatch, R, n=1)
    root = _tk_root()
    got = []
    try:
        v = viewer.Viewer(root, str(tmp_path / 'in'), busy=lambda: '', on_touch=lambda *a: got.append(a))
        root.update()
        M = engine.FIELDS.index('machine')
        v.save_cell(0, M, 'QM-07')
        v.save_cell(0, engine.FIELDS.index('shift'), None)
        v.save_cell(0, engine.FIELDS.index('t_no'), 'T9', 'guess')
        v.destroy()
    finally:
        root.destroy()
    assert [(a[1], a[2], a[3], a[4], a[5], a[6]) for a in got] == [
        (1, 0, 'machine', 'VM-07', 'QM-07', 'edit'), (1, 0, 'shift', 'D', 'D', 'ok'), (1, 0, 't_no', 'T4', 'T9', 'guess')]
    assert os.path.normcase(got[0][0]) == os.path.normcase(res.xlsx)
