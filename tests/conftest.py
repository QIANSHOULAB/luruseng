"""这些测试对着中文的字写：界面语言钉成中文。英文那套在 tests/test_lang.py 里单独测（用 strings.Tl 指定语言）。"""
import os

os.environ.setdefault('BANGONG_LANG', 'zh')
