// 中英两套（v1.11.3）：两套键一样、占位一样；英文里没漏中文；页面和代码里用到的键都有字。
// 跑：node --test web/test/strings.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import '../strings.js';

const I = globalThis.LURU_I18N;
const CJK = /[一-鿿]/;
const FOLDERS = ['录入僧', '待识别'];                    // 硬盘上真有的文件夹名，英文里照写
const flat = (v) => (Array.isArray(v) ? v : [v]);
const slots = (v) => new Set(flat(v).flatMap((s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1])));

test('every line has both languages with the same {slots}; English has no stray Chinese', () => {
  const { zh, en } = I.STR;
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  for (const k of Object.keys(en)) {
    assert.ok(flat(zh[k]).every(Boolean) && flat(en[k]).every(Boolean), k);
    assert.deepEqual([...slots(en[k])].sort(), [...slots(zh[k])].sort(), k);
    for (const s of flat(en[k])) {
      const left = FOLDERS.reduce((a, f) => a.split(f).join(''), s);
      assert.ok(!CJK.test(left), `${k}: ${s}`);
      assert.ok(!/\bPlease\b|kindly|successfully|Click here/i.test(s), `${k}: ${s}`);
    }
  }
});

test('default is English, ?lang only for this visit, choice is remembered, plurals pick by n', () => {
  assert.equal(I.t('st.queue', { n: 1 }), I.lang() === 'en' ? '1 photo queued' : '待识别 1 张');
  const keep = I.lang();
  I.setLang('en', false);
  assert.equal(I.t('st.queue', { n: 2 }), '2 photos queued');
  assert.equal(I.t('fullName'), 'Luru · Photo Typist');
  I.setLang('zh', false);
  assert.equal(I.t('sub'), '施主去玩，贫僧填表');             // 定稿副标题照旧
  assert.equal(I.t('slogan.fish'), '你可以去摸鱼了，剩下的交给老衲。');
  assert.equal(I.t('no.such.key'), 'no.such.key');
  I.setLang(keep, false);
});

test('every key used in the pages and the code exists', () => {
  const root = new URL('../../', import.meta.url);
  const web = new URL('../', import.meta.url);
  const files = [
    ...['index.html', 'key.html'].map((f) => new URL(f, root)),
    ...readdirSync(web).filter((f) => /\.(html|js)$/.test(f) && f !== 'strings.js').map((f) => new URL(f, web)),
  ];
  const keys = new Set(Object.keys(I.STR.en));
  let n = 0;
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const used = [
      ...[...src.matchAll(/data-i18n(?:-html)?="([\w.]+)"/g)].map((m) => m[1]),
      ...[...src.matchAll(/data-i18n-attr="([^"]+)"/g)].flatMap((m) => m[1].split(';').map((p) => p.split(':')[1].trim())),
      ...[...src.matchAll(/\bt\('([\w.]+)'/g)].map((m) => m[1]),
    ];
    for (const k of used) { n++; assert.ok(keys.has(k), `${f.pathname.split('/').slice(-2).join('/')}: ${k}`); }
  }
  assert.ok(n > 300, n);
});
