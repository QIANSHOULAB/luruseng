"""⚙ 设置里的开关：默认值，以及老用户的设置怎么接上。

只出一个版本给所有人用。分辨「老用户」靠的是这台电脑上有没有用过录入僧留下的设置：
有（比如 Song 自己的电脑）→ 所有开关照以前的样子全开，什么都不变；
没有（新装的电脑）→ 用下面这套对新人客气的默认值。
"""
from __future__ import annotations

SETTINGS_VER = 1

# (键, 标题, 说明)；顺序就是设置卡片里的顺序
ROWS = [
    ('startup', '开机自动启动', '开机后在后台挂着（收在任务栏），「来图就干」不用等你打开'),
    ('hide_on_close', '点 × 只收起', '开着「来图就干」时，点 × 收进任务栏，后台照样盯着文件夹'),
    ('auto_open', '干完自动打开', '手动点「开始工作」干完后，自动打开核对窗口，点格子就能改'),
    ('keep_originals', '保留原图', '原片留在「已识别 › 批次 › 原图」；关掉就扔进回收站，省一半硬盘'),
    ('auto_update', '自动更新', '开着：有新版自己下载、空闲时换上。关着：只提醒你有新版、更新了啥，你点了才换'),
    ('remember_keys', '记住钥匙', '钥匙存在这台电脑上，下次不用再填；公用电脑建议关掉'),
    ('shortcuts', '桌面和开始菜单图标', '在桌面和开始菜单放「录入僧」的图标'),
    ('report', '发数据给方丈', '每批认完，照片、认的过程、你改过的格子都送去方丈网盘，方丈闭关对答案，下回少认错几个字'),
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
    'report': False,        # 发数据给方丈：谁的电脑都默认关，Song 装到同事电脑上时自己打开
}

OLD = {k: True for k in NEW}  # 用过的电脑：以前就是这样，全开……
OLD['auto_update'] = False    # ……除了自动更新：没在 v1.8 存过设置的老电脑都是别人的（Song 的早就存成开着了）
OLD['report'] = False         # ……和发数据：往外送东西，必须是人自己打开的


def upgrade(cfg: dict, existed: bool) -> dict:
    """补齐开关。existed = 这台电脑之前有设置文件（老用户）。原来就有的值一律不动。"""
    if cfg.get('settings_ver') != SETTINGS_VER:
        for k, v in (OLD if existed else NEW).items():
            cfg.setdefault(k, v)
        cfg['settings_ver'] = SETTINGS_VER
    for k, v in NEW.items():          # 以后再加的新开关
        cfg.setdefault(k, v)
    return cfg
