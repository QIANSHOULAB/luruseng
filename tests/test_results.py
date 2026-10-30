"""不用去文件夹里翻：最新结果直接开、所有结果列出来点着开、核对里开这批的表、名单在窗口里改（Song 定的 1A、2 最新和所有两个选项）。"""
import os
import sys
import time

import pytest
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from bangong import engine, viewer  # noqa: E402


def fake_runs(folder):
    """三批：老的刀单（2 张编号照片）、质检单（Excel 开着时另存的 _181502）、最新的刀单；外加 Excel 的锁文件。"""
    od = os.path.join(folder, engine.OUT_DIR)
    os.makedirs(od, exist_ok=True)
    names = ['识别结果_20261029_090000.xlsx', '识别结果_20261030_100000_质检单_181502.xlsx',
             '识别结果_20261030_171733.xlsx', '~$识别结果_20261030_171733.xlsx', '录入僧日志.txt']
    for n in names:
        open(os.path.join(od, n), 'wb').close()
    d = os.path.join(folder, engine.DONE_DIR, '20261029_090000')
    os.makedirs(d)
    for i in (1, 2):
        Image.new('RGB', (40, 30), 'white').save(os.path.join(d, f'0{i}.jpg'))
    return od


def test_list_results_newest_first_with_category(tmp_path):
    od = fake_runs(str(tmp_path))
    runs = viewer.list_results(str(tmp_path))
    assert [r['run'] for r in runs] == ['20261030_171733', '20261030_100000', '20261029_090000']
    assert [r['cat'] for r in runs] == ['刀单', '质检单', '刀单']
    assert [r['photos'] for r in runs] == [0, 0, 2]
    assert runs[0]['xlsx'] == os.path.join(od, '识别结果_20261030_171733.xlsx')
    assert viewer.list_results(str(tmp_path / '没有这个文件夹')) == []


def test_names_file_saved_by_notepad_in_gbk(tmp_path):
    p = tmp_path / '名单.txt'
    p.write_bytes('# 夜班\r\n639/Lee Ah Kow\r\n232 张三\r\n'.encode('gbk'))
    assert engine.load_names(str(p)) == [('639', 'Lee Ah Kow'), ('232', '张三')]


def test_window_names_latest_all_and_this_batch(tmp_path, monkeypatch):
    try:
        import tkinter as tk
        root = tk.Tk()
    except Exception:
        pytest.skip('没有显示器，跳过窗口测试')
    from bangong import app
    home = tmp_path / 'app'
    monkeypatch.setattr(app, 'app_dir', lambda: str(home))
    monkeypatch.setattr(app, 'CONFIG', str(tmp_path / 'config.json'))
    opened = []
    monkeypatch.setattr(app, 'open_path', opened.append)
    monkeypatch.setattr(viewer, '_open', opened.append)
    folder = tmp_path / '待识别'
    od = fake_runs(str(folder))
    try:
        a = app.App(root)
        a.folder.set(str(folder))
        root.update()
        # 名单：在窗口里写，存成 名单.txt（带 BOM、Windows 换行），右边马上变
        assert a.names_head.get() == '没有名单' and a.names_btn.winfo_manager() == 'pack'
        a.edit_names()
        card = a.dialog
        card.box.set('639/Lee Ah Kow\n# 注释\n232/Tan Mei Ling\n')
        card.ok()
        raw = (home / '名单.txt').read_bytes()
        assert raw.startswith(b'\xef\xbb\xbf') and b'\r\n' in raw
        assert a.names_head.get() == '名单：2 人' and '名单存好了：2 人' in a.text.get('1.0', 'end')
        a.edit_names()
        assert '232/Tan Mei Ling' in a.dialog.box.get()                      # 再打开：上次写的都在
        a.dialog.destroy()
        # 最新结果：直接开最新那本
        a.open_latest()
        assert opened[-1] == os.path.join(od, '识别结果_20261030_171733.xlsx')
        # 所有结果：每批一行，点「打开表」开那批
        a.open_all()
        root.update()
        rc = a.dialog
        assert isinstance(rc, app.ResultsCard) and len(rc.runs) == 3
        assert [r['cat'] for r in rc.runs] == ['刀单', '质检单', '刀单']
        rc.destroy()
        # 核对里：看到哪批开哪批的表
        a.check(os.path.join(str(folder), engine.DONE_DIR, '20261029_090000'))
        root.update()
        a.viewer.open_table()
        assert opened[-1] == os.path.join(od, '识别结果_20261029_090000.xlsx')
        a.viewer.destroy()
        # 自建类别：没有名单这回事
        a.category.set('质检单')
        os.makedirs(home / '类别' / '质检单', exist_ok=True)
        a.refresh_category()
        assert a.names_btn.winfo_manager() == ''
    finally:
        root.destroy()


def test_no_results_yet_says_what_to_do(tmp_path, monkeypatch):
    try:
        import tkinter as tk
        root = tk.Tk()
    except Exception:
        pytest.skip('没有显示器，跳过窗口测试')
    from bangong import app
    monkeypatch.setattr(app, 'app_dir', lambda: str(tmp_path / 'app'))
    monkeypatch.setattr(app, 'CONFIG', str(tmp_path / 'config.json'))
    opened = []
    monkeypatch.setattr(app, 'open_path', opened.append)
    try:
        a = app.App(root)
        a.folder.set(str(tmp_path / '空的'))
        a.open_latest()
        assert not opened and '还没有结果' in a.text.get('1.0', 'end')
        a.open_all()
        root.update()
        assert a.dialog.runs == []
        time.sleep(0.05)
    finally:
        root.destroy()
