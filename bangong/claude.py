"""167 认照片先走 Claude API（Song 那把钥匙，Max 每月送的额度），用完、出错回老办法（大管家 → Gemini）。跟网页版 web/claude.js 一套。

- 钥匙不在这台：只放在中转站。配上了大管家的（089 的 cid）才走这条：带 cid 把 Claude Messages 请求发到中转站 /ai/messages，
  站里补上钥匙转给 Claude，原样回。没配对的录入僧一点不变。
- 请求照大管家 handheld/luru.py 那套从 Gemini 请求翻过来：要求当 system（不变的那段放前面，加 prompt cache），照片放后面；
  要 JSON 用结构化输出（output_config.format，Gemini 的 schema 翻成 JSON Schema）；不认 schema 就把 schema 写进提示、自己抠 JSON。
  回答翻回 Gemini 的样子，后面那步（parse_response）不用动。
- 模型、档位从 /ai/conf 拿（大管家照它的 config.toml [ai] 推上去的），开工时问一次、缓存 10 分钟，不写死在这里。
- 退路：额度歇着（503 quota）或者站里没钥匙：这一轮不再问 /ai，30 分钟后再问；别的错（超时、5xx、429、403）这一张走老办法，
  连着 3 张没成 5 分钟里不问（跟 089 一样）。两遍对答案照旧，哪一遍没成整张换（Miss）。
- 走中转站、不用官方 SDK：钥匙不能下到这台，请求要先到站里补钥匙；这里只是一条 HTTP。"""
import json
import re
import threading
import time
import urllib.error
import urllib.request

from .dagj import RELAY, UA, Miss

CONF_S = 600          # 模型表缓存多久
QUOTA_REST = 1800     # 额度歇着 / 没钥匙：多久以后再问
MISSES = 3
REST = 300
PARALLEL = 4          # 同时问几张（Claude 那头按分钟限 tokens，一下子十几张容易撞 429）
TIMEOUT = 240         # 一遍最多等多久（Opus low 认一张一般 10～60 秒）
MAX_TOKENS = 16000
DEFAULT = {'model': 'claude-opus-5-5', 'effort': 'low'}


class ClaudeMiss(Miss):
    """这一张 Claude 没认成。quota=True：额度歇着 / 没钥匙（不算进「连着 3 张」）；down=False：回了认不出的（只换这一张）。"""

    def __init__(self, why='', down=True, quota=False, first=False):
        super().__init__(why, down)
        self.quota = quota
        self.first = first


def json_schema(g):
    """Gemini 的 schema（type 大写）-> JSON Schema（结构化输出要 additionalProperties: false）。"""
    if not isinstance(g, dict):
        return g
    t = str(g.get('type') or '').lower()
    out = {}
    if t:
        out['type'] = t
    if isinstance(g.get('description'), str):
        out['description'] = g['description']
    if isinstance(g.get('enum'), list):
        out['enum'] = list(g['enum'])
    if t == 'object':
        out['properties'] = {k: json_schema(v) for k, v in (g.get('properties') or {}).items()}
        out['required'] = list(g.get('required') or [])
        out['additionalProperties'] = False
    if t == 'array' and g.get('items'):
        out['items'] = json_schema(g['items'])
    if g.get('nullable') and t:
        return {'anyOf': [out, {'type': 'null'}]}
    return out


def claude_body(body: dict, conf: dict, use_format: bool = True) -> dict:
    """本来要发给 Gemini 的请求 -> Claude Messages 请求。"""
    sys_ = '\n\n'.join(p['text'] for p in ((body.get('systemInstruction') or {}).get('parts') or [])
                       if isinstance(p, dict) and isinstance(p.get('text'), str) and p['text'])
    content = []
    for turn in body.get('contents') or []:
        for p in (turn or {}).get('parts') or []:
            if not isinstance(p, dict):
                continue
            if isinstance(p.get('text'), str):
                content.append({'type': 'text', 'text': p['text']})
            d = p.get('inline_data') or p.get('inlineData')
            if isinstance(d, dict):
                content.append({'type': 'image', 'source': {'type': 'base64', 'media_type': d.get('mime_type') or d.get('mimeType') or 'image/jpeg',
                                                            'data': d.get('data') or ''}})
    schema = (body.get('generationConfig') or {}).get('responseSchema')
    out = {'model': conf['model'], 'max_tokens': MAX_TOKENS, 'output_config': {'effort': conf['effort']}}
    if sys_:
        out['system'] = [{'type': 'text', 'text': sys_, 'cache_control': {'type': 'ephemeral'}}]   # 不变的那段：两遍、一批里的每张都一样
    if schema and use_format:
        out['output_config']['format'] = {'type': 'json_schema', 'schema': json_schema(schema)}
    else:
        if schema:
            content.append({'type': 'text', 'text': '照这个 JSON Schema 输出：\n' + json.dumps(json_schema(schema), ensure_ascii=False)})
        content.append({'type': 'text', 'text': '只输出 JSON。'})
    out['messages'] = [{'role': 'user', 'content': content}]
    return out


def extract_json(text: str) -> str:
    t = re.sub(r'^```(?:json)?\s*|\s*```$', '', (text or '').strip())
    try:
        json.loads(t)
        return t
    except ValueError:
        pass
    for a, b in (('{', '}'), ('[', ']')):
        i, j = t.find(a), t.rfind(b)
        if 0 <= i < j:
            try:
                json.loads(t[i:j + 1])
                return t[i:j + 1]
            except ValueError:
                continue
    raise ValueError('Claude 回的不是 JSON：' + t[:200])


def gemini_shape(msg: dict) -> dict:
    """Claude 的回答 -> Gemini 的样子（parse_response 认得）。"""
    if not isinstance(msg, dict) or msg.get('type') != 'message':
        raise ValueError('不是 Claude 的回答')
    if msg.get('stop_reason') == 'refusal':
        raise ValueError('Claude 不认这张（refusal）')
    if msg.get('stop_reason') == 'max_tokens':
        raise ValueError('Claude 写到上限没写完')
    text = ''.join(b.get('text') or '' for b in msg.get('content') or [] if isinstance(b, dict) and b.get('type') == 'text')
    return {'candidates': [{'content': {'role': 'model', 'parts': [{'text': extract_json(text)}]}, 'finishReason': 'STOP'}],
            'modelVersion': 'claude/' + str(msg.get('model') or '')}


def _call(url, cid, body=None, timeout=20):
    hd = {'User-Agent': UA, 'x-lr-cid': cid}
    data = None
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode('utf-8')
        hd['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, data=data, method='POST' if data is not None else 'GET', headers=hd)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode('utf-8') or 'null') or {}
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode('utf-8')) or {}
        except ValueError:
            return e.code, {}
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        return 0, {'error': str(getattr(e, 'reason', e))}


class Claude:
    def __init__(self, butler, relay: str = RELAY, clock=time.time, timeout: float = TIMEOUT, call=_call):
        self.butler = butler                 # dagj.Butler：用它配对拿到的 cid
        self.relay = relay.rstrip('/')
        self.clock = clock
        self.timeout = timeout
        self.call = call
        self.lock = threading.Lock()
        self.conf_lock = threading.Lock()
        self.slots = threading.BoundedSemaphore(PARALLEL)
        self.cid = None
        self.reset()

    def reset(self):
        self.cache, self.cache_at, self.misses, self.rest_until, self.use_format = None, 0.0, 0, 0.0, True

    def _cid(self):
        p = getattr(self.butler, 'pair_info', None)
        cid = p.get('cid') if p else None
        with self.lock:
            if cid != self.cid:              # 重新配了对 / 撤了：从头来
                self.cid = cid
                self.reset()
        return cid

    def ready(self) -> bool:
        return bool(self._cid()) and self.clock() >= self.rest_until

    def hit(self):
        with self.lock:
            self.misses = 0

    def miss(self) -> bool:
        """没成一张（不算额度歇着的）；连着 3 张歇 5 分钟。-> 这回开始歇了没有"""
        with self.lock:
            if self.clock() < self.rest_until:
                return False
            self.misses += 1
            if self.misses >= MISSES:
                self.rest_until = self.clock() + REST
                self.misses = 0
                return True
            return False

    def _quota(self) -> bool:
        """额度歇着 / 没钥匙：30 分钟里不问。-> 是不是这回才开始歇（日志只说一次）"""
        with self.lock:
            first = self.clock() >= self.rest_until
            self.rest_until = max(self.rest_until, self.clock() + QUOTA_REST)
            self.cache = None
            return first

    def conf(self) -> dict:
        with self.conf_lock:                 # 一批同时开工：只问一次
            if self.cache and self.clock() - self.cache_at < CONF_S:
                return self.cache
            st, j = self.call(self.relay + '/ai/conf', self.cid)
            if st != 200 or not j.get('ok'):
                raise ClaudeMiss(f"中转站 {st or j.get('error')}")
            if not j.get('key'):
                raise ClaudeMiss('中转站上还没 Claude 钥匙', quota=True, first=self._quota())
            if j.get('rest') and j['rest'] > self.clock() * 1000:
                raise ClaudeMiss('Claude 额度歇着', quota=True, first=self._quota())
            l = (j.get('conf') or {}).get('luru') or {}
            self.cache = {'model': str(l.get('model') or DEFAULT['model']), 'effort': str(l.get('effort') or DEFAULT['effort'])}
            self.cache_at = self.clock()
            return self.cache

    def read(self, body: dict, stop: threading.Event | None = None) -> dict:
        """一个 Gemini 请求交给 Claude -> 照 Gemini 的样子回来的 dict；没成抛 ClaudeMiss。"""
        if not self._cid():
            raise ClaudeMiss('没配对')
        with self.slots:
            if stop is not None and stop.is_set():
                raise ClaudeMiss('停了', down=False)
            c = self.conf()
            for _ in range(2):
                fmt = self.use_format
                st, r = self._send(claude_body(body, c, fmt), stop)
                if st == 200:
                    try:
                        return gemini_shape(r)
                    except ValueError as e:
                        raise ClaudeMiss(str(e)[:120], down=False) from None
                if st == 503 and r.get('why') in ('quota', 'nokey'):
                    raise ClaudeMiss('Claude 额度歇着' if r['why'] == 'quota' else '中转站上还没 Claude 钥匙', quota=True, first=self._quota())
                err = r.get('error')
                msg = str(err.get('message') if isinstance(err, dict) else (err or ''))
                if st == 400 and fmt and re.search(r'output_config|format|schema', msg, re.I):
                    self.use_format = False                     # 不认结构化输出：写进提示再来一次
                    continue
                raise ClaudeMiss(f"Claude {st or ''} {r.get('why') or msg}".strip()[:120])
            raise ClaudeMiss('Claude 不认这个格式')

    def _send(self, req, stop):
        url = self.relay + '/ai/messages'
        if stop is None:
            return self.call(url, self.cid, req, self.timeout)
        box = []                             # 点「停止」不能干等：另起一条线发，这边看着停
        t = threading.Thread(target=lambda: box.append(self.call(url, self.cid, req, self.timeout)), daemon=True)
        t.start()
        while t.is_alive():
            if stop.wait(0.5):
                raise ClaudeMiss('停了', down=False)
        return box[0] if box else (0, {'error': '没回'})
