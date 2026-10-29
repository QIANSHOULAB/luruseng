"""两遍对答案、格式整理、自动驾驶（来图就干 / 自己换新版）。"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bangong import autopilot, engine  # noqa: E402
import mock_server  # noqa: E402
from test_engine import K1, make_images, server, reset, sheet  # noqa: E402,F401

RED = 'FFC7CE'


def red_cols(ws, row=4):
    return {engine.FIELDS[c - 2] for c in range(2, 15) if (ws.cell(row=row, column=c).fill.fgColor.rgb or '').endswith(RED)}


def run2(folder, mode, n=1):
    make_images(folder, n)
    mock_server.STATE['modes'] = {K1: mode}
    logs = []
    res = engine.Engine(str(folder), [K1], log=logs.append, reads=2).run()
    return res, logs


# ---------------------------------------------------------------- 格式整理
def test_clean_record_formats_only():
    r = engine.clean_record({'date': '28/10', 'machine': 'vm - 12', 'part_number': 'TD-9155 513-2', 'mo': '8266 7003',
                             'opr_no': '130', 't_no': 'T9', 'description': 'T44. m3 tap x2', 'btmp': '',
                             'total_screened': '1', 'passed': '1', 'failed': '0', 'shift': '白', 'setter': '232 / Yang'})
    assert r['machine'] == 'VM-12' and r['part_number'] == 'TD-9155513-2' and r['mo'] == '82667003'
    assert r['t_no'] == 'T9, T44' and r['description'] == 'M3 TAP X2'
    assert r['shift'] == 'D' and r['setter'] == '232/Yang'
    r = engine.clean_record(dict(r, t_no='', description='T10. FACEMILL ø40 R0.8'))
    assert r['t_no'] == 'T10' and r['description'] == 'FACEMILL Φ40 R0.8'
    r = engine.clean_record(dict(r, t_no='T6.T7', description='Φ 4 FMM X2'))
    assert r['t_no'] == 'T6, T7' and r['description'] == 'Φ4 FMM X2'
    r = engine.clean_record(dict(r, t_no='', description='TAP M3'))          # TAP 不是刀号
    assert r['t_no'] == '' and r['description'] == 'TAP M3'
    assert engine.clean_record(dict(r, shift='夜班'))['shift'] == 'N'
    assert engine.clean_record(dict(r, shift='Night'))['shift'] == 'N'


def test_vote_majority_and_disputes():
    a = [{'shift': 'D', 'date': '28/10', 'machine': 'VM-1', 'unsure': []}]
    b = [{'shift': 'N', 'date': '28-10-26', 'machine': 'vm-1', 'unsure': ['shift']}]
    out = engine.vote([a, b, a])
    assert out[0]['shift'] == 'D' and out[0]['disputed'] == {'shift': ['D', 'N']}       # 日期写法不同、大小写不同不算不一样
    assert out[0]['unsure'] == ['shift']
    out = engine.vote([[{'machine': 'A'}], [{'machine': 'B'}], [{'machine': 'C'}]])
    assert out[0]['machine'] == 'A' and out[0]['disputed']['machine'] == ['A', 'B', 'C']   # 三遍都不一样：用第一遍，标红
    out = engine.vote([[{'machine': 'A'}], [], [{'machine': 'A'}]])
    assert len(out) == 1 and out[0]['counts'] == [1, 0, 1] and not out[0]['disputed']
    assert engine.records_agree([{'shift': 'Day'}], [{'shift': 'D'}])
    assert not engine.records_agree([{'shift': 'D'}], [])


# ---------------------------------------------------------------- 两遍对答案（假谷歌）
def test_two_reads_agree_no_third(tmp_path):
    res, logs = run2(tmp_path, 'ok', 3)
    assert res.ok == 3 and res.requests == 6                     # 一张两遍，对得上就不认第三遍
    ws = sheet(res.xlsx)
    assert red_cols(ws) == set() and ws.cell(row=4, column=15).value is None
    assert any('每张认两遍对答案' in m and f'v{engine.VERSION}' in m for m in logs)


def test_disagreement_gets_third_read_and_red(tmp_path):
    res, _ = run2(tmp_path, 'flip')
    assert res.requests == 3
    ws = sheet(res.xlsx)
    assert ws.cell(row=4, column=13).value == 'D'                 # 三遍里两遍是 D
    assert red_cols(ws) == {'shift'}
    assert 'SHIFT 几遍认得不一样：D / N' in ws.cell(row=4, column=15).value


def test_no_majority_uses_first_and_flags(tmp_path):
    res, _ = run2(tmp_path, 'chaos')
    ws = sheet(res.xlsx)
    assert ws.cell(row=4, column=3).value == 'VM-01' and 'machine' in red_cols(ws)


def test_messy_formats_cleaned(tmp_path):
    res, _ = run2(tmp_path, 'messy')
    ws = sheet(res.xlsx)
    row = [ws.cell(row=4, column=c).value for c in range(2, 15)]
    assert row[2] == 'TD-524613-5' and row[5] == 'T9, T44' and row[6] == 'M3 Φ6 TAP X2' and row[11] == 'D'
    assert red_cols(ws) == set()


def test_one_read_returns_nothing(tmp_path):
    res, _ = run2(tmp_path, 'sometimes_none')
    assert res.requests == 3 and res.records == 1                # 第 2 遍没认出东西：第三遍裁判，按多数还是 1 条
    assert '条数不一样' in sheet(res.xlsx).cell(row=4, column=15).value


# ---------------------------------------------------------------- 自动驾驶
class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def test_watcher_waits_until_photos_settle(tmp_path):
    c = Clock()
    w = autopilot.Watcher(stable=30, clock=c)
    assert not w.poll({})
    make_images(tmp_path, 2)
    snap = autopilot.image_snapshot(str(tmp_path))
    assert len(snap) == 2
    assert not w.poll(snap)                         # 刚看见，等它放完
    c.t += 10
    make_images(tmp_path, 1, start=5)               # 还在往里放
    snap = autopilot.image_snapshot(str(tmp_path))
    assert not w.poll(snap)
    c.t += 20
    assert not w.poll(snap)
    c.t += 15
    assert w.poll(snap)                             # 30 秒没再变：开工
    w.started(snap)
    c.t += 100
    assert not w.poll(snap)                         # 失败留在原地的照片不会反复重试
    make_images(tmp_path, 1, start=9)
    snap2 = autopilot.image_snapshot(str(tmp_path))
    assert not w.poll(snap2)
    c.t += 31
    assert w.poll(snap2)                            # 有新照片进来才再开工


def test_file_settle(tmp_path):
    c = Clock()
    s = autopilot.FileSettle(stable=20, clock=c)
    p = tmp_path / 'x.exe'
    assert not s.ready(str(p))
    p.write_bytes(b'12')
    assert not s.ready(str(p))
    c.t += 25
    assert s.ready(str(p))


def test_install_update_and_retire(tmp_path, monkeypatch):
    monkeypatch.setenv('BANGONG_NO_LAUNCH', '1')
    new = tmp_path / autopilot.UPDATE_NAME
    old = tmp_path / '录入僧.exe'
    new.write_bytes(b'NEW' * 1000)
    old.write_bytes(b'OLD')
    autopilot.install_update(str(new), str(old))
    assert old.read_bytes() == new.read_bytes() and autopilot.same_file(str(new), str(old))
    assert f'换上 v{engine.VERSION}' in (tmp_path / autopilot.UPDATE_LOG).read_text(encoding='utf-8-sig')
    dst = autopilot.retire_update_file(str(tmp_path), wait=1)
    assert dst and not new.exists() and os.path.exists(dst)


def test_status_and_show_request(tmp_path):
    autopilot.write_status(str(tmp_path), running=False, last_run={'ok': 3})
    st = json.load(open(tmp_path / autopilot.STATUS_NAME, encoding='utf-8'))
    assert st['version'] == engine.VERSION and st['last_run'] == {'ok': 3} and 'key1' not in json.dumps(st)
    assert not autopilot.take_show_request(str(tmp_path))
    autopilot.ask_running_to_show(str(tmp_path))
    assert autopilot.take_show_request(str(tmp_path)) and not autopilot.take_show_request(str(tmp_path))
