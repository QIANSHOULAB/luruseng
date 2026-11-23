"""089 认照片先问大管家（方丈的私人管家），问不成自己跳回 Gemini（Song 11-22 20:31：「优先是用大管家来识别。只要大管家
连接不上或者是出问题了，它直接就跳过来了」）。

- 配对：点「连接大管家」输一次暗号。暗号用大管家的公钥加密着发过去（中转站看不见）；对了，大管家回一把这台电脑自己的钥匙，
  存在 %APPDATA%\\录入僧\\dagj.json，以后一直连着，不用再输。
- 认一张：把本来要发给 Gemini 的那个请求（要求、照片、格式）用那把钥匙加密，交给中转站 /lr/ask，大管家认完照 Gemini 的样子回来。
- 跳回 Gemini（092 Song 11-23：「如果不是大管家用不了，不用 Gemini」）：只有没配对、连不上（隔 5 秒再试还不行）、大管家不在、明说接不了、被撤，
  才直接换；慢不算：交过去就一直等，一遍最多 5 分钟，没回再交一次，第二次也没回才换；回了错也先再认一次。
  连着 3 张是「用不了」才 5 分钟里直接走 Gemini；因为慢、因为错换的不算进去。
- 撤掉了（中转站回 403）或者大管家拆不开（forget）：忘掉这次配对，按钮回到「连接大管家」。"""
import base64
import json
import os
import platform
import secrets
import threading
import time
import urllib.error
import urllib.request

RELAY = 'https://luruseng-relay.lunzigeju.workers.dev'
WAIT = 305           # 一次交过去，最多等多久（socket 超时）；092：一遍等 ROUND 秒
ROUND = 300          # 092：慢不算用不了，一遍最多等 5 分钟，没回再交一次，第二次也没回才换 Gemini
MISSES = 3           # 连着几张没成就歇一歇
REST = 300           # 歇多久（秒）
PARALLEL = 4         # 同时问几张（092：大管家那头 parallel 也是 4）
UA = 'Luruseng-desktop'


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


def _get(url, timeout):
    return _open(urllib.request.Request(url, headers={'User-Agent': UA}), timeout)


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
            self.misses += 1
            if self.misses >= MISSES:
                self.rest_until = self.clock() + REST
                self.misses = 0
                return True
            return False

    def _ask_once(self, p, aes, body):
        n = secrets.token_bytes(12)
        pt = json.dumps({'v': 1, 'id': b64u(secrets.token_bytes(9)), 'body': body}, ensure_ascii=False).encode()
        ct = aes.encrypt(n, pt, b'luru/ask/' + p['cid'].encode())
        return _post(self.relay + '/ask', {'cid': p['cid'], 'n': b64u(n), 'ct': b64u(ct)}, self.wait)

    def _round(self, p, aes, body, stop):
        """一遍：等大管家认完，最多 ROUND 秒。中转站自己先喊「超时」（504）不算它放弃，接着等。
        -> (状态码, 回的)；一遍都没回 -> None（慢，不是不在）。"""
        end = self.clock() + ROUND
        for _ in range(8):
            if stop is not None and stop.is_set():
                raise Miss('停了', down=False)
            st, r = self._ask_once(p, aes, body)
            if st == 0 and 'timed out' not in str(r.get('error', '')) and r.get('error') != 'timeout':
                self.sleep(5)                                  # 连不上：隔 5 秒再试一次
                st, r = self._ask_once(p, aes, body)
                if st == 0 and 'timed out' not in str(r.get('error', '')):
                    raise Miss('连不上：' + str(r.get('error', ''))[:80])
            if st == 504 or st == 0:
                if self.clock() < end - 1:
                    continue
                return None
            return st, r
        return None

    def read(self, body: dict, stop: threading.Event | None = None) -> dict:
        """交一个 Gemini 请求给大管家 -> 照 Gemini 的样子回来的 dict。没成就 Miss。
        092：慢不算用不了。交过去了就一直等它认完（一遍最多 5 分钟）；5 分钟没回再交一次，第二次也没回才 Miss（down=False，
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
                    raise Miss('大管家不在')
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
