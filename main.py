"""搬工入口。双击 = 窗口；--cli 文件夹 = 无窗口跑一轮（给大管家/计划任务用）。"""
import os
import sys

from bangong import engine


def cli(folder: str) -> int:
    from bangong.app import load_config
    cfg = load_config()
    keys = [os.environ.get('BANGONG_KEY1') or cfg.get('key1', ''), os.environ.get('BANGONG_KEY2') or cfg.get('key2', '')]
    model = os.environ.get('BANGONG_MODEL') or cfg.get('model') or engine.DEFAULT_MODEL

    def log(m):
        if sys.stdout:
            try:
                print(m, flush=True)
            except Exception:
                pass
    from bangong.app import names_path
    res = engine.Engine(folder, keys, model, log=log, names_path=names_path()).run()
    return 0 if not res.failed and not res.stopped_reason else 2


if __name__ == '__main__':
    a = sys.argv[1:]
    if a and a[0] == '--version':
        if sys.stdout:
            print(engine.VERSION)
        sys.exit(0)
    if a and a[0] == '--shortcuts':
        from bangong.app import ensure_shortcuts, load_config
        cfg = load_config()
        ensure_shortcuts(cfg)
        sys.exit(0 if cfg.get('shortcut_for') else 1)
    if a and a[0] == '--cli':
        from bangong.app import default_folder, load_config
        sys.exit(cli(a[1] if len(a) > 1 else (load_config().get('folder') or default_folder())))
    from bangong.app import run_gui
    run_gui()
