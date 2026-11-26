"""167 认照片先走 Claude API（钥匙在中转站），不成再问大管家，再不成 Gemini（bangong/claude.py + engine.py）。
中转站换成假的（照 luruseng-relay src/ai.js 回）：只换「发给中转站」那一下（Claude(call=…)）。"""
import json
import os
import sys
import threading
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bangong import claude, dagj, engine  # noqa: E402
from test_dagj import REC, answer, fake  # noqa: E402
from test_engine import K1, make_images, reset, server  # noqa: E402,F401
import mock_server  # noqa: E402

CONF = {'luru': {'model': 'claude-opus-5-5', 'effort': 'low'}}


class Relay:
    """假中转站 /ai：mode(第几次, 请求) -> ok / quota / 500 / noformat"""

    def __init__(self, mode=lambda n, body: 'ok', key=True):
        self.mode, self.key = mode, key
        self.conf = 0
        self.msgs = []
        self.cids = []
        self.lock = threading.Lock()

    def __call__(self, url, cid, body=None, timeout=20):
        with self.lock:
            self.cids.append(cid)
            if url.endswith('/ai/conf'):
                self.conf += 1
                return 200, {'ok': True, 'conf': CONF, 'key': self.key, 'rest': None}
            self.msgs.append(body)
            m = self.mode(len(self.msgs), body)
        if isinstance(m, tuple):                 # (状态码, 回答, 回答头)
            return m
        if m == 'quota':
            return 503, {'why': 'quota', 'until': 1}
        if m == '500':
            return 500, {'type': 'error', 'error': {'type': 'api_error', 'message': 'Internal server error'}}
        if m == 'noformat' and body['output_config'].get('format'):
            return 400, {'type': 'error', 'error': {'type': 'invalid_request_error', 'message': 'output_config.format: schema not supported'}}
        assert body['system'][0]['cache_control'] == {'type': 'ephemeral'}
        assert [b['type'] for b in body['messages'][0]['content']][:2] == ['text', 'image']
        text = json.dumps({'title_side': 'top', 'records': [REC]})
        if m == 'noformat':
            text = '好的：\n```json\n' + text + '\n```'
        return 200, {'id': 'msg', 'type': 'message', 'role': 'assistant', 'model': body['model'], 'stop_reason': 'end_turn',
                     'content': [{'type': 'thinking', 'thinking': ''}, {'type': 'text', 'text': text}],
                     'usage': {'input_tokens': 10, 'output_tokens': 5}}


def run(folder, butler, api, keys=(K1,), **kw):
    logs = []
    eng = engine.Engine(str(folder), list(keys), log=logs.append, butler=butler, claude=api, **kw)
    return eng.run(), logs, eng


def test_schema_and_body():
    s = claude.json_schema(engine.SCHEMA)
    assert s['type'] == 'object' and s['additionalProperties'] is False
    assert s['properties']['records']['items']['additionalProperties'] is False
    body = claude.claude_body(engine.build_body(b'x', engine.DEFAULT_MODEL), {'model': 'claude-opus-5-5', 'effort': 'low'})
    assert body['output_config'] == {'effort': 'low', 'format': {'type': 'json_schema', 'schema': s}}
    assert 'thinking' not in body and 'temperature' not in body
    plain = claude.claude_body(engine.build_body(b'x', engine.DEFAULT_MODEL), {'model': 'm', 'effort': 'low'}, False)
    assert 'format' not in plain['output_config'] and '只输出 JSON' in plain['messages'][0]['content'][-1]['text']


def test_api_reads_everything_twice(tmp_path):
    make_images(tmp_path / 'in', 4)
    r = Relay()
    b = fake(tmp_path, lambda body, n: (_ for _ in ()).throw(AssertionError('不该问大管家')))
    res, logs, eng = run(tmp_path / 'in', b, claude.Claude(b, call=r), reads=2)
    assert (res.ok, res.requests, b.calls, len(r.msgs), r.conf) == (4, 0, 0, 8, 1)
    assert not mock_server.STATE['log']
    assert set(r.cids) == {'c' * 22}
    assert all(m['model'] == 'claude-opus-5-5' and m['output_config']['effort'] == 'low' for m in r.msgs)
    assert sum(1 for m in logs if m.startswith('✓') and m.endswith(' · C')) == 4


def test_quota_goes_to_the_butler_and_rests_thirty_minutes(tmp_path):
    make_images(tmp_path / 'in', 3)
    t = [1_000_000.0]
    r = Relay(mode=lambda n, body: 'quota')
    b = fake(tmp_path, lambda body, n: answer(body))
    a = claude.Claude(b, call=r, clock=lambda: t[0])
    res, logs, _ = run(tmp_path / 'in', b, a, reads=2)
    assert res.ok == 3
    assert sum(1 for m in logs if m.endswith(' · 管')) == 3
    assert sum('Claude 先歇着' in m for m in logs) == 1
    asked = len(r.msgs)
    assert 1 <= asked <= 3 and not a.ready()
    t[0] += claude.QUOTA_REST + 1
    assert a.ready()


def test_api_error_butler_then_gemini(tmp_path):
    make_images(tmp_path / 'in', 1)
    r = Relay(mode=lambda n, body: '500')
    b = fake(tmp_path, lambda body, n: (_ for _ in ()).throw(dagj.Miss('大管家不在')))
    res, logs, _ = run(tmp_path / 'in', b, claude.Claude(b, call=r), reads=2)
    assert (res.ok, res.requests) == (1, 2)
    assert any('Claude 没认成' in m and '500' in m for m in logs)
    assert any('大管家没认成' in m for m in logs)
    assert any(m.startswith('✓') and m.endswith(' · G') for m in logs)


def test_three_api_misses_rest_five_minutes(tmp_path):
    n = dagj.BATCH + 3
    make_images(tmp_path / 'in', n)
    t = [1_000_000.0]
    r = Relay(mode=lambda k, body: '500')
    b = fake(tmp_path, lambda body, k: answer(body))
    a = claude.Claude(b, call=r, clock=lambda: t[0])
    res, logs, _ = run(tmp_path / 'in', b, a)
    assert res.ok == n
    assert 3 <= len(r.msgs) <= dagj.BATCH
    assert sum('Claude 连着 3 张' in m for m in logs) == 1
    assert not a.ready()
    t[0] += claude.REST + 1
    assert a.ready()


def test_one_of_two_reads_fails_whole_photo_to_the_butler(tmp_path):
    make_images(tmp_path / 'in', 1)
    r = Relay(mode=lambda n, body: '500' if n == 2 else 'ok')
    b = fake(tmp_path, lambda body, n: answer(body))
    res, logs, _ = run(tmp_path / 'in', b, claude.Claude(b, call=r), reads=2)
    assert (res.ok, len(r.msgs), b.calls) == (1, 2, 2)
    assert any(m.endswith(' · 管') for m in logs)


def test_not_paired_never_asks(tmp_path):
    make_images(tmp_path / 'in', 2)
    r = Relay()
    b = dagj.Butler(str(tmp_path / 'cfg' / 'dagj.json'))
    res, logs, _ = run(tmp_path / 'in', b, claude.Claude(b, call=r))
    assert res.ok == 2 and not r.msgs and not r.conf


def test_no_key_on_the_relay_counts_as_resting(tmp_path):
    make_images(tmp_path / 'in', 1)
    r = Relay(key=False)
    b = fake(tmp_path, lambda body, n: answer(body))
    a = claude.Claude(b, call=r)
    res, logs, _ = run(tmp_path / 'in', b, a)
    assert res.ok == 1 and not r.msgs
    assert any('没 Claude 钥匙' in m for m in logs) and not a.ready()


def test_structured_output_refused_schema_in_words(tmp_path):
    make_images(tmp_path / 'in', 2)
    r = Relay(mode=lambda n, body: 'noformat')
    b = fake(tmp_path, lambda body, n: answer(body))
    a = claude.Claude(b, call=r)
    res, logs, _ = run(tmp_path / 'in', b, a)
    assert res.ok == 2 and a.use_format is False
    assert sum(1 for m in logs if m.endswith(' · C')) == 2


# ---------------------------------------------------------------- 180 限速：429 照 retry-after 等、排回队尾；剩的 token 不够先等
def limited(retry=None, why=None):
    return 429, ({'why': why} if why else {'type': 'error', 'error': {'type': 'rate_limit_error', 'message': 'slow down'}}), \
        ({'retry-after': str(retry)} if retry is not None else {})


class FakeTime:
    """假钟：「睡」就是把钟拨快，睡了多久记下来。"""

    def __init__(self):
        self.now = datetime(2026, 11, 26, 3, 0, 0, tzinfo=timezone.utc).timestamp()
        self.waits = []

    def clock(self):
        return self.now

    def sleep(self, s):
        self.waits.append(round(s, 3))
        self.now += s


def paced(b, r, t):
    return claude.Claude(b, call=r, clock=t.clock, sleep=t.sleep)


def test_429_waits_retry_after_then_claude_reads_it(tmp_path):
    make_images(tmp_path / 'in', 1)
    t = FakeTime()
    r = Relay(mode=lambda n, body: limited(7) if n == 1 else 'ok')
    b = fake(tmp_path, lambda body, n: (_ for _ in ()).throw(AssertionError('不该问大管家')))
    a = paced(b, r, t)
    res, logs, _ = run(tmp_path / 'in', b, a, reads=2)
    assert (res.ok, len(r.msgs), b.calls, a.misses) == (1, 3, 0, 0)
    assert t.waits == [7]
    assert any('限速' in m and '7 秒' in m for m in logs)
    assert not any('没认成' in m for m in logs)
    assert any(m.endswith(' · C') for m in logs)


def test_three_429_on_the_same_photo_then_the_butler(tmp_path):
    make_images(tmp_path / 'in', 1)
    t = FakeTime()
    r = Relay(mode=lambda n, body: limited())
    b = fake(tmp_path, lambda body, n: answer(body))
    a = paced(b, r, t)
    res, logs, _ = run(tmp_path / 'in', b, a, reads=2)
    assert (res.ok, len(r.msgs), a.misses) == (1, 3, 1)
    assert t.waits == [20, 20]
    assert any('429 连撞 3 次' in m for m in logs)
    assert any(m.endswith(' · 管') for m in logs)


def test_relay_daily_limit_is_not_a_rate_limit(tmp_path):
    make_images(tmp_path / 'in', 1)
    t = FakeTime()
    r = Relay(mode=lambda n, body: limited(why='day'))
    b = fake(tmp_path, lambda body, n: answer(body))
    res, logs, _ = run(tmp_path / 'in', b, paced(b, r, t), reads=2)
    assert (res.ok, len(r.msgs), t.waits) == (1, 1, [])
    assert any(m.endswith(' · 管') for m in logs)


def test_not_enough_tokens_left_waits_for_the_reset(tmp_path):
    make_images(tmp_path / 'in', 1)
    t = FakeTime()
    sent = []

    def mode(n, body):
        sent.append(t.now)
        reset = datetime.fromtimestamp(t.now + 30, timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        text = json.dumps({'title_side': 'top', 'records': [REC]})
        return (200, {'type': 'message', 'model': body['model'], 'stop_reason': 'end_turn', 'content': [{'type': 'text', 'text': text}]},
                {'anthropic-ratelimit-input-tokens-remaining': '3000' if n == 1 else '400000', 'anthropic-ratelimit-input-tokens-reset': reset})
    r = Relay(mode=mode)
    b = fake(tmp_path, lambda body, n: (_ for _ in ()).throw(AssertionError('不该问大管家')))
    a = paced(b, r, t)
    res, logs, _ = run(tmp_path / 'in', b, a, reads=2)
    assert res.ok == 1 and any(m.endswith(' · C') for m in logs)
    assert t.waits == [30] and sent[1] - sent[0] == 30           # 第一遍回来说只剩 3000：第二遍等到补满
    make_images(tmp_path / 'more', 1)
    run(tmp_path / 'more', b, a, reads=2)
    assert t.waits == [30]                                       # 剩得多：不等


def test_stop_while_waiting(tmp_path):
    r = Relay(mode=lambda n, body: limited(60))
    b = fake(tmp_path, lambda body, n: answer(body))
    a = claude.Claude(b, call=r)
    stop = threading.Event()
    try:
        a.read(engine.build_body(b'x', engine.DEFAULT_MODEL), stop, lambda s: stop.set())
    except claude.ClaudeMiss as e:
        assert e.down is False
    else:
        raise AssertionError('该停')
    assert len(r.msgs) == 1
