"""089 认照片先问大管家，问不成跳回 Gemini（bangong/dagj.py + engine.py）。大管家换成假的：只换「交给中转站」那一下。"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bangong import dagj, engine  # noqa: E402
from test_engine import K1, make_images, reset, server  # noqa: E402,F401  (假谷歌服务器，跟老测试同一个)
import mock_server  # noqa: E402

REC = {'date': '28/10', 'machine': 'VM-07', 'part_number': 'TD-1', 'mo': '1', 'opr_no': '9', 't_no': 'T4',
       'description': 'EM2.5', 'btmp': '1', 'total_screened': '1', 'passed': '1', 'failed': '0', 'shift': 'D',
       'setter': '639', 'unsure': []}


def answer(body):
    assert body['generationConfig'].get('responseSchema')            # 交的就是要给 Gemini 的那个请求
    assert any('inline_data' in p for p in body['contents'][0]['parts'])
    text = json.dumps({'title_side': 'top', 'records': [REC]})
    return {'candidates': [{'content': {'parts': [{'text': text}]}, 'finishReason': 'STOP'}]}


def fake(tmp_path, read):
    b = dagj.Butler(str(tmp_path / 'cfg' / 'dagj.json'))
    b.pair_info = {'cid': 'c' * 22, 'key': 'A' * 43, 'at': ''}
    b.calls = 0

    def go(body, stop=None):
        b.calls += 1
        return read(body, b.calls)
    b.read = go
    return b


def run(folder, butler, keys=(K1,), **kw):
    logs = []
    eng = engine.Engine(str(folder), list(keys), log=logs.append, butler=butler, **kw)
    return eng.run(), logs, eng


def test_paired_every_photo_goes_to_the_butler_and_says_so(tmp_path):
    make_images(tmp_path / 'in', 4)
    b = fake(tmp_path, lambda body, n: answer(body))
    res, logs, eng = run(tmp_path / 'in', b, reads=2)
    assert (res.ok, res.requests, b.calls) == (4, 0, 8)
    assert not mock_server.STATE['log']                              # Gemini 一次都没问
    assert sum(1 for m in logs if m.startswith('✓') and m.endswith(' · 管')) == 4


def test_a_miss_goes_to_gemini_whole(tmp_path):
    make_images(tmp_path / 'in', 1)

    def read(body, n):
        if n == 1:
            raise dagj.Miss('大管家不在')
        return answer(body)
    res, logs, _ = run(tmp_path / 'in', fake(tmp_path, read), reads=2)
    assert (res.ok, res.requests) == (1, 2)
    assert any('大管家没认成' in m and '大管家不在' in m for m in logs)
    assert any(m.startswith('✓') and m.endswith(' · G') for m in logs)


def test_three_misses_rest_five_minutes(tmp_path):
    make_images(tmp_path / 'in', 7)
    t = [1_000_000.0]
    b = fake(tmp_path, lambda body, n: (_ for _ in ()).throw(dagj.Miss('60 秒没回')))
    b.clock = lambda: t[0]
    res, logs, _ = run(tmp_path / 'in', b)
    assert res.ok == 7
    assert b.calls == 5                                              # 头一批 5 张同时问了；第二批直接 Gemini
    assert sum('5 分钟' in m for m in logs) == 1
    t[0] += 301
    assert b.ready()


def test_no_key_but_paired_still_runs(tmp_path):
    make_images(tmp_path / 'in', 3)

    def read(body, n):
        if n == 2:
            raise dagj.Miss('大管家没回')
        return answer(body)
    res, logs, _ = run(tmp_path / 'in', fake(tmp_path, read), keys=())
    assert (res.ok, res.failed) == (2, 1)
    assert any('没填钥匙' in m for m in logs)


def test_revoked_forgets_the_pairing(tmp_path, monkeypatch):
    p = tmp_path / 'cfg' / 'dagj.json'
    p.parent.mkdir()
    p.write_text(json.dumps({'cid': 'c' * 22, 'key': 'A' * 43, 'at': ''}), encoding='utf-8')
    b = dagj.Butler(str(p))
    changed = []
    b.on_change = lambda: changed.append(b.paired)
    assert b.paired
    monkeypatch.setattr(dagj, '_post', lambda url, body, timeout: (403, {'revoked': True}))
    try:
        b.read({'x': 1})
        raise AssertionError('should miss')
    except dagj.Miss:
        pass
    assert not b.paired and not p.exists() and changed == [False]


def test_pairing_round_trip_with_a_fake_butler(tmp_path, monkeypatch):
    """录入僧这头的配对、加密，跟大管家那头（pc-butler handheld/luru.py）一样的算法：这里照着它造一个假的。"""
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF
    priv = ec.generate_private_key(ec.SECP256R1())
    pub = priv.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    ck = os.urandom(32)

    def post(url, body, timeout):
        if url.endswith('/pair'):
            epk = dagj.unb64u(body['epk'])
            peer = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), epk)
            k = HKDF(algorithm=hashes.SHA256(), length=32, salt=epk, info=b'luru/pair').derive(priv.exchange(ec.ECDH(), peer))
            req = json.loads(AESGCM(k).decrypt(dagj.unb64u(body['n']), dagj.unb64u(body['ct']), b'luru/pair/' + body['cid'].encode()))
            if req['code'] != 'right':
                return 200, {'ok': False, 'wrong': True, 'left': 9}
            n = os.urandom(12)
            ct = AESGCM(k).encrypt(n, json.dumps({'key': dagj.b64u(ck)}).encode(), b'luru/paired/' + body['cid'].encode())
            return 200, {'ok': True, 'n': dagj.b64u(n), 'ct': dagj.b64u(ct)}
        cid = body['cid']
        req = json.loads(AESGCM(ck).decrypt(dagj.unb64u(body['n']), dagj.unb64u(body['ct']), b'luru/ask/' + cid.encode()))
        n = os.urandom(12)
        out = {'ok': True, 'data': answer(req['body'])}
        return 200, {'ok': True, 'n': dagj.b64u(n), 'ct': dagj.b64u(AESGCM(ck).encrypt(n, json.dumps(out).encode(), b'luru/ans/' + cid.encode()))}
    monkeypatch.setattr(dagj, '_get', lambda url, timeout: (200, {'on': True, 'pub': dagj.b64u(pub)}))
    monkeypatch.setattr(dagj, '_post', post)
    b = dagj.Butler(str(tmp_path / 'cfg' / 'dagj.json'))
    assert b.pair('wrong') == {'wrong': True, 'left': 9} and not b.paired
    assert b.pair(' right ') == {'ok': True} and b.paired
    assert dagj.Butler(str(tmp_path / 'cfg' / 'dagj.json')).paired          # 存下了：关了再开还连着
    body = engine.build_body(b'\xff\xd8jpeg', engine.DEFAULT_MODEL)
    assert engine.parse_response(b.read(body))[0][0]['machine'] == 'VM-07'


def test_slow_is_not_down_092(tmp_path, monkeypatch):
    """092：慢不算用不了：504 接着等；一遍没回再交一次；两次都没回才 Miss，而且 down=False（不进连着 3 张）。"""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    ck = os.urandom(32)
    t = [0.0]
    calls = []

    def sleep(s):
        t[0] += s

    def post(url, body, timeout):
        calls.append(t[0])
        t[0] += 75                                        # 中转站 75 秒喊一次超时
        return 504, {'timeout': True}
    monkeypatch.setattr(dagj, '_post', post)
    b = dagj.Butler(str(tmp_path / 'c' / 'dagj.json'), clock=lambda: t[0], sleep=sleep)
    b.pair_info = {'cid': 'c' * 22, 'key': dagj.b64u(ck), 'at': ''}
    try:
        b.read({'x': 1})
        raise AssertionError('should miss')
    except dagj.Miss as e:
        assert e.down is False and '2 次都没回' in str(e)
    assert len(calls) == 8 and t[0] >= 600                # 两遍，每遍 4 次 × 75 秒


def test_down_and_error_092(tmp_path, monkeypatch):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    ck = os.urandom(32)
    b = dagj.Butler(str(tmp_path / 'c' / 'dagj.json'), sleep=lambda s: None)
    b.pair_info = {'cid': 'c' * 22, 'key': dagj.b64u(ck), 'at': ''}
    seq = []

    def put(out):
        n = os.urandom(12)
        return 200, {'ok': True, 'n': dagj.b64u(n), 'ct': dagj.b64u(AESGCM(ck).encrypt(n, json.dumps(out).encode(), b'luru/ans/' + b.pair_info['cid'].encode()))}
    # 不在 -> down
    monkeypatch.setattr(dagj, '_post', lambda u, bd, t: (503, {'off': True}))
    try:
        b.read({}); raise AssertionError
    except dagj.Miss as e:
        assert e.down is True
    # 连不上，隔 5 秒再试还不行 -> down；第二次通了就算成
    monkeypatch.setattr(dagj, '_post', lambda u, bd, t: seq.append(1) or (0, {'error': 'refused'}))
    try:
        b.read({}); raise AssertionError
    except dagj.Miss as e:
        assert e.down is True and len(seq) == 2
    # 回错一次再认一次：第二次好了就成
    outs = [{'ok': False, 'error': 'bad json'}, {'ok': True, 'data': {'d': 1}}]
    monkeypatch.setattr(dagj, '_post', lambda u, bd, t: put(outs.pop(0)))
    assert b.read({}) == {'d': 1}
    # 回错两次 -> Miss down=False
    monkeypatch.setattr(dagj, '_post', lambda u, bd, t: put({'ok': False, 'error': 'bad json'}))
    try:
        b.read({}); raise AssertionError
    except dagj.Miss as e:
        assert e.down is False
    # 明说接不了 -> down
    monkeypatch.setattr(dagj, '_post', lambda u, bd, t: put({'ok': False, 'error': '大管家在陪玩', 'cant': True}))
    try:
        b.read({}); raise AssertionError
    except dagj.Miss as e:
        assert e.down is True


def test_slow_miss_does_not_rest_092(tmp_path):
    make_images(tmp_path / 'in', 7)
    b = fake(tmp_path, lambda body, n: (_ for _ in ()).throw(dagj.Miss('大管家 2 次都没回，换 Gemini', down=False)))
    res, logs, _ = run(tmp_path / 'in', b)
    assert res.ok == 7 and not any('5 分钟' in m for m in logs) and b.misses == 0
