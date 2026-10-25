# dom-mirror

基于 Chromium 的远程浏览器 DOM 镜像原型。业务页面在服务端执行，客户端接收 DOM/CSS 快照及增量补丁，在本地渲染并回传交互。

当前版本 **0.10.0**，支持 `dom` 和 `frame` 两种模式。旧的 JPEG/WebP/H.264、CanvasKit 通道已经移除，无需 ffmpeg。

## 工作方式

```text
访客浏览器                         Node.js 服务
Shadow DOM 本地渲染 ← WebSocket → 每会话独立 Chromium → 业务源站
                   快照 / 补丁 / 输入
图片、CSS、字体      ← /m/* 代理 ← ORIGIN_URL 所在源站
```

- `dom`（默认）：发送清理后的 DOM/CSS；MutationObserver 收集变化，合并子树补丁；canvas 按需转为图片。
- `frame`：服务端合成器驱动 PNG 差分条带，作为画面兜底。仍使用镜像 DOM 和交互管线，并非完全不下发 DOM 的纯像素隔离。
- 鼠标按压、移动、释放通过 CDP 派发，附带元素路径锚点校正；输入值通过原生 setter 与 input/change 事件回写，特殊按键通过 CDP 派发。
- 滚动双向同步，导航、结构漂移和样式表集合变化可触发全量重同步。
- 可选字体混淆：将部分中文和标点替换为会话 PUA 码点，再通过配套字体显示。

## 快速开始

### Docker

```bash
docker build -t dom-mirror:local .
docker run --rm -p 127.0.0.1:18088:8088 dom-mirror:local
```

访问 `http://127.0.0.1:18088/`，默认镜像容器内置演示页。接入自己的站点：

```bash
docker run --rm -p 127.0.0.1:18088:8088 \
  -e ORIGIN_URL=https://your-site.example/ \
  -e DEFAULT_MODE=dom \
  dom-mirror:local
```

容器内的 `127.0.0.1` 指向容器自身。外部业务源站必须能从容器内访问。默认无混淆字体池，文字按原文显示。

### 本地源码

需要 Node.js 22.12+、npm，以及 Chromium 所需的系统库。

```bash
npm ci
npx puppeteer browsers install chrome
npm run check
npm test
ORIGIN_URL=https://your-site.example/ npm start
```

显式运行 browsers install 可确保匹配的浏览器已下载，不依赖 npm 是否允许 postinstall 脚本。使用已有 Chromium 时可设置 `PUPPETEER_SKIP_DOWNLOAD=true` 安装，跳过 browsers install，并在启动时设置 `PUPPETEER_EXECUTABLE_PATH`。容器已包含浏览器及系统依赖。

项目目前为独立服务，`require()` 会启动监听，尚未提供可嵌入其他 Node 服务的 SDK。

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `DEMO_PORT` | `8088` | 镜像 HTTP/WS 监听端口，绑定 `0.0.0.0` |
| `ORIGIN_PORT` | `8077` | 内置演示源站端口，仅绑定回环；指定外部源站后仍会启动 |
| `ORIGIN_URL` | `http://127.0.0.1:8077/` | 初始业务页面与静态资源代理基址 |
| `DEFAULT_MODE` | `dom` | `dom` / `frame`；无效值回退 `dom` |
| `MAX_SESSIONS` | `3` | 活跃及断线保留会话的总上限；每会话独立 Chromium |
| `SESSION_GRACE_MS` | `60000` | 服务端检测到断线后的保留时间（毫秒），范围 0–300000；0 表示不保留 |
| `VIEW_W` / `VIEW_H` | `1280` / `800` | 初始视口，随后以客户端 hello 上报为准 |
| `OBFUSCATE` | `1` | 有完整字体池时开启；`0` 关闭 |
| `PROD_PRESENTATION` | `0` | `1` 隐藏演示面板，仅呈现业务页面；不增加安全保护 |
| `RBI_ALLOWED_ORIGINS` | 空 | 逗号分隔的源站 origin 白名单；为空时拒绝带 `x-rbi-origin` 的会话 |
| `PUPPETEER_EXECUTABLE_PATH` | Puppeteer 管理 | 自定义浏览器可执行文件 |

网关若使用 `x-rbi-origin`，需要配置 `RBI_ALLOWED_ORIGINS`，并在入口剥除访客同名头，只由可信网关注入。头值只用于选取白名单内的 origin，路径不保留。当前 `/m/*` 和部分 URL 重写仍使用固定 `ORIGIN_URL`，多源站资源路由尚不完整；建议每个源站使用独立实例。

## 短时断线恢复

同一页面的 WebSocket 断开后会自动重试，默认保留原 Chromium 60 秒，登录态、路由及服务端已收到的表单草稿随之保留。重连取得原会话后重新发送全量快照，完成同步才开放操作。客户端不会自动重放输入、点击或提交；提交结果不明确时，应先核对业务记录再决定是否重新操作。

恢复凭据只存于当前页面内存，通过 WS 消息传递，不写 URL、Cookie 或 Web Storage。刷新页面、关闭后重新打开、服务重启或 Chromium 退出均不能恢复。同账号多个页面各用独立会话。密码和文件输入值不会在新快照中回填；断线前尚未送达服务端的修改不保证保留。

断线检测依赖 WS close 或服务端心跳（10 秒一次，未响应的下一轮终止连接），实际网络黑洞的发现有延迟；保留计时从服务端确认断线开始。会话过期会冻结页面并显示“重新开始”，必须手动创建新会话。保留中的浏览器仍占资源和 `MAX_SESSIONS` 名额，关闭页面后也要等待保留期回收；协议客户端可用 `release` 主动结束。此功能不提供提交事务确认或持久会话。

隔离回归（镜像须先从当前源码构建；测试专用保留期为 2 秒）：

```bash
IMAGE=dom-mirror:local SESSION_GRACE_MS=2000 \
  BUSINESS_TEST_SCRIPT=verify-recovery.cjs EVIDENCE_DIR=artifacts/recovery \
  bash tools/verify-docker-vikunja.sh
```

覆盖 DOM/frame 的登录、路由和草稿恢复、已落库但未显示确认的提交、同账号会话隔离与关闭、过期后显式重新开始。证据不包含恢复凭据或登录密码。

## 可选字体混淆

需要 Python 3、fontTools 和 Brotli 支持。准备有合法再分发许可、包含中文字符的 Regular/Bold TTF 或 OTF 字体：

```bash
python3 -m venv .venv
.venv/bin/pip install 'fonttools[woff]'
mkdir -p assets/obf
.venv/bin/python tools/build_obf_font.py /path/Regular.ttf 861001 \
  assets/obf/reg-s861001.woff2 assets/obf/reg-s861001.json
.venv/bin/python tools/build_obf_font.py /path/Bold.ttf 861001 \
  assets/obf/bold-s861001.woff2 assets/obf/bold-s861001.json
```

每组种子的 Regular/Bold 必须采用相同字符覆盖，否则映射可能不一致。重启服务加载字体池；Docker 构建时会复制 `assets/`。本地构建网站自有字体孪生时，服务会调用 PATH 中的 `python3`，需保证该解释器也能导入 fontTools。

批量烘焙可将两份基础字体放在当前目录，命名为 `NotoSansSC-Reg.ttf`、`NotoSansSC-Bold.ttf`，再运行 `python3 tools/bake_pool.py 4 assets/obf`。

**字体混淆不是加密。** 客户端必须取得字体，且字体保留原码点与 PUA 到同一字形的映射，可恢复文字。ASCII、数字、输入框值及域外字符不混淆。它只增加直接提取部分文字的成本，也会影响复制、搜索和无障碍体验。

## 安全边界

- DOM 序列化会删除 script/noscript/template、on* 事件属性、srcdoc、formaction 和部分文本辅助属性，但不是经过完整安全验证的 HTML sanitizer。
- 可见文本、DOM 结构、CSS、输入值、隐藏字段及自定义属性可能下发。源站若把密钥或非展示数据放入 DOM/CSS，本服务不会自动识别并移除。不能承诺“所有业务数据不出服务器”。
- 业务页面脚本在服务端执行，Cookie 和浏览器存储不会作为通用同步项直接下发；页面自己展示的会话数据仍可能进入镜像。
- `/m/*` 限制为固定源站的静态资源扩展名，拒绝重定向及 HTML/JSON/JS/XML 响应，并设置超时；这不是完整的内容安全策略。源站需避免通过静态资源路径返回敏感信息。
- 外链、iframe、内联样式等仍需进一步收口。Shadow DOM 用于样式隔离，不是安全沙箱。
- `/ws` 没有内建用户鉴权、速率限制或 WebSocket Origin 校验。部署入口需完成认证、TLS、连接限制与来源控制；业务站点导航和子资源也没有完整的网络访问白名单。
- Chromium 当前使用 `--no-sandbox`，Docker 以 root 运行。适用范围是可信、受控源站的验证环境；处理不可信网页前需另行加固运行隔离。

## 已知限制与验收

- 每会话独立浏览器，内存和 CPU 成本需要按真实业务压测；默认 3 会话不代表已验证的容量指标。
- checkbox/radio 的专门 checked 同步、上传下载、剪贴板、弹窗、多窗口、iframe、Shadow DOM、复杂富文本与虚拟滚动尚无完整兼容性保证。
- CSS URL 与选择器重写依赖字符串/正则，嵌套规则、外链 CSS 相对资源及动态 CSSOM 修改需逐站验证。
- 补丁替换和全量重同步可能影响焦点、选区及交互。`frame` 也不保证消除所有交互兼容问题。
- 静止业务 DOM 可以不发结构补丁，但统计、ping/pong、滚动兜底消息仍会发送；不是零网络流量。
- 历史延迟、流量和像素差数据见 Git 历史及 CHANGELOG，仅代表当时场景。本轮未重新做性能或视觉验收，不作为当前版本保证。

本地检查：`npm run check && npm test`。CI 另做 Docker 构建与 HTTP 探活；HTTP 200 只证明壳页面可访问，不能替代真实浏览器会话验收。站点接入需验证登录、输入、导航、滚动、动态样式、断连释放，以及两种通道的截图差异。

## 滚动与首次点击回归

CI 使用同一个隔离 Docker 回归入口：

```bash
IMAGE=dom-mirror:local bash tools/verify-docker-scroll.sh
```

该命令使用 internal 网络，无宿主端口；分别启动服务端与浏览器容器，自动收集结果和日志并清理。默认结果位于 `artifacts/scroll/`，可通过 `EVIDENCE_DIR` 指定目录。镜像需先从当前源码构建。以下是手动运行方式。

`tools/verify-pointer-scroll.cjs` 用真实鼠标分别点击可见按钮、页面底部按钮、内部滚动容器中的按钮；每项只点一次，不等待滚动同步、不重试。仅对测试源站运行。

先按快速开始构建当前镜像，再启动专用测试实例：

```bash
docker run --rm --name dom-mirror-scroll-test \
  -p 127.0.0.1:18089:8088 \
  -e PROD_PRESENTATION=1 \
  -e ORIGIN_URL=http://127.0.0.1:8077/scroll.html \
  -v "$PWD/test/fixtures:/app/protected:ro" dom-mirror:local
```

另一个终端使用已安装依赖和 Chromium 的源码环境执行：

```bash
MIRROR_URL=http://127.0.0.1:18089/ \
  EVIDENCE_DIR=/tmp/dom-mirror-scroll-evidence \
  node tools/verify-pointer-scroll.cjs
```

失败时返回非零退出码，证据目录保存 `result.json` 及上行 WS 消息。测试结束后停止专用容器。DOM 模式在 pointerdown 前发送即时滚动同步，服务端串行处理后才派发按压；frame 模式仍以服务端滚动状态为准。

## 真实业务回归：Vikunja

使用固定 digest 的 Vikunja v2.7.1、SQLite 和临时合成账号/任务。准备当前源码构建的镜像后运行：

```bash
IMAGE=dom-mirror:local bash tools/verify-docker-vikunja.sh
```

该命令建立 internal 网络，无宿主端口，数据库与文件使用 tmpfs。分别验证直连、DOM、frame 的登录、创建任务、修改优先级为 Medium、标记完成；创建和修改同时检查应用 API 持久化及镜像控件状态。账号密码和 token 仅存于测试进程内存。默认证据保存在 `artifacts/vikunja/`，退出时删除测试容器、网络和临时业务数据。失败返回非零。

CI 也自动运行这项业务回归并保存证据。脚本针对这个固定版本的英文 UI；不代表任意站点兼容。完整结果、限制及版本信息见 [业务验收记录](docs/acceptance/vikunja-2026-10-26.md)。后续阶段见 [实施路线图](docs/ROADMAP.md)。

## 文件

- `server.js`：HTTP/WS、浏览器会话、序列化、补丁及 PNG 差分。
- `lib/policy.js`：资源 URL 与源站选择策略。
- `client/index.html`：镜像渲染、输入回传及演示面板。
- `protected/index.html`：内置演示源站。
- `tools/`：字体构建工具。
- [实施路线图](docs/ROADMAP.md)、[协议](docs/PROTOCOL.md)、[变更记录](CHANGELOG.md)、[演示说明](README.demo.md)。

代码采用 [Apache-2.0](LICENSE)；内置 Noto Sans SC 字体采用 [SIL OFL 1.1](assets/FONT-OFL-LICENSE.txt)。自备字体需遵循其自身许可。
