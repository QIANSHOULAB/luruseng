# 搬工

把一个文件夹里的刀具破损记录照片（照片、扫描件、HEIC 都行）送给 Gemini，认出每一条 TOOL BROKEN RECORD，边干边写进一本跟公司那本长得一样的 Excel。

- 下载：https://github.com/oilsongchengmin-svg/bangong/releases/latest/download/bangong.exe （双击就能用，不用装 Python）
- 用法：选文件夹，填钥匙（Google AI Studio 的 API Key，可以填两把），点「开始工作」。
- 编号：照片按拍摄时间（EXIF，没有就用文件时间）编号 1、2、3……，表里 A 列 No. 就是照片编号：第 N 张照片的记录在 No. N 那一行。一张照片有两条记录就两行同一个编号；认不出、失败的也留一行，编号不会错位。
- 表格：B 到 N 列跟公司 TOOL BROKEN RECORD 一格不差（DATE、MACHINE、PART NUMBER、MO、OPR NO.、T NO.、DESCRIPTION、BTMP、TOTAL SCREENED、PASSED、FAILED、SHIFT、SETTER），复制 B 到 N 的数据行整块贴进公司表。O 列是核对提示，不用贴。
- 标红：有看不清的字（□）、日期认不出、数字不是数字、SHIFT 不是 D/N、PASSED + FAILED ≠ TOTAL SCREENED。只看红格子就行。
- 日期：新加坡写法日在前；没写年份补今年，补出来是将来的日子就算去年。
- 每批 5 张，每张单独一次请求，5 张同时发；每批干完存一次盘。
- 干完的照片挪进 `已识别\<这次的时间>\`，文件名前面加上编号（`01_xxx.jpg`），跟 `识别结果\识别结果_<这次的时间>.xlsx` 一一对应。失败的留在原地，下次点开始会重试。日志在 `识别结果\搬工日志.txt`。
- 干过的照片记在账本里（按文件内容算指纹），改了名也不会重干，会挪进 `已识别\重复\`。
- 每分钟次数到顶：等 60 秒接着干。当天额度用完：先换钥匙 2；两把都用完就等到太平洋时间半夜（新加坡下午 3 点，冬令时 4 点）额度刷新后接着干。
- 谷歌说预付余额用完、钥匙无效、模型不存在：直接停，把谷歌原话写进日志。
- 钥匙只存在本机 `%APPDATA%\搬工\config.json`，请求时只走 URL 参数 `?key=`。
- 无窗口跑一轮：`bangong.exe --cli [文件夹]`（读同一份配置）。
