# dom-mirror — 虚影 DOM 镜像（RBI 引擎 + 四通道演示）

> 让业务逻辑与数据永不离开服务器的网页交付引擎。
> DOM 镜像 / JPEG / WebP / H.264 四种通道运行时可切换，带真实系统接入实测。

English one-liner: A Remote Browser Isolation engine that mirrors the DOM instead of pixels — business JS and data never leave the server, rendering runs locally at native feel.

## 这是什么

传统反爬两条路都有硬伤：**客户端加密/混淆**（代码终究要下发，可逆向——典型如 Service Worker 隧道方案）；**像素流 RBI**（安全但交互延迟高、带宽大、文字发糊）。

`dom-mirror` 在浏览器渲染管线的**"JS 执行之后、渲染之前"**切口：

```
JS执行 → [DOM+CSS] → 样式计算 → 布局 → 绘制 → 合成 → 像素
           ↑切口：逻辑留服务端，中间表示下发，渲染在客户端本地
```

- 服务端无头 Chromium 跑真实页面（业务 JS、密钥、接口全部不出服务器）；
- 客户端拿到的是**剥除全部脚本后的 DOM 镜像**，在本地渲染——滚动/悬停/打字是原生体验；
- 交互（点击/输入）按元素路径回传，页面变化以几百字节的补丁回推。

## 实测数据（1280×800，同一交互场景）

| 通道 | 首次成本 | 交互流量 | 交互更新延迟 | 空闲流量 |
|---|---|---|---|---|
| JPEG q60 | - | 2050 KB | 27–30 ms | ~57 KB/s（有时钟的页面） |
| WebP | - | 1825 KB | 87–92 ms | 类似 |
| H.264（x264 ultrafast/zerolatency） | 探测期 | 456 KB | 30–33 ms | 极低 |
| **DOM 镜像** | **快照 ~31KB（真实系统约 210KB 含全量 CSS）** | **~1.4 KB** | **4–8 ms** | **~0.19 KB/s** |

已在真实企业级 React SPA（含外链组件库样式、`:root` 主题变量、登录鉴权）上验证可用。

## 快速开始

```bash
# 1. 获取静态 ffmpeg（H.264 通道用；只用 DOM 镜像可跳过）
./get-ffmpeg.sh

# 2. 构建并运行（内置演示源站）
docker build -t dom-mirror:demo .
docker run -d --name dom-mirror -p 18088:8088 dom-mirror:demo
# 打开 http://127.0.0.1:18088/ → 点"DOM 镜像"按钮

# 3. 镜像你自己的站点
docker run -d --name dom-mirror -p 18088:8088 \
  -e ORIGIN_URL=http://your-site.example.com/ \
  -e DEFAULT_MODE=dom dom-mirror:demo
```

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `ORIGIN_URL` | `http://127.0.0.1:8077/` | 被镜像的真实站点（内置演示页） |
| `DEFAULT_MODE` | `jpeg` | 初始通道：`jpeg` / `webp` / `h264` / `dom` |
| `MAX_SESSIONS` | `3` | 并发会话上限（每会话一个 Chromium 页签） |
| `VIEW_W` × `VIEW_H` | 1280×800 | 像素通道分辨率 |
| `FRAME_MIN_INTERVAL` | 33 | 像素通道帧率节流（ms，30fps 上限） |

## 架构

```
访客浏览器                                服务端
┌──────────────────┐   WS(快照/补丁/事件)  ┌────────────────────────────┐
│ 壳页面            │◄──────────────────► │ dom-mirror 服务             │
│  ├ Shadow DOM 镜像│                     │  ├ 海关序列化器（剥script等）│
│  │ (本地渲染)     │                     │  ├ CDP ──► 无头 Chromium    │
│  └ WebCodecs(H264)│                     │  ├ ffmpeg (H.264 通道)      │
└──────────────────┘                     │  └ /m/* 静态资源代理        │
                                          └────────────────────────────┘
```

核心组件：

- **海关序列化器**（`server.js` / PAGE_HELPERS）：克隆 DOM → 剥 `<script>`/`noscript`/`template`、`on*` 事件属性、`srcdoc` → URL 重写到资源代理 → `<canvas>` 转位图兜底。这是脱敏/剔除策略的挂载点。
- **补丁模型**：MutationObserver 捕获变化，元素级 innerHTML/outerHTML 重发（自愈语义，路径失配自动全量重同步）。
- **事件回传**：客户端按元素路径（body 起 childNodes 索引）转发 click/input/change，服务端对真实页面元素执行。
- **客户端**：Shadow DOM 样式隔离 + `:root`/`html`/`body` 选择器映射 + 本地原生输入。

WS 协议消息定义见 [docs/PROTOCOL.md](docs/PROTOCOL.md)。

## 安全边界（诚实版）

**保证**：业务 JS 零下发；密钥/隐藏字段可在海关层逐字段剔除；源站地址不下发；会话 Cookie/token 留在服务端浏览器。

**不保证**：页面上用户可见的文本会随镜像下发（可被程序化解析）。任何方案下可见内容都无法对"人"保密（可截图）；若需对"机器"保密，将敏感字段在海关层替换为像素瓦片，并配合行为风控限速。**本引擎不内建反爬风控，反爬能力需外层 WAF 配合。**

## 已知边界（生产化清单）

- [ ] checkbox/radio 按 `checked` 同步（当前按 `value`，不正确）
- [ ] div+onClick 的非语义按钮点击转发（当前只委托 button/a）
- [ ] `javascript:` href 应删除属性（当前仅拦截点击）
- [ ] 海关对 inline style 内容的扫描（`content:url()` 类旁路）
- [ ] 含活动输入框的补丁块跳过保护（防丢焦点）
- [ ] 重同步风暴检测 → 自动降级像素流
- [ ] CDP Input 管线替换合成事件（`isTrusted`）
- [ ] CSS AST（postcss）替换正则做选择器映射
- [ ] SPA 深链接路由同步（URL 携带当前路由）
- [ ] alert/confirm 桥接（CDP dialog 事件）
- [ ] CSS 按需裁剪与字体子集化（快照瘦身）
- 虚拟滚动/无限滚动页面假设"全量 DOM 在场"，此类页面建议走像素通道

## 路线图

- **v0.1**（当前）：单容器演示，四通道可切换，协议稳定
- **v0.2**：npm 依赖包形态 —— `@yuzhian/dom-mirror-server`（挂到已有 Node 服务）+ `@yuzhian/dom-mirror-client`（纯前端 attach）；协议版本化
- **v0.3**：Go 实现（chromedp）与浏览器池/会话管理，适配虚影按路径策略体系
- 欢迎通过 issue 提交站点适配案例（"某某组件库镜像异常"），沉淀通用规则包

## License

[Apache-2.0](LICENSE) © 2026 Chengdu Yuzhian Technology Co., Ltd.（成都御之安科技有限公司）
