// 这几份测试对着中文的字写：先把界面语言拨成中文（不记进 localStorage）。英文那一套另有 web/test/bilingual.cjs 在真浏览器里跑。
import '../strings.js';

globalThis.LURU_I18N.setLang('zh', false);
