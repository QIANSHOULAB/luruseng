import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bangong import engine, viewer  # noqa: E402
import mock_server  # noqa: E402
from test_engine import K1, make_images, server, reset  # noqa: E402,F401


def make_run(tmp_path, n=4, once=None, modes=None):
    make_images(tmp_path, n)
    mock_server.STATE['delay'] = 0
    if once:
        mock_server.STATE['once'] = once
    if modes:
        mock_server.STATE['modes'] = modes
    res = engine.Engine(str(tmp_path), [K1], log=lambda m: None).run()
    return res


def test_runs_photos_and_rows(tmp_path):
    res = make_run(tmp_path, 4, modes={K1: 'mismatch'})
    runs = viewer.list_runs(str(tmp_path))
    assert len(runs) == 1
    run_id, d, xlsx = runs[0]
    assert d == res.photos_dir and xlsx == res.xlsx
    photos = viewer.load_photos(d)
    assert sorted(photos) == [1, 2, 3, 4] and photos[1].endswith('01.jpg')
    rows = viewer.load_rows(xlsx)
    assert sorted(rows) == [1, 2, 3, 4]
    r = rows[1][0]
    assert r['values'][1] == 'VM-07' and r['values'][0] == '28-Oct' and r['values'][12] == '639/Lee Ah Kow'
    assert r['red'] == {8, 9, 10}                        # TOTAL / PASSED / FAILED 标红
    assert 'PASSED 9 + FAILED 0 ≠ TOTAL 10' in r['note']
    assert viewer.run_label(run_id, 4).endswith('这批（4 张）')


def test_newest_run_first(tmp_path):
    make_run(tmp_path, 2)
    import time
    time.sleep(1.1)
    make_images(tmp_path, 1, start=60)
    engine.Engine(str(tmp_path), [K1], log=lambda m: None).run()
    runs = viewer.list_runs(str(tmp_path))
    assert len(runs) == 2 and runs[0][0] > runs[1][0]
    assert sorted(viewer.load_photos(runs[0][1])) == [1]


def _tk_root():
    try:
        import tkinter as tk
        root = tk.Tk()
        root.withdraw()
        return root
    except Exception:
        pytest.skip('没有显示器，跳过窗口测试')


def test_window_flip_and_jump(tmp_path):
    make_run(tmp_path, 4, once={K1: ('two', 1)})
    root = _tk_root()
    try:
        v = viewer.Viewer(root, str(tmp_path))
        root.update()
        assert v.cur == 1 and v.title() == '核对 · 第 1 张 / 共 4 张'
        v.step(1)
        assert v.cur == 2
        v.step(-5)
        assert v.cur == 1                                   # 到头了就停在 1
        v.num.set('4')
        v.jump()
        assert v.cur == 4 and v.num.get() == '4'
        v.step(1)
        assert v.cur == 4                                   # 到尾了就停在最后一张
        v.num.set('9')
        v.jump()
        assert v.cur == 4 and '没有第 9 张' in v.info.get()
        text = v.panel.get('1.0', 'end')
        assert 'No. 4' in text and 'SETTER' in text
        two = [n for n, recs in v.rows.items() if len(recs) == 2]
        v.show(two[0])
        assert '第 2 条' in v.panel.get('1.0', 'end')
        root.update()
        assert v._tk is not None                            # 照片真的画出来了
        v.destroy()
    finally:
        root.destroy()


def test_window_without_runs(tmp_path):
    root = _tk_root()
    try:
        v = viewer.Viewer(root, str(tmp_path))
        root.update()
        assert v.title() == '核对' and not v.runs
        v.destroy()
    finally:
        root.destroy()
