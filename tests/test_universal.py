"""通用版：⚙ 开关的默认值、老用户照旧、exe 放哪数据在哪、自动更新、不留原图。"""
import functools
import http.server
import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bangong import autopilot, engine, settings, updater  # noqa: E402
import mock_server  # noqa: E402
from test_engine import K1, make_images, server, reset  # noqa: E402,F401


# ---------------------------------------------------------------- 开关
def test_new_computer_gets_polite_defaults():
    cfg = settings.upgrade({}, existed=False)
    assert cfg['settings_ver'] == settings.SETTINGS_VER
    assert cfg['auto'] is False and cfg['startup'] is False and cfg['hide_on_close'] is False
    assert cfg['auto_update'] is False                       # 别人的电脑：有新版只提醒，点了才换
    assert cfg['auto_open'] and cfg['keep_originals'] and cfg['remember_keys'] and cfg['shortcuts']


def test_old_computer_keeps_everything_on():
    old = {'folder': r'F:\songchengmin\录入僧\待识别', 'key1': 'AIzaX', 'auto': True, 'model': 'm'}
    cfg = settings.upgrade(dict(old), existed=True)
    assert all(cfg[k] is True for k in settings.NEW if k != 'auto_update'), cfg
    assert cfg['auto_update'] is False                       # 没存过新设置的老电脑都是别人的
    assert {k: cfg[k] for k in old} == old                      # 原来的值一个不动
    again = settings.upgrade(dict(cfg), existed=True)
    assert again == cfg


def test_old_computer_that_had_turned_auto_off_stays_off():
    cfg = settings.upgrade({'folder': 'x', 'auto': False}, existed=True)
    assert cfg['auto'] is False and cfg['startup'] is True


def test_settings_rows_cover_every_switch():
    keys = [k for k, _, _ in settings.ROWS]
    assert sorted(keys) == sorted(k for k in settings.NEW if k != 'auto')   # 来图就干在主窗口上


# ---------------------------------------------------------------- 文件位置跟着 exe 走
def test_bin_dir_prefers_the_one_next_door(tmp_path):
    app = tmp_path / '录入僧'
    app.mkdir()
    assert autopilot.bin_dir(str(app)) == str(app / '待删除')     # 别人：程序文件夹里自己建
    (tmp_path / '待删除').mkdir()
    assert autopilot.bin_dir(str(app)) == str(tmp_path / '待删除')  # Song：上一级已经有「待删除」


def test_home_plan(tmp_path):
    ver = {}

    def version_of(p):
        return ver.get(os.path.basename(os.path.dirname(p)) + '/' + os.path.basename(p), '')

    dl = tmp_path / '下载'
    dl.mkdir()
    me = dl / 'luruseng.exe'
    me.write_bytes(b'x')
    home_exe = dl / '录入僧' / '录入僧.exe'
    # 在「下载」里双击：搬进旁边新建的「录入僧」文件夹
    assert autopilot.home_plan(str(me), version_of) == ('copy', str(home_exe))
    # 家里已经有一样新的：直接开家里那个，不覆盖
    home_exe.parent.mkdir()
    home_exe.write_bytes(b'y')
    ver['录入僧/录入僧.exe'] = engine.VERSION
    assert autopilot.home_plan(str(me), version_of) == ('open', str(home_exe))
    # 家里的是旧版：抄过去覆盖（升级）
    ver['录入僧/录入僧.exe'] = '0.1.0'
    assert autopilot.home_plan(str(me), version_of) == ('copy', str(home_exe))
    # 已经在家：什么都不做（Song 的 F:\songchengmin\录入僧\录入僧.exe 就是这种）
    assert autopilot.home_plan(str(home_exe), version_of) == ('', '')
    # 在「录入僧」文件夹里但名字不对：在原地正名
    odd = home_exe.parent / 'luruseng.exe'
    odd.write_bytes(b'z')
    ver['录入僧/录入僧.exe'] = '0.1.0'
    assert autopilot.home_plan(str(odd), version_of) == ('copy', str(home_exe))
    # 更新包不归这里管
    assert autopilot.home_plan(str(home_exe.parent / autopilot.UPDATE_NAME), version_of) == ('', '')


def test_home_plan_never_leaves_data_behind(tmp_path):
    """已经在用的文件夹（有数据库、名单、待识别……），哪怕不叫「录入僧」也是家：只在原地正名，不搬走。"""
    d = tmp_path / '刀具记录'
    d.mkdir()
    me = d / 'luruseng.exe'
    me.write_bytes(b'x')
    assert autopilot.home_plan(str(me), lambda p: '') == ('copy', str(d / '录入僧' / '录入僧.exe'))
    (d / '数据库.sqlite').write_bytes(b'db')
    assert autopilot.home_plan(str(me), lambda p: '') == ('copy', str(d / '录入僧.exe'))
    (d / '录入僧.exe').write_bytes(b'y')
    assert autopilot.home_plan(str(d / '录入僧.exe'), lambda p: '') == ('', '')


def test_downloaded_name_counts_as_stray(tmp_path):
    (tmp_path / '录入僧.exe').write_bytes(b'y')
    (tmp_path / 'luruseng.exe').write_bytes(b'x')
    (tmp_path / '别的.exe').write_bytes(b'w')
    strays = autopilot.stray_exes(str(tmp_path), autopilot.canonical_exe(str(tmp_path)))
    assert [os.path.basename(p) for p in strays] == ['luruseng.exe']


def test_versions():
    assert autopilot.vtuple('1.8.0') == (1, 8, 0) and autopilot.vtuple('v1.10') == (1, 10)
    assert autopilot.vtuple('') == () and autopilot.vtuple('<html>') == ()
    assert updater.is_newer('1.10.0', '1.9.9') and not updater.is_newer('1.8.0', '1.8.0')
    assert not updater.is_newer('', '1.0.0') and not updater.is_newer('abc', '1.0.0')


# ---------------------------------------------------------------- 自动更新
@pytest.fixture()
def site(tmp_path, monkeypatch):
    root = tmp_path / '网站'
    root.mkdir()
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(root))
    handler.log_message = lambda *a: None
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    monkeypatch.setattr(updater, 'LATEST', f'http://127.0.0.1:{srv.server_address[1]}')
    yield root
    srv.shutdown()


def test_update_downloads_newer_version(tmp_path, site):
    big = os.urandom(updater.MIN_SIZE + 1234)
    (site / 'luruseng.exe').write_bytes(big)
    (site / 'version.txt').write_text('99.0.0', encoding='utf-8')
    app = tmp_path / '录入僧'
    app.mkdir()
    said = []
    assert updater.check(str(app), log=said.append) == '99.0.0'
    got = app / autopilot.UPDATE_NAME
    assert got.read_bytes() == big and not list(app.glob('*.part'))
    assert any('下载好了' in m for m in said)
    assert '下载好新版 v99.0.0' in (app / autopilot.UPDATE_LOG).read_text(encoding='utf-8-sig')
    assert updater.check(str(app)) == '99.0.0'                 # 已经下好了：不重下
    assert updater.check(str(app), skip='99.0.0') == ''        # 换失败过的版本：这次别再下


def test_update_nothing_when_latest(tmp_path, site):
    (site / 'version.txt').write_text(engine.VERSION, encoding='utf-8')
    assert updater.check(str(tmp_path)) == ''
    assert not (tmp_path / autopilot.UPDATE_NAME).exists()


def test_update_refuses_a_tiny_file(tmp_path, site):
    (site / 'luruseng.exe').write_bytes(b'<html>not an exe</html>')
    (site / 'version.txt').write_text('99.0.0', encoding='utf-8')
    with pytest.raises(IOError):
        updater.check(str(tmp_path))
    assert not (tmp_path / autopilot.UPDATE_NAME).exists() and not list(tmp_path.glob('*.part'))


def test_update_rejects_garbage_version(tmp_path, site):
    (site / 'version.txt').write_text('<!doctype html>', encoding='utf-8')
    with pytest.raises(ValueError):
        updater.check(str(tmp_path))


# ---------------------------------------------------------------- 不留原图
def test_originals_tossed_when_switched_off(tmp_path):
    make_images(tmp_path, 3)
    mock_server.STATE['delay'] = 0
    tossed = []

    def discard(p):
        tossed.append(os.path.basename(p))
        os.remove(p)                      # 测试里代替回收站
        return True

    res = engine.Engine(str(tmp_path), [K1], log=lambda m: None, keep_originals=False, discard=discard).run()
    assert res.ok == 3 and sorted(tossed) == ['img_00.jpg', 'img_01.jpg', 'img_02.jpg']
    run = os.path.join(str(tmp_path), engine.DONE_DIR, os.listdir(os.path.join(str(tmp_path), engine.DONE_DIR))[0])
    assert sorted(f for f in os.listdir(run) if f.endswith('.jpg')) == ['01.jpg', '02.jpg', '03.jpg']
    assert not os.path.isdir(os.path.join(run, engine.ORIG_DIR))


def test_originals_kept_when_recycle_bin_fails(tmp_path):
    make_images(tmp_path, 2)
    mock_server.STATE['delay'] = 0
    res = engine.Engine(str(tmp_path), [K1], log=lambda m: None, keep_originals=False, discard=lambda p: False).run()
    assert res.ok == 2
    run = os.path.join(str(tmp_path), engine.DONE_DIR, os.listdir(os.path.join(str(tmp_path), engine.DONE_DIR))[0])
    assert len(os.listdir(os.path.join(run, engine.ORIG_DIR))) == 2      # 扔不掉就照旧留着


def test_recycle_is_a_no_op_off_windows(tmp_path):
    p = tmp_path / 'a.jpg'
    p.write_bytes(b'x')
    if os.name != 'nt':
        assert engine.recycle(str(p)) is False and p.exists()
    else:                                 # Windows：真扔进回收站
        assert engine.recycle(str(p)) is True and not p.exists()


def test_song_pc_keeps_auto_update():
    """Song 的电脑 v1.8 起就存成「自动更新开着」（settings_ver=1），升级不动它。"""
    saved = {'folder': 'x', 'settings_ver': 1, 'auto_update': True, 'startup': True}
    assert settings.upgrade(dict(saved), existed=True)['auto_update'] is True


def test_release_notes_since():
    text = """# 说明

## 1.9.1
- 新的一条
- 第二条

## 1.9.0
- 类别

## 1.8.0
- 设置
"""
    assert updater.notes_since(text, '1.9.0') == 'v1.9.1\n- 新的一条\n- 第二条'
    assert updater.notes_since(text, '1.8.0').startswith('v1.9.1') and 'v1.9.0\n- 类别' in updater.notes_since(text, '1.8.0')
    assert updater.notes_since(text, '1.9.1') == '' and updater.notes_since('', '1.0.0') == ''


def test_notes_from_site(tmp_path, site):
    (site / 'changes.md').write_text('## 99.0.0\n- 大更新\n## 1.0.0\n- 老的\n', encoding='utf-8')
    assert updater.notes() == 'v99.0.0\n- 大更新'
    (site / 'changes.md').unlink()
    assert updater.notes() == ''                              # 拿不到说明不耽误更新
