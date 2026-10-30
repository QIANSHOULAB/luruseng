"""⚙ 设置里的开关：默认值，以及老用户的设置怎么接上。

只出一个版本给所有人用。分辨「老用户」靠的是这台电脑上有没有用过录入僧留下的设置：
有（比如 Song 自己的电脑）→ 所有开关照以前的样子全开，什么都不变；
没有（新装的电脑）→ 用下面这套对新人客气的默认值。
"""
from __future__ import annotations

SETTINGS_VER = 1

# (键, 标题, 说明)；顺序就是设置卡片里的顺序
ROWS = [
    ('startup', '开机自动启动', '电脑一开，贫僧就在任务栏里蹲着，「来图就干」不用你再请'),
    ('hide_on_close', '点 × 只收起', '开着「来图就干」时，点 × 只是让我躲进任务栏，眼睛照样盯着文件夹'),
    ('auto_open', '干完自动打开', '你亲手点的「开始工作」，干完把表格和核对窗口一起甩到你面前'),
    ('keep_originals', '保留原图', '原片留在「已识别 › 批次 › 原图」。关了就扔回收站，硬盘省一半，后悔了还能去回收站捡'),
    ('auto_update', '自动更新', '开着：有新版我自己下，趁你歇着换上。关着：只来报个信、说说更新了啥，你点头才换'),
    ('remember_keys', '记住钥匙', '钥匙记在这台电脑上，下次不用再填。公用电脑就关了吧，钥匙跟牙刷一样，别借人'),
    ('shortcuts', '桌面和开始菜单图标', '在桌面和开始菜单给贫僧留个座'),
]

NEW = {                     # 新装的电脑
    'auto': False,          # 来图就干：先手动点「开始工作」用熟了再开
    'startup': False,
    'hide_on_close': False,
    'auto_open': True,
    'keep_originals': True,
    'auto_update': False,   # 别人的电脑：有新版只提醒，点了才换（Song 定的：他自己的全自动，别人的让他自己开）
    'remember_keys': True,
    'shortcuts': True,
}

OLD = {k: True for k in NEW}  # 用过的电脑：以前就是这样，全开……
OLD['auto_update'] = False    # ……除了自动更新：没在 v1.8 存过设置的老电脑都是别人的（Song 的早就存成开着了）


def upgrade(cfg: dict, existed: bool) -> dict:
    """补齐开关。existed = 这台电脑之前有设置文件（老用户）。原来就有的值一律不动。"""
    if cfg.get('settings_ver') != SETTINGS_VER:
        for k, v in (OLD if existed else NEW).items():
            cfg.setdefault(k, v)
        cfg['settings_ver'] = SETTINGS_VER
    for k, v in NEW.items():          # 以后再加的新开关
        cfg.setdefault(k, v)
    return cfg
