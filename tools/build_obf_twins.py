#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""build_obf_twins.py <fontfile> <perm.json> <out.woff2>

网站自有字体的 PUA 孪生构建（艺术字/品牌字保护）：
- perm.json：会话种子置换表（网关种子池同源下发）
- 只给该字体 cmap 中存在的域内码点追加 PUA 孪生条目（format 12 重建）
- 字体其余部分（轮廓/fvar/特性）原样保留——艺术字逐位还原
"""
import json
import sys

from fontTools.ttLib import TTFont
from fontTools.ttLib.tables._c_m_a_p import CmapSubtable


def main():
    src, perm_path, out = sys.argv[1], sys.argv[2], sys.argv[3]
    perm_raw = json.load(open(perm_path, encoding="utf-8"))
    perm = {int(k, 16): int(v, 16) for k, v in perm_raw.items()}

    f = TTFont(src)
    merged = f.getBestCmap()
    twins = 0
    for c, p in perm.items():
        g = merged.get(c)
        if g is not None and p not in merged:
            merged[p] = g
            twins += 1
    t12 = CmapSubtable.getSubtableClass(12)()
    t12.cmap = merged
    t12.platformID = 3
    t12.platEncID = 10
    t12.language = 0
    f["cmap"].tables = [t12]
    f.flavor = "woff2"
    f.save(out)
    print("TWINS-OK", twins)


if __name__ == "__main__":
    main()
