# DL/A 路线验收记录 v1 · 2026-11-20/21

## 环境

- 补丁版 Chromium 156.0.8078.47（XY_SKP 导出补丁），186 编译管线产出 `out/Rel/headless_shell` 511MB
- CanvasKit 0.42（npm，与引擎 B 线共用）
- 测试页：data:URL 纯色块 + 系统字体（验收 v2 口径：纯色+系统字体，无 webfont/无图）

## 三关结果

| 关卡 | 预期 | 实测 | 结论 |
|---|---|---|---|
| ① skp 导出 | `skiapictn` 8 字节魔数 | `736b 6961 7069 6374 6e`（293KB skp，`Finalize()` 触发） | ✅ |
| ② CanvasKit 兼容 | 预期版本拒绝→记录→自编预案 | **0.42 直接打开 156 的 skp**（MakePicture OK） | ✅（自编预案不需要） |
| ③ 重放一致性 | 与源 HTML 视觉一致 | replay.png：蓝底/白 H1/黑正文，逐项一致 | ✅ |

## 遗留与备注

- 验收页为单层静态；多层/滚动容器/真网页字体页的完整验收在 v9 引擎接入后做
- WebGL/视频层不在本次范围（路线图 v4 混合渲染）
- 产物：`/opt/dl-a/{headless_shell,skp-watcher.js,skp-replay.js}`；接入 8737 见 roadmap-dl 阶段"引擎集成"
