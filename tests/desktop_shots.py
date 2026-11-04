"""电脑版截图（中英两套 × 空着、干完、核对、⚙）：Xvfb 里开窗口、假谷歌认 3 张，截下来放 docs/shots-bi/。
跑：xvfb-run -a python tests/desktop_shots.py [放哪]（不是测试，pytest 不收）"""
import os
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
sys.path.insert(0, HERE)
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'docs', 'shots-bi')

import tkinter as tk  # noqa: E402

from PIL import Image, ImageDraw, ImageFont, ImageGrab  # noqa: E402

import mock_server  # noqa: E402
from bangong import engine, strings  # noqa: E402


def forms(folder, n):
    os.makedirs(folder, exist_ok=True)
    try:
        big = ImageFont.truetype('DejaVuSans-Bold.ttf', 40)
        small = ImageFont.truetype('DejaVuSans.ttf', 30)
    except OSError:
        big = small = ImageFont.load_default()
    for i in range(n):
        im = Image.new('RGB', (1000 + i, 720), 'white')
        d = ImageDraw.Draw(im)
        d.text((60, 50), 'TOOL REQUEST FORM', fill='#222', font=big)
        for k, t in enumerate(['M/C No.   VM-07', 'Part Number   TD-524613-5', f'MO Number   {82664581 + i}',
                               'Opr No.   150', 'Tool   T4  EM2.5', 'Setter   639']):
            d.text((60, 150 + k * 80), t, fill='#333', font=small)
        p = os.path.join(folder, f'form_{i + 1}.jpg')
        im.save(p, quality=90)
        os.utime(p, (1_700_000_000 + i, 1_700_000_000 + i))


def grab(win, name):
    win.update()
    time.sleep(0.4)
    win.update()
    x, y, w, h = win.winfo_rootx(), win.winfo_rooty(), win.winfo_width(), win.winfo_height()
    ImageGrab.grab(bbox=(x, y, x + w, y + h), xdisplay=os.environ.get('DISPLAY')).save(os.path.join(OUT, name))
    print('  ', name)


def run(lang):
    os.environ['BANGONG_LANG'] = lang
    strings.init()
    from bangong import app
    work = tempfile.mkdtemp(prefix=f'luruseng-shots-{lang}-')
    app.app_dir = lambda: os.path.join(work, 'app')
    app.CONFIG = os.path.join(work, 'config.json')
    app.open_path = lambda p: None
    root = tk.Tk()
    a = app.App(root)
    root.geometry('1120x700+0+0')
    a.folder.set(os.path.join(work, '待识别'))
    a.refresh_count()
    grab(root, f'pc-empty-{lang}.png')
    if lang == 'en':                                    # 介绍页英文版那张大图：路径写成 Windows 上的样子
        keep = a.folder.get()
        a.folder.set('D:\\录入僧\\待识别')
        a.key1.set('AIzaSyDemoKeyForTheScreenshot')
        a.status.set(strings.T('st.queue', n=12))
        a.text.config(state='normal')
        a.text.delete('1.0', 'end')
        a.text.config(state='disabled')
        a.write(strings.T('log.autoOn'))
        grab(root, 'pc-hero-en.png')
        a.folder.set(keep)
        a.key1.set('')
    forms(os.path.join(work, '待识别'), 3)
    a.key1.set('AIzaKEY_shots')
    mock_server.STATE['once'] = {'AIzaKEY_shots': ('unsure', 3)}       # 头几回说拿不准：核对里有红格子
    a.start()
    for _ in range(600):
        root.update()
        time.sleep(0.05)
        if a.worker and not a.worker.is_alive() and a.viewer is not None:
            break
    for _ in range(20):
        root.update()
        time.sleep(0.05)
    v = a.viewer
    v.geometry('1100x720+10+10')
    grab(v, f'pc-review-{lang}.png')
    v.destroy()
    grab(root, f'pc-done-{lang}.png')
    a.open_settings()
    root.update()
    a.settings_win.geometry('+40+20')
    grab(a.settings_win, f'pc-settings-{lang}.png')
    root.destroy()


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    srv = mock_server.start()
    engine.API_BASE = f'http://127.0.0.1:{srv.server_address[1]}/v1beta'
    mock_server.STATE['delay'] = 0.05
    for lang in ('en', 'zh'):
        run(lang)
    srv.shutdown()
