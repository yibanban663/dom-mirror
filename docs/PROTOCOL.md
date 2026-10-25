# WebSocket 协议（实现版本 0.9.0）

连接入口为 `GET /ws`。当前消息均为 JSON 文本，图片通过 data URL 嵌入；无 H.264、JPEG/WebP 二进制流。通道只接受 `dom` 和 `frame`。

单条上行消息上限 64 KiB，超过时连接由 ws 关闭。上行 JSON 应为对象，非法 JSON、null 和数组忽略。尚无协议版本协商或稳定 SDK 兼容承诺。

## 客户端 → 服务端

| type | 字段 | 用途 |
|---|---|---|
| `hello` | `dpr,w,h` | 首次上报和后续调整像素比/视口；DPR 1–3，宽 320–2560，高 240–1600 |
| `mode` | `mode` | 切换 dom/frame；重复当前模式可请求全量重同步 |
| `dom` | `kind,path,value?` | input/change 值同步；保留 click 处理，当前客户端指针走 mouse |
| `mouse` | `action,x,y,button?,buttons?,dx?,dy?,apath?,ax?,ay?` | move/down/up/wheel；坐标为视口 CSS 像素，apath/ax/ay 校正服务端元素锚点偏移 |
| `key` | `action,key?,text?` | 特殊按键或文本键入；action 为 down/up |
| `scroll` | `x,y,inner?` | 页面及内部容器滚动；inner 为 `[path,scrollTop,scrollLeft]` 数组 |
| `scrolltop` | 无 | 服务端页面回顶部 |
| `repaint` | `x,y,w,h` | 请求服务端页面坐标区域的像素重绘 |
| `ping` | `t` | RTT 探测 |

## 服务端 → 客户端

| type | 字段 | 用途 |
|---|---|---|
| `meta` | `w,h,title?,maxSessions?,mode?,prod` | 初始会话信息或视口调整；不直接发送源站 URL |
| `mode` | `mode` | 通道切换确认 |
| `dom-snapshot` | `css,html,title,w,h,tiles,frame,docClass,docAttrs` | 全量镜像；frame 模式附带 PNG 条带底板 |
| `dom-patches` | `patches` | 子树 innerHTML/outerHTML 补丁，元素携带 path |
| `doc-class` | `cls` | 更新镜像根 class |
| `scroll-sync` | `sx,sy,scrolls` | 服务端滚动位置；scrolls 为 `[path,scrollTop,scrollLeft]` 数组 |
| `canvas-tile` | `path,url` | 更新 canvas 对应镜像图片 |
| `anim-tiles` | `tiles,holes?,sx?,sy?,scrolls?` | PNG 差分及区域重绘；坐标和尺寸见下文 |
| `sstats` | `fps,mr,inLat,mode,els` | 帧/消息速率、输入到帧延迟及结构计数；inLat 不是 DOM 端到端更新延迟 |
| `pong` | `t` | 回显 ping 时间戳 |
| `error` | `msg` | 会话建立、事件处理或通道错误 |

`dom-snapshot.frame` 为 null 或 `{pageW,pageH,tiles}`。每个 tile 包含 `{w,h,cssX,cssY,cssW,cssH,url}`：w/h 为图片设备像素尺寸，cssX/cssY 为页面 CSS 像素坐标，cssW/cssH 为展示尺寸，url 为 PNG data URL。`anim-tiles.tiles` 使用同样结构；holes 为 `[x,y,w,h]` 页面 CSS 像素矩形数组。

frame 是画面底板，客户端仍构建镜像 DOM。字段尚在演进，消费端需与服务端一起升级。

## 路径与同步

path 是以业务 body 为根的元素索引串，如 `3/5/1`，空串代表 body。服务端按 children 编号并跳过 SCRIPT/NOSCRIPT/TEMPLATE；客户端按镜像 children 编号。文本节点和注释不参与编号，避免 Vue 等框架生成的空文本、相邻文本在 HTML 重解析后改变路径。canvas 替换为 img，仍占同一个元素位置。

**0.9.0 的路径语义与 0.8.x childNodes 路径不兼容。必须一起升级服务端与客户端，并重新建立会话；不支持混用旧客户端或复用旧路径。**

DOM 客户端在 pointerdown 之前发送 `scroll`，包括页面位置和目标祖先内部容器位置。服务端按接收顺序串行处理命令，先完成滚动再测量锚点并派发 mouse down；不能依赖浏览器异步 scroll 事件先于 pointerdown 到达。frame 保持服务端滚动为准。

结构变化合并后发送子树补丁；客户端路径失配请求全量快照。重同步、导航和输入可能存在竞态，协议不提供事务序号、确认重传或跨断连恢复；重新连接会创建新浏览器会话。

## 资源和边界

`/m/*` 只代理固定 `ORIGIN_URL` 同源、扩展名在白名单内的表现层资源，拒绝重定向和 HTML/JSON/JS/XML 响应。`/m/obf/<sid>/*` 为混淆字体路径。

`x-rbi-origin` 仅在 `RBI_ALLOWED_ORIGINS` 显式允许时接受；网关需剥除访客伪造头。该选项不提供完整的多源站资源路由。

HTML/CSS/属性和值可能携带业务数据。frame 并非纯像素保密协议，字体混淆也非加密。完整限制见 [README](../README.md)。
