#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""build_obf_font.py <base.ttf> <seed> <out.woff2> <out.perm.json>

防抓取字体混淆（Cloudflare 式）：
- 域：CJK 标点 3000-303F + 基本区 4E00-9FFF + 全角 FF00-FFEF（ASCII/西文不混淆，
  保证等宽代码块、数字、英文照常）
- 置换：域内码点 c -> 0xF0000+shuffled[i]（PUA-A 平面15，与会话种子绑定）
- cmap 双映射：原码点保留（输入框明文/字体未就绪兜底）+ PUA 码点指向同一字形
- 输出 woff2（CFF 轮廓原样保留，渲染与原生逐位一致）+ perm JSON（网关侧编码用）
"""
import json
import sys

from fontTools import subset
from fontTools.ttLib import TTFont


def make_perm(codes, seed):
    # xorshift32 与网关侧无关：perm 表以 JSON 下发，两端不重复实现
    s = (seed & 0xFFFFFFFF) or 1
    idx = list(range(len(codes)))
    for i in range(len(idx) - 1, 0, -1):
        s ^= (s << 13) & 0xFFFFFFFF
        s ^= s >> 17
        s ^= (s << 5) & 0xFFFFFFFF
        j = s % (i + 1)
        idx[i], idx[j] = idx[j], idx[i]
    # 消不动点（c -> c 自映射没有混淆意义）
    for i in range(len(idx)):
        if idx[i] == i:
            k = (i + 1) % len(idx)
            idx[i], idx[k] = idx[k], idx[i]
    return {codes[i]: 0xF0000 + idx[i] for i in range(len(codes))}


def main():
    base_ttf, seed_s, out_w2, out_json = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
    f = TTFont(base_ttf)

    # 域：保留域内码点 + 组件闭包；域外字形全部裁掉（体积/构建时间 ↓）
    cmap = f.getBestCmap()
    dom = sorted(c for c in cmap if (0x3000 <= c <= 0x303F) or (0x4E00 <= c <= 0x9FFF) or (0xFF00 <= c <= 0xFFEF))
    keep = [c for c in cmap if (0x20 <= c <= 0x7E)] + dom  # ASCII 原样保留字形（不混淆但要能渲染）
    sub = subset.Subsetter()
    sub.populate(unicodes=keep)
    sub.subset(f)

    perm = make_perm(dom, seed_s)
    # 重建 cmap：单一 format 12 子表（覆盖 BMP+补充平面），先并再双映射
    from fontTools.ttLib.tables._c_m_a_p import CmapSubtable
    merged = f.getBestCmap()
    for c, p in perm.items():
        g = merged.get(c)
        if g is not None and p not in merged:
            merged[p] = g
    t12 = CmapSubtable.getSubtableClass(12)()
    t12.cmap = merged
    t12.platformID = 3
    t12.platEncID = 10
    t12.language = 0
    f["cmap"].tables = [t12]

    f.flavor = "woff2"
    f.save(out_w2)

    with open(out_json, "w", encoding="utf-8") as fp:
        json.dump({("%05X" % c): ("%06X" % p) for c, p in perm.items()}, fp)
    print("OBFFONT-OK", len(perm), "entries")


if __name__ == "__main__":
    main()
