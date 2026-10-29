"""假的 Gemini 服务器：按钥匙决定返回什么。单独运行时给 exe 冒烟测试用：python mock_server.py 端口"""
import base64
import io
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from PIL import Image

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
        width = Image.open(io.BytesIO(raw)).size[0]          # 测试图的宽度 = 编号暗号，用来核对顺序
        rec = {'date': '28/10', 'machine': 'VM-07', 'part_number': 'TD-524613-5', 'mo': '82664580',
               'opr_no': str(width), 't_no': 'T4', 'description': 'EM2.5', 'btmp': '1',
               'total_screened': '1', 'passed': '1', 'failed': '0', 'shift': 'D', 'setter': '639/Tan Bao Hong'}
        recs = [rec]
        if mode == 'two':
            recs = [rec, dict(rec, date='1-Oct', t_no='T9', description='EM1.5', btmp='4', total_screened='4', passed='4', shift='N')]
        elif mode == 'none':
            recs = []
        elif mode == 'mismatch':
            recs = [dict(rec, total_screened='10', passed='9', failed='0')]
        elif mode == 'unclear':
            recs = [dict(rec, setter='6□9/Tan Bao Hong', date='3□/10', shift='X')]
        elif mode == 'unsure':
            recs = [dict(rec, machine='VM-99', description='QQ7', btmp='7', setter='777/NEW GUY', unsure=['MACHINE', 'btmp', 'Setter', 'date'])]
        elif mode == 'newsure':
            recs = [dict(rec, machine='VM-99', description='QQ7', setter='777/NEW GUY', unsure=[])]
        elif mode == 'confusable':
            recs = [dict(rec, machine='VM-O7', part_number='TD-S24613-5', description='EM2.S')]
        elif mode == 'aliases':
            recs = [{'DATE': '28/10', 'M/C': 'VM-07', 'Part No.': 'TD-524613-5', 'MO': '82664580', 'OPR NO.': '150',
                     'T NO.': 'T4', 'Description': 'EM2.5', 'BTMP': '1', 'Total Screened': '1', 'Passed': '1',
                     'Failed': '0', 'Shift': 'Day', 'Setter': '639/Tan Bao Hong'}]
        text = json.dumps({'records': recs}, ensure_ascii=False)
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
