"""089 认照片先问大管家（方丈的私人管家），问不成自己跳回 Gemini（Song 11-22 20:31：「优先是用大管家来识别。只要大管家
连接不上或者是出问题了，它直接就跳过来了」）。

- 配对：点「连接大管家」输一次暗号。暗号用大管家的公钥加密着发过去（中转站看不见）；对了，大管家回一把这台电脑自己的钥匙，
  存在 %APPDATA%\\录入僧\\dagj.json，以后一直连着，不用再输。
- 认一张：把本来要发给 Gemini 的那个请求（要求、照片、格式）用那把钥匙加密，交给中转站 /lr/ask，大管家认完照 Gemini 的样子回来。
- 跳回 Gemini（092 Song 11-23：「如果不是大管家用不了，不用 Gemini」）：只有没配对、连不上（隔 5 秒再试还不行）、大管家不在、明说接不了、被撤，
  才直接换；慢不算：交过去就一直等，一遍最多 5 分钟，没回再交一次，第二次也没回才换；回了错也先再认一次。
  连着 3 张是「用不了」才 5 分钟里直接走 Gemini；因为慢、因为错换的不算进去。
- 撤掉了（中转站回 403）或者大管家拆不开（forget）：忘掉这次配对，按钮回到「连接大管家」。
- 093 电脑、掌机一起认：一批同时交 BATCH 张，中转站按两台的空位分、都满就在站里排着（排队不算 5 分钟，从大管家取走起算，
  中转站自己管：过了回 504 = 这一遍慢）。照片先缩到大脑自己会缩到的尺寸（fit，Opus 5.5：长边 2576、视觉 token 4784），
  本来就在限度以内的原样发。"""
import base64
import io
import json
import os
import platform
import secrets
import threading
import time
import urllib.error
import urllib.request

RELAY = 'https://luruseng-relay.lunzigeju.workers.dev'
WAIT = 1230          # 093：一次交过去最多等多久（socket 超时）：中转站排队最多 15 分钟 + 大管家认 5 分钟，再宽一点
MISSES = 3           # 连着几张没成就歇一歇
REST = 300           # 歇多久（秒）
PARALLEL = 16        # 093：同时问几张（排队交给中转站：电脑 4 + 掌机 8）
BATCH = 12           # 093：配上大管家时一批交几张（没配上照旧 engine.BATCH）
UA = 'Luruseng-desktop'
EDGE, TOKENS, PATCH = 2576, 4784, 28     # 093：Opus 5.5 看图的限度（Claude 文档 vision-coordinates）


def image_tokens(w: int, h: int) -> int:
    return -(-w // PATCH) * -(-h // PATCH)


def resized_size(w: int, h: int, max_edge: int = EDGE, max_tokens: int = TOKENS) -> tuple[int, int]:
    """大脑那边会把图缩到多大（照 Claude 文档的 resized_size）；本来就放得下 -> 原样。"""
    def fits(a, b):
        return -(-a // PATCH) * PATCH <= max_edge and -(-b // PATCH) * PATCH <= max_edge and image_tokens(a, b) <= max_tokens

    if fits(w, h):
        return w, h
    if h > w:
        rh, rw = resized_size(h, w, max_edge, max_tokens)
        return rw, rh
    ar = w / h
    lo, hi = 1, w
    while lo + 1 < hi:
        mid = (lo + hi) // 2
        if fits(mid, max(round(mid / ar), 1)):
            lo = mid
        else:
            hi = mid
    return lo, max(round(lo / ar), 1)


def fit(jpeg: bytes) -> bytes:
    """093：发给大管家之前缩到大脑自己会缩到的尺寸（JPEG 90）；本来就在限度以内的不动。"""
    try:
        from PIL import Image
        with Image.open(io.BytesIO(jpeg)) as im:
            size = resized_size(*im.size)
            if size == im.size:
                return jpeg
            im = im.convert('RGB').resize(size, Image.LANCZOS)
            buf = io.BytesIO()
            im.save(buf, 'JPEG', quality=90)
            return buf.getvalue()
    except Exception:
        return jpeg


class Miss(Exception):
    """这一张大管家没认成：退回 Gemini。down=True：大管家真的用不了（没配对、连不上、不在、明说接不了、被撤），
    才算进「连着 3 张歇 5 分钟」；慢、回错（down=False）只换这一张，不歇。"""

    def __init__(self, why='', down=True):
        super().__init__(why)
        self.down = down


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip('=')


def unb64u(s: str) -> bytes:
    s = str(s)
    return base64.urlsafe_b64decode(s + '=' * (-len(s) % 4))


def _post(url, body, timeout):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method='POST',
                                 headers={'Content-Type': 'application/json', 'User-Agent': UA})
    return _open(req, timeout)


def _get(url, timeout, headers=None):
    return _open(urllib.request.Request(url, headers={'User-Agent': UA, **(headers or {})}), timeout)


def _open(req, timeout):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode('utf-8') or 'null')
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode('utf-8'))
        except ValueError:
            return e.code, {}
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        return 0, {'error': str(getattr(e, 'reason', e))}


def label() -> str:
    """配对表里那一行：哪台电脑上的录入僧（不写人名、不写电脑名）。"""
    return f'录入僧电脑版 · {platform.system()} {platform.release()}'


class Butler:
    def __init__(self, path: str, relay: str = RELAY, clock=time.time, wait: float = WAIT, sleep=time.sleep):
        self.path = path
        self.relay = relay.rstrip('/') + '/lr'
        self.clock = clock
        self.sleep = sleep
        self.wait = wait
        self.lock = threading.Lock()
        self.slots = threading.BoundedSemaphore(PARALLEL)
        self.misses = 0
        self.rest_until = 0.0
        self.pair_info = self._load()
        self.on_change = lambda: None       # 配上、忘掉的时候界面换按钮

    # ---------------------------------------------------------------- 存的那份
    def _load(self):
        try:
            with open(self.path, encoding='utf-8') as f:
                p = json.load(f)
            return p if p.get('cid') and len(unb64u(p.get('key', ''))) == 32 else None
        except (OSError, ValueError):
            return None

    def _save(self, p):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        tmp = self.path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(p, f)
        os.replace(tmp, self.path)

    @property
    def paired(self) -> bool:
        return self.pair_info is not None

    def forget(self):
        with self.lock:
            self.pair_info = None
            try:
                os.remove(self.path)
            except OSError:
                pass
        self.on_change()

    # ---------------------------------------------------------------- 配对
    def pair(self, code: str) -> dict:
        """-> {'ok': True} / {'wrong': True, 'left': n} / {'locked': True, 'until': ms} / {'off': True} / {'error': '…'}"""
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        from cryptography.hazmat.primitives.kdf.hkdf import HKDF
        st, hello = _get(self.relay + '/hello', 20)
        if st != 200:
            return {'error': f'中转站连不上（{st}）'}
        if not hello.get('on') or not hello.get('pub'):
            return {'off': True}
        cid = b64u(secrets.token_bytes(16))
        eph = ec.generate_private_key(ec.SECP256R1())
        epk = eph.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
        pc = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), unb64u(hello['pub']))
        k = HKDF(algorithm=hashes.SHA256(), length=32, salt=epk, info=b'luru/pair').derive(eph.exchange(ec.ECDH(), pc))
        n = secrets.token_bytes(12)
        ct = AESGCM(k).encrypt(n, json.dumps({'code': code.strip(), 'label': label()}).encode(), b'luru/pair/' + cid.encode())
        st, r = _post(self.relay + '/pair', {'cid': cid, 'epk': b64u(epk), 'n': b64u(n), 'ct': b64u(ct)}, 45)
        if st == 429 or r.get('locked'):
            return {'locked': True, 'until': r.get('until')}
        if st == 503:
            return {'off': True}
        if st != 200:
            return {'error': f'没连上（{st}）'}
        if not r.get('ok'):
            return {'wrong': True, 'left': r.get('left')}
        try:
            key = json.loads(AESGCM(k).decrypt(unb64u(r['n']), unb64u(r['ct']), b'luru/paired/' + cid.encode()))['key']
        except Exception:
            return {'error': '大管家回的拆不开'}
        p = {'cid': cid, 'key': key, 'at': time.strftime('%Y-%m-%d %H:%M')}
        self._save(p)
        with self.lock:
            self.pair_info = p
            self.misses, self.rest_until = 0, 0.0
        self.on_change()
        return {'ok': True}

    # ---------------------------------------------------------------- 认
    def ready(self) -> bool:
        """这一张要不要先问大管家：配上了，而且不在歇着。"""
        return self.paired and self.clock() >= self.rest_until

    def hit(self):
        with self.lock:
            self.misses = 0

    def miss(self) -> bool:
        """没成一张；连着 3 张就歇 5 分钟。-> 这回开始歇了没有"""
        with self.lock:
            if self.clock() < self.rest_until:       # 093：一批同时问的多：已经在歇了，别的没成的不再算一轮
                return False
            self.misses += 1
            if self.misses >= MISSES:
                self.rest_until = self.clock() + REST
                self.misses = 0
                return True
            return False

    def _ask_once(self, p, aes, body, stop=None):
        n = secrets.token_bytes(12)
        pt = json.dumps({'v': 1, 'id': b64u(secrets.token_bytes(9)), 'body': body}, ensure_ascii=False).encode()
        ct = aes.encrypt(n, pt, b'luru/ask/' + p['cid'].encode())
        req = {'cid': p['cid'], 'n': b64u(n), 'ct': b64u(ct)}
        if stop is None:
            return _post(self.relay + '/ask', req, self.wait)
        box = []                                   # 093：一次可能等十几分钟，点「停止」不能干等它：另起一条线发，这边看着停
        t = threading.Thread(target=lambda: box.append(_post(self.relay + '/ask', req, self.wait)), daemon=True)
        t.start()
        while t.is_alive():
            if stop.wait(0.5):
                raise Miss('停了', down=False)
        return box[0] if box else (0, {'error': '没回'})

    def _round(self, p, aes, body, stop):
        """一遍：交过去等大管家认完。093：中转站排队不算时间，从大管家取走起最多 5 分钟，中转站自己管，过了回 504。
        -> (状态码, 回的)；慢（504、等过头）-> None。"""
        if stop is not None and stop.is_set():
            raise Miss('停了', down=False)
        st, r = self._ask_once(p, aes, body, stop)
        if st == 0 and 'timed out' not in str(r.get('error', '')) and r.get('error') != 'timeout':
            self.sleep(5)                                      # 连不上：隔 5 秒再试一次
            st, r = self._ask_once(p, aes, body, stop)
            if st == 0 and 'timed out' not in str(r.get('error', '')):
                raise Miss('连不上：' + str(r.get('error', ''))[:80])
        if st == 504 or st == 0:
            return None
        return st, r

    def read(self, body: dict, stop: threading.Event | None = None) -> dict:
        """交一个 Gemini 请求给大管家 -> 照 Gemini 的样子回来的 dict。没成就 Miss。
        092：慢不算用不了。交过去了就一直等它认完（一遍最多 5 分钟，093 起在中转站排队的时间不算）；5 分钟没回再交一次，第二次也没回才 Miss（down=False，
        不算进「连着 3 张」）。大管家回了错：再认一次，第二次还错才 Miss。只有没配对、连不上、不在、明说接不了、被撤才 down=True。"""
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        p = self.pair_info
        if not p:
            raise Miss('没配对')
        aes = AESGCM(unb64u(p['key']))
        slow = errs = 0
        with self.slots:
            while True:
                got = self._round(p, aes, body, stop)
                if got is None:
                    slow += 1
                    if slow >= 2:
                        raise Miss('大管家 2 次都没回，换 Gemini', down=False)
                    continue
                st, r = got
                if st == 403 and (r.get('revoked') or r.get('unknown')):
                    self.forget()
                    raise Miss('配对被撤了')
                if st == 503:
                    raise Miss('大管家在陪玩' if r.get('cant') else '大管家不在')
                if st != 200:
                    raise Miss(f'中转站 {st}')
                if not r.get('ok'):
                    if r.get('forget'):
                        self.forget()
                        raise Miss('大管家拆不开')
                    errs += 1
                    if errs >= 2:
                        raise Miss('大管家回错 2 次', down=False)
                    continue
                try:
                    ans = json.loads(aes.decrypt(unb64u(r['n']), unb64u(r['ct']), b'luru/ans/' + p['cid'].encode()))
                except Exception:
                    raise Miss('回的拆不开', down=False)
                if ans.get('ok'):
                    return ans['data']
                if ans.get('cant'):
                    raise Miss('大管家：' + str(ans.get('error', ''))[:120])     # 明说接不了（陪玩）：算不在
                errs += 1
                if errs >= 2:
                    raise Miss('大管家：' + str(ans.get('error', ''))[:120], down=False)

    # ---------------------------------------------------------------- 184 录入僧越用越准（learn.py 管记、管排队，这里只管封好交过去）
    def learn(self, pkg: dict) -> dict:
        """一包「人改过的格子」交给大管家（跟 /lr/ask 一样封）。-> {'ok': True, 'got': n}：收下了（删这包）/
        {'split': True}：太大（413）/ {'gone': True}：配对被撤 / {'later': True, 'why': …}：过一阵再交。
        forget:true 在这里不是「忘掉配对」：还没装新版的大管家拆不开学的包也这么回，照 {ok:false} 办，留着过一阵再交。"""
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        p = self.pair_info
        if not p:
            return {'gone': True}
        aes = AESGCM(unb64u(p['key']))
        n = secrets.token_bytes(12)
        ct = aes.encrypt(n, json.dumps(pkg, ensure_ascii=False).encode(), b'luru/learn/' + p['cid'].encode())
        st, r = _post(self.relay + '/learn', {'cid': p['cid'], 'n': b64u(n), 'ct': b64u(ct)}, 120)
        r = r if isinstance(r, dict) else {}
        if st == 413:
            return {'split': True}
        if st == 403 and (r.get('revoked') or r.get('unknown')):
            self.forget()
            return {'gone': True}
        if st != 200:
            return {'later': True, 'why': str(st or r.get('error', ''))}
        if not r.get('ok'):
            return {'later': True, 'why': 'forget' if r.get('forget') else 'not ok'}
        try:
            ans = json.loads(aes.decrypt(unb64u(r['n']), unb64u(r['ct']), b'luru/learned/' + p['cid'].encode()))
            if ans.get('ok'):
                return {'ok': True, 'got': ans.get('got')}
        except Exception:
            pass                                    # 回执拆不开：当没收到，过一阵再交（大管家那头按 id 去重）
        return {'later': True, 'why': 'receipt'}

    def learn_list(self):
        """大管家学会的那份「常错提醒」：-> {'learn': …}（可能是 None = 还没学到什么）；没配对、拿不到 -> None"""
        p = self.pair_info
        if not p:
            return None
        st, r = _get(self.relay + '/learn/list', 20, {'x-lr-cid': p['cid']})
        if st == 200 and isinstance(r, dict) and r.get('ok'):
            got = r.get('learn')
            return {'learn': got if isinstance(got, dict) else None}
        return None
