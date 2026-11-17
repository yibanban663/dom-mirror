# npm tarball 独立宿主业务验收

2026-10-26，本地实际打包产物通过三通道业务、DOM/frame 恢复和关闭回收验收。机器可读结果见 [package-business-summary.json](package-business-summary.json)。本轮补齐安装产物与真实浏览器业务之间的验证链，不修改库入口、公共 API、引擎或默认配置。

## 产物与宿主

- 工作区基于 `dcb1500`，包含本轮新增验收工具；测试对象是本地生成的 `@lizhen-xxaq/dom-mirror@0.11.0`，尚未发布 npm。
- tarball SHA-256：`1aecc222d15087a67848f3d484641dd29a6381ad6d30bf8a3b6a4c6cb46e0d9b`。该摘要对应生成本报告前的测试快照；之后修改文档再打包会得到不同摘要。
- 消费端安装后逐项核验归档内 151 个文件，入口为 `/consumer/node_modules/@lizhen-xxaq/dom-mirror/index.js`。通过包名导入 `createMirror`，使用公共 HTTP/WS 和 `close()` 接口。
- 基于已有浏览器运行时镜像创建消费端镜像，删除 `/app`，清空 `NODE_PATH`、`NODE_OPTIONS`、`LD_PRELOAD` 和 `MALLOC_CONF`；在 `/consumer` 使用 npm 安装 tarball 及其依赖。Puppeteer、sharp、ws 及实际加载模块均来自消费端目录，不从源码或全局模块回退。
- 保存消费端 `package-lock.json` 与 `npm ls` 依赖树。核心与恢复两组使用同一消费端镜像和锁文件，锁文件 SHA-256 为 `b71623f5f65f20b58b895c1c821b951506bf0a9efac60853cd998af6c5da854a`。传递依赖是本次安装的解析结果，后续重新安装应核对各自锁文件。
- Node `24.21.0`，Linux x64；没有启用 jemalloc、V8 semi-space 参数或强制 GC。本轮复用了浏览器基础运行时，没有重新构建标准 Dockerfile 的基础系统层。

源站固定为 Vikunja `v2.7.1`，镜像 `vikunja/vikunja@sha256:f7dc8428d10aef17f3075886d3c1c022f566ec456f88985f02c137f4fc534576`，使用 tmpfs SQLite 和合成账号、任务。服务端限制 2 CPU / 2 GiB，源站 1 CPU / 768 MiB，客户端 2 GiB。每组使用独立 internal Docker 网络，不映射宿主端口，业务运行时清空代理环境。

## 验收结果

| 检查 | 结果 |
|---|---|
| 直连、DOM、frame：登录、创建、Medium 优先级、完成 | 3/3 通道通过，独立应用 API 确认持久化 |
| DOM/frame：登录路由和草稿断线恢复 | 2/2 通过，恢复原会话 |
| 提交成功但 UI 确认丢失 | 2/2 通过，独立查询记录数为 1，无额外提交重放 |
| 同账号不同会话隔离 | 2/2 通过 |
| 过期后显式重建 | 2/2 通过，旧会话不能静默变成新会话 |
| 业务完成后浏览器回收 | 核心组 2 个、恢复组 6 个全部关闭、断开且 `/proc/PID` 消失 |
| 存在活动会话时调用 `close()`，再重复调用 | 两组各额外启动 1 个真实浏览器，WS 关闭，浏览器退出，两次关闭均完成 |
| 关闭镜像后宿主所有权 | 两组宿主健康路由继续响应；镜像路由返回 503 |
| 内存耗尽与客户端退出 | 服务端、客户端无 OOM，客户端退出码为 0 |
| 异常归档、异常安装文件、源码目录、NODE_PATH 回退 | 四项负对照全部被拒绝 |

业务操作与持久化断言复用原有回归，不通过放宽条件或重试提交取得通过。服务端浏览器观测只包装真实 Puppeteer 的启动/关闭，记录子进程状态，不替换浏览器，也不读取内部会话表。两组共 10 个服务端浏览器均在删除容器前完成回收；容器与网络随后全部清理。

## 复现与证据

```bash
docker build -t dom-mirror:local .
IMAGE=dom-mirror:local bash tools/verify-docker-package-business.sh
```

默认输出到 `artifacts/package-business/`：归档文件摘要清单、消费端镜像标识、四项负对照、两组依赖锁和依赖树、业务 JSON、截图、日志、容器状态及关闭回收证据，最后严格汇总为 `summary.json`。安装失败、业务失败或证据断言失败均返回非零；不会保留旧的成功汇总。测试用控制端点只存在于独立宿主夹具，不属于库或 Demo 的接口。

本地完整成功记录位于 `/home/Kei/dom-mirror-validation/20261026/package-business-run/`。CI 已增加同一命令及 `package-business-regression` artifact 上传；本地通过不代表远端 CI 已通过，远端以包含本轮改动的提交结果为准。

## 边界与下一步

本轮证明本地 tarball 在固定环境下能通过真实业务、恢复及资源生命周期验收；不代表 npm 注册表发布后的安装验收、Node/平台兼容矩阵、真实身份提供方、导航/网络安全准入、容量或长期运行验收。字体混淆关闭，未将其当作保密措施。

下一步使用打包消费端开展 DOM/frame 的 1/3/6 会话容量矩阵，分别记录默认配置与已验证的显式宿主内存配置，然后再做长时间稳定性验收。
