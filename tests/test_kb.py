import os
import sys
from datetime import datetime

import pytest
from openpyxl import Workbook, load_workbook

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bangong import engine, kb  # noqa: E402
import mock_server  # noqa: E402
from test_engine import K1, make_images, server, reset, sheet  # noqa: E402,F401

ROWS = [  # 公司 TOOL BROKEN RECORD 10 月那页的样子
    (datetime(2026, 10, 1), 'VM-07', 'TD-524613-5', 82664580, 150, 'T4', 'EM2.5', 1, 1, 1, 0, 'D', '639/Tan Bao Hong'),
    (datetime(2026, 10, 2), '4X-9', 'TD-HAR8230G', 82665285, 130, 'T2', 'EM6', 4, 4, 4, 0, 'D', '535/GANESAN RANJITH'),
    (datetime(2026, 10, 4), '5X-3', 'AB-5313706C', 82666511, 130, 'T7', 'BU10', 1, 1, 1, 0, 'N', '552/PANTHALLA VENUGOPAL'),
    (datetime(2026, 10, 4), '5X-5', 'AB-5313706C', 82666511, 130, 'T343', 'EM6', 2, 2, 2, 0, 'D', '551/DURGAIYAN SELVAM'),
    (datetime(2026, 10, 4), '4X-8', 'TD-HAR8308G-05', 82665551, 130, 'T3', 'EM1.5', 1, 1, 1, 0, 'D', '535/GANESAN RANJITH'),
    (datetime(2026, 10, 7), '4x-16', 'AB-5067282E', 82665168, 150, 'T9', 'EM1.', 4, 4, 4, 0, 'D', '232/YANG FAN'),
    (datetime(2026, 10, 26), 'VM-07', 'TD-524613-5', 82665807, 150, 'T4', 'EM2.5', 2, 2, 1, 0, 'D', '495/WONG THIAM CHAI'),
    (datetime(2026, 10, 28), '5X-2', 'AB-5086733B', 82666997, 130, 'T12', 'BM1', 1, 1, 1, 0, 'D', '495/WONG THIAM CHAI'),
]


def company_book(path, rows=ROWS, extra_sheet_rows=()):
    wb = Workbook()
    for title, data in (('SEPT', extra_sheet_rows), ('OCT', rows)):
        ws = wb.create_sheet(title)
        ws.merge_cells('A1:L1')
        ws['A1'] = 'TOOL BROKEN RECORD'
        heads = ['DATE', 'MACHINE', 'PART NUMBER', 'MO', 'OPR NO.', 'TOOL', None, 'BTMP',
                 'CONTAINMENT/SCREENING DETAIL', None, None, 'SHIFT', 'SETTER']
        subs = [None, None, None, None, None, 'T NO.', 'DESCRIPTION', None, 'TOTAL SCREENED', 'PASSED', 'FAILED', None, None]
        for c, (h, sub) in enumerate(zip(heads, subs), start=1):
            ws.cell(row=2, column=c, value=h)
            ws.cell(row=3, column=c, value=sub)
        ws.merge_cells('F2:G2')
        ws.merge_cells('I2:K2')
        for r in data:
            ws.append(list(r))
    names = wb.create_sheet('NAME')
    names.append(['EMP NO', 'NAME', 'SHIFT'])
    names.append([576, 'LIN DEFENG', 'D'])
    names.append(['648', 'KARTHIKEYAN', 'D'])
    names.append(['652/Tian Yucheng'])
    names.append([999, 3, 'N'])                       # 不是名字，不能当人
    del wb['Sheet']
    wb.save(path)
    return path


def test_feed_company_book_and_dedupe(tmp_path):
    db = kb.KnowledgeBase(str(tmp_path / 'db.sqlite'))
    book = company_book(tmp_path / 'TOOL BROKEN RECORD.xlsx', extra_sheet_rows=[ROWS[0]])
    r = db.feed(str(book))
    assert r.rows == 9 and r.added == 8 and r.sheets == ['SEPT', 'OCT'] and not r.error   # SEPT 那行跟 OCT 第一行重复
    people = dict(db.load().roster())
    assert people['576'] == 'LIN DEFENG' and people['648'] == 'KARTHIKEYAN' and people['652'] == 'Tian Yucheng'
    assert people['535'] == 'GANESAN RANJITH' and '999' not in people
    again = db.feed(str(book))
    assert again.added == 0 and again.people == 0
    s = db.summary()
    assert s.startswith('数据库：8 条记录') and '机台 7 台' in s


def test_reject_old_xls(tmp_path):
    db = kb.KnowledgeBase(str(tmp_path / 'db.sqlite'))
    (tmp_path / 'old.xls').write_bytes(b'xx')
    assert '另存为 .xlsx' in db.feed(str(tmp_path / 'old.xls')).error


def snapshot(tmp_path):
    db = kb.KnowledgeBase(str(tmp_path / 'db.sqlite'))
    db.feed(str(company_book(tmp_path / 'c.xlsx')))
    return db.load()


def rec(**kw):
    r = dict(zip(engine.FIELDS, ['28/10', 'VM-07', 'TD-524613-5', '82664580', '150', 'T4', 'EM2.5', '1', '1', '1', '0', 'D', '639/Tan Bao Hong']))
    r.update(kw)
    return r


def test_fix_confusable_and_near_values(tmp_path):
    s = snapshot(tmp_path)
    out, fixed, flags = s.fix(rec(machine='VM-O7', part_number='TD-S24613-5', description='EM2.S'))
    assert out['machine'] == 'VM-07' and out['part_number'] == 'TD-524613-5' and out['description'] == 'EM2.5'
    assert set(fixed) == {'machine', 'part_number', 'description'} and not flags
    out, fixed, flags = s.fix(rec(machine='4X-16'))              # 只是大小写不同：直接用库里的写法，不算改
    assert out['machine'] == '4x-16' and not fixed and not flags


def test_flags_against_history(tmp_path):
    s = snapshot(tmp_path)
    _, fixed, flags = s.fix(rec(description='EM6'))             # 这个零件的 T4 以前是 EM2.5
    assert 'T4 以前是 EM2.5' in flags['description'] and not fixed
    _, _, flags = s.fix(rec(part_number='AB-5313706C', t_no='T7', description='BU10', opr_no='130'))
    assert 'MO 82664580 以前对的是 TD-524613-5' in flags['mo']
    _, _, flags = s.fix(rec(opr_no='170'))
    assert '以前的 OPR 是 150' in flags['opr_no']
    _, _, flags = s.fix(rec(machine='ZZ-99', part_number='XY-0001'))
    assert '没见过：ZZ-99' in flags['machine'] and '新零件' in flags['part_number']
    out, fixed, flags = s.fix(rec(mo='82666999', part_number='AB-5313706C', t_no='T7', description='BU10', opr_no='130'))
    assert not flags and out['mo'] == '82666999'                 # 新 MO 不乱改


def test_empty_db_changes_nothing(tmp_path):
    s = kb.KnowledgeBase(str(tmp_path / 'db.sqlite')).load()
    r = rec(machine='ZZ-99')
    assert s.fix(r) == (r, {}, {}) and s.hints() == ''


def test_engine_uses_db_marks_orange_and_feeds_folder(tmp_path):
    feed = tmp_path / '投喂'
    feed.mkdir()
    company_book(feed / 'TOOL BROKEN RECORD.xlsx')
    imgs = tmp_path / 'in'
    make_images(imgs, 2)
    mock_server.STATE['modes'] = {K1: 'confusable'}
    logs = []
    res = engine.Engine(str(imgs), [K1], log=logs.append, kb_path=str(tmp_path / 'db.sqlite'), feed_dir=str(feed)).run()
    assert any(m.startswith('✓ 吃进 TOOL BROKEN RECORD.xlsx') for m in logs)
    assert any(m.startswith('数据库：8 条记录') for m in logs)
    prompt = mock_server.STATE['log'][0]
    ws = sheet(res.xlsx)
    assert ws.cell(row=4, column=3).value == 'VM-07' and ws.cell(row=4, column=3).fill.fgColor.rgb.endswith('FCE4D6')
    assert ws.cell(row=4, column=4).value == 'TD-524613-5' and ws.cell(row=4, column=8).value == 'EM2.5'
    assert 'MACHINE VM-O7→VM-07' in ws.cell(row=4, column=15).value
    # 第二次开工：文件没改，不重吃
    logs2 = []
    make_images(imgs, 1, start=30)
    engine.Engine(str(imgs), [K1], log=logs2.append, kb_path=str(tmp_path / 'db.sqlite'), feed_dir=str(feed)).run()
    assert not any(m.startswith('✓ 吃进') for m in logs2)
    assert prompt


def test_hints_go_into_prompt(tmp_path):
    s = snapshot(tmp_path)
    h = s.hints()
    assert h.startswith('公司记录里出现过的值（数据库 8 条记录）') and 'VM-07' in h and 'TD-HAR8308G-05' in h and 'BU10' in h
    body = engine.build_body(b'x', 'gemini-3.5-flash-lite', names=s.roster(), hints=h)
    text = body['systemInstruction']['parts'][0]['text']
    assert 'TD-HAR8308G-05' in text and '535/GANESAN RANJITH' in text


def test_feed_a_checked_bangong_result(tmp_path):
    """核对过的搬工结果表也能喂（A 列是 No.，B–N 是记录）。"""
    book = engine.RecordBook(str(tmp_path / 'r.xlsx'))
    book.add(1, [dict(rec(), machine='HM-3', part_number='AB-5089924H')])
    book.save()
    db = kb.KnowledgeBase(str(tmp_path / 'db.sqlite'))
    r = db.feed(str(tmp_path / 'r.xlsx'))
    assert r.rows == 1 and r.added == 1
    assert db.load().canon['machine'] == {'HM-3': 'HM-3'}
