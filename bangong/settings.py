"""⚙ 设置里的开关：默认值，以及老用户的设置怎么接上。

只出一个版本给所有人用。分辨「老用户」靠的是这台电脑上有没有用过录入僧留下的设置：
有（比如 Song 自己的电脑）→ 所有开关照以前的样子全开，什么都不变；
没有（新装的电脑）→ 用下面这套对新人客气的默认值。
"""
from __future__ import annotations

SETTINGS_VER = 1

# (键, 标题的字, 说明的字)；字在 strings.py（row.<键>、row.<键>.d），顺序就是设置卡片里的顺序
ROWS = [(k, f'row.{k}', f'row.{k}.d') for k in
        ('startup', 'hide_on_close', 'auto_open', 'keep_originals', 'auto_update', 'remember_keys', 'shortcuts', 'redo', 'report')]

NEW = {                     # 新装的电脑
    'auto': False,          # 来图就干：先手动点「开始工作」用熟了再开
    'startup': False,
    'hide_on_close': False,
    'auto_open': True,
    'keep_originals': True,
    'auto_update': False,   # 别人的电脑：有新版只提醒，点了才换（Song 定的：他自己的全自动，别人的让他自己开）
    'remember_keys': True,
    'shortcuts': True,
    'redo': False,          # 干过的照片也重干：测试用（Song 2026-11-02 要的），谁的电脑都默认关
    'report': False,        # 发数据给方丈：谁的电脑都默认关，Song 装到同事电脑上时自己打开
}

OLD = {k: True for k in NEW}  # 用过的电脑：以前就是这样，全开……
OLD['auto_update'] = False    # ……除了自动更新：没在 v1.8 存过设置的老电脑都是别人的（Song 的早就存成开着了）
OLD['report'] = False         # ……和发数据：往外送东西，必须是人自己打开的
OLD['redo'] = False           # ……和重干：测试用，平时干过的照旧跳过


def upgrade(cfg: dict, existed: bool) -> dict:
    """补齐开关。existed = 这台电脑之前有设置文件（老用户）。原来就有的值一律不动。
    语言（lang）：新装的英文；老电脑没选过的照旧中文（Song 的、同事的电脑升级后不突然变英文）。"""
    if cfg.get('lang') not in ('en', 'zh'):
        cfg['lang'] = 'zh' if existed else 'en'
    if cfg.get('settings_ver') != SETTINGS_VER:
        for k, v in (OLD if existed else NEW).items():
            cfg.setdefault(k, v)
        cfg['settings_ver'] = SETTINGS_VER
    for k, v in NEW.items():          # 以后再加的新开关
        cfg.setdefault(k, v)
    return cfg
