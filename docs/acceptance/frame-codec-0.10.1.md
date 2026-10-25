# 0.10.1 frame 编码优化验收（2026-10-26）

本地源码和镜像完成验收，未发布或部署。此次将已有实验中验证的 RGBA 复用正式接入 frame 差分条带；DOM、协议、帧轮询 16ms 和补丁合并 60ms 保持原行为。

## 实现

- 输入 base64 只转一次 Buffer，扫描与后续裁剪共用该输入。
- 对普通 8-bit、非交错、IHDR 后直接 IDAT 的 RGB/RGBA PNG，裁剪复用首次解码产生的 RGBA。
- RGB 去掉补入的全不透明 alpha；RGBA 保留原 alpha；压缩级别仍为 3。
- 带透明键、色彩/密度元数据、灰度、调色板或其他编码的 PNG 使用原 PNG 输入管线，避免改变原有颜色和透明度处理。
- 核心改动集中在 server.js 的输入缓冲及裁剪调用，以及 lib/frame-codec.js；未引入语言、依赖或新协议。

## 正确性与业务回归

`npm run check && npm test` 共 12 项通过。新测试逐像素比较整图与子矩形 RGBA、核对输出通道数，并用替换 raw 数据证明普通 RGB/RGBA 确实使用快路径。透明键、带 ICC/密度元数据、灰度和调色板测试给快路径传入错误 raw 数据，输出仍须与原 PNG 管线相同，从而验证回退真实发生。

从当前源码构建 `dom-mirror:optimized`，镜像标识：`sha256:7b0da1a8621945e50cc0983a37cc49b2adc3ad8588e3e8f62ef924a684c8c51b`。对该镜像运行：

- 滚动/路径/选择状态：可见、页面滚动及内部滚动三种首次点击均通过。
- Vikunja 业务：直连、DOM、frame 均通过登录、UI 创建任务、优先级修改、完成，以及独立 API/UI 断言。
- 恢复：DOM/frame 均通过原会话草稿与路由恢复、已落库但未显示确认的提交不重放、同账号会话隔离、过期及手动重新开始。
- 调查入口在 production 和 png/4ms 两种配置下编译锚点及实际注入脚本通过；该检查已加入 CI 配置。本记录描述本地验收，远端结果以对应提交的 GitHub Actions 记录为准。

## 正式实现的性能对照

在同一 0.10.1 源码上，`PROFILE_CODEC=png` 强制用原 PNG 裁剪，默认 `production` 使用正式 helper；两者都只转换一次输入 base64。这能隔离裁剪复用收益，不是两个 Git 版本的完整性能比较。

沿用固定 Vikunja 镜像、2 CPU / 2 GiB、1280×900 / DPR 1，按 png→production→production→png 顺序独立运行。每轮 3 次预热、20 次正式 UI 创建，最终独立 API 检查 23 条唯一记录；4 轮业务与绘制负对照全部通过，80 个正式绘制样本均保留。

| 轮次 | 每块裁剪编码 P50 | Enter→标记画布验证 P50 / P95 | 逐帧编号关联 |
|---|---:|---:|---:|
| png / 1 | 2.078ms | 76.4 / 116.5ms | 19/20 |
| production / 1 | 1.373ms | 77.4 / 102.7ms | 20/20 |
| production / 2 | 1.398ms | 76.7 / 101.1ms | 20/20 |
| png / 2 | 2.091ms | 73.7 / 81.4ms | 20/20 |

正式实现的单块裁剪编码 P50 约减少 33%–34%。客户端标记验证中位数没有稳定下降，P95 也未稳定优于对照。整个生命周期平均 CPU 对照为 0.687/0.689 核，production 为 0.695/0.673 核，不能据此声称整体 CPU 或业务延迟稳定降低。

png/1 有一个绘制样本未能与 anim-tiles 的编号关联，原因未进一步冻结；其像素匹配、业务和端到端时间断言正常，未从绘制统计中剔除，也不计为成功关联。production 两轮全部关联。标记只代表源站任务版本的 PNG 像素到达画布，仍含读回探针开销，不代表整条任务逐像素验收或物理屏幕显示。

用正式 helper 再做一次交替顺序的回放，各场景 3 次预热、20 次正式计时：

| 回放场景 | 原 PNG 路径 P50 | production P50 |
|---|---:|---:|
| 实际捕获整帧 | 17.30ms | 17.27ms |
| 实际捕获单条带 | 8.91ms | 8.49ms |
| 实际捕获八条带 | 34.83ms | 15.14ms |

五种回放（含透明 RGBA 和灰度回退）解码后像素及 PNG 总字节数全部一致。八条带场景耗时减少约 56.5%，是多块压力回放结果，不能当业务整体提速。回放的透明小图带密度元数据，会走保守回退；普通 RGBA 快路径另由上述单元测试覆盖。

## 复现和交付边界

```bash
npm run check && npm test
docker build -t dom-mirror:local .
IMAGE=dom-mirror:local bash tools/verify-docker-scroll.sh
IMAGE=dom-mirror:local bash tools/verify-docker-vikunja.sh
IMAGE=dom-mirror:local SESSION_GRACE_MS=2000 BUSINESS_TEST_SCRIPT=verify-recovery.cjs \
  EVIDENCE_DIR=artifacts/recovery bash tools/verify-docker-vikunja.sh

IMAGE=dom-mirror:local PROFILE=1 PROFILE_PRESENTATION=1 PROFILE_MODE=frame CASES=frame \
  BUSINESS_TEST_SCRIPT=profile-business.cjs EVIDENCE_DIR=artifacts/optimized \
  bash tools/verify-docker-vikunja.sh
```

最后一条默认测正式生产 helper；增加 PROFILE_CODEC=png 为原裁剪对照，raw 为 production 别名。PROFILE_* 只作用于调查入口，普通 server.js 不读取这些实验参数。测试源站使用临时数据和合成账号，脚本自动回收资源。

本地证据根目录：`/home/Kei/dom-mirror-validation/20261026/optimization/`，含构建日志、scroll/business/recovery 结果、codec-replay 回放及四轮绘制对照。调查工具与历史报告一并保留；历史 0.10.0 报告中的“生产未改”是当时状态，本次 0.10.1 才正式采用此项局部优化。

尚未做多会话容量、长稳、跨网络或物理呈现性能验收。保留整体性能承诺的边界，继续以源站 UI/渲染/帧捕获阶段为后续主要定位方向。
