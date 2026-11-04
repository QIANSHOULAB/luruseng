"""中英两套（v1.11.3）：字全在 strings.py，两套键一样、占位一样；新装默认英文、老电脑照旧中文；
⚙ 里换语言存进设置、照新语言重开；英文界面按钮不被撑破。别的测试都钉在中文（conftest.py）。"""
import os
import re
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from bangong import macui as ui, settings, strings  # noqa: E402

CJK = re.compile(r'[一-鿿]')
# 英文里允许出现的中文：硬盘上真有的文件夹名（换语言不改名，老电脑上的数据都在里面）、语言开关上的「中文」
FOLDERS = ('录入僧', '待识别', '已识别', '原图')


def texts(v):
    return list(v) if isinstance(v, tuple) else [v]


def test_both_languages_have_every_line_with_the_same_slots():
    for key, pair in strings.S.items():
        assert len(pair) == 2 and all(pair), key
        zh, en = pair
        slots = lambda s: set(re.findall(r'\{(\w+)\}', s))    # noqa: E731
        want = set().union(*(slots(s) for s in texts(zh)))
        got = set().union(*(slots(s) for s in texts(en)))
        assert want == got, (key, want, got)
        for s in texts(en):
            left = s
            for f in FOLDERS:
                left = left.replace(f, '')
            assert not CJK.search(left), (key, s)            # 英文里没漏中文
            assert 'Please' not in s and 'kindly' not in s.lower() and 'successfully' not in s.lower(), (key, s)


def test_buttons_are_short_in_english():
    """按钮照直写：英文 1–3 个词。"""
    for key in ('app.start', 'app.stop', 'app.latest', 'app.all', 'app.check', 'app.feed', 'app.pick', 'app.getKey',
                'app.getKey2', 'app.names', 'set.done', 'set.check', 'set.mail', 'new.ok', 'cancel', 'save',
                'res.open', 'res.check', 'feed.go', 'upd.btnNow', 'upd.btnAlways', 'upd.btnLater', 'view.save',
                'view.right', 'view.open', 'view.prev', 'view.next'):
        words = strings.Tl('en', key).replace('…', '').replace('◀', '').replace('▶', '').split()
        assert 1 <= len(words) <= 3, (key, words)


def test_new_computer_english_old_computer_keeps_chinese():
    assert settings.upgrade({}, existed=False)['lang'] == 'en'
    assert settings.upgrade({'folder': 'x', 'key1': 'k'}, existed=True)['lang'] == 'zh'
    assert settings.upgrade({'lang': 'en', 'folder': 'x'}, existed=True)['lang'] == 'en'    # 选过的不动


def test_lookup_plural_and_fallback():
    assert strings.Tl('en', 'st.queue', n=1) == '1 photo queued'
    assert strings.Tl('en', 'st.queue', n=3) == '3 photos queued'
    assert strings.Tl('zh', 'st.queue', n=3) == '待识别 3 张'
    assert strings.Tl('en', 'title').startswith('QIANSHOU LAB')
    assert strings.Tl('zh', 'sub') == '施主去玩，贫僧填表'                          # 定稿副标题照旧
    assert strings.Tl('zh', 'upd.title', v='1.9.2') == '录入僧 v1.9.2 搞出来了'      # 定稿卡片照旧
    assert strings.Tl('en', 'no.such.key') == 'no.such.key'


@pytest.fixture
def english(monkeypatch):
    monkeypatch.setenv('BANGONG_LANG', 'en')
    strings.init()
    yield
    monkeypatch.setenv('BANGONG_LANG', 'zh')
    strings.init()


def make_app(tmp_path, monkeypatch, scale=None):
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
    root._scaling0 = root.tk.call('tk', 'scaling')
    return root, app, app.App(root)


def close(root):
    try:
        root.tk.call('tk', 'scaling', root._scaling0)
        root.destroy()
    except Exception:
        pass
    ui.S = 1.0


def test_english_window_buttons_fit_at_150_percent(tmp_path, monkeypatch, english):
    root, app, a = make_app(tmp_path, monkeypatch, 1.5)
    try:
        root.update()
        assert root.title() == strings.Tl('en', 'title')
        bar = a.start_btn.master
        names = [p.cget('text') for p in bar.winfo_children() if isinstance(p, ui.Pill)]
        assert names == ['Start', 'Stop', 'Latest', 'All results', 'Review', 'Add samples']
        room = ui.px(1120) - 2 * ui.px(9) - ui.px(300) - ui.px(4) - 2 * (ui.px(ui.LIFT[1]) + ui.px(18))
        assert bar.winfo_reqwidth() <= room, (bar.winfo_reqwidth(), room)       # 一排放得下，不挤、不折
        assert [b.cget('text') for b in a.key_btns] == ['Get a key', 'Get another']
        assert a.cat_combo.box.get() == 'Tool breakage' and a.category.get() == '刀单'   # 显示英文，存的还是刀单
        a.refresh_count()
        assert a.status.get() == '0 photos queued'
    finally:
        close(root)


def test_english_rows_fit_at_100_percent(tmp_path, monkeypatch, english):
    """窗口照设计的 1120 宽：左边大卡片每一排（类别、来图就干的说明）、⚙ 每一排（语言、落款四个按钮）都放得下。"""
    root, app, a = make_app(tmp_path, monkeypatch)
    try:
        root.update()
        g = a.start_btn.master.master                 # 照设计的 1120 宽算（CI 的屏幕可能比这窄，窗口跟着窄，不算数）
        room = ui.px(1120) - 2 * ui.px(9) - ui.px(300) - ui.px(4) - 2 * (ui.px(ui.LIFT[1]) + ui.px(18))
        for row in g.winfo_children():
            assert row.winfo_reqwidth() <= room, (row, row.winfo_reqwidth(), room)
        a.open_settings()
        root.update()
        body = a.settings_win.card.body
        labels = [w.cget('text') for f in body.winfo_children() for w in f.winfo_children() if isinstance(w, ui.Pill)]
        assert 'English' in labels and '中文' in labels and 'Check for updates' in labels
        for row in body.winfo_children():                                   # 按钮不被挤扁、字不被切
            assert row.winfo_reqwidth() <= body.winfo_width(), (row, row.winfo_reqwidth(), body.winfo_width())
    finally:
        close(root)


def test_switching_language_saves_and_reopens(tmp_path, monkeypatch):
    monkeypatch.delenv('BANGONG_LANG', raising=False)
    strings.init()
    root, app, a = make_app(tmp_path, monkeypatch)
    try:
        assert strings.lang() == 'en' and a.cfg['lang'] == 'en'           # 新装：英文
        a.open_settings()
        root.update()
        a.settings_win.pick_lang('zh')
        assert a.relaunch is True and app.load_config()['lang'] == 'zh' and strings.lang() == 'zh'
        import tkinter as tk
        root2 = tk.Tk()
        root2._scaling0 = root2.tk.call('tk', 'scaling')
        b = app.App(root2, relaunched=True)                              # run_gui 接着照新语言开一个
        try:
            root2.update()
            assert b.start_btn.cget('text') == '开始工作' and root2.title() == strings.Tl('zh', 'title')
        finally:
            close(root2)
    finally:
        close(root)
        monkeypatch.setenv('BANGONG_LANG', 'zh')
        strings.init()
