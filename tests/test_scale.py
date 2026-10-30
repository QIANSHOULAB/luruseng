"""屏幕放大 125%/150% 时字和图要清楚：程序自己按真实像素画，所有尺寸照放大倍数 S 放大，样子跟 100% 一样。

LURUSENG_SCALE=1.5 假装在放大 150% 的屏幕上。测完把 S 拨回 1，别的测试照旧。
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from bangong import engine, macui as ui, updater  # noqa: E402


def make_app(tmp_path, monkeypatch, scale):
    try:
        import tkinter as tk
        root = tk.Tk()
    except Exception:
        pytest.skip('没有显示器，跳过窗口测试')
    from bangong import app
    if scale is None:
        monkeypatch.delenv('LURUSENG_SCALE', raising=False)
    else:
        monkeypatch.setenv('LURUSENG_SCALE', str(scale))
    monkeypatch.setattr(app, 'app_dir', lambda: str(tmp_path / 'app'))
    monkeypatch.setattr(app, 'CONFIG', str(tmp_path / 'config.json'))
    return root, app, app.App(root)


def pills(frame):
    return [w for w in frame.winfo_children() if isinstance(w, ui.Pill)]


def first_pad(info, key):
    return int(str(info[key]).strip('()').replace(',', ' ').split()[0])


def test_everything_grows_with_the_screen(tmp_path, monkeypatch):
    root, app, a = make_app(tmp_path, monkeypatch, 1.5)
    try:
        root.update()
        assert ui.S == 1.5 and ui.px(14) == 21
        assert abs(float(root.tk.call('tk', 'scaling')) - 2.0) < 0.01      # 字号是「点」：跟着放大 1.5 倍
        assert a.start_btn.h == 66 and int(a.start_btn.cget('height')) == 66
        # 照 100% 设计的窗口（1120 宽）放大 1.5 倍以后，底下一排六个按钮还是整排放得下
        bar = a.start_btn.master
        room = ui.px(1120) - 2 * ui.px(9) - ui.px(300) - ui.px(4) - 2 * (ui.px(ui.LIFT[1]) + ui.px(18))
        assert len(pills(bar)) == 6 and bar.winfo_reqwidth() <= room, (bar.winfo_reqwidth(), room)
        sw, sh = root.winfo_screenwidth(), root.winfo_screenheight()
        assert root.minsize() == (min(ui.px(1040), sw - ui.px(40)), min(ui.px(600), sh - ui.px(90)))
        logcard = a.text.master.master                         # pack/grid 的边距也跟着放大：4 → 6
        assert isinstance(logcard, ui.Card) and first_pad(logcard.grid_info(), 'pady') == 6
        a.open_settings()
        root.update()
        card = a.settings_win.card
        assert int(card.cget('width')) == ui.px(730)
        switches = [s for row in card.body.winfo_children() for s in row.winfo_children() if isinstance(s, ui.Switch)]
        assert switches and all((s.W, s.H) == (60, 36) for s in switches)
    finally:
        root.destroy()
        ui.S = 1.0


def test_at_100_percent_nothing_moves_and_settings_foot(tmp_path, monkeypatch):
    root, app, a = make_app(tmp_path, monkeypatch, None)
    try:
        root.update()
        assert ui.S == 1.0 and ui.px(14) == 14 and a.start_btn.h == 44
        assert root.title() == engine.TITLE == '入我千手院，凡事尽释手；千僧替牛马，施主自风流。'
        a.open_settings()
        root.update()
        foot = [w for w in a.settings_win.card.body.winfo_children() if pills(w)][0]
        order = [p.cget('text') for p in reversed(foot.pack_slaves()) if isinstance(p, ui.Pill)]   # 都靠右排
        assert order == ['千手院总舵', '方丈邮箱', '检查新版', '完成']
        info = [lab.cget('text') for f in foot.winfo_children() if not isinstance(f, ui.Pill)
                for lab in f.winfo_children()]
        assert info == [f'{engine.APP_NAME} v{engine.VERSION}', '千手院方丈释手']
        opened = []
        monkeypatch.setattr(app, 'open_path', opened.append)
        [p for p in pills(foot) if p.cget('text') == '千手院总舵'][0].command()
        assert opened == [updater.HUB_URL] == ['https://qianshoulab.github.io/']
    finally:
        root.destroy()
