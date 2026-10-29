import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bangong import engine  # noqa: E402
import mock_server  # noqa: E402
from test_engine import K1, make_images, server, reset  # noqa: E402,F401


def test_names():
    assert engine.APP_NAME == '录入僧' and engine.SUBTITLE == '施主去玩，贫僧填表'


def test_old_home_moves_over(tmp_path):
    from bangong import app
    old, new = tmp_path / '搬工', tmp_path / '录入僧'
    (old / '投喂').mkdir(parents=True)
    (old / '待识别' / '已识别').mkdir(parents=True)
    (old / '名单.txt').write_text('639/Lee Ah Kow\n', encoding='utf-8')
    (old / '投喂' / '表.xlsx').write_bytes(b'x')
    (old / '待识别' / 'a.jpg').write_bytes(b'y')
    (old / '待识别' / '把图片放这里.txt').write_text('old', encoding='utf-8')
    (new / '待识别').mkdir(parents=True)
    (new / '待识别' / '把图片放这里.txt').write_text('new', encoding='utf-8')
    lines = app.migrate_old_home(str(new))
    assert (new / '名单.txt').read_text(encoding='utf-8').startswith('639/')
    assert (new / '投喂' / '表.xlsx').exists() and (new / '待识别' / 'a.jpg').exists()
    assert (new / '待识别' / '已识别').is_dir()
    assert (new / '待识别' / '把图片放这里.txt').read_text(encoding='utf-8') == 'new'
    assert not old.exists() and (tmp_path / '待删除' / '搬工').is_dir()
    assert any('旧文件夹挪到' in x for x in lines)
    assert app.migrate_old_home(str(new)) == []          # 第二次什么都不做


def test_old_ledger_still_counts(tmp_path):
    make_images(tmp_path, 2)
    mock_server.STATE['delay'] = 0
    engine.Engine(str(tmp_path), [K1], log=lambda m: None).run()
    out = tmp_path / engine.OUT_DIR
    os.replace(out / engine.LEDGER, out / engine.OLD_LEDGER)      # 装成改名前干过的
    make_images(tmp_path, 2)                                      # 同样的照片又丢进来
    res = engine.Engine(str(tmp_path), [K1], log=lambda m: None).run()
    assert res.ok == 0 and res.requests == 0 and (out / engine.LEDGER).exists() and not (out / engine.OLD_LEDGER).exists()
    assert (out / '录入僧日志.txt').exists()
