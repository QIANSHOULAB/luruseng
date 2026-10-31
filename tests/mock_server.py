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

STATE = {'modes': {}, 'log': [], 'inflight': 0, 'peak': 0, 'delay': 0.05, 'once': {}, 'calls': {}}
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
        with LOCK:                                            # 同一张图第几次被认（测两遍对答案）
            nth = STATE['calls'][width] = STATE['calls'].get(width, 0) + 1
        rec = {'date': '28/10', 'machine': 'VM-07', 'part_number': 'TD-524613-5', 'mo': '82664580',
               'opr_no': str(width), 't_no': 'T4', 'description': 'EM2.5', 'btmp': '1',
               'total_screened': '1', 'passed': '1', 'failed': '0', 'shift': 'D', 'setter': '639/Lee Ah Kow'}
        recs = [rec]
        if mode == 'two':
            recs = [rec, dict(rec, date='1-Oct', t_no='T9', description='EM1.5', btmp='4', total_screened='4', passed='4', shift='N')]
        elif mode == 'none':
            recs = []
        elif mode == 'mismatch':
            recs = [dict(rec, total_screened='10', passed='9', failed='0')]
        elif mode == 'unclear':
            recs = [dict(rec, setter='6□9/Lee Ah Kow', date='3□/10', shift='X')]
        elif mode == 'unsure':
            recs = [dict(rec, machine='VM-99', description='QQ7', btmp='7', setter='777/NEW GUY', unsure=['MACHINE', 'btmp', 'Setter', 'date'])]
        elif mode == 'newsure':
            recs = [dict(rec, machine='VM-99', description='QQ7', setter='777/NEW GUY', unsure=[])]
        elif mode == 'nobtmp':                                # 换刀调试单：单子上没有 BTMP
            recs = [dict(rec, btmp='')]
        elif mode == 'confusable':
            recs = [dict(rec, machine='VM-O7', part_number='TD-S24613-5', description='EM2.S')]
        elif mode == 'flip':                                  # 第 1、3 遍认成 D，第 2 遍认成 N
            recs = [dict(rec, shift='N' if nth == 2 else 'D')]
        elif mode == 'chaos':                                 # 三遍机台各不一样
            recs = [dict(rec, machine=f'VM-0{nth}')]
        elif mode == 'messy':                                 # 格式乱：零件号带空格、刀号混进描述、Φ 写成 ø、班次写「白」
            recs = [dict(rec, part_number='TD-524 613-5', t_no='T9', description='T44. m3 ø6 tap x2', shift='白')]
        elif mode == 'sometimes_none':                        # 第 2 遍什么都没认出来
            recs = [] if nth == 2 else [rec]
        elif mode == 'aliases':
            recs = [{'DATE': '28/10', 'M/C': 'VM-07', 'Part No.': 'TD-524613-5', 'MO': '82664580', 'OPR NO.': '150',
                     'T NO.': 'T4', 'Description': 'EM2.5', 'BTMP': '1', 'Total Screened': '1', 'Passed': '1',
                     'Failed': '0', 'Shift': 'Day', 'Setter': '639/Lee Ah Kow'}]
        side = {'side_right': 'right', 'side_left': '左边', 'side_flip': 'right' if nth != 2 else 'top'}.get(mode, 'top')
        sys_text = body['systemInstruction']['parts'][0]['text']
        if '这种单子还没有定好的表头' in sys_text:          # 自建类别 · 认全部内容
            cols = ['Date', 'M/C No.', 'Qty', 'Remark']
            vals = ['28/10', 'VM-07', str(width), '']
            if mode == 'open_flip' and nth == 2:            # 第 2 遍列名写法不一样、数量也认错
                cols, vals = ['date', 'M/C No', 'QTY', 'Remark'], ['28/10', 'VM-07', '1', '']
            text = json.dumps({'title_side': side, 'columns': cols,
                               'records': [{'values': vals, 'unsure': ['Remark'] if mode == 'open_unsure' else []}]},
                              ensure_ascii=False)
        elif '每条记录填下面这些列' in sys_text and '「' in sys_text:   # 自建类别 · 按定好的列认
            n = len([ln for ln in sys_text.splitlines() if ln.startswith('- c')])
            rec = {f'c{i}': '' for i in range(1, n + 1)}
            got = {'c1': '28/10', 'c2': 'VM-O7' if mode == 'cat_confusable' else 'VM-07', 'c3': str(width)}
            rec.update({k: v for k, v in got.items() if k in rec})
            rec['unsure'] = ['c3'] if mode == 'cat_unsure' else []
            text = json.dumps({'title_side': side, 'records': [rec]}, ensure_ascii=False)
        else:
            text = json.dumps({'title_side': side, 'records': recs}, ensure_ascii=False)
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
