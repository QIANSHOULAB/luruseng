import io
import json
import os
import shutil
import sys
import threading
from datetime import date, datetime, timezone

import pytest
from openpyxl import load_workbook
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bangong import engine  # noqa: E402
import mock_server  # noqa: E402

K1, K2 = 'AIzaKEY1_mock', 'AIzaKEY2_mock'
HEAD = ['No.', 'DATE', 'MACHINE', 'PART NUMBER', 'MO', 'OPR NO.', 'TOOL', None, 'BTMP',
        'CONTAINMENT/SCREENING DETAIL', None, None, 'SHIFT', 'SETTER']
SUB = [None, None, None, None, None, None, 'T NO.', 'DESCRIPTION', None, 'TOTAL SCREENED', 'PASSED', 'FAILED', None, None]


@pytest.fixture(scope='session')
def server():
    srv = mock_server.start()
    engine.API_BASE = f'http://127.0.0.1:{srv.server_address[1]}/v1beta'
    engine.RETRY_WAITS = [0.01, 0.01, 0.01]
    yield srv
    srv.shutdown()


@pytest.fixture(autouse=True)
def reset(server):
    mock_server.STATE.update(modes={}, log=[], inflight=0, peak=0, delay=0.05, once={})


def make_images(folder, n, start=0):
    """第 i 张图宽 800+i 像素：假服务器把宽度填进 OPR NO.，用来核对编号和顺序。"""
    os.makedirs(folder, exist_ok=True)
    paths = []
    for i in range(start, start + n):
        p = os.path.join(folder, f'img_{i:02d}.jpg')
        Image.new('RGB', (800 + i, 600), (i * 7 % 255, 100, 150)).save(p)
        os.utime(p, (1_700_000_000 + i, 1_700_000_000 + i))
        paths.append(p)
    return paths


class FakeClock:
    def __init__(self, t):
        self.t = t
        self.slept = []
        self.hook = None

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.slept.append(s)
        self.t += s
        if self.hook:
            self.hook(self)


def run(folder, keys=(K1,), **kw):
    logs = []
    eng = engine.Engine(str(folder), list(keys), log=logs.append, **kw)
    res = eng.run()
    return res, logs, eng


def sheet(xlsx):
    return load_workbook(xlsx).worksheets[0]


def data_rows(xlsx):
    return [list(r) for r in sheet(xlsx).iter_rows(min_row=4, max_col=15, values_only=True)]


def done_files(folder):
    out = []
    for root, _, files in os.walk(os.path.join(folder, '已识别')):
        out += [os.path.relpath(os.path.join(root, f), folder) for f in files]
    return sorted(out)


def test_twelve_photos_numbered_in_order(tmp_path):
    make_images(tmp_path, 12)
    res, logs, _ = run(tmp_path)
    log = mock_server.STATE['log']
    assert res.ok == 12 and res.records == 12 and res.failed == 0 and res.requests == 12
    assert len(log) == 12 and all(e['key'] == K1 and e['hdr'] is None for e in log)
    assert mock_server.STATE['peak'] <= 5
    g = log[0]['gen']
    assert 'temperature' not in g and set(g['responseSchema']['properties']['records']['items']['required']) == set(engine.FIELDS) | {'unsure'}
    ws = sheet(res.xlsx)
    assert ws.title == 'OCT' and ws['A1'].value == 'TOOL BROKEN RECORD'
    assert [c.value for c in ws[2]][:14] == HEAD and [c.value for c in ws[3]][:14] == SUB
    rows = data_rows(res.xlsx)
    assert [r[0] for r in rows] == list(range(1, 13))                     # 第 N 行 = 第 N 张
    assert [r[5] for r in rows] == [800 + i for i in range(12)]            # 第 N 张的内容进第 N 行
    r = rows[0]
    assert isinstance(r[1], datetime) and (r[1].month, r[1].day) == (10, 28)
    assert r[2:5] == ['VM-07', 'TD-524613-5', 82664580] and r[6:14] == ['T4', 'EM2.5', 1, 1, 1, 0, 'D', '639/Tan Bao Hong']
    assert r[14] is None
    assert ws.cell(row=4, column=2).number_format == 'd-mmm'
    assert ws.cell(row=4, column=9).fill.fgColor.rgb.endswith('FFE699')       # BTMP 黄底
    assert ws.auto_filter.ref == 'A3:N15' and ws.freeze_panes == 'B4'
    run_dirs = os.listdir(tmp_path / '已识别')
    assert len(run_dirs) == 1 and run_dirs[0] in res.xlsx
    run_dir = tmp_path / '已识别' / run_dirs[0]
    assert sorted(os.listdir(run_dir)) == sorted([f'{i + 1:02d}.jpg' for i in range(12)] + ['原图'])     # 印了编号的照片
    assert sorted(os.listdir(run_dir / '原图')) == [f'{i + 1:02d}_img_{i:02d}.jpg' for i in range(12)]  # 原图原封不动
    assert res.photos_dir == str(run_dir)
    assert Image.open(run_dir / '原图' / '01_img_00.jpg').size == (800, 600)
    assert not [f for f in os.listdir(tmp_path) if f.endswith('.jpg')]
    ledger = json.load(open(tmp_path / '识别结果' / engine.LEDGER, encoding='utf-8'))
    assert sorted(v['no'] for v in ledger.values()) == list(range(1, 13))
    assert any('按拍摄顺序编号 1–12' in m for m in logs)
    assert (tmp_path / '识别结果' / '搬工日志.txt').exists()


def test_exif_shot_time_beats_file_time(tmp_path):
    os.makedirs(tmp_path, exist_ok=True)
    for i, (shot, mtime) in enumerate([('2026:10:28 09:00:00', 3), ('2026:10:28 08:00:00', 2), (None, 1)]):
        im = Image.new('RGB', (900 + i, 500), 'white')
        p = tmp_path / f'p{i}.jpg'
        if shot:
            ex = im.getexif()
            ex.get_ifd(0x8769)[36867] = shot
            im.save(p, exif=ex)
        else:
            im.save(p)
        os.utime(p, (1_600_000_000 + mtime, 1_600_000_000 + mtime))      # 没 EXIF 的这张文件时间最早
    order = [os.path.basename(p) for p in engine.scan(str(tmp_path))]
    assert order == ['p2.jpg', 'p1.jpg', 'p0.jpg']


def test_two_records_one_photo_share_its_number(tmp_path):
    make_images(tmp_path, 3)
    mock_server.STATE['delay'] = 0
    mock_server.STATE['once'] = {K1: ('two', 1)}
    res, _, _ = run(tmp_path)
    rows = data_rows(res.xlsx)
    nos = [r[0] for r in rows]
    assert res.records == 4 and len(nos) == 4 and sorted(set(nos)) == [1, 2, 3]
    assert nos == sorted(nos)                                              # 同一张的两条挨着，还是按编号排
    shifts = [r[12] for r in rows]
    assert 'N' in shifts


def test_red_flags_and_notes(tmp_path):
    make_images(tmp_path, 2)
    mock_server.STATE['delay'] = 0
    mock_server.STATE['modes'] = {K1: 'mismatch'}
    res, _, _ = run(tmp_path)
    ws = sheet(res.xlsx)
    for col in (10, 11, 12):
        assert ws.cell(row=4, column=col).fill.fgColor.rgb.endswith('FFC7CE')
    assert 'PASSED 9 + FAILED 0 ≠ TOTAL 10' in ws.cell(row=4, column=15).value
    assert not ws.cell(row=4, column=2).fill.fgColor.rgb.endswith('FFC7CE')


def test_unclear_chars_bad_date_bad_shift(tmp_path):
    make_images(tmp_path, 1)
    mock_server.STATE['modes'] = {K1: 'unclear'}
    res, _, _ = run(tmp_path)
    ws = sheet(res.xlsx)
    assert ws.cell(row=4, column=14).value == '6□9/Tan Bao Hong' and ws.cell(row=4, column=14).fill.fgColor.rgb.endswith('FFC7CE')
    assert ws.cell(row=4, column=2).value == '3□/10' and not ws.cell(row=4, column=2).fill.fgColor.rgb.endswith('FFC7CE')  # 日期不标红
    assert ws.cell(row=4, column=13).fill.fgColor.rgb.endswith('FFC7CE')
    note = ws.cell(row=4, column=15).value
    assert 'DATE' not in note and '日期' not in note and 'SHIFT 不是 D/N' in note and 'SETTER 有看不清的字' in note
    assert ws.title == 'RECORD'                                            # 没有认得出的日期就不按月份起名


def test_label_variants_are_mapped(tmp_path):
    make_images(tmp_path, 1)
    mock_server.STATE['modes'] = {K1: 'aliases'}
    res, _, _ = run(tmp_path)
    r = data_rows(res.xlsx)[0]
    assert r[2:14] == ['VM-07', 'TD-524613-5', 82664580, 150, 'T4', 'EM2.5', 1, 1, 1, 0, 'D', '639/Tan Bao Hong']


def test_photo_with_no_record_keeps_its_row(tmp_path):
    make_images(tmp_path, 3)
    mock_server.STATE['delay'] = 0
    mock_server.STATE['once'] = {K1: ('none', 1)}
    res, _, _ = run(tmp_path)
    rows = data_rows(res.xlsx)
    assert [r[0] for r in rows] == [1, 2, 3]
    empty = [r for r in rows if r[1] is None]
    assert len(empty) == 1 and '没认出刀具破损记录' in empty[0][14]


def test_failed_photo_keeps_its_number_and_stays_for_next_run(tmp_path):
    make_images(tmp_path, 3)
    mock_server.STATE['delay'] = 0
    mock_server.STATE['once'] = {K1: ('garbage', 1)}
    res, _, _ = run(tmp_path)
    assert res.ok == 2 and res.failed == 1
    rows = data_rows(res.xlsx)
    assert [r[0] for r in rows] == [1, 2, 3]
    bad = [r for r in rows if r[14] and '识别失败' in r[14]]
    assert len(bad) == 1 and 'JSON 解析不了' in bad[0][14]
    assert len([f for f in os.listdir(tmp_path) if f.endswith('.jpg')]) == 1
    res2, _, _ = run(tmp_path)
    assert res2.ok == 1 and res2.requests == 1 and [r[0] for r in data_rows(res2.xlsx)] == [1]


def test_rerun_skips_done_even_renamed(tmp_path):
    make_images(tmp_path, 3)
    run(tmp_path)
    mock_server.STATE['log'] = []
    first = [f for f in done_files(tmp_path) if '原图' in f][1]
    shutil.copy(tmp_path / first, tmp_path / '改了名.jpg')
    make_images(tmp_path, 1, start=50)
    res, logs, _ = run(tmp_path)
    assert res.ok == 1 and res.skipped == 1 and len(mock_server.STATE['log']) == 1
    assert any('改了名.jpg 以前干过' in m and '第 2 张' in m for m in logs)
    assert os.path.exists(tmp_path / '已识别' / '重复' / '改了名.jpg')
    assert not [f for f in os.listdir(tmp_path) if f.endswith('.jpg')]


def test_nothing_to_do(tmp_path):
    res, logs, _ = run(tmp_path)
    assert res.requests == 0 and res.xlsx == '' and '没有新图片' in logs[-1]


def test_key1_out_for_day_switches_to_key2(tmp_path):
    make_images(tmp_path, 10)
    mock_server.STATE['modes'] = {K1: 'day'}
    res, logs, eng = run(tmp_path, keys=(K1, K2))
    keys = [e['key'] for e in mock_server.STATE['log']]
    assert res.ok == 10 and keys.count(K2) == 10 and keys.count(K1) <= 5
    assert eng.keys.dead_until[0] > eng.clock() + 60
    assert '钥匙2×10' in logs[-1]


def test_both_out_for_day_waits_until_reset_then_finishes(tmp_path):
    make_images(tmp_path, 7)
    clock = FakeClock(datetime(2026, 10, 29, 8, 0, tzinfo=timezone.utc).timestamp())   # 新加坡 16:00
    mock_server.STATE['modes'] = {K1: 'day', K2: 'day'}

    def reset_quota(c):
        if c.t >= datetime(2026, 10, 30, 7, 0, tzinfo=timezone.utc).timestamp():       # 太平洋午夜
            mock_server.STATE['modes'] = {}
    clock.hook = reset_quota
    res, logs, _ = run(tmp_path, keys=(K1, K2), clock=clock, sleep=clock.sleep)
    assert res.ok == 7 and res.failed == 0
    assert [r[0] for r in data_rows(res.xlsx)] == list(range(1, 8))
    assert any('等到' in m and '额度刷新后接着干' in m for m in logs)
    assert max(clock.slept) > 20 * 3600


def test_minute_limit_waits_then_continues(tmp_path):
    make_images(tmp_path, 3)
    clock = FakeClock(1_800_000_000)
    mock_server.STATE['once'] = {K1: ('minute', 3)}
    res, logs, _ = run(tmp_path, clock=clock, sleep=clock.sleep)
    assert res.ok == 3 and res.failed == 0
    assert clock.slept and max(clock.slept) <= 60


def test_prepay_depleted_stops_at_once(tmp_path):
    make_images(tmp_path, 8)
    mock_server.STATE['modes'] = {K1: 'prepay', K2: 'ok'}
    res, logs, _ = run(tmp_path, keys=(K1, K2))
    assert res.stopped_reason and 'prepayment credits are depleted' in res.stopped_reason
    assert res.ok == 0 and len([f for f in os.listdir(tmp_path) if f.endswith('.jpg')]) == 8
    assert len(mock_server.STATE['log']) <= 5 and res.xlsx == ''


def test_invalid_key_stops(tmp_path):
    make_images(tmp_path, 2)
    mock_server.STATE['modes'] = {K1: 'invalid'}
    res, logs, _ = run(tmp_path)
    assert 'HTTP 400：API key not valid' in res.stopped_reason


def test_server_error_retried(tmp_path):
    make_images(tmp_path, 2)
    mock_server.STATE['once'] = {K1: ('500', 2)}
    res, logs, _ = run(tmp_path)
    assert res.ok == 2 and res.requests == 4


def test_stop_button_marks_unfinished_and_next_run_finishes(tmp_path):
    make_images(tmp_path, 15)
    mock_server.STATE['delay'] = 0.3
    stop = threading.Event()
    threading.Timer(0.45, stop.set).start()
    res, logs, _ = run(tmp_path, stop=stop)
    assert res.stopped_reason == '手动停止' and res.ok < 15
    if res.xlsx:
        rows = data_rows(res.xlsx)
        assert [r[0] for r in rows] == sorted(r[0] for r in rows)
        assert all('未完成' in (r[14] or '') for r in rows if r[1] is None)
    res2, _, _ = run(tmp_path)
    assert res.ok + res2.ok == 15
    assert [r[0] for r in data_rows(res2.xlsx)] == list(range(1, res2.ok + 1))


def test_image_prep_heic_alpha_rotation_large(tmp_path):
    import pillow_heif
    big = tmp_path / 'big.png'
    Image.new('RGBA', (4032, 3024), (0, 0, 0, 0)).save(big)
    out = Image.open(io.BytesIO(engine.prepare_image(str(big))))
    assert out.size == (2048, 1536) and out.getpixel((5, 5)) == (255, 255, 255)
    heic = tmp_path / 'photo.heic'
    pillow_heif.from_pillow(Image.new('RGB', (1000, 500), 'red')).save(str(heic))
    assert Image.open(io.BytesIO(engine.prepare_image(str(heic)))).size == (1000, 500)
    rot = tmp_path / 'rot.jpg'
    im = Image.new('RGB', (600, 300), 'blue')
    exif = im.getexif()
    exif[0x0112] = 6
    im.save(rot, exif=exif)
    assert Image.open(io.BytesIO(engine.prepare_image(str(rot)))).size == (300, 600)


def test_pacific_midnight():
    f = lambda *a: datetime(*a, tzinfo=timezone.utc).timestamp()
    assert engine.next_pacific_midnight(f(2026, 10, 29, 8, 0)) == f(2026, 10, 30, 7, 0) + 30   # 夏令时：新加坡 15:00
    assert engine.next_pacific_midnight(f(2026, 11, 2, 8, 30)) == f(2026, 11, 3, 8, 0) + 30    # 冬令时：新加坡 16:00
    assert engine.next_pacific_midnight(f(2026, 11, 1, 5, 0)) == f(2026, 11, 1, 7, 0) + 30     # 切换当天
    assert engine.next_pacific_midnight(f(2027, 3, 14, 9, 0)) == f(2027, 3, 15, 7, 0) + 30     # 3 月切回夏令时


def test_parse_date_day_first():
    t = date(2026, 10, 29)
    p = lambda s: engine.parse_date(s, t)
    assert p('28/10') == date(2026, 10, 28) and p('1-Oct') == date(2026, 10, 1) and p('01-Oct-26') == date(2026, 10, 1)
    assert p('28-10-26') == date(2026, 10, 28) and p('28.10.2026') == date(2026, 10, 28) and p('2026-10-28') == date(2026, 10, 28)
    assert p('Oct 1') == date(2026, 10, 1) and p('28 Oct') == date(2026, 10, 28) and p('3/1') == date(2026, 1, 3)
    assert p('15/12') == date(2025, 12, 15)                         # 将来的日子算去年
    assert engine.parse_date('15/12', date(2027, 1, 5)) == date(2026, 12, 15)
    assert p('31/02') is None and p('hello') is None and p('') is None


def test_parse_records_variants():
    wrap = lambda t: {'candidates': [{'content': {'parts': [{'text': t}]}, 'finishReason': 'STOP'}]}
    recs = engine.parse_records(wrap('```json\n{"records":[{"DATE":"1-Oct","T NO.":"T4","unsure":["T NO.","bogus"]},{"unsure":["date"]}]}\n```'))
    assert len(recs) == 1 and recs[0]['date'] == '1-Oct' and recs[0]['t_no'] == 'T4' and recs[0]['setter'] == ''
    assert recs[0]['unsure'] == ['t_no']
    assert engine.parse_records(wrap('[]')) == []
    assert engine.parse_records(wrap('{"date":"2/10","shift":"N"}'))[0]['shift'] == 'N'
    with pytest.raises(ValueError):
        engine.parse_records({'promptFeedback': {'blockReason': 'SAFETY'}})


def test_schema_rejected_falls_back_to_plain_json(tmp_path):
    make_images(tmp_path, 6)
    mock_server.STATE['modes'] = {K1: 'noschema'}
    res, logs, _ = run(tmp_path)
    assert res.ok == 6 and res.failed == 0
    assert any('改用纯 JSON' in m for m in logs)
    assert sum(1 for e in mock_server.STATE['log'] if 'responseSchema' not in e['gen']) == 6


def test_model_prefix_and_thinking():
    assert engine.model_name('models/gemini-2.5-flash') == 'gemini-2.5-flash'
    assert engine.build_body(b'x', 'gemini-2.5-flash')['generationConfig']['thinkingConfig'] == {'thinkingBudget': 0}
    g3 = engine.build_body(b'x', 'gemini-3.5-flash-lite')['generationConfig']
    assert 'thinkingConfig' not in g3 and 'temperature' not in g3
    assert engine.build_body(b'x', 'gemini-2.5-flash-lite')['generationConfig']['temperature'] == 0.1


def test_excel_survives_formula_and_control_chars(tmp_path):
    book = engine.RecordBook(str(tmp_path / 'x.xlsx'), today=date(2026, 10, 29))
    rec = {f: '' for f in engine.FIELDS}
    rec.update(machine='=1+1', setter='ok\x07bell', part_number='\x00')
    book.add(1, [rec])
    book.add(2, None, 'HTTP 500：boom\x1f')
    book.save()
    ws = load_workbook(tmp_path / 'x.xlsx').worksheets[0]
    assert ws.cell(row=4, column=3).value == '=1+1' and ws.cell(row=4, column=3).data_type == 's'
    assert ws.cell(row=4, column=14).value == 'okbell'
    assert '识别失败：HTTP 500：boom' in ws.cell(row=5, column=15).value


def _red_box_at(im, box):
    reds = 0
    for x in range(box[0], box[2], 3):
        for y in range(box[1], box[3], 3):
            r, g, b = im.getpixel((x, y))[:3]
            reds += r > 150 and g < 80 and b < 80
    return reds


def test_stamp_goes_to_an_empty_corner(tmp_path):
    src = tmp_path / 'form.jpg'
    im = Image.new('RGB', (1200, 900), 'white')
    from PIL import ImageDraw
    d = ImageDraw.Draw(im)
    for i in range(0, 400, 12):                       # 左上角写满「字」
        d.line([(0, i), (420, i)], fill='black', width=3)
    im.save(src)
    out = tmp_path / '07.jpg'
    engine.stamp_number(str(src), 7, str(out))
    st = Image.open(out).convert('RGB')
    assert st.size == (1200, 900)                      # 有空角就不加白边
    assert _red_box_at(st, (850, 0, 1200, 250)) > 20   # 印在右上角那个空角
    assert _red_box_at(st, (0, 0, 420, 400)) == 0      # 左上角的「字」没被盖
    assert st.getpixel((10, 12))[0] < 80


def test_stamp_adds_a_band_when_every_corner_is_busy(tmp_path):
    import random
    random.seed(1)
    src = tmp_path / 'busy.png'
    im = Image.new('L', (600, 400))
    im.putdata([random.choice((0, 255)) for _ in range(600 * 400)])
    im.convert('RGB').save(src)
    out = tmp_path / '12.jpg'
    engine.stamp_number(str(src), 12, str(out))
    st = Image.open(out).convert('RGB')
    assert st.size[0] == 600 and st.size[1] > 400          # 顶上加了一条白边
    assert _red_box_at(st, (0, 0, 600, st.size[1] - 400)) > 10


def test_stamp_follows_exif_rotation_and_shrinks_huge_photos(tmp_path):
    src = tmp_path / 'rot.jpg'
    im = Image.new('RGB', (5000, 2500), 'white')
    ex = im.getexif()
    ex[0x0112] = 6
    im.save(src, exif=ex)
    out = tmp_path / '01.jpg'
    engine.stamp_number(str(src), 1, str(out))
    assert Image.open(out).size == (1280, 2560)


NAMES = [('639', 'Tan Bao Hong'), ('535', 'GANESAN RANJITH'), ('552', 'PANTHALLA VENUGOPAL'), ('232', 'YANG FAN')]


def test_match_setter_rules():
    m = lambda raw: engine.match_setter(raw, NAMES)
    assert m('535') == ('535/GANESAN RANJITH', '', False)                       # 只写工号：补名字
    assert m('535/Ganesan') == ('535/GANESAN RANJITH', '', False)               # 名字潦草：按名单
    assert m('639 Tan B Hong') == ('639/Tan Bao Hong', '', False)
    v, note, red = m('PANTHALLA VENUGOPAL')                                     # 只写名字：补工号，标红让你看
    assert v == '552/PANTHALLA VENUGOPAL' and red and '工号补成 552' in note
    v, note, red = m('535/YANG FAN')                                            # 工号和名字对不上
    assert v == '535/YANG FAN' and red and '工号 535 在名单上是 GANESAN RANJITH' in note
    v, note, red = m('999/NOBODY HERE')
    assert v == '999/NOBODY HERE' and red and note == 'SETTER 不在名单里'
    assert engine.match_setter('535', []) == ('535', '', False)                 # 没名单：照抄


def test_roster_goes_into_prompt_and_fixes_setter(tmp_path):
    roster = tmp_path / '名单.txt'
    roster.write_text('# 工号/名字\n639/Tan Bao Hong\n535 / GANESAN RANJITH\n\n', encoding='utf-8')
    assert engine.load_names(str(roster)) == [('639', 'Tan Bao Hong'), ('535', 'GANESAN RANJITH')]
    imgs = tmp_path / 'in'
    make_images(imgs, 1)
    mock_server.STATE['modes'] = {K1: 'unclear'}                                # setter 写成 6□9/Tan Bao Hong
    logs = []
    res = engine.Engine(str(imgs), [K1], log=logs.append, names_path=str(roster)).run()
    prompt = mock_server.STATE['log'][0]['sys']
    assert any('名单 2 人' in m for m in logs)
    ws = sheet(res.xlsx)
    assert ws.cell(row=4, column=14).value == '639/Tan Bao Hong'                # □ 按名单补上了
    assert not ws.cell(row=4, column=14).fill.fgColor.rgb.endswith('FFC7CE')
    body = engine.build_body(b'x', 'gemini-3.5-flash-lite', names=engine.load_names(str(roster)))
    assert '535/GANESAN RANJITH' in body['systemInstruction']['parts'][0]['text']
    assert prompt
