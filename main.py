"""录入僧入口。双击 = 窗口；--cli 文件夹 = 无窗口跑一轮（给大管家/计划任务用；按窗口里选的类别认，
BANGONG_CATEGORY 环境变量可以指定别的类别）。"""
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
    from bangong import tables
    from bangong.app import app_dir, feed_dir, kb_path, names_path
    cat = os.environ.get('BANGONG_CATEGORY') or cfg.get('category') or tables.BUILTIN
    if cat != tables.BUILTIN and cat in tables.names(app_dir()):     # 窗口里选的是自建类别：按它认
        spec = tables.TableSpec(cat, tables.db_path(app_dir(), cat), tables.feed_path(app_dir(), cat))
        res = engine.Engine(folder, keys, model, log=log, spec=spec,
                            keep_originals=cfg.get('keep_originals', True)).run()
    else:
        res = engine.Engine(folder, keys, model, log=log, names_path=names_path(), kb_path=kb_path(),
                            feed_dir=feed_dir(), keep_originals=cfg.get('keep_originals', True)).run()
    return 0 if not res.failed and not res.stopped_reason else 2


if __name__ == '__main__':
    a = sys.argv[1:]
    if a and a[0] == '--write-version':            # 换新版前试一下新 exe 能不能打开：把版本号写进文件
        with open(a[1], 'w', encoding='utf-8') as fh:
            fh.write(engine.VERSION)
        sys.exit(0)
    if a and a[0] == '--install-update':           # 录入僧.new.exe --install-update 旧exe路径：把自己抄过去再开
        from bangong.autopilot import install_update
        try:
            install_update(sys.executable, a[1])
        except Exception as e:
            try:
                from bangong.autopilot import log_update
                log_update(os.path.dirname(a[1]), f'换新版失败：{type(e).__name__}：{e}')
            except Exception:
                pass
            sys.exit(1)
        sys.exit(0)
    if a and a[0] == '--version':
        if sys.stdout:
            print(engine.VERSION)
        sys.exit(0)
    if a and a[0] == '--shortcuts':
        from bangong.app import ensure_shortcuts, load_config
        cfg = load_config()
        ensure_shortcuts(cfg)
        sys.exit(0 if cfg.get('shortcut_for') else 1)
    if a and a[0] == '--check-update':             # 查一次新版，有就下载成 录入僧.new.exe（测试 / 大管家用）
        from bangong import updater
        try:
            v = updater.check(a[1] if len(a) > 1 else os.path.dirname(sys.executable))
        except Exception as e:
            if sys.stdout:
                print(f'✗ {type(e).__name__}：{e}', flush=True)
            sys.exit(1)
        if sys.stdout:
            print(v or '已经是最新版', flush=True)
        sys.exit(0)
    if a and a[0] == '--feed':                     # 录入僧.exe --feed 表1.xlsx 表2.xlsx（给大管家/计划任务用）
        from bangong.app import kb_path
        from bangong.kb import KnowledgeBase
        kb = KnowledgeBase(kb_path())
        lines = [kb.feed(p).line() for p in a[1:]] + [kb.summary()]
        if sys.stdout:
            print('\n'.join(lines), flush=True)
        sys.exit(0 if a[1:] and not any(x.startswith('✗') for x in lines) else 1)
    if a and a[0] == '--cli':
        from bangong.app import default_folder, load_config
        sys.exit(cli(a[1] if len(a) > 1 else (load_config().get('folder') or default_folder())))
    from bangong.app import run_gui
    run_gui()
