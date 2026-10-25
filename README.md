# dom-mirror

基于 Chromium 的远程浏览器 DOM 镜像原型。业务页面在服务端执行，客户端接收 DOM/CSS 快照及增量补丁，在本地渲染并回传交互。

当前版本 **0.8.4**，支持 `dom` 和 `frame` 两种模式。旧的 JPEG/WebP/H.264、CanvasKit 通道已经移除，无需 ffmpeg。

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
| `MAX_SESSIONS` | `3` | 并发会话上限；每会话启动独立 Chromium 实例 |
| `VIEW_W` / `VIEW_H` | `1280` / `800` | 初始视口，随后以客户端 hello 上报为准 |
| `OBFUSCATE` | `1` | 有完整字体池时开启；`0` 关闭 |
| `PROD_PRESENTATION` | `0` | `1` 隐藏演示面板，仅呈现业务页面；不增加安全保护 |
| `RBI_ALLOWED_ORIGINS` | 空 | 逗号分隔的源站 origin 白名单；为空时拒绝带 `x-rbi-origin` 的会话 |
| `PUPPETEER_EXECUTABLE_PATH` | Puppeteer 管理 | 自定义浏览器可执行文件 |

网关若使用 `x-rbi-origin`，需要配置 `RBI_ALLOWED_ORIGINS`，并在入口剥除访客同名头，只由可信网关注入。头值只用于选取白名单内的 origin，路径不保留。当前 `/m/*` 和部分 URL 重写仍使用固定 `ORIGIN_URL`，多源站资源路由尚不完整；建议每个源站使用独立实例。

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

## 文件

- `server.js`：HTTP/WS、浏览器会话、序列化、补丁及 PNG 差分。
- `lib/policy.js`：资源 URL 与源站选择策略。
- `client/index.html`：镜像渲染、输入回传及演示面板。
- `protected/index.html`：内置演示源站。
- `tools/`：字体构建工具。
- [协议](docs/PROTOCOL.md)、[变更记录](CHANGELOG.md)、[演示说明](README.demo.md)。

代码采用 [Apache-2.0](LICENSE)；内置 Noto Sans SC 字体采用 [SIL OFL 1.1](assets/FONT-OFL-LICENSE.txt)。自备字体需遵循其自身许可。
