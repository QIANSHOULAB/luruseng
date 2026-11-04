// 中英文字各导出一份，一行一条（给队长逐条读）：docs/strings-bi/zh.txt、en.txt，同一行号是同一条。
// 网页（介绍页、领钥匙页、网页版、手机传图页）来自 web/strings.js，电脑版来自 bangong/strings.py。
// 每行：键<TAB>字（换行写成 \n；英文分单复数的写成「单数 | 复数」）。跑：node web/test/export_strings.cjs
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'docs', 'strings-bi');
require(path.join(ROOT, 'web', 'strings.js'));
const W = globalThis.LURU_I18N.STR;
const py = JSON.parse(execFileSync(process.env.PYTHON || 'python3', ['-c',
  'import json,sys; sys.path.insert(0, sys.argv[1]); from bangong import strings; print(json.dumps(strings.S, ensure_ascii=False))', ROOT],
  { encoding: 'utf8' }));
const show = (v) => (Array.isArray(v) ? v.join(' | ') : v).replace(/\n/g, '\\n');
const lines = { zh: [], en: [] };
for (const k of Object.keys(W.en)) { lines.zh.push(`web.${k}\t${show(W.zh[k])}`); lines.en.push(`web.${k}\t${show(W.en[k])}`); }
for (const [k, [zh, en]] of Object.entries(py)) { lines.zh.push(`pc.${k}\t${show(zh)}`); lines.en.push(`pc.${k}\t${show(en)}`); }
fs.mkdirSync(OUT, { recursive: true });
for (const l of ['zh', 'en']) fs.writeFileSync(path.join(OUT, `${l}.txt`), lines[l].join('\n') + '\n');
console.log(`${lines.en.length} lines each → ${OUT}`);
