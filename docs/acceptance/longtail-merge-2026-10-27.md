# 长尾兼容与合并准入验收

2026-10-27，PR #1 的 v0.27.0 候选在合并 main 的打包验收后，完成文件传输、跨源 iframe 和回归判定修复。机器可读结果见 [longtail-merge-summary.json](longtail-merge-summary.json)。本记录只覆盖固定环境的功能与交付验证，不代表容量、长期运行或生产安全准入。

## 合并边界

- 节点 ID、IME、Shadow DOM/iframe、canvas 指令流、资源改写、表单/媒体/选区与虚拟列表等原有兼容功能保留，库入口仍为 `createMirror`，独立启动仍属于 Demo。
- 上行原始分块由 48KiB 调整为 32KiB，为 base64 和 JSON 留出余量，保留 WS 64KiB 上限。上传总预算包括待传与已完成文件，默认是单文件上限的两倍；同时限制并发、空闲超时、分块数量和每会话文件数。
- Node 侧跨源 iframe 抓取默认关闭，只有宿主 `crossOriginFrameOrigins` 明确允许的 HTTP(S) 源才能抓取；不接受 URL 凭据、不跟随重定向，限制单次候选数并避免周期抓取重叠。页面出现 iframe URL 不再自动授权 Node 出站请求。此选项不约束 Chromium 本身的出站访问，仍须宿主网络隔离。
- 跨源 srcdoc 剥离 script/noscript/template，并复用主文档的输入值剔除、指定属性剔除及掩码逻辑。修复 textarea 掩码判断；掩码至多 32 个星号，不处理上行数据、CSS、资源正文或像素。
- 下载在进度超限时请求取消，完整读取文件前复核磁盘大小。文件传输仍不是病毒扫描器或完整磁盘/带宽配额系统。
- 删除业务模式的自动重试和额外浏览器预热；失败保持失败，打包验收的浏览器回收计数保持原约束。

## 本地证据

| 检查 | 结果 |
|---|---|
| Node 单元/策略/生命周期与新增预算、WS 分块、基准负对照 | 36/36 通过 |
| IME 合成与上屏、文件下载 | 通过 |
| 65,553 字节、8MiB 精确上限上传 | 均通过源站 File 的 SHA-256 与预期内容一致检查 |
| 默认 iframe 策略 | 显示占位块，Node 侧跨源抓取数为 0 |
| 显式允许 iframe | 保留可见内容；hidden/password/file、email/textarea 原值、指定属性、template/script 标记不出现在 srcdoc 或 WS 中 |
| 通用性必检项 | forms/editor/media/layout/style/canvas/dnd/vlist/xiframe/cshadow/audio 共 11 类通过 |
| 实际 tarball 消费端 | direct/dom/frame 业务 3/3、DOM/frame 恢复 2/2、异常产物负对照与关闭回收通过 |

首次通用性运行暴露旧基准假绿：editor 在 `out.perf.keyRttMs` 初始化前抛异常，却因为此前一项检查为真而标记成功。已初始化计量对象，并改为无异常且各类必检项全部为 true 才通过；该历史结果在新判定下被拒绝。编辑器重新运行后，键盘、选区、追加与文本更新等五项全部通过。其余十类既有结果也按新规则逐项复核；CI 使用修正后的完整基准。

真实浏览器为 Chrome `156.0.8078.47`，Node `24.21.0`，Linux x64。复用已有系统/浏览器镜像，复制候选源码并检查依赖；未声称本地重新安装标准 Dockerfile 的系统层。实验均采用隔离 Docker 环境和合成数据，无真实业务凭据。原始记录保存在 `/home/Kei/dom-mirror-validation/20261027/merge-longtail/`。

本地消费端 tarball SHA-256 为 `e72cafb7b508b4791372f31e0c4a96709bc523cbe1197988f1f70564717b66b4`。它生成于本文和基准判定修正之前；机器结果核验了引擎、客户端、上传模块、选项、Demo 和业务驱动仍与该归档完全一致。远端 CI 会重新生成和验收实际提交的 tarball，以该次 artifact 为准。

## 复现

```bash
npm run check && npm test
docker build -t dom-mirror:local .
IMAGE=dom-mirror:local bash tools/verify-docker-longtail-p0.sh
docker run --rm --network none --memory 3g --cpus 2 dom-mirror:local timeout 120 node tools/verify-xframe-policy.cjs
IMAGE=dom-mirror:local bash tools/verify-docker-generality.sh
IMAGE=dom-mirror:local bash tools/verify-docker-package-business.sh
```

新增边界回归与证据上传均接入 CI，合并以修复后提交的完整 CI 结果为准。未发布 npm、未部署生产服务；新版本仍需要独立的资源容量、长稳、平台兼容和宿主安全策略验收。
