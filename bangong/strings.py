"""录入僧电脑版的界面文字，全在这一个文件，中文、英文各一套（网页版的在 web/strings.js）。

每条一行：键: (中文, 英文)。英文不是翻译，是照英文用户的习惯重写的；英文要分单复数的写成 (单数, 复数)，按 n 挑。
默认英文，第二语言中文（Song 2026-11-03 22:19）。⚙ 设置里切，选过存进 config.json 的 lang；
用过录入僧的老电脑（升级前就有设置）没选过的照旧中文，新装的英文（settings.upgrade）。环境变量 BANGONG_LANG=zh|en 盖过一切（测试用）。
不在这里的：认单子的提示词、写进表里的核对提示（O 列）、表头、文件夹和文件名（待识别、识别结果、名单.txt……）。
那些是给模型、给公司那本表、给老电脑上已有的文件夹的，换语言不动。
"""
from __future__ import annotations

import os
import re

S: dict[str, tuple] = {
    # ---------------------------------------------------------------- 共用
    'name': ('录入僧', 'Luru'),
    'sub': ('施主去玩，贫僧填表', 'Snap the forms. Skip the typing.'),
    'title': ('入我千手院，凡事尽释手；千僧替牛马，施主自风流。', 'QIANSHOU LAB · A thousand monks on the grind, so you don’t have to.'),
    'builtin': ('刀单', 'Tool breakage'),
    'list.sep': ('、', ', '),
    'empty': ('空', 'empty'),
    'lnk.desc': ('刀具破损记录照片识别成 Excel', 'Turns photos of tool breakage records into Excel'),
    'ft.photos': ('照片', 'Photos'),
    'ft.sheets': ('表格（Excel、CSV）', 'Spreadsheets (Excel, CSV)'),
    'ft.all': ('所有文件', 'All files'),

    # ---------------------------------------------------------------- 主窗口
    'app.cat': ('类别', 'Form type'),
    'app.newcat': ('＋ 新建类别', '+ New type'),
    'app.folder': ('图片文件夹', 'Photo folder'),
    'app.pick': ('选照片…', 'Add photos…'),
    'app.key1': ('钥匙 1', 'Key 1'),
    'app.key2': ('钥匙 2（可空）', 'Key 2 (optional)'),
    'app.getKey': ('免费领钥匙', 'Get a key'),
    'app.getKey2': ('再领一把', 'Get another'),
    'app.model': ('模型', 'Model'),
    'app.auto': ('来图就干', 'Auto-start'),
    'app.autoHint': ('（文件夹里一有新照片就自己开工）', '(starts when photos land)'),
    'app.start': ('开始工作', 'Start'),
    'app.stop': ('停止', 'Stop'),
    'app.latest': ('最新结果', 'Latest'),
    'app.all': ('所有结果', 'All results'),
    'app.check': ('核对', 'Review'),
    'app.feed': ('放入样板资料', 'Add samples'),
    'app.statusHead': ('任务状态', 'Status'),
    'app.update': ('新版本', 'Update'),
    'app.updateV': ('新版本 v{v}', 'Update v{v}'),
    'app.names': ('编辑名单', 'Edit roster'),
    'st.queue': ('待识别 {n} 张', ('{n} photo queued', '{n} photos queued')),
    'st.pages': ('{d}/{t} 张', '{d}/{t} photos'),
    'st.copying': ('正在复制…', 'Copying…'),
    'st.stopping': ('正在停…（等手上这几张回来）', 'Stopping… (waiting on the ones in flight)'),
    'st.done': ('干完：成功 {ok} · 失败 {bad}', 'Done: {ok} ok · {bad} failed'),
    'cat.hint.builtin': ('内置 · 专属优化', 'Built-in · tuned for it'),
    'cat.hint.cols': ('自建 · {c} 列 · {n} 条记录', 'Custom · {c} columns · {n} records'),
    'cat.hint.empty': ('自建 · 还没放过表', 'Custom · no samples yet'),
    'names.head': ('名单：{n} 人', ('Roster: 1 person', 'Roster: {n} people')),
    'names.none': ('没有名单', 'No roster'),
    'names.noneHint': ('没有也能用，SETTER 就照单子抄', 'Optional. Without one, SETTER is copied as written.'),
    'names.fromKb': ('其中 {n} 人是样板资料里认识的', '{n} of them known from samples'),
    'names.cat': ('「{cat}」数据库：{n} 条', '“{cat}” database: {n} records'),
    'names.catEmpty': ('「{cat}」还没放过表', '“{cat}” has no samples yet'),
    'names.cols': ('列：{cols}', 'Columns: {cols}'),
    'names.catEmptyHint': ('先认全部内容，改对了点「放入样板资料」，表头就定成它的列', 'It reads everything at first. Fix the result, Add samples, and those headers become its columns.'),
    'pick.title': ('选照片（可以多选）', 'Choose photos (several is fine)'),
    'feed.pickTitle': ('选要放进「{cat}」的表（可以多选）', 'Choose sheets for “{cat}” (several is fine)'),

    # ---------------------------------------------------------------- 日志
    'log.copied': ('✓ 复制了 {n} 张进「{folder}」，原照片还在老地方。点「开始工作」', ('✓ Copied 1 photo into “{folder}”. The original stays put. Hit Start.', '✓ Copied {n} photos into “{folder}”. Originals stay put. Hit Start.')),
    'log.copiedRedo': ('↻ 其中 {n} 张以前干过，⚙ 开着「干过的照片也重干」，照样复制进去了', '↻ {n} of them were done before. Redo old photos is on in ⚙, so they went in anyway.'),
    'log.copiedHad': ('↷ {n} 张「{folder}」里已经有了，没再复制', '↷ {n} already in “{folder}”, not copied again'),
    'log.copiedDone': ('↷ {n} 张以前干过，没再复制：{names}', '↷ {n} done before, not copied: {names}'),
    'log.copyBad': ('✗ {name}：{why}', '✗ {name}: {why}'),
    'log.copyMore': ('✗ 还有 {n} 个也没复制', '✗ {n} more not copied'),
    'copy.notPhoto': ('不是照片', 'not a photo'),
    'copy.cant': ('复制不了：{e}', 'can’t copy: {e}'),
    'log.copyFail': ('✗ 复制不进 {folder}：{e}', '✗ Can’t copy into {folder}: {e}'),
    'log.moved': ('搬过来：{x}', 'Moved over: {x}'),
    'log.oldMoved': ('旧文件夹挪到：{d}', 'Old folder moved to: {d}'),
    'log.oldStuck': ('旧文件夹没搬完：{e}', 'Old folder not fully moved: {e}'),
    'log.updated': ('✓ 换上新版 v{v}', '✓ Updated to v{v}'),
    'log.autoOn': ('来图就干：开着。往文件夹里放照片，30 秒内放完它就自己开工。', 'Auto-start is on. Drop photos in the folder; it starts 30 seconds after the last one lands.'),
    'log.noKey': ('✗ 先填钥匙。还没有？点钥匙框后面的「免费领钥匙」，两分钟的事，一分钱不花', '✗ Add a key first. Don’t have one? Hit Get a key. Two minutes, zero dollars.'),
    'log.sameKey': ('✗ 两个钥匙填的是同一把（额度按项目算，同一把没意义）', '✗ Both boxes hold the same key. Quota is per project, so a second copy buys nothing.'),
    'log.autoGo': ('▶ 来图就干：发现新照片，自己开工', '▶ Auto-start: new photos found, starting.'),
    'log.crash': ('✗ 程序出错：{e}', '✗ Something broke: {e}'),
    'log.noResult': ('还没有结果：先点「选照片…」，再点「开始工作」干一批', 'No results yet. Click Add photos…, then Start.'),
    'log.feedStart': ('开始把 {n} 本表放进「{cat}」的数据库…', ('Adding 1 sheet to the “{cat}” database…', 'Adding {n} sheets to the “{cat}” database…')),
    'log.newCols': ('「{cat}」多了这些列：{cols}', '“{cat}” gained columns: {cols}'),
    'log.feedErr': ('✗ 放入样板资料出错：{e}', '✗ Adding samples failed: {e}'),
    'log.dropHere': ('（也可以把表丢进：{dir}）', ' (or drop sheets into: {dir})'),
    'log.dbErr': ('「{cat}」的数据库打不开：{e}', 'Can’t open the “{cat}” database: {e}'),
    'log.checkedErr': ('✗ 核完的那条放不进样板资料：{e}', '✗ Couldn’t add the checked row to samples: {e}'),
    'log.hidden': ('窗口收起来了，后台照样盯着文件夹。真要退出：去掉「来图就干」的勾再点 ×（或者在右上角 ⚙ 里关掉「点 × 只收起」）。',
                   'Window tucked away; still watching the folder. To really quit, untick Auto-start and click × (or turn off “× just minimises” in ⚙).'),
    'log.bgErr': ('后台出错：{e}', 'Background task failed: {e}'),
    'log.refused': ('方丈网盘暂时不收（{why}），东西先攒在本机，过一阵自己再发', 'The abbot’s drive isn’t taking uploads right now ({why}). Keeping things here and retrying later.'),
    'log.refusedFull': ('今天收满了', 'full for today'),
    'log.refusedToken': ('接口换了，等新版', 'endpoint changed, waiting for an update'),
    'rep.status': ('发给方丈：这次开着送出去 {n} 份，', 'Sent to the abbot this session: {n}. '),
    'rep.left': ('还有 {n} 份在路上', '{n} still queued'),
    'rep.none': ('没有欠账', 'Nothing pending'),
    'log.badNew': ('✗ 新版 {name} 打不开，没换', '✗ The new version {name} won’t open, so no swap.'),
    'log.swapping': ('发现新版 v{v}，换上后自己重开', 'New version v{v} found. Swapping it in and restarting.'),
    'upd.dev': ('网站上最新是 v{v}（这是开发版，不下载）', 'Latest on the site is v{v} (dev build, not downloading)'),
    'upd.downloaded': ('新版 v{v} 下载好了，空闲时自己换上', 'v{v} downloaded. It swaps in when things are quiet.'),
    'upd.latest': ('已经是最新版 v{v}', 'Already up to date (v{v})'),
    'upd.available': ('有新版本 v{v}', 'v{v} is available'),
    'upd.err': ('查不到新版：{e}', 'Couldn’t check for updates: {e}'),
    'upd.found': ('发现新版 v{v}，正在下载…', 'New version v{v} found, downloading…'),
    'upd.downloading': ('正在下载…', 'Downloading…'),
    'upd.progress': ('正在下载… {n} / {t} MB', 'Downloading… {n} / {t} MB'),
    'upd.now': ('新版 v{v} 下载好了，马上换上（正在干活的话干完这批再换）', 'v{v} downloaded. Swapping in now (or right after the current batch).'),
    'upd.fail': ('下载失败：{e}（过一会儿再点一次）', 'Download failed: {e} (try again in a bit)'),
    'upd.devNo': ('这是开发版，不下载', 'Dev build, not downloading'),
    'log.redoOn': ('↻ 干过的照片也重干：开了。以前认过的照片再放进待识别，照样认一遍（钥匙次数照扣），测完记得关', '↻ Redo old photos: on. Photos read before get read again, on your quota. Switch it off when you’re done testing.'),
    'log.redoOff': ('干过的照片也重干：关了，以前干过的照旧自动跳过', 'Redo old photos: off. Repeats get skipped again.'),
    'log.reportOn': ('✓ 发数据给方丈：开了。每批认完，照片和认的过程自己送去方丈网盘；在表里改完存个盘，改过的格子也一起送去',
                     '✓ Send data to the abbot: on. After each batch, the photos and how they were read go to the abbot’s drive. Fix cells in the sheet and save, and those fixes go too.'),
    'log.reportOff': ('发数据给方丈：关了，一个字都不往外送了', 'Send data to the abbot: off. Nothing leaves this computer now.'),
    'log.pingOk': ('✓ 方丈网盘连上了', '✓ Connected to the abbot’s drive'),
    'log.pingBad': ('现在连不上方丈网盘（{why}）。东西先攒在本机，连上了自己发', 'Can’t reach the abbot’s drive ({why}). Keeping things here; they’ll go once it connects.'),
    'log.queued': ('↗ 这批的照片和认的过程排好队了，闲下来就送去方丈网盘（⚙ 里能关）', '↗ This batch’s photos and reading log are queued for the abbot’s drive (turn off in ⚙).'),
    'log.namesSaved': ('✓ 名单存好了：{n} 人', ('✓ Roster saved: 1 person', '✓ Roster saved: {n} people')),
    'log.namesEmpty': ('名单是空的：没有也能用，SETTER 就照单子抄', 'Roster is empty. That’s fine: SETTER gets copied as written.'),
    'log.autoUpdOn': ('自动更新打开了：以后有新版自己下载、空闲时换上（⚙ 里可以关）', 'Auto-update is on: new versions download and swap in when things are quiet (turn off in ⚙).'),
    'log.langBusy': ('正在干活：干完这批再换语言', 'Busy with a batch. Switch languages once it’s done.'),

    # 干活（engine.py）
    'eng.waitLong': ('⏸ {why}，等到 {when} 额度刷新后接着干（约 {h} 小时）', '⏸ {why}. Waiting until {when} for the quota to reset (about {h} h)'),
    'eng.wait': ('⏸ {why}，等 {s} 秒', '⏸ {why}. Waiting {s}s'),
    'eng.allKeys': ('所有钥匙额度都用完了', 'All keys are out of quota'),
    'eng.perMinute': ('每分钟次数到顶', 'Per-minute limit hit'),
    'eng.dayOut': ('钥匙{i} 今天的额度用完了 · {raw}', 'Key {i} is out of quota for today · {raw}'),
    'eng.prepay': ('钥匙{i} · {raw}（账单账户预付余额用完，等也没用）', 'Key {i} · {raw} (prepaid billing balance is empty, waiting won’t help)'),
    'eng.keyBad': ('钥匙{i} · {raw}', 'Key {i} · {raw}'),
    'eng.schema': ('模型不认结构化输出格式，改用纯 JSON 提示重试 · {raw}', 'Model rejected structured output, retrying with plain JSON · {raw}'),
    'eng.retry': ('{name} · {raw} · {w} 秒后重试', '{name} · {raw} · retrying in {w}s'),
    'eng.noKey': ('✗ 没填钥匙', '✗ No key'),
    'eng.dbErr': ('数据库打不开，这次不用它：{e}', 'Can’t open the database, skipping it this time: {e}'),
    'eng.tableDbErr': ('「{name}」的数据库打不开，这次不用它：{e}', 'Can’t open the “{name}” database, skipping it this time: {e}'),
    'eng.dup': ('↷ {name} 以前干过（{xlsx} 第 {no} 张），挪进 已识别\\{dup}', '↷ {name} was done before ({xlsx}, #{no}). Moved to 已识别\\{dup}'),
    'eng.redoing': ('↻ {n} 张以前干过，⚙ 开着「干过的照片也重干」，这回照样认（钥匙次数照扣）：{names}', '↻ {n} done before. Redo old photos is on in ⚙, so they’re read again (on your quota): {names}'),
    'eng.nothing': ('文件夹里没有新图片，收工。', 'No new photos in the folder. Done.'),
    'eng.what.builtin': ('，类别「刀单」', ', type: Tool breakage'),
    'eng.what.names': ('，名单 {n} 人', ', roster: {n}'),
    'eng.what.noNames': ('，没找到名单', ', no roster found'),
    'eng.what.cat': ('，类别「{cat}」', ', type: {cat}'),
    'eng.what.open': ('（还没定列：认全部内容）', ' (no columns yet, reading everything)'),
    'eng.what.cols': ('（{n} 列）', ' ({n} columns)'),
    'eng.start': ('▶ 开工（录入僧 v{v}）：{n} 张，按拍摄顺序编号 1–{n}，每批 {batch} 张，模型 {model}{twice}{what}', '▶ Starting (Luru v{v}): {n} photos, numbered 1–{n} by time taken, {batch} at a time, model {model}{twice}{what}'),
    'eng.twice': ('，每张认两遍对答案', ', each read twice and cross-checked'),
    'eng.stampErr': ('{tag} 编号照片没印成：{e}', '{tag} couldn’t stamp the number: {e}'),
    'eng.ok': ('✓ {tag} {name} · {n} 条', ('✓ {tag} {name} · 1 record', '✓ {tag} {name} · {n} records')),
    'eng.halted': ('■ 停工：{why}', '■ Stopped: {why}'),
    'eng.stopped': ('■ 已停止，没干完的下次接着干', '■ Stopped. The rest picks up next time.'),
    'eng.reportErr': ('给方丈的记录没写成（不耽误干活）：{e}', 'Couldn’t write the abbot’s report (work carries on): {e}'),
    'eng.used': ('钥匙{i}×{n}', 'key {i}×{n}'),
    'eng.sum': ('{mark} 成功 {ok} 张（{rec} 条记录）· 失败 {bad} 张 · {req} 次请求{used}', '{mark} {ok} ok ({rec} records) · {bad} failed · {req} requests{used}'),
    'eng.sumXlsx': ('\n结果：{xlsx}', '\nResult: {xlsx}'),

    # 数据库（kb.py、tables.py）、读表（sheets.py）
    'kb.empty': ('数据库还是空的：点「放入样板资料」喂几本改对的刀单表，喂得越多它越不瞎', 'Database is empty. Feed it a few corrected sheets with Add samples; the more it sees, the less it guesses.'),
    'kb.sum': ('数据库：{n} 条记录 · 机台 {m} 台 · 零件 {p} 种 · 刀具描述 {d} 种 · 认识 {people} 人', 'Database: {n} records · {m} machines · {p} parts · {d} tool descriptions · {people} people'),
    'kb.fed': ('✓ 吃进 {src}：读到 {rows} 行记录，新增 {added} 行（其余以前吃过）', '✓ Took in {src}: {rows} rows read, {added} new (the rest were already in)'),
    'kb.people': ('，新认识 {n} 人', ', {n} new people'),
    'kb.lists': ('，认得{got}', ', learned {got}'),
    'kb.list.machine': ('机台表 {n} 台', 'machine list ({n})'),
    'kb.list.opr_no': ('工序表 {n} 道', 'process list ({n})'),
    'kb.sheets': ('（{s}）', ' ({s})'),
    'kb.bad': ('✗ {src}：{why}', '✗ {src}: {why}'),
    'kb.notTool': ('这本不像刀单：没找到 DATE、MACHINE 那样的表头，一条没吃。是别的单子的话，放进它自己的类别', 'Doesn’t look like a tool breakage sheet (no DATE or MACHINE header), so nothing was taken. If it’s another form, add it to its own type.'),
    'kb.noHead': ('没找到表头和记录（表头要在前 15 行，至少两列）', 'No headers or rows found (headers must be in the first 15 rows, at least two columns).'),
    'tbl.empty': ('「{name}」还没放过表：先认全部内容，改对了点「放入样板资料」，表头就定成这个类别的列', '“{name}” has no samples yet. It reads everything at first; fix the result, Add samples, and those headers become its columns.'),
    'tbl.sum': ('「{name}」数据库：{n} 条记录 · {c} 列（{cols}{more}）', '“{name}” database: {n} records · {c} columns ({cols}{more})'),
    'name.empty': ('名字不能空着', 'Give it a name.'),
    'name.long': ('名字太长了（最多 {max} 个字）', 'Too long ({max} characters max).'),
    'name.chars': ('名字里不能有 \\ / : * ? " < > | 这些符号', 'No \\ / : * ? " < > | in the name.'),
    'name.reserved': ('Windows 不让用这个名字', 'Windows won’t allow that name.'),
    'name.taken': ('已经有「{n}」了', '“{n}” already exists.'),
    'sheet.unsupported': ('只认 .xlsx、.xlsm、.xls 和 .csv（照片、PDF、Word 不吃：数据库只认人核对过的表）', 'Only .xlsx, .xlsm, .xls and .csv. No photos, PDFs or Word files: the database only takes checked sheets.'),
    'sheet.notExcel': ('不是 Excel 文件，打不开：用 Excel 打开看看，能打开就另存为 .xlsx 再放', 'Not an Excel file. Try opening it in Excel; if that works, save as .xlsx and add it again.'),
    'sheet.web': ('这个文件其实是网页导出的（HTML/XML），不是真 Excel：用 Excel 打开，另存为 .xlsx 再放', 'This is really a web export (HTML/XML), not Excel. Open it in Excel, save as .xlsx and add it again.'),
    'sheet.locked': ('这本表加了密码，打不开：用 Excel 打开、去掉密码另存一份再放', 'This sheet is password-protected. Remove the password in Excel, save a copy and add that.'),
    'sheet.broken': ('这本表坏了，打不开：用 Excel 打开看看，能打开就另存为 .xlsx 再放', 'This sheet is damaged. Try opening it in Excel; if that works, save as .xlsx and add it again.'),
    'sheet.cant': ('读不了：{e}', 'Can’t read it: {e}'),

    # ---------------------------------------------------------------- ⚙ 设置
    'set.title': ('设置', 'Settings'),
    'set.lang': ('语言', 'Language'),
    'set.langD': ('换了马上生效；正在干活的话等这批干完', 'Takes effect right away, or after the current batch'),
    'set.ver': ('录入僧 v{v}', 'Luru v{v}'),
    'set.sign': ('千手院方丈释手', 'Made by Abbot Shishou'),
    'set.contact': ('要什么新功能、有修改建议，或洽谈商业合作请直接找方丈飞鸽传书：{mail}', 'Feature ideas, complaints or business inquiries? Send the abbot a carrier pigeon: {mail}'),
    'set.hubLine': ('千手院总舵：', 'More monks at '),
    'set.copied': ('{mail}　已复制，粘进邮箱找方丈算账', '{mail} copied. Paste it into an email and give the abbot an earful.'),
    'set.done': ('完成', 'Done'),
    'set.check': ('检查新版', 'Check for updates'),
    'set.mail': ('方丈邮箱', 'Email the abbot'),
    'set.hub': ('千手院总舵', 'QIANSHOU LAB'),
    'set.checking': ('正在查…', 'Checking…'),
    'row.startup': ('开机自动启动', 'Start with Windows'),
    'row.startup.d': ('开机后在后台挂着（收在任务栏），「来图就干」不用等你打开', 'Runs in the background after boot (in the taskbar), so Auto-start works without opening it.'),
    'row.hide_on_close': ('点 × 只收起', '× just minimises'),
    'row.hide_on_close.d': ('开着「来图就干」时，点 × 收进任务栏，后台照样盯着文件夹', 'With Auto-start on, × tucks it into the taskbar and it keeps watching the folder.'),
    'row.auto_open': ('干完自动打开', 'Open review when done'),
    'row.auto_open.d': ('手动点「开始工作」干完后，自动打开核对窗口，点格子就能改', 'After a batch you started yourself, the review window opens. Click any cell to fix it.'),
    'row.keep_originals': ('保留原图', 'Keep originals'),
    'row.keep_originals.d': ('原片留在「已识别 › 批次 › 原图」；关掉就扔进回收站，省一半硬盘', 'Originals stay in 已识别 › batch › 原图. Off sends them to the Recycle Bin and saves half the disk.'),
    'row.auto_update': ('自动更新', 'Auto-update'),
    'row.auto_update.d': ('开着：有新版自己下载、空闲时换上。关着：只提醒你有新版、更新了啥，你点了才换', 'On: new versions download and swap in when idle. Off: you hear what’s new and update when you say so.'),
    'row.remember_keys': ('记住钥匙', 'Remember keys'),
    'row.remember_keys.d': ('钥匙存在这台电脑上，下次不用再填；公用电脑就关掉', 'Keys stay on this computer so you don’t paste them again. Turn off on shared computers.'),
    'row.shortcuts': ('桌面和开始菜单图标', 'Desktop & Start menu icons'),
    'row.shortcuts.d': ('在桌面和开始菜单放「录入僧」的图标', 'Puts a Luru icon on the desktop and in the Start menu.'),
    'row.redo': ('干过的照片也重干', 'Redo old photos'),
    'row.redo.d': ('测试用：以前认过的照片再放进来照样认一遍，钥匙次数照扣；平时关着，干过的自动跳过', 'For testing: photos read before get read again, on your quota. Off means repeats are skipped.'),
    'row.report': ('发数据给方丈', 'Send data to the abbot'),
    'row.report.d': ('每批认完，照片、认的过程、你改过的格子都送去方丈网盘，方丈闭关对答案，下回少认错几个字', 'After each batch, photos, the reading log and your fixes go to the abbot’s drive. He checks the answers in monk mode, so it misreads less next time.'),

    # ---------------------------------------------------------------- 小卡片
    'cancel': ('取消', 'Cancel'),
    'save': ('存好', 'Save'),
    'done': ('完成', 'Done'),
    'new.title': ('新建类别', 'New form type'),
    'new.name': ('名字', 'Name'),
    'new.para': ('比如「质检单」「送货单」。建好会多一个文件夹 {root}\\<名字>，它自己的数据库和投喂文件夹都在里面，跟刀单互不串味。',
                 'Like “QC check” or “Delivery note”. It gets its own folder, {root}\\<name>, with its own database and feed folder, kept apart from tool breakage.'),
    'new.ok': ('建好', 'Create'),
    'new.err': ('建不了：{e}', 'Can’t create it: {e}'),
    'names.title': ('名单', 'Roster'),
    'names.para': ('一行一个「工号/名字」，比如 639/Lee Ah Kow。单子上只写了工号的，贫僧照这个把名字补上。没有也能用。', 'One “ID/Name” per line, like 639/Lee Ah Kow. When a form only has the ID, the monk fills in the name. Optional.'),
    'names.err': ('存不了：{e}', 'Can’t save: {e}'),
    'res.title': ('所有结果', 'All results'),
    'res.empty': ('还没有结果：先点「选照片…」，再点「开始工作」干一批。', 'No results yet. Click Add photos…, then Start.'),
    'res.tag': ('{cat} · {n} 张', ('{cat} · 1 photo', '{cat} · {n} photos')),
    'res.latest': ('　最新', ' · latest'),
    'res.check': ('核对', 'Review'),
    'res.open': ('打开表', 'Open sheet'),
    'res.older': ('更早的 {n} 批在结果文件夹里。', ('1 older batch is in the results folder.', '{n} older batches are in the results folder.')),
    'res.folder': ('打开结果文件夹', 'Open results folder'),
    'feed.title': ('放入样板资料', 'Add samples'),
    'feed.into': ('放进', 'Into'),
    'feed.go': ('选表放进去', 'Choose sheets'),
    'feed.desc.builtin': ('改对的刀单表，人工录的、录入僧认完改好的都行，一次能塞好几本。\nExcel（.xlsx、.xls）、CSV 都行。\n不像刀单的表（没有 DATE、MACHINE 表头）一条都不吃，免得别的单子串进来。\n',
                          'Corrected tool breakage sheets, typed by hand or fixed after Luru read them. Several at once is fine.\nExcel (.xlsx, .xls) or CSV.\nSheets without DATE and MACHINE headers are ignored, so other forms don’t leak in.\n'),
    'feed.desc.cat': ('认完、改对了的「{cat}」结果表（录入僧出的那本就行），可以一次选好几本。\nExcel（.xlsx、.xls）、CSV 都行。\n',
                      'Corrected “{cat}” result sheets (the one Luru made is fine). Several at once is fine.\nExcel (.xlsx, .xls) or CSV.\n'),
    'feed.desc.cols': ('现在的列：{cols}。表里多出来的列会接在后面。\n', 'Current columns: {cols}. Extra columns get added at the end.\n'),
    'feed.desc.first': ('第一本的表头会定成「{cat}」的列。\n', 'The first sheet’s headers become the “{cat}” columns.\n'),
    'feed.desc.drop': ('也可以把表直接丢进 {dir}，每次开工前自动吃。', 'Or drop sheets straight into {dir}; they’re taken in before each run.'),
    'upd.title': ('录入僧 v{v} 搞出来了', 'Luru v{v} is out'),
    'upd.old': ('（你那 v{v} 该淘汰了）', '(Your v{v} has had a good run.)'),
    'upd.what': ('这次弄了点啥：', 'What’s new:'),
    'upd.fetching': ('正在拿更新说明…', 'Fetching the notes…'),
    'upd.calm': ('放心，换版本不会动你的设置、数据库和照片。更新完自己重启一下。\n如果想要什么新花样，或者觉得哪里反人类，直接发邮件找我算账：',
                 'Updating won’t touch your settings, database or photos. It restarts itself when done.\nWant something new, or found something that drives you up the wall? Email me and let me have it:'),
    'upd.btnNow': ('现在更新', 'Update now'),
    'upd.btnAlways': ('以后都自动更新', 'Always update'),
    'upd.btnLater': ('以后再说', 'Later'),
    'upd.noNotes': ('这次没写更新说明。', 'No notes this time.'),

    # ---------------------------------------------------------------- 核对窗口
    'view.title': ('核对', 'Review'),
    'view.titleN': ('核对 · 第 {no} 张 / 共 {n} 张', 'Review · {no} of {n}'),
    'view.none': ('还没有编号照片：先点「开始工作」干一批。', 'No numbered photos yet. Hit Start to run a batch.'),
    'view.run': ('{when} 这批（{n} 张）', ('{when} · 1 photo', '{when} · {n} photos')),
    'view.prev': ('◀ 上一张', '◀ Prev'),
    'view.go': ('看', 'Go'),
    'view.next': ('下一张 ▶', 'Next ▶'),
    'view.open': ('打开表', 'Open sheet'),
    'view.gone': ('这批的表找不到了（挪走或者删了？）', 'Can’t find this batch’s sheet (moved or deleted?)'),
    'view.noSuch': ('没有第 {t} 张（这批是 {a}–{b}）', 'No #{t} here (this batch is {a}–{b})'),
    'view.typeNo': ('先输入编号', 'Type a number first'),
    'view.pos': ('第 {no} 张 / 共 {n} 张　←→ 翻页，双击看大图，点格子改', '{no} of {n} · ←→ flip · click a cell to edit'),
    'view.cantOpen': ('第 {no} 张打不开：{e}', 'Can’t open #{no}: {e}'),
    'view.rotErr': ('转不了：{e}', 'Couldn’t rotate: {e}'),
    'view.noRec': ('表里没有这一号的记录。', 'No rows for this number.'),
    'view.recN': ('　第 {k} 条', ' · record {k}'),
    'view.busy': ('这批还在干：干完再改（干完存盘会把这本表整本重写）', 'This batch is still running. Edit once it’s done (the sheet gets rewritten when it finishes).'),
    'view.save': ('改好了', 'Save'),
    'view.right': ('对的', 'Correct'),
    'view.locked': ('✗ 表在 Excel 里开着，写不进去：关掉 Excel 再点「改好了」', '✗ The sheet is open in Excel, can’t write. Close Excel and hit Save again.'),
    'view.err': ('✗ 改不了：{e}', '✗ Couldn’t edit: {e}'),
    'view.still': ('{label} {v} 还不对：{why}', '{label} {v} still looks off: {why}'),
    'view.checked': ('{label} 核过了', '{label} confirmed'),
    'view.changed': ('{label} 改成 {v}', '{label} → {v}'),
    'view.shiftToo': ('，SHIFT 跟着猜成 {s}（照 {id} 以前的班次）', ', SHIFT guessed as {s} from {id}’s past shifts'),
    'view.fedRow': ('，这条核完进了样板资料', ', row added to samples'),
    'view.sheetToo': ('，表跟着改了', '. Sheet updated'),
}

# 写进表里的核对提示（O 列）照旧是中文（核对窗口还要从里面读候选）；英文界面显示的时候照句式换成英文，换不了的照原样。
# 网页版 web/strings.js 的 NOTE_RULES 同一套。
NOTE_RULES = [
    (r'^未完成：页面被关的时候这张照片没存住，重新选 (.+) 再干$', r'Not finished: the page closed before this photo was saved. Add \1 again.'),
    (r'（照片还在列表里，再点开始会重干）', ' (photo still in the list; Start retries it)'),
    (r'（照片还在列表里，再点开始接着干）', ' (photo still in the list; Start picks it up)'),
    (r'（照片还在待识别里，下次点开始会重干）', ' (photo still in 待识别; Start retries it)'),
    (r'^✗ 识别失败：', '✗ Couldn’t read it: '),
    (r'^未完成：已停止', 'Not finished: stopped'),
    (r'^未完成：', 'Not finished: '),
    (r'^这张照片里没认出刀具破损记录$', 'No tool breakage record found in this photo'),
    (r'^这张照片里没认出「(.+)」的记录$', r'No “\1” record found in this photo'),
    (r'✓ 人核过', '✓ Checked by a human'),
    (r'只认成了一遍，没能对答案', 'Read only once, nothing to cross-check'),
    (r'几遍认出的条数不一样（(.+?) 条），按多数定', r'Reads found different row counts (\1), majority wins'),
    (r'SETTER 工号 (\S+) 在名单上是 (.+?)，单子上名字是「(.+?)」', r'SETTER ID \1 is \2 on the roster, but the form says “\3”'),
    (r'SETTER 看不清的工号按名单补成 ', 'SETTER unclear ID filled from the roster: '),
    (r'SETTER 按名字对上名单，工号补成 ', 'SETTER matched the roster by name, ID: '),
    (r'（公司没有 (\S+)，', r' (no \1 at the company; '),
    (r'公司没有 (\S+)，按长得像猜的', r'no \1 at the company, closest look-alike'),
    (r'这批同一个 MO 的单子是 ', 'other forms with this MO say '),
    (r'这批同一个零件的单子是 ', 'other forms for this part say '),
    (r'按长得像猜的', 'closest look-alike'),
    (r' 几遍认得不一样：', ' differs between reads: '),
    (r'几遍认得不一样：', 'reads differ: '),
    (r'，名单上只有 ', ', only on the roster: '),
    (r'，公司只有 ', ', the company only has '),
    (r'（单子上的编码：', ' (code on the form: '),
    (r' 模型拿不准', ': the model wasn’t sure'),
    (r' 不是数字：', ' isn’t a number: '),
    (r'SHIFT 不是 D/N：', 'SHIFT isn’t D or N: '),
    (r' 有看不清的字', ' has an unreadable character'),
    (r' 认不成日期', ' isn’t a valid date'),
    (r'，可能是：', ', maybe: '),
    (r' 公司没有这台机', ' isn’t a company machine'),
    (r' 公司没有这道工序', ' isn’t a company process'),
    (r'（几遍认的：', ' (reads: '),
    (r' 数据库里没见过，模型也拿不准：', ' isn’t in the database and the model wasn’t sure: '),
    (r' 名单上没有', ' isn’t on the roster'),
    (r'SHIFT 空→', 'SHIFT empty→'),
    (r'（单子上没写班次，', ' (no shift on the form; '),
    (r'；单子上真圈了 (\S+) 就改回来）', r'; if the form really circles \1, change it back)'),
    (r' 最近 (\d+) 回都是夜班', r'’s last \1 shifts were all nights'),
    (r' 最近 (\d+) 回都是白班', r'’s last \1 shifts were all days'),
    (r' 最近 (\d+) 回有 (\d+) 回是夜班', r' worked nights \2 of the last \1 times'),
    (r' 最近 (\d+) 回有 (\d+) 回是白班', r' worked days \2 of the last \1 times'),
    (r'，就是 ', ', so it’s '),
    (r'按数据库改', 'matched the database'),
    (r'照公司简写', 'company shorthand'),
    (r'(^|[\s：/])空(?=$|[\s；，）/])', r'\1empty'),
    (r'（', ' ('), (r'）', ')'), (r'：', ': '), (r'，', ', '), (r'；', '; '), (r'「', '“'), (r'」', '”'), (r'\s{2,}', ' '),
]
_NOTE_RES = [(re.compile(a), b) for a, b in NOTE_RULES]


def note(text: str) -> str:
    """核对提示给人看：中文界面原样，英文界面照句式换成英文。"""
    if _lang != 'en' or not text:
        return text
    out = text
    for rx, to in _NOTE_RES:
        out = rx.sub(to, out)
    return out.strip()


LANGS = ('en', 'zh')
_lang = 'en'
_forced = False


def _env() -> str:
    v = (os.environ.get('BANGONG_LANG') or '').strip().lower()
    return v if v in LANGS else ''


def init(cfg_lang: str | None = None) -> str:
    """开窗口前定语言：环境变量 BANGONG_LANG > 设置里存的 > 英文。"""
    global _lang, _forced
    env = _env()
    _forced = bool(env)
    _lang = env or (cfg_lang if cfg_lang in LANGS else 'en')
    return _lang


def lang() -> str:
    return _lang


def set_lang(value: str) -> str:
    global _lang
    if value in LANGS and not _forced:
        _lang = value
    return _lang


def T(key: str, **kw) -> str:
    pair = S.get(key)
    if pair is None:
        s = key
    else:
        s = pair[1 if _lang == 'en' else 0]
        if isinstance(s, tuple):
            s = s[0] if kw.get('n') == 1 else s[1]
    return s.format(**kw) if kw else s


def Tl(value: str, key: str, **kw) -> str:
    """指定语言取一条（测试、核对两边的字时用）。"""
    global _lang
    keep = _lang
    _lang = value
    try:
        return T(key, **kw)
    finally:
        _lang = keep


def join(items) -> str:
    return T('list.sep').join(items)


def cat_label(cat: str) -> str:
    """刀单在英文界面叫 Tool breakage（存的、文件名里的还是「刀单」）。"""
    return T('builtin') if cat == '刀单' else cat


init()
