"""拿公司表当规矩把关（Song 2026-11-01 拍板：1A 2A 3A 4A，机台看起来像的就猜）。

名字是编的，机台、零件、工号也都是编的：同事和公司的数据不进 GitHub。
"""
import os
import sqlite3
import sys
from datetime import datetime

from openpyxl import Workbook

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bangong import engine, kb, viewer  # noqa: E402

PEOPLE = [('9471', 'TAN AH MENG'), ('9491', 'GOH KIM SENG'), ('9641', 'ALI BIN OMAR'), ('9556', 'HOO PENG'),
          ('9495', 'NG SOO LAN'), ('9392', 'KOH TECK')]
MACHINES = ['KM-3', 'QM-7', 'QM-8', 'QM-9', 'QM-12', 'QM-14', 'QM-17', '7X-2', '7X-3', 'RM-2']
OPS = [110, 130, 150, 170, 190, 210, 230]
D = datetime(2026, 10, 20)
ROWS = [  # 公司那本里的样子：描述全是简写；工号有的只写号、有的「号/名字」
    (D, 'QM-07', 'PX-101202-5', 90001001, 150, 'T4', 'EM2.5', 1, 1, 1, 0, 'D', '9471/TAN AH MENG'),
    (D, '7X-2', 'KB-7104562B', 90002002, 130, 'T12', 'BM1', 1, 1, 1, 0, 'D', '9495'),
    (D, '7X-2', 'KB-7104562B', 90002002, 130, 'T4', 'EM3', 1, 1, 1, 0, 'N', '9495'),
    (D, 'QM-8', 'KB-7104562B', 90003003, 110, 'T5', 'EM8', 1, 1, 1, 0, 'D', '9491'),
    (D, 'QM-14', 'PX-333-444-01-A', 90004004, 150, 'T7', 'DR2.5', 2, 2, 2, 0, 'N', '9556'),
    (D, 'KM-3', 'KB-7300111C', 90005005, 170, 'T2', 'SD3', 1, 1, 1, 0, 'D', '9392/KOH TECK'),
    (D, 'QM-9', 'KB-7300111C', 90005005, 170, 'T3', 'M4', 1, 1, 1, 0, 'D', '9641'),
    (D, 'QM-12', 'PX-101202-5', 90001001, 130, 'T9', 'EM6', 1, 1, 1, 0, 'N', '9231'),
]


def company_book(path, rows=ROWS):
    """跟公司那本一个样：几页记录 + NAME 页（工号/名字、MACHINE、OPERATION、TOOL、SHIFT 各一列，中间隔着空列）。"""
    wb = Workbook()
    ws = wb.active
    ws.title = 'OCT'
    ws['A1'] = 'TOOL BROKEN RECORD'
    heads = ['DATE', 'MACHINE', 'PART NUMBER', 'MO', 'OPR NO.', 'TOOL', None, 'BTMP',
             'CONTAINMENT/SCREENING DETAIL', None, None, 'SHIFT', 'SETTER']
    subs = [None, None, None, None, None, 'T NO.', 'DESCRIPTION', None, 'TOTAL SCREENED', 'PASSED', 'FAILED', None, None]
    for c, (h, sub) in enumerate(zip(heads, subs), start=1):
        ws.cell(row=2, column=c, value=h)
        ws.cell(row=3, column=c, value=sub)
    for r in rows:
        ws.append(list(r))
    nm = wb.create_sheet('NAME')
    nm.append(['Employee Name / ID', None, 'MACHINE', None, 'OPERATION', None, 'TOOL', None, 'SHIFT'])
    for i in range(max(len(PEOPLE), len(MACHINES))):
        nm.append([f'{PEOPLE[i][0]}/{PEOPLE[i][1]}' if i < len(PEOPLE) else None, None,
                   MACHINES[i] if i < len(MACHINES) else None, None,
                   OPS[i] if i < len(OPS) else None, None, None, None,
                   ['DAY', 'NIGHT'][i] if i < 2 else None])
    wb.save(path)
    return path


def snap(tmp_path):
    db = kb.KnowledgeBase(str(tmp_path / 'db.sqlite'))
    r = db.feed(str(company_book(tmp_path / 'TOOL BROKEN RECORD 2026.xlsx')))
    assert not r.error
    return db, r


def rec(**kw):
    base = {f: '' for f in engine.FIELDS}
    base.update(date='30/10', machine='QM-14', part_number='PX-101202-5', mo='90001001', opr_no='150', t_no='T4',
                description='EM2.5', total_screened='1', passed='1', failed='0', shift='D', setter='9471')
    base.update(kw)
    return base


def test_name_page_lists_are_read_and_shift_words_are_not_people(tmp_path):
    db, r = snap(tmp_path)
    assert r.lists == {'machine': len(MACHINES), 'opr_no': 7}
    assert '认得机台表 10 台、工序表 7 道' in r.line()
    s = db.load()
    roster = dict(s.roster())
    assert roster['9471'] == 'TAN AH MENG' and roster['9392'] == 'KOH TECK'
    assert '110' not in roster and '130' not in roster          # 工序 130 跟班次 NIGHT 隔着空列：不是一个人
    assert s.oprs == {'110', '130', '150', '170', '190', '210', '230'}
    assert s.check_machine and s.known_machine('QM-07') == 'QM-07' and s.known_machine('qm7') == 'QM-7'
    assert s.known_machine('RM-2') == 'RM-2'                     # 机台表上有、记录里没出现过：也算
    assert '9495' in s.setter_ids and '9231' not in s.setter_ids   # 只写工号的：出现过两回以上才算
    assert 'OPR NO.：110、130、150、170、190、210、230' in s.hints()


def test_old_database_gets_lists_and_loses_fake_people(tmp_path):
    book = company_book(tmp_path / 'c.xlsx')
    path = tmp_path / 'db.sqlite'
    with sqlite3.connect(path) as c:                            # 上一版建的库：没有 lists 表，有个凑出来的假人
        c.executescript(kb.SCHEMA.replace('CREATE TABLE IF NOT EXISTS lists (kind TEXT, value TEXT, source TEXT, '
                                          'PRIMARY KEY (kind, value));', ''))
        c.execute("INSERT INTO people VALUES ('130', 'NIGHT', 'c.xlsx')")
        c.execute('INSERT INTO sources VALUES (?, 1, 1, ?, 0)', (str(book), '2026-10-31T08:00:00'))
    s = kb.KnowledgeBase(str(path)).load()
    assert '130' not in dict(s.roster()) and s.oprs and s.known_machine('RM-2')


def test_parts_match_without_dashes_and_b_read_as_13(tmp_path):
    s = snap(tmp_path)[0].load()
    for read, want in (('PX-333-444-01A', 'PX-333-444-01-A'),   # 只差横杠：出现过一回也认
                       ('K13-7104562B', 'KB-7104562B'),          # B 写得像 13
                       ('KB47104562B', 'KB-7104562B'),           # 去掉横杠只差一个字
                       ('KB-7104562D', 'KB-7104562B')):
        out, fixed, flags, _ = s.fix(rec(part_number=read))
        assert out['part_number'] == want and fixed['part_number'] == (read, want, '按数据库改') and not flags
    out, fixed, _, _ = s.fix(rec(part_number='KB-A99999AD'))    # 没见过的零件：照抄，不标
    assert out['part_number'] == 'KB-A99999AD' and 'part_number' not in fixed


def test_machines_known_guessed_or_red(tmp_path):
    s = snap(tmp_path)[0].load()
    out, fixed, flags, extra = s.fix(rec(machine='QM-17'))
    assert out['machine'] == 'QM-17' and not fixed and not flags and not extra['ctx']
    out, fixed, flags, _ = s.fix(rec(machine='QM-O7'))          # 只差易混字：写机台表上的写法
    assert out['machine'] == 'QM-7' and fixed['machine'][2] == '按数据库改'
    out, fixed, flags, extra = s.fix(rec(machine='7K-2'))       # 只差一个字的只有一台：就是它
    assert out['machine'] == '7X-2' and fixed['machine'] == ('7K-2', '7X-2', '公司没有 7K-2，按长得像猜的')
    assert extra['ctx']['machine'] == {'read': '7K-2', 'guess': '7X-2', 'cands': []}
    # QM-2：只差一个字的有好几台（QM-7、QM-8、QM-9、QM-12、RM-2），这个零件以前只上过其中的 QM-8
    out, fixed, flags, extra = s.fix(rec(machine='QM-2', part_number='KB-7104562B'))
    assert out['machine'] == 'QM-8' and 'machine' in fixed
    out, fixed, flags, extra = s.fix(rec(machine='QM-2', part_number='XY-1'))   # 没法猜：标红，列出像的
    assert out['machine'] == 'QM-2' and 'machine' not in fixed
    assert flags['machine'].startswith('MACHINE QM-2 公司没有这台机，可能是：') and len(extra['alts']['machine']) == 4
    out, fixed, flags, _ = s.fix(dict(rec(machine='7X-2'), disputed={'machine': ['7X-2', '7K-2']}))
    assert out['machine'] == '7X-2' and fixed['machine'] == ('7X-2', '7X-2', '几遍认得不一样：7X-2 / 7K-2，公司只有 7X-2')
    assert out['disputed'] == {}


def test_operation_not_in_the_list_is_red_with_lookalikes(tmp_path):
    s = snap(tmp_path)[0].load()
    out, fixed, flags, extra = s.fix(rec(opr_no='140'))
    # 带横的 7 排最前，其次手写易混的（4 跟 9），再按公司表里用得多少
    assert flags['opr_no'] == 'OPR_NO 140 公司没有这道工序，可能是：170 / 190 / 130 / 150'
    assert extra['alts']['opr_no'] == ['170', '190', '130', '150']
    out, fixed, flags, _ = s.fix(dict(rec(opr_no='140'), disputed={'opr_no': ['140', '170']}))
    assert out['opr_no'] == '170' and not flags and fixed['opr_no'][2] == '几遍认得不一样：140 / 170，公司只有 170'
    assert not s.fix(rec(opr_no='130'))[2]


def test_tool_codes_become_company_short_forms(tmp_path):
    s = snap(tmp_path)[0].load()
    assert s.short_desc and {'EM', 'DR', 'SD', 'BM'} <= s.desc_types
    for code, short in (('4FEM-M0300C-0080-04', 'EM3'), ('2CEM-MO3000N-D110-00', 'EM3'), ('CFEM-M0.400C-0110-01', 'EM4'),
                        ('HRDR-M0600DC-0700-00', 'DR6'), ('CZSD-M03000N-0900-00', 'SD3'), ('Φ1.5 FEM', 'EM1.5'),
                        ('Φ4EM-M0250C-0080-06', 'EM2.5')):
        out, fixed, flags, _ = s.fix(rec(description=code))
        assert out['description'] == short and fixed['description'] == (code, short, '照公司简写') and not flags, code
    # 几遍认的前面几个字母不一样（DP 不是刀），拆出来是同一种刀、同一个直径：算对上
    reads = ['HRDR-M0600DC-0700-00', 'HL2DR-M06000C-0700-00', 'HZDP-M06000C-0700-00']
    out, fixed, flags, _ = s.fix(dict(rec(description=reads[0]), disputed={'description': reads}))
    assert out['description'] == 'DR6' and 'description' in fixed and out['disputed'] == {}
    reads = ['4FEM-M0300C-0080-04', '4FEM-M0800C-0080-04']      # 直径对不上：还红着，候选是简写
    out, fixed, flags, extra = s.fix(dict(rec(description=reads[0]), disputed={'description': reads}))
    assert out['description'] == 'EM3' and extra['alts']['description'] == ['EM3', 'EM8']
    assert flags['description'].startswith('DESCRIPTION 几遍认得不一样：EM3 / EM8（单子上的编码：')
    for keep in ('FACEMILL Φ40 R0.8', 'EM8', 'Φ4 FMM X2'):        # 不是编码、本来就是简写、拆不出来：照抄
        out, fixed, _, _ = s.fix(rec(description=keep))
        assert out['description'] == keep and 'description' not in fixed


def test_book_fills_names_flags_strangers_and_looks_across_the_batch(tmp_path):
    db, _ = snap(tmp_path)
    s = db.load()
    book = engine.RecordBook(str(tmp_path / 'r.xlsx'), today=datetime(2026, 11, 1).date(), names=s.roster(), kb=s)
    book.add(1, [rec(machine='QM-2', part_number='K13-7104562B', mo='90002002', setter='9441', opr_no='140')])
    book.add(2, [rec(machine='7X-2', part_number='KB-7104562B', mo='90002002', setter='9491', date='13-51')])
    book.add(3, [rec(machine='QM-14', setter='9556', description='4FEM-M0300C-0080-04', date='30/10')])
    book.save()
    rows = viewer.load_rows(book.path)
    r1, r2, r3 = rows[1][0], rows[2][0], rows[3][0]
    f = engine.FIELDS.index
    # 第 1 张：QM-2 公司没有，同一张 MO 的第 2 张写的是 7X-2 → 7X-2（橙）
    assert r1['values'][f('machine')] == '7X-2' and f('machine') in r1['fixed']
    assert 'MACHINE QM-2→7X-2（公司没有 QM-2，这批同一个 MO 的单子是 7X-2）' in r1['note']
    # 工号 9441 名单上没有：标红，同一个 MO 的 9491 排最前，带横的 7（9471）其次
    assert f('setter') in r1['red'] and r1['alts'][f('setter')] == ['9491/GOH KIM SENG', '9471/TAN AH MENG', '9641/ALI BIN OMAR']
    assert f('opr_no') in r1['red'] and r1['alts'][f('opr_no')][0] == '170'
    assert r1['values'][f('part_number')] == 'KB-7104562B'
    # 第 2 张：号对上自动对名字；日期认不成：标红，候选是这批别的单子的日期
    assert r2['values'][f('setter')] == '9491/GOH KIM SENG' and f('setter') not in r2['red']
    assert f('date') in r2['red'] and r2['alts'][f('date')] == ['30-Oct'] and 'DATE 13-51 认不成日期，可能是：30-Oct' in r2['note']
    # 第 3 张：刀具编码写成简写，原编码在核对提示里
    assert r3['values'][f('description')] == 'EM3' and 'DESCRIPTION 4FEM-M0300C-0080-04→EM3（照公司简写）' in r3['note']
    assert r3['values'][f('setter')] == '9556/HOO PENG' and not r3['red']
    # 核对里点候选：日期填上；SETTER 只打工号也补名字
    out = viewer.edit_cell(book.path, r2['row'], f('date'), '30-Oct', today=datetime(2026, 11, 1).date())
    assert not out['still']
    out = viewer.edit_cell(book.path, r1['row'], f('setter'), '9491', roster=s.roster())
    assert out['value'] == '9491/GOH KIM SENG' and not out['still']


def test_prompt_knows_the_crossed_seven():
    assert '中间再一横的是 7，不是 4' in engine.PROMPT and '拼成一个 H' in engine.PROMPT


def test_no_company_data_no_new_flags(tmp_path):
    """没喂公司表：工号照抄、不标，机台、工序也不把关；只有认不成的日期标红。"""
    book = engine.RecordBook(str(tmp_path / 'r.xlsx'))
    book.add(1, [rec(setter='9441', machine='QM-2', opr_no='140', date='13-51')])
    book.save()
    r = viewer.load_rows(book.path)[1][0]
    f = engine.FIELDS.index
    assert r['red'] == {f('date')} and r['values'][f('setter')] == '9441' and r['note'] == 'DATE 13-51 认不成日期'
