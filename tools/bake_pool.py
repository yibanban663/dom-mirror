#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 烘焙混淆字体种子池：tools/bake_pool.py <N> <out-dir>
# 原料：Debian fonts-noto-cjk 的 NotoSansCJK-{Regular,Bold}.ttc
#       （先抽 SC 单面 + 域子集为 NotoSansSC-{Reg,Bold}.ttf 放在执行目录）
# 产出：<out-dir>/{reg,bold}-s<seed>.woff2 与 .json（perm 表，网关启动加载）
import os, subprocess, sys, time

N = int(sys.argv[1]) if len(sys.argv) > 1 else 4
out = sys.argv[2] if len(sys.argv) > 2 else 'assets/obf'
os.makedirs(out, exist_ok=True)
here = os.path.dirname(os.path.abspath(__file__))
seeds = [861001 + i for i in range(N)]
procs = []
t0 = time.time()
for seed in seeds:
    for w, src in [('reg', 'NotoSansSC-Reg.ttf'), ('bold', 'NotoSansSC-Bold.ttf')]:
        cmd = [sys.executable, os.path.join(here, 'build_obf_font.py'), src, str(seed),
               os.path.join(out, '%s-s%d.woff2' % (w, seed)), os.path.join(out, '%s-s%d.json' % (w, seed))]
        procs.append((os.path.basename(cmd[-1]), subprocess.Popen(cmd)))
for tag, p in procs:
    o, e = p.communicate()
    print(tag, 'OK' if p.returncode == 0 else 'FAIL ' + e.decode()[-300:])
print('%d fonts in %.0fs' % (len(procs), time.time() - t0))
