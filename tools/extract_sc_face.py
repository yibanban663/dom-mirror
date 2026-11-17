#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""extract_sc_face.py：从系统 fonts-noto-cjk 的 TTC 抽 SC 单面 → NotoSansSC-{Reg,Bold}.ttf
（bake_pool.py 的前置原料；Dockerfile 构建期调用）"""
import os
import sys

from fontTools.ttLib import TTFont

OUT = os.path.dirname(os.path.abspath(__file__))
for src, name in [
    ("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", "NotoSansSC-Reg.ttf"),
    ("/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc", "NotoSansSC-Bold.ttf"),
]:
    names = []
    for i in range(32):
        try:
            t = TTFont(src, fontNumber=i, lazy=True)
            names.append((i, t["name"].getDebugName(4) or "?"))
            t.close()
        except Exception:
            break
    cand = [i for i, nm in names if "SC" in nm and "Mono" not in nm]
    if not cand:
        print("no SC face in", src, names, file=sys.stderr)
        sys.exit(1)
    TTFont(src, fontNumber=cand[0]).save(os.path.join(OUT, name))
    print("extracted", name, "from face", cand[0])
