# Optional font obfuscation / 可选字体混淆

Font obfuscation is optional and **is not encryption**. Without a font pool, the Demo displays ordinary text. It only makes some text extraction less direct, and may affect copying, searching and accessibility.

字体混淆不是加密。字体保留原码点与 PUA 到同一字形的映射，可以恢复文字；ASCII、数字、输入值和域外字符不混淆。不要用它保护敏感数据。

## Build a pool

Use Python 3, fontTools and Brotli. Supply Regular and Bold TTF/OTF fonts that contain Chinese characters and permit redistribution:

```bash
python3 -m venv .venv
.venv/bin/pip install 'fonttools[woff]'
mkdir -p assets/obf
.venv/bin/python tools/build_obf_font.py /path/Regular.ttf 861001 \
  assets/obf/reg-s861001.woff2 assets/obf/reg-s861001.json
.venv/bin/python tools/build_obf_font.py /path/Bold.ttf 861001 \
  assets/obf/bold-s861001.woff2 assets/obf/bold-s861001.json
```

Each seed's Regular/Bold pair must use identical character coverage. Restart the instance to load the pool; Docker copies `assets/` at build time. Website-specific font twins require `python3` on PATH with fontTools available to that interpreter.

每组种子的 Regular/Bold 必须采用相同字符覆盖；生成后重启实例加载。构建网站自有字体孪生时，PATH 中的 `python3` 也要能够导入 fontTools。

For a batch pool, place `NotoSansSC-Reg.ttf` and `NotoSansSC-Bold.ttf` in the repository root and run:

```bash
python3 tools/bake_pool.py 4 assets/obf
```

See [English README](../README.md) / [中文 README](../README.zh-CN.md).
