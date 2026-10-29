"""假的 Gemini 服务器：按钥匙决定返回什么。单独运行时给 exe 冒烟测试用：python mock_server.py 端口"""
import base64
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

STATE = {'modes': {}, 'log': [], 'inflight': 0, 'peak': 0, 'delay': 0.05, 'once': {}}
LOCK = threading.Lock()


def quota(per):
    qid = {'day': 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
           'minute': 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier'}[per]
    return 429, {'error': {'code': 429, 'status': 'RESOURCE_EXHAUSTED',
                           'message': 'You exceeded your current quota, please check your plan and billing details.',
                           'details': [{'@type': 'type.googleapis.com/google.rpc.QuotaFailure', 'violations': [{'quotaId': qid}]}]}}


def answer(mode, body):
    if mode == 'noschema' and 'responseSchema' in body['generationConfig']:
        return 400, {'error': {'code': 400, 'status': 'INVALID_ARGUMENT', 'message': 'Invalid JSON payload received. Unknown name "responseSchema" at \'generation_config\': Cannot find field.'}}
    parts = body['contents'][0]['parts']
    img = next(p['inline_data']['data'] for p in parts if 'inline_data' in p)
    raw = base64.b64decode(img)
    if mode == 'day':
        return quota('day')
    if mode == 'minute':
        return quota('minute')
    if mode == 'prepay':
        return 429, {'error': {'code': 429, 'status': 'RESOURCE_EXHAUSTED', 'message': 'Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing.'}}
    if mode == 'invalid':
        return 400, {'error': {'code': 400, 'status': 'INVALID_ARGUMENT', 'message': 'API key not valid. Please pass a valid API key.',
                               'details': [{'reason': 'API_KEY_INVALID'}]}}
    if mode == '500':
        return 500, {'error': {'code': 500, 'status': 'INTERNAL', 'message': 'An internal error has occurred.'}}
    if mode == 'garbage':
        text = '这不是 JSON'
    else:
        rows = [['换型检查表'], ['项目', '状态', '备注'], ['开始时间', '8:30', ''], ['字节', str(len(raw)), '√']]
        text = json.dumps({'rows': rows}, ensure_ascii=False)
    return 200, {'candidates': [{'content': {'parts': [{'text': text}]}, 'finishReason': 'STOP'}]}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        u = urlparse(self.path)
        key = parse_qs(u.query).get('key', [''])[0]
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        with LOCK:
            STATE['inflight'] += 1
            STATE['peak'] = max(STATE['peak'], STATE['inflight'])
            once = STATE['once'].get(key)
            mode = STATE['modes'].get(key, 'ok')
            if once and once[1] > 0:          # 前 N 次用 once 模式
                mode = once[0]
                STATE['once'][key] = (once[0], once[1] - 1)
            STATE['log'].append({'key': key, 'path': u.path, 'mode': mode, 'hdr': self.headers.get('x-goog-api-key'),
                                 'sys': body['systemInstruction']['parts'][0]['text'][:10],
                                 'gen': body['generationConfig']})
        try:
            time.sleep(STATE['delay'])
            status, obj = answer(mode, body)
            data = json.dumps(obj, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        finally:
            with LOCK:
                STATE['inflight'] -= 1


def start(port=0):
    srv = ThreadingHTTPServer(('127.0.0.1', port), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


if __name__ == '__main__':
    srv = start(int(sys.argv[1]) if len(sys.argv) > 1 else 8765)
    print('mock on', srv.server_address[1], flush=True)
    while True:
        time.sleep(3600)
