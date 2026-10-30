"""「选照片…」：挑的照片复制进待识别（原照片不动，Song 定的），已经有的、以前干过的不再复制；「放入样板资料」的叫法。"""
import json
import os
import shutil
import sys

import pytest
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from bangong import engine  # noqa: E402


def photo(path, w, color=(10, 20, 30), t=1_700_000_000):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    Image.new('RGB', (w, 300), color).save(path)
    os.utime(path, (t, t))
    return str(path)


def test_copy_in_keeps_originals_and_skips_repeats(tmp_path):
    src = tmp_path / '手机导出'
    a = photo(src / 'IMG_1.jpg', 801, t=1_700_000_100)
    b = photo(src / 'IMG_2.jpg', 802)
    same_as_a = tmp_path / '别处' / 'a 的副本.jpg'
    os.makedirs(same_as_a.parent)
    shutil.copy2(a, same_as_a)
    pdf = src / 'scan.pdf'
    pdf.write_bytes(b'%PDF')
    folder = tmp_path / '录入僧' / '待识别'                   # 还没有：当场建
    r = engine.copy_in([a, b, str(same_as_a), str(pdf)], str(folder))
    assert sorted(os.path.basename(p) for p in r.copied) == ['IMG_1.jpg', 'IMG_2.jpg']
    assert r.already == ['a 的副本.jpg'] and r.bad == [('scan.pdf', '不是照片')]
    assert os.path.exists(a) and os.path.exists(b)                          # 原照片原地不动
    assert int(os.path.getmtime(folder / 'IMG_1.jpg')) == 1_700_000_100     # 时间一起带过去，编号顺序不乱
    again = engine.copy_in([a], str(folder))                                # 再选一次同一张：不重复
    assert again.copied == [] and again.already == ['IMG_1.jpg']
    inside = engine.copy_in([str(folder / 'IMG_2.jpg')], str(folder))       # 本来就在待识别里的
    assert inside.copied == [] and inside.already == ['IMG_2.jpg']


def test_copy_in_skips_done_and_renames_clashes(tmp_path):
    folder = tmp_path / '待识别'
    done = photo(tmp_path / 'old' / '干过的.jpg', 900)
    os.makedirs(folder / engine.OUT_DIR)
    with open(folder / engine.OUT_DIR / engine.LEDGER, 'w', encoding='utf-8') as fh:
        json.dump({engine.file_hash(done): {'file': '原名.jpg', 'no': 3, 'xlsx': 'x.xlsx'}}, fh)
    photo(folder / 'IMG_1.jpg', 700)                                        # 待识别里已有同名、内容不一样的
    new = photo(tmp_path / 'new' / 'IMG_1.jpg', 701)
    r = engine.copy_in([done, new], str(folder))
    assert [n for n, _ in r.done] == ['干过的.jpg'] and r.done[0][1]['no'] == 3
    assert [os.path.basename(p) for p in r.copied] == ['IMG_1_1.jpg']      # 同名不覆盖
    assert Image.open(folder / 'IMG_1.jpg').size[0] == 700


def test_pick_button_copies_photos_and_feed_is_called_samples(tmp_path, monkeypatch):
    try:
        import tkinter as tk
        root = tk.Tk()
    except Exception:
        pytest.skip('没有显示器，跳过窗口测试')
    import time
    from bangong import app
    monkeypatch.setattr(app, 'app_dir', lambda: str(tmp_path / 'app'))
    monkeypatch.setattr(app, 'CONFIG', str(tmp_path / 'config.json'))
    picks = [photo(tmp_path / 'phone' / f'IMG_{i}.jpg', 800 + i) for i in range(3)]
    monkeypatch.setattr(app.filedialog, 'askopenfilenames', lambda **kw: tuple(picks))
    try:
        a = app.App(root)
        folder = tmp_path / '待识别'
        a.folder.set(str(folder))
        assert a.pick_btn.cget('text') == '选照片…' and a.feed_btn.cget('text') == '放入样板资料'
        a.pick()
        end = time.time() + 10
        while '待识别 3 张' not in a.status.get() and time.time() < end:
            root.update()
            time.sleep(0.05)
        assert a.status.get() == '待识别 3 张'
        assert sorted(os.listdir(folder)) == ['IMG_0.jpg', 'IMG_1.jpg', 'IMG_2.jpg']
        assert all(os.path.exists(p) for p in picks)                        # 原照片还在
        log = a.text.get('1.0', 'end')
        assert '复制了 3 张进「待识别」' in log and '点「开始工作」' in log
        assert a.cfg['pick_dir'] == str(tmp_path / 'phone')                 # 下次从同一个地方挑
        assert not (a.worker and a.worker.is_alive())                       # 复制完不自己开工（Song 定的）
        a.feed()
        root.update()
        assert a.dialog.title() == '放入样板资料' and '公司' not in a.dialog.desc.get()
        a.dialog.destroy()
    finally:
        root.destroy()


def test_empty_database_hint_does_not_say_company(tmp_path):
    from bangong.kb import KnowledgeBase
    s = KnowledgeBase(str(tmp_path / 'db.sqlite')).summary()
    assert '放入样板资料' in s and '公司' not in s
