# dom-mirror WebSocket 协议（v0.1）

单 WebSocket 连接（`GET /ws` → 101），文本帧为 JSON，二进制帧为像素通道的图像/编码数据。
本协议是依赖包化的契约基础：v0.x 内保持向后兼容，破坏性变更升主版本并在本文件记录。

## 消息总表

| 方向 | 帧 | type | 载荷 | 说明 |
|---|---|---|---|---|
| ↓ | text | `meta` | `{w,h,title,url,maxSessions,mode}` | 会话建立，通道初始模式 |
| ↓ | text | `mode` | `{mode}` | 通道切换确认（`jpeg`/`webp`/`h264`/`dom`） |
| ↑ | text | `mode` | `{mode}` | 请求切换通道；`dom` 模式下亦作"全量重同步"请求 |
| ↓ | text | `quality` | `{q}` | 画质切换确认（10–95，仅 jpeg/webp） |
| ↑ | text | `quality` | `{q}` | 请求切换画质 |
| ↓ | binary | - | JPEG/WebP 字节 | jpeg/webp 通道的帧（仅变化推帧） |
| ↓ | binary | - | H.264 Annex-B | h264 通道的编码块（x264, repeat-headers, 客户端 WebCodecs 解码） |
| ↓ | text | `dom-snapshot` | `{css,html,title,w,h}` | DOM 镜像全量快照（首次/重同步） |
| ↓ | text | `dom-patches` | `{patches:[{path,inner?,outer?}]}` | DOM 增量补丁 |
| ↑ | text | `dom` | `{kind,path,value?}` | 交互回传：click / input / change |
| ↓ | text | `sstats` | `{fps,inLat,mode}` | 每秒服务端指标（出帧率、最近输入→出帧延迟） |
| ↑ | text | `ping` | `{t}` | RTT 探测 |
| ↓ | text | `pong` | `{t}` | 回显 t |
| ↓ | text | `error` | `{msg}` | 错误/降级通知 |

## DOM 镜像语义

- **元素路径**：以 body 为根的 childNodes 索引串，`"3/5/1/3/1"`；空串表示 body 本身。两端使用同一算法（见 `server.js` PAGE_HELPERS `pathOf` 与客户端 `pathOfMirror`）。
- **快照**：`css` 为源站全部样式文本（`<style>` + 外链 `<link>` 抓取，`url(/x)` 已重写为 `/m/x`）；`html` 为海关消毒后的 body innerHTML（无 script/事件属性，canvas→img，静态资源 URL 已重写 `/m/...`）。
- **补丁**：元素级重发。`inner` 替换该元素 innerHTML；`outer` 以整节点替换。路径失配时客户端应发送 `{type:"mode",mode:"dom"}`（或 `dombitmap`）请求重同步。
- **文字位图补丁（dombitmap 模式）**：`{path, bitmap:{w,h,url}}` 将元素整块替换为服务端渲染位图（PNG dataURL）；`{path, bitmapInner:{w,h,url}}` 仅替换元素内容、保留元素本身（用于按钮/链接等交互元素，保证可点击）。快照阶段文本节点直接以 `<img data-xy-bitmap>` 形式内嵌；不可见文本被剥除。
- **事件**：客户端在镜像 Shadow DOM 上捕获 click（a/form 之外不阻止默认，a 与表单提交一律 preventDefault）、input、change，携带路径与值上行；服务端定位真实页面元素执行（click() / 设值+dispatchEvent）。
- **静态资源**：`GET /m/*` 由引擎代理回源（表现层资源；非白名单实现，严格模式自行收敛）。
- **字体一致性（dom 模式）**：`GET /f/noto-regular|/f/noto-bold` 下发服务端 fontconfig 同款 TTC，客户端以 FontFace API 按字重注册（Shadow DOM 内 `<style>` 的 @font-face 在 Chromium 不生效；单一 Regular 覆盖全字重会导致伪粗体与排版偏移）。`dombitmap` 模式文字为位图，无需字体下发。

## H.264 通道要点

- 服务端：CDP screencast(JPEG) → ffmpeg `image2pipe` → libx264 `-preset ultrafast -tune zerolatency -profile main -level 4.0`，**`-analyzeduration 0 -probesize 1M`（稀疏输入首帧即出流的关键参数）**，`keyint=30`、`repeat-headers=1`。
- 客户端：Annex-B NAL 切分 → 首个 SPS 解析 codec 字符串 → `VideoDecoder`（`optimizeForLatency`）→ canvas。
- 需要 WebCodecs（Chrome/Edge）；不支持的浏览器应回落 jpeg/webp。
