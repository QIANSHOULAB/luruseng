"""184 录入僧越用越准（网页版，真浏览器）：假中转站 + 假大管家（暗号 2468）+ 假谷歌。
- 没配大管家：⚙ 里没有那个开关，页脚不说，核对里改了格子也一点不往外发。
- 配上了：开页面、配上对就要「常错提醒」，送去认的请求里真带着那段；「不用标红」那格真不红。
  核对里改一格、点「对的」、点猜的值，三样都进包；大管家不在（503）留着，回来了再交，收到回执才删。
- ⚙ 里关掉：一格都不记、不发。

跑：python web/test/learn_184.py [截图放哪]
要：playwright（chromium）、Pillow、cryptography；本机只装了 Edge 就设 E2E_CHANNEL=msedge
"""
import json
import os
import sys
import tempfile

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import start_why as W  # noqa: E402  （同一套：起网页、假谷歌、做图）
from start_why import dagj, mock_server  # noqa: E402

SHOTS = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix='luruseng-184-')
os.makedirs(SHOTS, exist_ok=True)
CAT = '刀单'
HEAD = '常错提醒（大管家从人改过的格子里学的，是看字的提醒，不是规矩）：'
LIST = {'ver': 7, 'at': 1, 'lists': {CAT: ['MACHINE 手写的 Q 常被看成 0'], '*': ['7 中间带横，不是 4']},
        'nored': [{'cat': CAT, 'col': 'setter', 'value': '6□9/Lee Ah Kow'}]}
BLOCK = HEAD + '\n- MACHINE 手写的 Q 常被看成 0\n- 7 中间带横，不是 4'
errors = []


def main():
    site = W.serve(W.ROOT)
    base = f'http://127.0.0.1:{site.server_address[1]}/web/'
    mock = mock_server.start()
    mock_url = f'http://127.0.0.1:{mock.server_address[1]}'
    mock_server.STATE.update(delay=0)
    mock_server.STATE['modes']['BUTLER'] = 'quick'          # 班次、机台几遍不一样，工号看不清
    R = {'asks': [], 'learn': [], 'got': [], 'lists': 0, 'mode': 'ok'}

    def gemini(route, request):
        if request.method == 'OPTIONS':
            route.fulfill(status=204, headers=W.CORS)
            return
        status, body = W.post(mock_url + request.url.split('googleapis.com', 1)[1], request.post_data_buffer)
        route.fulfill(status=status, headers={**W.CORS, 'content-type': 'application/json'}, body=body)

    priv = ec.generate_private_key(ec.SECP256R1())
    pub = priv.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    ck = os.urandom(32)
    cids = []

    def seal(key, obj, aad):
        n = os.urandom(12)
        return {'ok': True, 'n': dagj.b64u(n), 'ct': dagj.b64u(AESGCM(key).encrypt(n, json.dumps(obj).encode(), aad))}

    def relay(route, request):                 # 照 luruseng-relay 的 /lr/hello、/pair、/ask、/learn、/learn/list
        if request.method == 'OPTIONS':
            route.fulfill(status=204, headers={**W.CORS, 'access-control-allow-headers': 'content-type, x-lr-cid'})
            return
        path = request.url.split('/lr', 1)[1].split('?')[0]
        status, out = 200, None
        if path == '/hello':
            out = {'on': True, 'pub': dagj.b64u(pub)}
        elif path == '/learn/list':
            R['lists'] += 1
            ok = request.headers.get('x-lr-cid') in cids
            status, out = (200, {'ok': True, 'learn': LIST}) if ok else (403, {'unknown': True})
        else:
            body = json.loads(request.post_data)
            cid, n, ct = body['cid'], dagj.unb64u(body['n']), dagj.unb64u(body['ct'])
            if path == '/pair':
                epk = dagj.unb64u(body['epk'])
                peer = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), epk)
                k = HKDF(algorithm=hashes.SHA256(), length=32, salt=epk, info=b'luru/pair').derive(priv.exchange(ec.ECDH(), peer))
                code = json.loads(AESGCM(k).decrypt(n, ct, b'luru/pair/' + cid.encode()))['code']
                if code == '2468':
                    cids.append(cid)
                    out = seal(k, {'key': dagj.b64u(ck)}, b'luru/paired/' + cid.encode())
                else:
                    out = {'ok': False, 'wrong': True, 'left': 9}
            elif path == '/learn':
                pkg = json.loads(AESGCM(ck).decrypt(n, ct, b'luru/learn/' + cid.encode()))
                R['learn'].append(pkg['id'])
                if R['mode'] == 'away':
                    status, out = 503, {'off': True}
                else:
                    R['got'].append(pkg)
                    out = seal(ck, {'ok': True, 'got': len(pkg['items'])}, b'luru/learned/' + cid.encode())
            else:
                ask = json.loads(AESGCM(ck).decrypt(n, ct, b'luru/ask/' + cid.encode()))['body']
                R['asks'].append(ask)
                _, data = W.post(mock_url + '/v1beta/models/butler:generateContent?key=BUTLER', json.dumps(ask).encode())
                out = seal(ck, {'ok': True, 'data': json.loads(data)}, b'luru/ans/' + cid.encode())
        route.fulfill(status=status, headers={**W.CORS, 'content-type': 'application/json'}, body=json.dumps(out))

    def ai(route, request):                    # Claude 那条：站上没钥匙，这份测试走大管家
        if request.method == 'OPTIONS':
            route.fulfill(status=204, headers={**W.CORS, 'access-control-allow-headers': 'content-type, x-lr-cid'})
            return
        route.fulfill(status=200, headers={**W.CORS, 'content-type': 'application/json'}, body=json.dumps({'ok': True, 'key': False}))

    with sync_playwright() as pw:
        channel = os.environ.get('E2E_CHANNEL')
        browser = pw.chromium.launch(**({'channel': channel} if channel else {}))
        ctx = browser.new_context(viewport={'width': 1280, 'height': 860}, locale='zh-CN')
        ctx.add_init_script("window.LURUSENG_QUAD = false; try { localStorage.setItem('luruseng.lang', 'zh') } catch (e) {}")

        def tab():
            p = ctx.new_page()
            p.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
            p.route('https://**', lambda route, req: errors.append(f'外网请求：{req.url}') or route.abort())
            p.route('https://generativelanguage.googleapis.com/**', gemini)
            p.route('https://luruseng-relay.lunzigeju.workers.dev/lr/**', relay)
            p.route('https://luruseng-relay.lunzigeju.workers.dev/ai/**', ai)
            p.goto(base)
            p.wait_for_function('() => document.querySelector("#log p")', timeout=60000)
            p.wait_for_timeout(500)
            return p

        def kv(p, prefix):
            return p.evaluate('''async (pre) => { const S = await import('./store.js'); const st = await S.openStore();
                return (await st.prefixed('kv', pre)).map(([k, v]) => v); }''', prefix)

        def run_rows(p):
            return p.evaluate('''async () => { const S = await import('./store.js'); const st = await S.openStore();
                const c = await st.get('kv', 'cfg'); const r = await st.get('runs', c.lastRun); return r.rows; }''')

        def settings_row(p):
            p.click('#gear')
            p.wait_for_selector('#dlg-set[open]')
            vis = p.is_visible('#setrows input[data-key="learn"]') or p.is_visible('label.srow:has(input[data-key="learn"])')
            return vis

        def close_settings(p):
            p.click('#dlg-set [data-close]')
            p.wait_for_selector('#dlg-set', state='hidden')

        def viewer(p):
            p.wait_for_selector('#dlg-view[open]', timeout=60000)
            p.wait_for_function('() => !!document.querySelector("#vpanel h3")')

        def close_viewer(p):
            p.click('#vclose')
            p.wait_for_selector('#dlg-view', state='hidden')

        try:
            # ---------------- 没配大管家：开关不露，改了格子一点不往外发
            p = tab()
            assert not settings_row(p), '没配大管家：开关不该露'
            close_settings(p)
            assert not p.is_visible('#learnfoot')
            W.fill_key(p, W.KEY, '#key1')
            p.set_input_files('#files', W.make_images('lone', 1, 300))
            p.click('#start')
            viewer(p)
            p.click('#vpanel dd[data-f="t_no"]')
            p.fill('#vpanel .cell-ed input', 'T9')
            p.press('#vpanel .cell-ed input', 'Enter')
            p.wait_for_function('() => document.querySelector("#vinfo").textContent.includes("T9")')
            close_viewer(p)
            p.wait_for_timeout(800)
            assert R['learn'] == [] and R['lists'] == 0, R
            assert kv(p, 'learn/') == []
            assert 'reads' not in run_rows(p)[0]
            p.close()

            # ---------------- 配上大管家：要那份提醒，请求里带着；「不用标红」那格不红
            p = tab()
            p.click('#dagj')
            p.wait_for_selector('#dlg-dagj[open]')
            p.fill('#dagjcode', '2468')
            p.click('#dagjok')
            p.wait_for_selector('#dlg-dagj', state='hidden')
            p.wait_for_function('() => !document.querySelector("#learnfoot").hidden', timeout=10000)
            assert R['lists'] >= 1
            assert '交给大管家' in p.inner_text('#learnfoot')
            assert settings_row(p)
            assert p.is_checked('#setrows input[data-key="learn"]')        # 默认开着
            p.screenshot(path=os.path.join(SHOTS, '184-设置-越用越准开关.png'))
            close_settings(p)
            R['mode'] = 'away'                                             # 大管家这会儿不收
            p.set_input_files('#files', W.make_images('learn', 2, 310))
            p.click('#start')
            viewer(p)
            assert R['asks'] and all(a['systemInstruction']['parts'][-1]['text'] == BLOCK for a in R['asks']), R['asks'][0]['systemInstruction']
            rows = run_rows(p)
            assert all('setter' not in r['red'] for r in rows), [r['red'] for r in rows]     # 两遍都是 6□9/…，规则说不用红
            assert all('machine' in r['red'] and 'shift' in r['red'] for r in rows), [r['red'] for r in rows]
            assert rows[0]['reads']['machine'] == ['VM-07', 'VM-01'], rows[0]['reads']
            p.screenshot(path=os.path.join(SHOTS, '184-核对.png'))
            # 一格「对的」、一格点猜的值、一格自己打
            p.click('#vpanel .quick.qok[data-f="shift"]')
            p.wait_for_function('() => document.querySelector("#vinfo").textContent.includes("SHIFT")')
            p.wait_for_timeout(450)
            p.click('#vpanel .quick.qalt[data-f="machine"] >> nth=0')
            p.wait_for_function('() => document.querySelector("#vinfo").textContent.includes("MACHINE")')
            p.click('#vpanel dd[data-f="t_no"]')
            p.fill('#vpanel .cell-ed input', 'T44')
            p.press('#vpanel .cell-ed input', 'Enter')
            p.wait_for_function('() => document.querySelector("#vinfo").textContent.includes("T44")')
            p.wait_for_timeout(300)
            close_viewer(p)                                                # 核完了：打包交，大管家不在 -> 留着
            p.wait_for_function('() => true')
            for _ in range(50):
                if R['learn'] and len(kv(p, 'learn/q/')) == 1:
                    break
                p.wait_for_timeout(200)
            assert R['learn'] and not R['got'], R
            q = kv(p, 'learn/q/')
            assert len(q) == 1, q
            pkg = q[0]['pkg']
            assert sorted(i['act'] for i in pkg['items']) == ['edit', 'guess', 'ok'], pkg['items']
            assert {i['col'] for i in pkg['items']} == {'shift', 'machine', 't_no'}
            it = next(i for i in pkg['items'] if i['col'] == 'machine')
            assert it['before'] == 'VM-07' and it['color'] == 'red' and it['reads'] == ['VM-07', 'VM-01'], it
            assert it['by'] == 'butler' and it['page'] == 1 and it['row'] == 1 and it['cat'] == CAT, it
            assert pkg['batches'][0]['cells'] == 26 and pkg['batches'][0]['edited'] == 3 and pkg['batches'][0]['list_ver'] == 7, pkg['batches']
            assert [x['page'] for x in pkg['photos']] == [1], pkg['photos']                 # 只带动过的那张
            ph = pkg['photos'][0]
            assert ph['prompt'].startswith('你是工厂') and HEAD not in ph['prompt'] and ph['schema'] and ph['data']
            assert ph['answer']['records'][0]['t_no'] == 'T44' and ph['answer']['records'][0]['shift'] == 'D', ph['answer']
            assert pkg['device'].startswith('录入僧网页版') and pkg['app'].startswith('web ')

            # ---------------- 大管家回来了：再开页面就交，收到回执删掉
            R['mode'] = 'ok'
            p.reload()
            p.wait_for_function('() => document.querySelector("#log p")', timeout=60000)
            for _ in range(50):
                if R['got'] and not kv(p, 'learn/q/'):
                    break
                p.wait_for_timeout(200)
            assert len(R['got']) == 1 and R['got'][0]['id'] == pkg['id'], R['got']
            assert kv(p, 'learn/q/') == []
            p.wait_for_function('() => [...document.querySelectorAll("#log p")].some(x => x.textContent.includes("改过的格子交给大管家了"))')

            # ---------------- ⚙ 里关掉：一格都不记、不发
            settings_row(p)
            p.click('label.srow:has(input[data-key="learn"]) .switch')
            close_settings(p)
            assert not p.is_visible('#learnfoot')
            n = len(R['learn'])
            p.click('#check')
            viewer(p)
            p.click('#vpanel dd[data-f="part_number"]')
            p.fill('#vpanel .cell-ed input', 'TD-1')
            p.press('#vpanel .cell-ed input', 'Enter')
            p.wait_for_function('() => document.querySelector("#vinfo").textContent.includes("TD-1")')
            close_viewer(p)
            p.wait_for_timeout(800)
            assert len(R['learn']) == n and kv(p, 'learn/log/') == [] and kv(p, 'learn/q/') == [], (R['learn'], kv(p, 'learn/'))
            p.close()
        finally:
            browser.close()
    assert not errors, '\n'.join(errors)
    print(f'184 全过 · 截图在 {SHOTS}')


if __name__ == '__main__':
    try:
        main()
    except BaseException:
        if os.environ.get('GITHUB_ACTIONS'):
            import traceback as _tb
            msg = _tb.format_exc()[-1800:].replace('%', '%25').replace('\r', '').replace('\n', '%0A')
            print(f'::error title=learn_184::{msg}', flush=True)
        raise
