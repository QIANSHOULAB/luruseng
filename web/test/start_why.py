"""146 点开始干不了：原因贴在开始按钮上面、下一步的按钮就在旁边；155「一张拍四份」默认开着（iPhone 尺寸，假谷歌 + 假中转站）。

跑：python web/test/start_why.py [截图放哪]
要：playwright（chromium）、Pillow、cryptography；本机只装了 Edge 就设 E2E_CHANNEL=msedge
"""
import functools
import http.server
import json
import os
import re
import sys
import tempfile
import threading
import urllib.error
import urllib.request

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, 'tests'))
from bangong import dagj  # noqa: E402  (只借 b64u)
import mock_server  # noqa: E402

KEY = 'AIzaKEY1_mock'
SHOTS = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix='luruseng-why-')
os.makedirs(SHOTS, exist_ok=True)
WORK = tempfile.mkdtemp(prefix='luruseng-why-work-')
CORS = {'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type, x-goog-api-key'}
errors = []


# 169：钥匙、来图就干搬进了 ⚙ 设置；任务状态看面板（#state 待命 / 在干活 / 干完了 / 出问题了，#nok 认完、#nbad 失败）
DONE_JS = ('([ok, bad]) => ["干完了", "出问题了"].includes(document.querySelector("#state").textContent)'
           ' && !document.querySelector("#start").disabled'
           ' && document.querySelector("#nok").textContent === String(ok) && document.querySelector("#nbad").textContent === String(bad)')


def wait_done(pg, ok, bad=0, timeout=60000):
    pg.wait_for_function(DONE_JS, arg=[ok, bad], timeout=timeout)


def board(pg):
    return pg.inner_text('#state'), int(pg.inner_text('#nok')), int(pg.inner_text('#nbad'))


def fill_key(pg, value, sel='#key1'):
    shut = not pg.is_visible(sel)
    if shut:
        pg.click('#gear')
        pg.wait_for_selector('#dlg-set[open]')
    pg.fill(sel, value)
    if shut:
        pg.click('#dlg-set [data-close]')


def toggle_auto(pg):
    pg.click('#gear')
    pg.wait_for_selector('#dlg-set[open]')
    pg.click('label:has(#auto)')
    pg.click('#dlg-set [data-close]')


def make_images(name, n, start):
    out = []
    for i in range(start, start + n):
        p = os.path.join(WORK, f'{name}_{i}.jpg')
        Image.new('RGB', (800 + i % 50, 600), (i * 7 % 255, 100, 150)).save(p)
        os.utime(p, (1_700_000_000 + i, 1_700_000_000 + i))
        out.append(p)
    return out


def sheet_photo(name, spots, stamp, bright=1.0, size=(4032, 3024)):
    """深色桌面上摆几张画出来的单子（spots：每张中心的比例坐标）"""
    W, H = size
    im = Image.new('RGB', size, (92, 70, 52))
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
    if bright != 1.0:
        im = im.point(lambda v: int(v * bright))
    p = os.path.join(WORK, name)
    im.save(p, quality=92)
    os.utime(p, (stamp, stamp))
    return p


def serve(root):
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass
    Quiet.extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript',
                            '.webmanifest': 'application/manifest+json'}
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=root))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def post(url, data):
    req = urllib.request.Request(url, data=data, method='POST', headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def main():
    site = serve(ROOT)
    base = f'http://127.0.0.1:{site.server_address[1]}/web/'
    mock = mock_server.start()
    mock_url = f'http://127.0.0.1:{mock.server_address[1]}'
    mock_server.STATE.update(delay=0)

    def gemini(route, request):
        if request.method == 'OPTIONS':
            route.fulfill(status=204, headers=CORS)
            return
        status, body = post(mock_url + request.url.split('googleapis.com', 1)[1], request.post_data_buffer)
        route.fulfill(status=status, headers={**CORS, 'content-type': 'application/json'}, body=body)

    def butler(pg, asked):                    # 假中转站 + 假大管家（跟 tests/test_dagj.py 一样的算法）：暗号 2468
        priv = ec.generate_private_key(ec.SECP256R1())
        pub = priv.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
        ck = os.urandom(32)

        def seal(key, obj, aad):
            n = os.urandom(12)
            return {'ok': True, 'n': dagj.b64u(n), 'ct': dagj.b64u(AESGCM(key).encrypt(n, json.dumps(obj).encode(), aad))}

        def relay(route, request):
            if request.method == 'OPTIONS':
                route.fulfill(status=204, headers=CORS)
                return
            path = request.url.split('/lr', 1)[1]
            if path == '/hello':
                out = {'on': True, 'pub': dagj.b64u(pub)}
            else:
                body = json.loads(request.post_data)
                cid, n, ct = body['cid'], dagj.unb64u(body['n']), dagj.unb64u(body['ct'])
                if path == '/pair':
                    epk = dagj.unb64u(body['epk'])
                    peer = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), epk)
                    k = HKDF(algorithm=hashes.SHA256(), length=32, salt=epk, info=b'luru/pair').derive(priv.exchange(ec.ECDH(), peer))
                    code = json.loads(AESGCM(k).decrypt(n, ct, b'luru/pair/' + cid.encode()))['code']
                    out = (seal(k, {'key': dagj.b64u(ck)}, b'luru/paired/' + cid.encode()) if code == '2468'
                           else {'ok': False, 'wrong': True, 'left': 9})
                else:
                    ask = json.loads(AESGCM(ck).decrypt(n, ct, b'luru/ask/' + cid.encode()))['body']
                    _, data = post(mock_url + '/v1beta/models/butler:generateContent?key=BUTLER', json.dumps(ask).encode())
                    asked.append(cid)
                    out = seal(ck, {'ok': True, 'data': json.loads(data)}, b'luru/ans/' + cid.encode())
            route.fulfill(status=200, headers={**CORS, 'content-type': 'application/json'}, body=json.dumps(out))
        pg.route('https://luruseng-relay.lunzigeju.workers.dev/lr/**', relay)

    with sync_playwright() as pw:
        channel = os.environ.get('E2E_CHANNEL')
        browser = pw.chromium.launch(**({'channel': channel} if channel else {}))

        def iphone(quad_off=True):             # quad_off：146 那几项拿纯色图当单子，把「一张拍四份」的默认拨成关
            m = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True,
                                    has_touch=True, locale='zh-CN')
            if quad_off:
                m.add_init_script('window.LURUSENG_QUAD = false')
            m.add_init_script("try { if (!localStorage.getItem('luruseng.lang')) localStorage.setItem('luruseng.lang', 'zh') } catch (e) {}")
            return m

        def tab(m, name):
            p = m.new_page()
            p.on('pageerror', lambda e: errors.append(f'{name} pageerror: {e}'))
            p.route('https://**', lambda route, req: errors.append(f'外网请求：{req.url}') or route.abort())
            p.route('https://generativelanguage.googleapis.com/**', gemini)
            p.goto(base)
            p.wait_for_function('() => document.querySelector("#log p") && document.querySelector("#phinttxt").textContent',
                                timeout=60000)
            p.wait_for_timeout(500)
            return p

        def said(p, words):
            p.wait_for_function('t => [...document.querySelectorAll("#log p")].some(p => p.textContent.includes(t))',
                                arg=words, timeout=60000)

        def logs(p):
            return p.eval_on_selector_all('#log p', 'ps => ps.map(p => p.textContent)')

        def finished(p, status):
            ok, bad = map(int, re.findall(r'\d+', status))
            wait_done(p, ok, bad)

        def reason(p, words, buttons):        # 原因条：不用划就看得见、字对、按钮对、能点
            p.wait_for_function('w => !document.querySelector("#why").hidden && document.querySelector("#whytxt").textContent.includes(w)'
                                ' && ![...document.querySelectorAll("#whyacts button")].some(b => b.disabled)', arg=words, timeout=30000)
            p.wait_for_timeout(900)           # 滚过去要一下
            got = p.eval_on_selector_all('#whyacts button', 'b => b.map(x => x.textContent)')
            assert got == buttons, got
            box = p.locator('#why').bounding_box()
            assert box['y'] >= 0 and box['y'] + box['height'] <= p.viewport_size['height'], box

        def close_viewer(p):
            p.wait_for_timeout(500)
            if p.is_visible('#dlg-view'):
                p.click('#vclose')
                p.wait_for_selector('#dlg-view', state='hidden')

        def shot(p, name):
            p.screenshot(path=os.path.join(SHOTS, name))

        def nothing_set_up_asks_to_pair_then_runs():
            m = iphone()
            try:
                p, asked = tab(m, 'pair'), []
                butler(p, asked)
                two = make_images('pair', 2, 200)
                p.set_input_files('#files', two)
                assert not p.is_visible('#why') and not p.is_visible('#dlg-dagj')
                p.click('#start')
                p.wait_for_selector('#dlg-dagj[open]')
                assert p.inner_text('#dagjkey') == '或者填 Gemini 钥匙'
                shot(p, '13-点开始-弹连接大管家.png')
                p.click('#dlg-dagj [data-close]')                       # 关掉不连：原因还在按钮上面
                reason(p, '开不了工', ['连接大管家', '填谷歌钥匙'])
                shot(p, '14-原因贴在开始上面.png')
                p.click('#start')
                p.click('#dagjkey')                                     # 「或者填钥匙」：框收掉，打开设置，光标进钥匙 1
                assert not p.is_visible('#dlg-dagj') and p.is_visible('#dlg-set') and p.evaluate('document.activeElement.id') == 'key1'
                p.click('#dlg-set [data-close]')
                p.click('#start')
                reason(p, '开不了工', ['连接大管家', '填谷歌钥匙'])
                p.click('#dlg-dagj [data-close]')
                p.click('#whyacts button:nth-child(2)')                 # 原因条上「填谷歌钥匙」：一样打开设置、光标进钥匙 1
                assert p.is_visible('#dlg-set') and p.evaluate('document.activeElement.id') == 'key1'
                p.click('#dlg-set [data-close]')
                p.click('#start')
                p.fill('#dagjcode', '0000')
                p.click('#dagjok')
                p.wait_for_function('() => document.querySelector("#dagjerr").textContent === "不对。"')
                assert not asked
                p.fill('#dagjcode', '2468')
                p.click('#dagjok')                                      # 对上了：不用再点开始
                finished(p, '干完：成功2·失败0')
                assert len(asked) >= 4 and not p.is_visible('#why') and not p.is_visible('#dlg-dagj'), asked
                close_viewer(p)
                p.eval_on_selector('.side', 'e => e.scrollIntoView({block: "center"})')
                shot(p, '15-对上暗号自己干完.png')

                # 同样两张再放一遍：认过了 -> 再认一遍
                p.set_input_files('#files', two)
                p.click('#start')
                reason(p, '这几张都认过了', ['再认一遍'])
                shot(p, '16-认过了-再认一遍.png')
                n = len(asked)
                p.click('#whyacts button')
                said(p, '↻ 2 张再认一遍')
                finished(p, '干完：成功2·失败0')
                assert len(asked) >= n + 4 and not p.is_visible('#why')
                close_viewer(p)

                # 列表空着点开始；两把一样的钥匙
                p.click('#start')
                reason(p, '还没选照片', ['选照片…'])
                with p.expect_file_chooser():
                    p.click('#whyacts button')
                fill_key(p, KEY, '#key1')
                fill_key(p, KEY, '#key2')
                p.click('#start')
                reason(p, '同一把钥匙', ['清掉钥匙 2'])
                p.click('#whyacts button')
                assert p.input_value('#key2') == ''
                reason(p, '还没选照片', ['选照片…'])
                p.click('.lang button[data-lang="en"]')                  # 换语言：原因条跟着换
                reason(p, 'No photos yet', ['Add photos…'])
                shot(p, '17-英文原因条.png')
            finally:
                m.close()

        def auto_start_with_nothing_set_up():
            m = iphone()
            try:
                p, asked = tab(m, 'auto'), []
                butler(p, asked)
                toggle_auto(p)
                p.set_input_files('#files', make_images('auto', 1, 230))   # 来图就干：放进来就弹框，对上就干
                p.wait_for_selector('#dlg-dagj[open]')
                p.fill('#dagjcode', '2468')
                p.press('#dagjcode', 'Enter')
                finished(p, '干完：成功1·失败0')
                assert asked and not p.is_visible('#why')
            finally:
                m.close()

        def another_tab_working_take_over():
            m = iphone()
            held = []
            try:
                a = tab(m, 'A')
                fill_key(a, KEY, '#key1')
                a.wait_for_timeout(900)
                b = tab(m, 'B')                       # B 先开着：A 后放的照片它列表里本来没有

                def hold(route, request):
                    if request.method == 'OPTIONS':
                        route.fulfill(status=204, headers=CORS)
                    else:
                        held.append(route)
                a.route('https://generativelanguage.googleapis.com/**', hold)
                a.set_input_files('#files', make_images('steal', 2, 210))
                a.click('#start')                     # A 开了工就卡住不动
                a.wait_for_function('() => document.querySelector("#state").textContent === "在干活" && document.querySelector("#nok").textContent === "0"', timeout=30000)
                a.wait_for_timeout(800)
                b.bring_to_front()
                b.click('#start')
                reason(b, '另一个窗口在干活', ['抢过来'])
                said(b, '另一个窗口正在干活')
                shot(b, '18-另一个窗口-抢过来.png')
                b.click('#whyacts button')
                finished(b, '干完：成功2·失败0')
                assert not any('没存住' in x for x in logs(b)), logs(b)
                said(a, '另一个窗口把活抢过去了')
                read = '''async () => { const S = await import('./store.js'); const st = await S.openStore();
                    const ids = await st.keys('runs'); const r = await st.get('runs', ids[0]);
                    return [ids.length, r.rows.map(x => [x.no, x.kind, !!x.left]), !!(await st.get('kv', 'work')),
                            (await st.prefixed('photos', 'pending/')).length]; }'''
                before = b.evaluate(read)
                assert before == [1, [[1, 'rec', False], [2, 'rec', False]], False, 0], before
                assert held
                a.bring_to_front()
                for route in held:                    # 卡住的那个窗口醒过来：什么都不许再写
                    route.abort()
                a.wait_for_function('() => !document.querySelector("#start").disabled', timeout=60000)
                reason(a, '抢走了', ['抢过来'])
                a.wait_for_timeout(1000)
                assert b.evaluate(read) == before, b.evaluate(read)
                shot(a, '19-被抢走的那个窗口.png')
            finally:
                m.close()

        def four_per_photo_is_on_by_default():
            m = iphone(quad_off=False)
            try:
                p = tab(m, 'quad')
                assert p.is_checked('#quad'), '干净的浏览器：开关是勾着的'
                fill_key(p, KEY, '#key1')

                def listed(n):
                    p.wait_for_function('w => document.querySelector("#droptxt").textContent.startsWith(w)',
                                        arg=f'{n} 张：', timeout=30000)

                def reload():
                    p.wait_for_timeout(900)
                    p.reload()
                    p.wait_for_function('() => document.querySelector("#log p") && document.querySelector("#phinttxt").textContent',
                                        timeout=60000)

                # 一张一单（亮的、昏暗的）：列表里就 1 张，认完 1 行
                for name, stamp, bright in (('single.jpg', 1_700_200_000, 1.0), ('dim.jpg', 1_700_200_100, .42)):
                    p.set_input_files('#files', sheet_photo(name, [(.5, .5)], stamp, bright))
                    listed(1)
                    if bright == 1.0:
                        p.eval_on_selector('#quadbox', 'e => e.scrollIntoView({block: "center"})')
                        shot(p, '21-默认开着-一张一单.png')
                    p.click('#start')
                    finished(p, '干完：成功1·失败0')
                    close_viewer(p)
                p.set_input_files('#files', sheet_photo('four.jpg', [(.27, .27), (.73, .27), (.27, .73), (.73, .73)], 1_700_200_200))
                listed(4)
                p.eval_on_selector('#quadbox', 'e => e.scrollIntoView({block: "center"})')
                shot(p, '22-默认开着-四张.png')
                p.click('#start')
                finished(p, '干完：成功4·失败0')
                close_viewer(p)

                p.click('label:has(#quad)')           # 自己关掉：刷新还是关着；再开：记住开着
                reload()
                assert not p.is_checked('#quad')
                p.click('label:has(#quad)')
                reload()
                assert p.is_checked('#quad')
                # 老版本随手存下的 quad:false（他没点过开关）算没存过
                p.evaluate('''async () => { const S = await import('./store.js'); const st = await S.openStore();
                    const c = await st.get('kv', 'cfg'); delete c.quadPick; c.quad = false; await st.put('kv', 'cfg', c); }''')
                reload()
                assert p.is_checked('#quad')
            finally:
                m.close()

        for fn in (nothing_set_up_asks_to_pair_then_runs, auto_start_with_nothing_set_up, another_tab_working_take_over,
                   four_per_photo_is_on_by_default):
            fn()
            print(f'  ✓ {fn.__name__}', flush=True)
        browser.close()
    assert not errors, '\n'.join(errors)
    print(f'全过 · 截图在 {SHOTS}')


if __name__ == '__main__':
    main()
