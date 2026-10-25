# 0.10.0 续测：PNG 解码复用与客户端绘制

沿用[首轮调查](2026-10-26.md)的提交、镜像、Vikunja 版本、1280×900 / DPR 1 和隔离条件。本轮只改调查脚本和进程内源码副本，生产 server.js / client/index.html 未改。

结论：复用已解码 RGBA 可减少单块裁剪编码耗时，多块裁剪的独立回放收益明显；当前任务创建流程的客户端绘制延迟尚未稳定改善。此结果支持继续减少重复编解码，不支持宣称业务已整体加速，也无需为本项改用 Rust/Wasm。

## 1. 解码复用回放

旧路径：整帧解码为 RGBA 用于扫描，然后对每个矩形重新从原 PNG 创建裁剪编码管线。候选路径：裁剪直接使用第一次得到的 RGBA，省掉各块的 PNG 输入解码。

候选只作用于调查入口 `PROFILE_CODEC=raw`。Chromium RGB PNG 移除补入的 alpha，RGBA PNG 保留 alpha；其他 PNG 颜色类型回退原路径。该实验输入为受控 CDP PNG，未验证任意外部 PNG 的色彩配置、tRNS 或 metadata 兼容性，不能当成通用图片处理库。

回放使用实际捕获的一张 RGB 帧，分别裁整帧、一个 128px 高条带和八个 16px 高条带。八条带是多块压力场景，不代表真实任务创建每帧都有八块。另外加入透明 RGBA 和真正的 grayscale PNG（颜色类型 0），验证透明度与回退分支。

每场景先各执行一次，逐块解码为 RGBA 比较全部像素，再各预热 3 次、正式 20 次，按 AB/BA 交替顺序计时。容器无网络、2 CPU / 1 GiB。计时包含共同的首次 RGBA 解码与全部裁剪编码，不包含 JS 像素扫描、传输和浏览器绘制。

| 场景 | 原 PNG 路径 P50 | RGBA 复用 P50 | 观察 |
|---|---:|---:|---|
| 整帧一个矩形 | 16.65ms | 16.09ms | 收益小 |
| 一个条带 | 8.89ms | 8.44ms | 收益约 5% |
| 八个条带 | 34.89ms | 14.91ms | 耗时减少约 57%，约 2.34 倍 |
| 透明 RGBA 小图 | 1.11ms | 1.09ms | 主要验证 alpha 正确性 |
| grayscale 回退 | 1.82ms | 1.85ms | 两者走同一路径，差异属于噪声 |

五项解码后像素全部一致，各场景输出 PNG 总字节数也一致。没有通过删除 alpha、降质或减少裁剪块来换速度。

## 2. 客户端绘制观测及负对照

首轮 Enter→任务 DOM 指标不足以判断 frame 画面更新。本轮新增测试专用观测：

1. 源站页面添加固定 24×24px 的不透明颜色标记。它观察真实业务任务 DOM，每出现一个新编号任务就改变颜色；不通过 API 创建任务，不改变业务写入过程。
2. 客户端在真实 Enter keydown 记录起点，使用同一浏览器 performance.now 时钟记录任务 DOM、画布像素匹配、再经过两次 requestAnimationFrame 的时间。
3. 仅在实际 `.xy-tiles` 画布执行 drawImage 后读取标记像素；镜像 HTML 中提前出现相同标记颜色不能满足条件。
4. 每轮第一项预热创建时，允许业务和 DOM 更新，却临时丢弃画布 drawImage。API 确认任务存在后继续等待 250ms，必须满足“DOM 已更新，但像素未绘制”。随后解除拦截并请求只读全量重同步；不重试业务提交。

四轮负对照均通过；解除拦截后均观察到正确颜色写入画布。这证明探针没有把 DOM 存在或业务 API 成功当成已绘制。

该指标是 **源站任务版本标记的 PNG 像素到达客户端画布**，不是整条任务文本的逐像素验收；标记增加了源站 DOM 观察和一小块脏区域。读取像素及客户端插桩也有开销，两组使用同一探针。两次 rAF 代表后续渲染机会，不证明物理显示器已显示。不能将它称为无干扰的用户可见端到端 SLA。

## 3. 真实业务 ABBA 对照

镜像容器保持 2 CPU / 2 GiB、合并窗 60ms。按原路径→复用→复用→原路径顺序运行，每轮独立账号、项目、浏览器和临时数据库；3 次预热、20 次正式 UI 创建，API 独立确认最终 23 条唯一记录。共 4 轮、80 个正式样本、92 条记录，全部通过。

下表每行是独立一轮的统计值，未跨轮混算分位数。

| 轮次 | 每块裁剪编码 P50 | Enter→标记画布绘制 P50 / P95 | 绘制后两次 rAF P50 / P95 |
|---|---:|---:|---:|
| 原路径 1 | 2.185ms | 77.4 / 113.4ms | 96.6 / 143.8ms |
| RGBA 复用 1 | 1.388ms | 76.2 / 103.7ms | 97.3 / 128.2ms |
| RGBA 复用 2 | 1.345ms | 73.7 / 114.5ms | 97.0 / 130.4ms |
| 原路径 2 | 2.101ms | 73.9 / 88.2ms | 96.6 / 113.6ms |

裁剪编码的单块 P50 下降约 34%–38%，但客户端标记绘制中位数仍约 74–77ms，没有稳定下降。复用路径的 P95 也没有稳定优于原路径：不能取最好一轮宣称端到端加速。

镜像容器整个测试生命周期平均 CPU 原路径约 0.712–0.742 核，复用约 0.710–0.714 核；该差异很小且包含启动、负对照、空闲和回收，不能据此宣称稳定 CPU 降幅。各轮消耗帧数、补丁及全量快照次数也会变化，不是严格相同的帧流回放。

还观察到部分请求中 PNG 标记先于镜像任务 DOM 更新。两条下行通道可以先后交错，因此 DOM 时间既不能直接当 PNG 时间，也不能假定“DOM 耗时 + 图片耗时”就是总延迟。

## 复现

使用从当前源码构建的镜像，沿用原隔离 Docker 入口：

```bash
IMAGE=dom-mirror:local PROFILE=1 PROFILE_PRESENTATION=1 PROFILE_CODEC=png \
  PROFILE_MODE=frame CASES=frame BUSINESS_TEST_SCRIPT=profile-business.cjs \
  EVIDENCE_DIR=artifacts/presentation/png-1 bash tools/verify-docker-vikunja.sh
```

`PROFILE_CODEC=raw` 切换候选裁剪路径；每轮使用独立 EVIDENCE_DIR。默认 PROFILE_PRESENTATION=0、PROFILE_CODEC=png，普通服务入口不会加载本实验候选或标记。

在含 `frame-00.png` 的捕获目录运行独立回放：

```bash
docker run --rm --network none --memory 1g --cpus 2 \
  -v "$PWD/tools:/app/tools:ro" \
  -v "$PWD/artifacts/presentation/png-1:/evidence" -e PROFILE_DIR=/evidence \
  --entrypoint timeout dom-mirror:local 120 node tools/profile-codec-replay.cjs
```

本轮原始证据在 `/home/Kei/dom-mirror-validation/20261026/performance-next/`：四个 presentation-* 子目录包含客户端观测、服务端分段计时、镜像标识、资源限制及应用/引擎日志；codec-replay/ 包含回放输入和 codec-comparison.json。所有数据来自合成账号；不记录密码或恢复凭据。测试结束无遗留容器和网络。

下一步若继续优化，应补充源站事件→帧入队/消费→消息下发→客户端解码/绘制的关联时间，定位余下几十毫秒的来源；并在实际多块负载上验证复用收益。当前只保留实验候选，不改生产默认实现，不扩大成全服务语言重写。

关联帧续测已完成，见 [分段等待与 4ms 轮询对照](2026-10-26-frame-trace.md)：80/80 正式操作关联成功，主要等待位于源站 UI/渲染/捕获段；缩短轮询未证明端到端稳定改善。

0.10.1 已采用保守格式识别后的正式快路径，新增透明键/元数据回退验证，见 [正式优化验收](../acceptance/frame-codec-0.10.1.md)。当前调查默认 production，显式 png 保留旧裁剪对照；以上表格保持 0.10.0 当时的实验口径。
