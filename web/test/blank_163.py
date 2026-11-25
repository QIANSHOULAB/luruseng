"""163 手机「拍照」传成白纸：诊断页、传图页的画法、白纸不发不认（iPhone 尺寸，Chromium / Edge）。

查：
1. 传图页 #diag：「拍照」那种 File（方向 6、像素没转、4032×3024、很花）几种画法都不白、都转正；纯白的几种都标「白」。
2. 传图页真用的 squeeze()：大照片画一次、压到 1.8MB 以内、不白、转正；纯白、几乎纯白的拿不出图（不发）。
3. 压完的图交给电脑（一张拍四份开着）：四张一拍切成 4 张；白纸弹提示条、不进列表、不查重。
4. 有真照片就一起过（LURU_MAT=文件夹;文件夹，只在本机用）：每张都不许判成白纸，切出来的张数对得上 148 报告。

跑：python web/test/blank_163.py [截图放哪]
要：playwright（chromium）、Pillow；本机只装了 Edge 就设 E2E_CHANNEL=msedge
"""
import base64
import functools
import http.server
import io
import os
import random
import sys
import tempfile
import threading

from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SHOTS = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix='luruseng-163-')
os.makedirs(SHOTS, exist_ok=True)
WORK = tempfile.mkdtemp(prefix='luruseng-163-work-')
errors = []

# 真照片该切几张（148 报告、161 素材）；名字里带这几个字的才比张数
CUTS = {'四联_A': 4, '四联_B': 4, '二联_C': 2, '三联_D': 3, '三联_F': 3, '单张_': 1, '四张': 4}


def sheets(size, spots, seed=1):
    """深色花垫子上摆几张画出来的单子（很花：压到 q0.86 也大）"""
    W, H = size
    rnd = random.Random(seed)
    im = Image.effect_noise(size, 60).convert('RGB')
    im = Image.blend(im, Image.new('RGB', size, (70, 58, 48)), 0.55)
    d0 = ImageDraw.Draw(im)
    for _ in range(1500):                              # 垫子上的白点
        x, y = rnd.randrange(W), rnd.randrange(H)
        d0.ellipse([x, y, x + 9, y + 9], fill=(230, 230, 225))
    k = 0.40 if len(spots) > 1 else 0.75
    pw, ph = int(W * k), int(H * k)
    for n, (fx, fy) in enumerate(spots):
        s = Image.new('RGB', (pw, ph), (246, 246, 242))
        d = ImageDraw.Draw(s)
        d.rectangle([pw * .08, ph * .07, pw * (.30 + .05 * n), ph * .18], fill=(40, 40, 50))
        for r in range(9):
            y = int(ph * (.28 + r * .075))
            d.line([(pw * .07, y), (pw * .93, y)], fill=(70, 70, 70), width=4)
            for c in range(5):
                x = int(pw * (.09 + c * .17))
                d.rectangle([x, y - ph * .045, x + pw * (.05 + .02 * ((r + c + n) % 3)), y - ph * .018], fill=(40, 40, 50))
        im.paste(s, (int(W * fx - pw / 2), int(H * fy - ph / 2)))
    return im


def save(im, name, orient=None, q=92):
    p = os.path.join(WORK, name)
    kw = {'quality': q}
    if orient:
        ex = Image.Exif()
        ex[0x0112] = orient
        kw['exif'] = ex.tobytes()
    im.save(p, **kw)
    return p


def camera_like():
    """「拍照」那种：竖着拿手机拍，像素是横的 4032×3024、EXIF 方向 6；摆正了是竖的 3024×4032"""
    upright = sheets((3024, 4032), [(.27, .27), (.73, .27), (.27, .73), (.73, .73)], seed=6)
    return save(upright.transpose(Image.Transpose.ROTATE_90), 'image.jpg', orient=6)   # 逆时针转回去存，方向 6 再顺时针转正


def album_like():
    """相册导出那种：已经转好、方向 1"""
    return save(sheets((3024, 4032), [(.27, .27), (.73, .27), (.27, .73), (.73, .73)], seed=7), 'IMG_0001.jpg', orient=1)


def blank(name, noise=0):
    im = Image.new('RGB', (4032, 3024), (255, 255, 255))
    if noise:
        im = Image.blend(im, Image.effect_noise((4032, 3024), 40).convert('RGB'), noise)
    return save(im, name, orient=6)


def serve(root):
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass
    Quiet.extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript',
                            '.webmanifest': 'application/manifest+json'}
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=root))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


SQUEEZE = '''async ([b64, name, type]) => {
  const I = await import('./image.js');
  const bin = atob(b64), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  const r = await I.squeeze(new File([u], name, { type }), 2560, 1800000);
  let out = null, w = 0, h = 0;
  if (r.blob) {
    const b = await createImageBitmap(r.blob); w = b.width; h = b.height; b.close();
    out = await I.b64(r.blob);
  }
  return { way: r.way, tried: r.tried, flat: r.flat, w, h, size: r.blob ? r.blob.size : 0, out, info: r.info };
}'''


def main():
    site = serve(ROOT)
    base = f'http://127.0.0.1:{site.server_address[1]}/web/'
    cam, album = camera_like(), album_like()
    white, almost = blank('white.jpg'), blank('almost.jpg', noise=0.012)
    mats = []
    for d in filter(None, os.environ.get('LURU_MAT', '').split(os.pathsep)):
        mats += [os.path.join(d, f) for f in sorted(os.listdir(d)) if f.lower().endswith(('.jpg', '.jpeg', '.png'))]

    with sync_playwright() as pw:
        channel = os.environ.get('E2E_CHANNEL')
        browser = pw.chromium.launch(**({'channel': channel} if channel else {}))

        def phone():
            m = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True,
                                    has_touch=True, locale='zh-CN')
            m.add_init_script("try { localStorage.setItem('luruseng.lang', 'zh') } catch (e) {}")
            return m

        def page(m, url, name):
            p = m.new_page()
            p.on('pageerror', lambda e: errors.append(f'{name} pageerror: {e}'))
            p.on('console', lambda msg: errors.append(f'{name} console.error: {msg.text}')
                 if msg.type == 'error' and 'Failed to load resource' not in msg.text else None)
            p.route('https://**', lambda route, req: route.abort())
            p.goto(url)
            return p

        def diag_page_tells_white_from_photo():
            m = phone()
            try:
                p = page(m, base + 'send.html#diag', 'diag')
                p.wait_for_selector('#diag', state='visible')
                assert not p.is_visible('#paired') and not p.is_visible('#nopair')
                for f, want in ((cam, '不白'), (white, '白')):
                    p.set_input_files('#dfile', f)
                    p.wait_for_function('() => document.querySelectorAll(".drow").length === 5 && '
                                        '![...document.querySelectorAll(".dv")].some(v => v.textContent === "…")', timeout=90000)
                    got = p.eval_on_selector_all('.drow', 'rs => rs.map(r => [r.querySelector("b").textContent, '
                                                 'r.querySelector(".dv").textContent, r.querySelector(".dnum").textContent])')
                    info = p.eval_on_selector_all('.dinfo', 'ds => ds.map(d => d.textContent)')
                    print('    ', os.path.basename(f), info[1])
                    for g in got:
                        print('      ', *g)
                    assert all(g[1] == want for g in got), got
                    if want == '不白':
                        assert 'EXIF 方向 6' in info[1] and '4032×3024' in info[1], info
                        assert all(g[2].startswith('1920×2560') for g in got[1:]), got      # 转正了：竖的
                        p.screenshot(path=os.path.join(SHOTS, '163-诊断-拍照那种.png'), full_page=True)
                    else:
                        p.screenshot(path=os.path.join(SHOTS, '163-诊断-白纸.png'), full_page=True)
                p.goto(base + 'send.html')                                  # 没 #diag：连点标题 5 下也进得去
                p.wait_for_selector('#nopair', state='visible')
                for _ in range(5):
                    p.click('#h1')
                p.wait_for_selector('#diag', state='visible')
            finally:
                m.close()

        def squeeze_draws_once_and_never_white():
            m = phone()
            outs = {}
            try:
                p = page(m, base + 'send.html#diag', 'squeeze')
                p.wait_for_selector('#diag', state='visible')

                def run(path, mime='image/jpeg'):
                    b64 = base64.b64encode(open(path, 'rb').read()).decode()
                    return p.evaluate(SQUEEZE, [b64, os.path.basename(path), mime])

                for name, path in (('拍照那种', cam), ('相册那种', album)):
                    r = run(path)
                    print(f'     {name}: {r["way"]} {r["w"]}×{r["h"]} {r["size"]/1e6:.2f}MB 平整度 {r["flat"]} 试过 {r["tried"]}')
                    assert r['out'] and r['flat'] >= 1.5 and (r['w'], r['h']) == (1920, 2560) and r['size'] <= 1_800_000, r
                    outs[name] = r['out']
                form = Image.new('RGB', (3024, 4032), (250, 250, 248))      # 白纸黑线：只印了表格细线的空单子，不许当白纸
                dr = ImageDraw.Draw(form)
                for y in range(300, 3900, 110):
                    dr.line([(150, y), (2870, y)], fill=(60, 60, 60), width=3)
                for x in (150, 900, 1700, 2870):
                    dr.line([(x, 300), (x, 3820)], fill=(60, 60, 60), width=3)
                r = run(save(form, 'form.jpg'))
                print(f'     白纸黑线：{r["way"]} 平整度 {r["flat"]}')
                assert r['out'] and r['flat'] >= 1.5, r
                for name, path in (('纯白', white), ('几乎纯白', almost)):
                    r = run(path)
                    print(f'     {name}: 不发 · 试过 {r["tried"]}')
                    assert r['out'] is None and len(r['tried']) >= 4, r
                for path in mats:
                    r = run(path, 'image/png' if path.lower().endswith('.png') else 'image/jpeg')
                    nm = os.path.basename(path)
                    print(f'     真照片 {nm}: {r["way"]} {r["w"]}×{r["h"]} {r["size"]/1e6:.2f}MB 平整度 {r["flat"]}')
                    assert r['out'] and r['flat'] >= 1.5, (nm, r['tried'])
                    outs[nm] = r['out']
            finally:
                m.close()
            return outs

        def pc_cuts_what_the_phone_made_and_refuses_white(outs):
            m = phone()
            try:
                p = page(m, base, 'pc')
                p.wait_for_function('() => document.querySelector("#log p")', timeout=60000)
                if not p.is_checked('#quad'):
                    p.click('label:has(#quad)')
                assert p.is_checked('#quad')

                def count():
                    t = p.inner_text('#droptxt')
                    return int(t.split(' 张')[0]) if ' 张' in t and t.split(' 张')[0].isdigit() else 0

                have = 0
                for i, (nm, b64) in enumerate(outs.items()):
                    want = next((n for k, n in CUTS.items() if k in nm), 4)
                    f = os.path.join(WORK, f'sent_{i}.jpg')
                    open(f, 'wb').write(base64.b64decode(b64))
                    p.set_input_files('#files', f)
                    p.wait_for_function('n => { const t = document.querySelector("#droptxt").textContent; return t.startsWith(n + " 张") }',
                                        arg=str(have + want), timeout=60000)
                    have += want
                    print(f'     {nm}: 切成 {want} 张')
                p.eval_on_selector('#quadbox', 'e => e.scrollIntoView({block: "center"})')
                p.screenshot(path=os.path.join(SHOTS, '163-电脑切手机传来的.png'))
                for f in (white, almost):                                     # 白纸：提示条、不进列表
                    p.set_input_files('#files', f)
                    p.wait_for_function('() => !document.querySelector("#why").hidden && '
                                        'document.querySelector("#whytxt").textContent.includes("白纸")', timeout=30000)
                    p.wait_for_function('n => [...document.querySelectorAll("#log p")].filter(x => x.textContent.includes("是白纸")).length >= n',
                                        arg=1 if f == white else 2, timeout=30000)
                    assert count() == have, (count(), have)
                p.wait_for_timeout(700)
                p.screenshot(path=os.path.join(SHOTS, '163-电脑白纸提示.png'))
                print('     白纸：', p.inner_text('#whytxt'))
            finally:
                m.close()

        diag_page_tells_white_from_photo()
        print('  ✓ diag_page_tells_white_from_photo', flush=True)
        outs = squeeze_draws_once_and_never_white()
        print('  ✓ squeeze_draws_once_and_never_white', flush=True)
        pc_cuts_what_the_phone_made_and_refuses_white(outs)
        print('  ✓ pc_cuts_what_the_phone_made_and_refuses_white', flush=True)
        browser.close()
    assert not errors, '\n'.join(errors)
    print(f'全过 · 截图在 {SHOTS}')


if __name__ == '__main__':
    main()
