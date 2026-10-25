# frame 首张差分帧已包含更新时的绘制回归

内存循环实验在第 9 轮遇到首次操作的像素确认超时，该轮及后续对照没有计入有效内存数据。随后使用独立受控用例，确认了一个首帧基准缺陷；旧循环缺少足够的绘制诊断，不能事后断言其超时一定由同一原因造成。

## 受控条件与结果

源站初始标记像素为 `[24,139,67,255]`。初始全量截图照常下发；测试拦截服务端 CDP screencast，丢弃并 ACK 旧状态的帧，仅允许包含首次操作后标记 `[31,139,67,255]` 的帧交给引擎。真实客户端鼠标聚焦、输入并按 Enter，不发送重复操作或补画请求。

| 观察 | 修复前 | 修复后 |
|---|---|---|
| 独立源站收到首次操作 | 1 次 | 1 次 |
| 客户端 DOM | Measured task 00 | Measured task 00 |
| 首张允许进入差分器的帧标记 | 31 | 31 |
| 客户端画布标记 | 仍为 24，5 秒绘制确认超时 | 更新到 31，绘制确认通过 |

旧实现把首帧保存为比较基准并返回空 tiles；即使这张帧已经包含用户操作，也不会下发。随后画面静止或仅其他区域变化时，标记区域可能一直保留旧截图。

修复将首次基准帧或尺寸改变后的基准帧作为完整视口 PNG tile 下发，同时保存比较基准。沿用现有 DPR、滚动位置和 tile 格式，不新增传输通道。后续仍按原算法发送差分。

源代码、脚本摘要及实际对照见 [frame-baseline-summary.json](frame-baseline-summary.json)。修复前后使用同一测试脚本。正对照实际运行于隔离缓存依赖镜像；不是标准 Dockerfile 在线全新安装的证明。Node 27 项测试及默认/4ms 插桩编译检查另行通过。

## 复现与范围

```bash
docker build -t dom-mirror:local .
IMAGE=dom-mirror:local bash tools/verify-docker-frame-baseline.sh
```

容器 network none，2 CPU / 3 GiB，60 秒上限，结束后删除。脚本启动自己的 loopback 合成源站和宿主；证据默认位于 `artifacts/frame-baseline/`，包含结果、截图和镜像 ID。CI 已接入此回归和证据上传；本记录不代表远端 CI 已执行。

本轮只直接验证 DPR 1、1280×900、无滚动的受控首帧顺序。其他业务、持续动画和不同 DPR 的完整兼容性仍需各自验收。

修复后另完成 Vikunja frame 核心业务与 DOM/frame 恢复回归，均通过；对应镜像与逐项结果见[内存调查汇总](../performance/2026-10-26-frame-memory-summary.json)的 `functionalRegression`。这些业务检查不扩大受控首帧用例的 DPR/滚动覆盖范围。
