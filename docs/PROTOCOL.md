# WebSocket 协议（实现版本 0.10.1）

连接入口为 `GET /ws`。当前消息均为 JSON 文本，图片通过 data URL 嵌入；无 H.264、JPEG/WebP 二进制流。通道只接受 `dom` 和 `frame`。

单条上行消息上限 64 KiB，超过时连接由 ws 关闭。首次消息必须在 3 秒内发送 `hello`，无效握手关闭连接；后续上行 JSON 应为对象，非法 JSON、null 和数组忽略。尚无协议版本协商或稳定 SDK 兼容承诺。

## 客户端 → 服务端

| type | 字段 | 用途 |
|---|---|---|
| `hello` | `dpr,w,h,resume?` | 首次上报和后续调整像素比/视口；DPR 1–3，宽 320–2560，高 240–1600 |
| `mode` | `mode` | 切换 dom/frame；重复当前模式可请求全量重同步 |
| `dom` | `kind,path,value?` | input/change 值同步；保留 click 处理，当前客户端指针走 mouse |
| `mouse` | `action,x,y,button?,buttons?,dx?,dy?,apath?,ax?,ay?` | move/down/up/wheel；坐标为视口 CSS 像素，apath/ax/ay 校正服务端元素锚点偏移 |
| `key` | `action,key?,text?` | 特殊按键或文本键入；action 为 down/up |
| `scroll` | `x,y,inner?` | 页面及内部容器滚动；inner 为 `[path,scrollTop,scrollLeft]` 数组 |
| `scrolltop` | 无 | 服务端页面回顶部 |
| `repaint` | `x,y,w,h` | 请求服务端页面坐标区域的像素重绘 |
| `ping` | `t` | RTT 探测 |
| `release` | 无 | 立即结束当前逻辑会话并关闭浏览器；关闭 WS 则进入保留期 |

## 服务端 → 客户端

| type | 字段 | 用途 |
|---|---|---|
| `session` | `token,resumed,graceMs` | 首次握手返回恢复凭据；resumed 标记是否复用原会话 |
| `sync-ready` | 无 | 首次建立或恢复的全量同步已发送；客户端完成快照构建后才开放操作 |
| `meta` | `w,h,title?,maxSessions?,mode?,prod` | 初始会话信息或视口调整；不直接发送源站 URL |
| `mode` | `mode` | 通道切换确认 |
| `dom-snapshot` | `css,html,title,w,h,tiles,frame,docClass,docAttrs,sx,sy,scrollers` | 全量镜像；frame 模式附带 PNG 条带底板 |
| `dom-patches` | `patches` | 子树 innerHTML/outerHTML 补丁，元素携带 path |
| `doc-class` | `cls` | 更新镜像根 class |
| `scroll-sync` | `sx,sy,scrolls` | 服务端滚动位置；scrolls 为 `[path,scrollTop,scrollLeft]` 数组 |
| `canvas-tile` | `path,url` | 更新 canvas 对应镜像图片 |
| `anim-tiles` | `tiles,holes?,sx?,sy?,scrolls?` | PNG 差分及区域重绘；坐标和尺寸见下文 |
| `sstats` | `fps,mr,inLat,mode,els` | 帧/消息速率、输入到帧延迟及结构计数；inLat 不是 DOM 端到端更新延迟 |
| `pong` | `t` | 回显 ping 时间戳 |
| `error` | `msg,code?,terminal?` | 会话建立、事件处理或通道错误 |

`dom-snapshot.frame` 为 null 或 `{pageW,pageH,tiles}`。每个 tile 包含 `{w,h,cssX,cssY,cssW,cssH,url}`：w/h 为图片设备像素尺寸，cssX/cssY 为页面 CSS 像素坐标，cssW/cssH 为展示尺寸，url 为 PNG data URL。`anim-tiles.tiles` 使用同样结构；holes 为 `[x,y,w,h]` 页面 CSS 像素矩形数组。

frame 是画面底板，客户端仍构建镜像 DOM。字段尚在演进，消费端需与服务端一起升级。

## 路径与同步

path 是以业务 body 为根的元素索引串，如 `3/5/1`，空串代表 body。服务端按 children 编号并跳过 SCRIPT/NOSCRIPT/TEMPLATE；客户端按镜像 children 编号。文本节点和注释不参与编号，避免 Vue 等框架生成的空文本、相邻文本在 HTML 重解析后改变路径。canvas 替换为 img，仍占同一个元素位置。

**0.9.0 的路径语义与 0.8.x childNodes 路径不兼容。必须一起升级服务端与客户端，并重新建立会话；不支持混用旧客户端或复用旧路径。**

DOM 客户端在 pointerdown 之前发送 `scroll`，包括页面位置和目标祖先内部容器位置。服务端按接收顺序串行处理命令，先完成滚动再测量锚点并派发 mouse down；不能依赖浏览器异步 scroll 事件先于 pointerdown 到达。frame 保持服务端滚动为准。

结构变化合并后发送子树补丁；客户端路径失配请求全量快照。重同步、导航和输入可能存在竞态，协议不提供事务序号或提交确认重传。

## 会话恢复（0.10.0）

首次 `hello` 不含 resume，服务端创建会话并返回 `session.token`。断线后在保留期内发送 `hello.resume=token`，只有已断开的会话可以恢复；源站配置与请求 Origin 必须与原连接一致。这是恢复范围绑定，不替代入口身份鉴权或 Origin 白名单。token 为随机 256 bit 凭据，持有者可恢复原浏览器；必须使用 TLS，禁止记录 token。官方客户端只存于页面内存。

恢复时保留 Chromium，丢弃离线期间下行更新，串行完成此前已接收的命令，再发送 meta、全量 dom-snapshot 与 sync-ready。快照包含运行中的非密码/非文件表单值及滚动位置；客户端清掉旧输入缓存，以服务端状态为准。恢复期间冻结操作，不缓冲或重发业务命令。客户端需同时等待该连接的快照构建完成及 sync-ready，不能仅凭 WS open 开放交互。

默认服务端检测断线后保留 60000ms，由 SESSION_GRACE_MS 调整，最大 300000ms。检测依赖 WS close 或 10 秒心跳，网络黑洞检测可能延迟。断线保留仍计入 MAX_SESSIONS；过期、release 或浏览器退出会清理会话。SESSION_BUSY（原连接仍活跃）及 SESSION_LIMIT 可退避重试；SESSION_EXPIRED 和 INVALID_HANDSHAKE 为 terminal，停止自动重试，等待用户手动新建。错误不会悄悄回退成新会话。

页面刷新、关闭重开、服务进程重启不支持恢复；未送达服务端的输入无法保证保留，已提交但未确认的操作需要用户核对。0.10.0 客户端新增同步屏障，须与服务端一起升级。

## 资源和边界

`/m/*` 只代理固定 `ORIGIN_URL` 同源、扩展名在白名单内的表现层资源，拒绝重定向和 HTML/JSON/JS/XML 响应。`/m/obf/<sid>/*` 为混淆字体路径。

`x-rbi-origin` 仅在 `RBI_ALLOWED_ORIGINS` 显式允许时接受；网关需剥除访客伪造头。该选项不提供完整的多源站资源路由。

HTML/CSS/属性和值可能携带业务数据。frame 并非纯像素保密协议，字体混淆也非加密。完整限制见 [README](../README.md)。
