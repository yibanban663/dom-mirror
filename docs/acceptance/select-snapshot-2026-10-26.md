# 业务回归中的 select 句柄替换

提交 `e0ca5e6` 的[远端 CI](https://github.com/yibanban663/dom-mirror/actions/runs/40240172935)中，Vikunja 直连与 DOM 流程通过，frame 的登录/创建通过，优先级持久化断言失败。保留的 WS trace 没有 select 对应的 input/change 消息，截图仍为 Unset。原始 CI 证据下载至本机 `/home/Kei/dom-mirror-validation/20261026/ci-e0ca5e6/vikunja/`，不删除失败记录或自动重试业务命令。

独立可控复现确认：先获取 select 句柄，再将它替换为相同克隆；旧句柄的 `select('2')` 仍返回 `['2']`，但当前控件值为 `0`，根节点收不到事件。在 document 与 Shadow DOM 两种根下均能复现。它与上述缺失消息一致；原 CI 没有保存当时句柄的 isConnected 状态，不能单凭 trace 证明每个内部时序。

业务脚本改为在一次 `page.evaluate` 浏览器任务中，从当前根重新定位 select、确认选项、设置值并派发同样的 input/change。保持原合成选择事件语义，继续经过镜像根监听器、WS 和源站业务处理，不直接调用业务 API 修改优先级；API 仍只用于独立确认持久化。不增加重试、延迟或放宽断言。

`tools/verify-select.cjs` 同时保留旧句柄负对照，验证新方法在两个根各只产生一次 input 与一次 change。已通过本地隔离 Chromium 检查，并加入远端 CI。修正后的本地 Vikunja 直连、DOM、frame 三通道均完成登录、创建、优先级 Medium 与完成任务，UI/API 断言通过；证据在 `/home/Kei/dom-mirror-validation/20261026/ci-select-fixed/`。生产引擎不变，之前 allocator 数值不因该测试脚本修正而重算。

复现：

```bash
docker run --rm --network none --memory 1g --cpus 2 dom-mirror:local \
  timeout 30 node tools/verify-select.cjs
IMAGE=dom-mirror:local bash tools/verify-docker-vikunja.sh
```

应使用包含当前 tools 的镜像。远端完整验收以最终提交对应 CI 为准；本记录不把第一次 CI 失败改写为成功，也不据此承诺所有真实用户下拉交互时序已覆盖。
