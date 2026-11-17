# WebSocket 协议（实现版本 0.21.0）

连接入口为 `GET /ws`。当前消息均为 JSON 文本，图片通过 data URL 嵌入；无 H.264、JPEG/WebP 二进制流。通道只接受 `dom` 和 `frame`。WS 启用 permessage-deflate（阈值 512B，文本快照/补丁典型 5-10× 缩减）。

宿主配置 `getSessionIdentity` 时，在 WS 升级前验证非空身份，失败返回 HTTP 401。身份参与服务端恢复 scope，不增加协议字段；hello 中自报身份不参与授权。不配置时仍为匿名模式。

单条上行消息上限 64 KiB，超过时连接由 ws 关闭。首次消息必须在 3 秒内发送 `hello`，无效握手关闭连接；后续上行 JSON 应为对象，非法 JSON、null 和数组忽略。尚无协议版本协商或稳定 SDK 兼容承诺。

## 客户端 → 服务端

| type | 字段 | 用途 |
|---|---|---|
| `hello` | `dpr,w,h,resume?` | 首次上报和后续调整像素比/视口；DPR 1–3，宽 320–2560，高 240–1600 |
| `mode` | `mode` | 切换 dom/frame；重复当前模式可请求全量重同步 |
| `dom` | `kind,id?,path?,value?,html?` | input/change 值同步；v0.12 起按 id 定位（path 为过渡回退，下版删除）；kind `ce` 为 contenteditable 内容同步（html=元素 innerHTML，服务端 setInnerHTML+派发 input）；保留 click 处理，当前客户端指针走 mouse |
| `mouse` | `action,x,y,button?,buttons?,dx?,dy?,aid?,ax?,ay?` | move/down/up/wheel；坐标为视口 CSS 像素，aid/ax/ay 校正服务端元素锚点偏移（v0.12 起锚点按 id） |
| `key` | `action,key?,text?` | 特殊按键或文本键入；action 为 down/up；text 为单字符原文（键盘型应用：焦点不在输入控件时客户端转发，服务端 CDP 派发到真实焦点） |
| `scroll` | `x,y,inner?` | 页面及内部容器滚动；inner 为 `{id,top,left}` 对象数组（v0.12；旧元组 `[path,top,left]` 仅过渡期兼容） |
| `scrolltop` | 无 | 服务端页面回顶部 |
| `repaint` | `x,y,w,h` | 请求服务端页面坐标区域的像素重绘 |
| `composition` | `id,text,s,e` | IME 组合过程镜像（compositionstart/update），服务端 CDP imeSetComposition 写入源站焦点字段 |
| `composition-commit` | `id,text` | IME 上屏（compositionend），服务端 CDP insertText 键入最终文本 |
| `upload-begin` | `tid,name,size,fid` | 镜像 file input 选择本地文件后发起上传；tid 为客户端生成传输号，fid 为字段节点 id |
| `upload-chunk` | `tid,b64` | 上传分块（原始字节 ≤32KiB，base64 后连同 JSON 保持在 64KiB 消息上限内）；服务端校验分块数量与累计大小 |
| `upload-end` | `tid` | 分块结束；服务端落会话临时目录并 CDP setFileInputFiles 到远端字段 |
| `ping` | `t,fp?,rum?` | RTT 探测；fp=镜像元素指纹（剔除引擎自建层），服务端与源站比对做分歧自愈；rum=真实会话性能数据（首拍即报、此后 10s 一拍：帧时间 p50/p95、交互到视觉延迟 p50/p95、快照/补丁计数、按消息类型字节），服务端落 [rum] 日志聚合 |
| `dnd` | `kind,x,y,id?,text?` | v0.19：HTML5 拖拽转发——镜像上 dragstart/over/drop/end 合成到源站（DataTransfer 带 text/plain 载荷；over/drop 目标按坐标命中） |
| `touch` | `kind,pts` | v0.19：触摸转发——touchstart/move/end 触点坐标 → CDP dispatchTouchEvent（本地 preventDefault 防合成鼠标双事件） |
| `release` | 无 | 立即结束当前逻辑会话并关闭浏览器；关闭 WS 则进入保留期 |

## 服务端 → 客户端

| type | 字段 | 用途 |
|---|---|---|
| `session` | `token,resumed,graceMs` | 首次握手返回恢复凭据；resumed 标记是否复用原会话 |
| `sync-ready` | 无 | 首次建立或恢复的全量同步已发送；客户端完成快照构建后才开放操作 |
| `meta` | `w,h,title?,maxSessions?,mode?,prod` | 初始会话信息或视口调整；不直接发送源站 URL |
| `mode` | `mode` | 通道切换确认 |
| `dom-snapshot` | `css,cssSame?,html,title,w,h,tiles,frame,docClass,docAttrs,bodyStyle,sx,sy,scrollers,bodyId` | 全量镜像；html 元素携带 `data-xy-id`，bodyId 为镜像根对应的源站 body id；bodyStyle 为源站 body 的可继承计算样式（字体/颜色/字距等），客户端钉到 .xy-body——裸元素不继承客户端外壳样式；frame 模式附带 PNG 条带底板。css 按文档序收集（style/link 交错保持原级联顺序，adopted 排最后；同源 @import 服务端递归内联深度≤3），其中 url() 与元素资源 URL 一并改写为 /m 代理路径。cssSame=true 表示 css 与上次快照相同已省略，客户端用缓存（hello/恢复握手后服务端必发全量）。客户端对 css+html 与上一次完全相同的快照跳过整树重建（仅跟随滚动/标题），导航兜底重拍不再整页闪动 |
| `dom-patches` | `patches` | 子树补丁：`{id,outer|inner}`（整段替换，元素携带 id 与 path，id 为主）；`{id,ti,text}` 文本节点级（characterData 只发文本）；`{id,append}` 追加型（纯末尾新节点只发增量，同 sanitize；既有节点移动不适用——回落 inner 保正确） |
| `dom-props` | `props` | v0.17：程序化表单/媒体态 `{id,checked?,value?,sel?,media?}`——源站 JS 直改 checked/value/option.selected 或媒体 play/pause/seek/音量（MutationObserver 盲区）由原型 setter 劫持与媒体事件捕获，60ms 合并下发；客户端静默应用（焦点中元素的 value 跳过防打断）。media={paused,t,muted,vol}，有声播放受自动播放策略限制为已知边界 |
| `dom-sel` | `rects` | v0.18：程序化选区跟随。镜像在 shadow root 内、文档级 Selection 无法跨边界设置——服务端下发选区矩形（Range.getClientRects 页面坐标，≤200 个），客户端绝对定位高亮层随镜像文档流滚动 |
| `focus-sync` | `id?` | v0.19：源站程序化聚焦跟随（autofocus/校验定位）；访客文本输入中不抢焦点 |
| `doc-class` | `cls` | 更新镜像根 class |
| `scroll-sync` | `sx,sy,scrolls` | 服务端滚动位置；scrolls 为 `{id,top,left}` 对象数组 |
| `canvas-tile` | `id,path,url` | 更新 canvas 对应镜像图片 |
| `anim-tiles` | `tiles,holes?,sx?,sy?,scrolls?` | PNG 差分及区域重绘；坐标和尺寸见下文 |
| `sstats` | `fps,mr,inLat,mode,els` | 帧/消息速率、输入到帧延迟及结构计数；inLat 不是 DOM 端到端更新延迟 |
| `upload-accept` | `tid,ok,error?,maxChunk?` | 上传握手应答：扩展名白名单与大小上限校验结果 |
| `upload-end` | `tid,ok,name?,size?,error?` | 上传完成通知（远端字段已取得文件）或失败原因 |
| `download-begin` | `id,name,size?` | 源站下载开始（size 在文件就绪重发时给出）；id 为下载 guid |
| `download-chunk` | `id,b64` | 下载内容分块（原始字节 ≤48KiB，再 base64 编码；该限制用于服务端下行） |
| `download-end` | `id,ok,name?,size?,error?` | 下载完成（客户端 Blob + a[download] 保存）或失败/取消 |
| `canvas-ops` | `batches` | 2D 指令流（0.14.0）：batches 为 `[{id,reset?,ops}]`；ops 为 `[方法,...参数]` / `['$属性',值]` / `['__ac',渐变idx,offset,color]`；渐变引用 `'@g<idx>'`，图像 `{__img:src}`，ImageData `{__imgd:{w,h,b64}}`。客户端在镜像 canvas 上同序重放 |
| `pong` | `t` | 回显 ping 时间戳 |
| `error` | `msg,code?,terminal?` | 会话建立、事件处理或通道错误 |

`dom-snapshot.frame` 为 null 或 `{pageW,pageH,tiles}`。每个 tile 包含 `{w,h,cssX,cssY,cssW,cssH,url}`：w/h 为图片设备像素尺寸，cssX/cssY 为页面 CSS 像素坐标，cssW/cssH 为展示尺寸，url 为 PNG data URL。`anim-tiles.tiles` 使用同样结构；holes 为 `[x,y,w,h]` 页面 CSS 像素矩形数组。

frame 是画面底板，客户端仍构建镜像 DOM。字段尚在演进，消费端需与服务端一起升级。

## 路径与同步

### 节点 ID（v0.12，主定位方式）

源站序列化时给每个元素分配递增数值 id（WeakMap 双向映射，移动/插入/删除不改 id），镜像元素以 `data-xy-id` 属性携带；快照带 `bodyId`。补丁、输入定位、滚动容器、鼠标锚点、canvas 捕获全部按 id 命中。索引路径漂移（重排/相邻插入）不再影响定位。

path 是以业务 body 为根的元素索引串，如 `3/5/1`，空串代表 body。服务端按 children 编号并跳过 SCRIPT/NOSCRIPT/TEMPLATE；客户端按镜像 children 编号。文本节点和注释不参与编号，避免 Vue 等框架生成的空文本、相邻文本在 HTML 重解析后改变路径。**path 在 v0.12 与 id 并行下发作回退，下一个版本删除。**

**0.12.0 的补丁/滚动消息以 id 为主字段；0.9.0 的路径语义与 0.8.x childNodes 路径不兼容。必须一起升级服务端与客户端，并重新建立会话；不支持混用旧客户端或复用旧路径。**

DOM 客户端在 pointerdown 之前发送 `scroll`，包括页面位置和目标祖先内部容器位置。服务端按接收顺序串行处理命令，先完成滚动再测量锚点并派发 mouse down；不能依赖浏览器异步 scroll 事件先于 pointerdown 到达。frame 保持服务端滚动为准。

结构变化合并后发送子树补丁；客户端路径失配请求全量快照。重同步、导航和输入可能存在竞态，协议不提供事务序号或提交确认重传。

## 会话恢复（0.10.0）

首次 `hello` 不含 resume，服务端创建会话并返回 `session.token`。断线后在保留期内发送 `hello.resume=token`，只有已断开的会话可以恢复；源站配置与请求 Origin 必须与原连接一致。这是恢复范围绑定，不替代入口身份鉴权或 Origin 白名单。token 为随机 256 bit 凭据，持有者可恢复原浏览器；必须使用 TLS，禁止记录 token。官方客户端只存于页面内存。

恢复时保留 Chromium，丢弃离线期间下行更新，串行完成此前已接收的命令，再发送 meta、全量 dom-snapshot 与 sync-ready。快照包含运行中的非密码/非文件表单值及滚动位置；客户端清掉旧输入缓存，以服务端状态为准。恢复期间冻结操作，不缓冲或重发业务命令。客户端需同时等待该连接的快照构建完成及 sync-ready，不能仅凭 WS open 开放交互。

默认服务端检测断线后保留 60000ms，由 SESSION_GRACE_MS 调整，最大 300000ms。检测依赖 WS close 或 10 秒心跳，网络黑洞检测可能延迟。断线保留仍计入 MAX_SESSIONS；过期、release 或浏览器退出会清理会话。SESSION_BUSY（原连接仍活跃）及 SESSION_LIMIT 可退避重试；SESSION_EXPIRED 和 INVALID_HANDSHAKE 为 terminal，停止自动重试，等待用户手动新建。NAVIGATION_BLOCKED 为非 terminal 提示：服务端浏览器的主框架导航指向请求白名单之外的源，已被拦截，会话停留在原页面。错误不会悄悄回退成新会话。

宿主主动调用 `revokeSession` / `revokeIdentity` 时，逻辑会话立即失效，WS 发送应用关闭码 **4001**，reason 为 `SESSION_REVOKED`（不是 JSON error 消息）。客户端收到 4001 后清空恢复 token、禁用交互，显示“会话已撤销，请重新登录后再访问”，停止自动重连及页面上的重连操作，并隐藏直接新建按钮。宿主鉴权决定后续重新登录是否允许新会话。

服务端给关闭握手最多 1 秒，未响应则强制终止；不等待对端确认才作废 token。若链路已断开或被强制终止，客户端可能只看到 1006，不能保证取得撤销提示；宿主仍须先拒绝旧凭据。401 是升级前的 HTTP 拒绝，浏览器的 WebSocket API 不提供其 HTTP 状态给页面，因此不能把任意连接失败都当作注销。

页面刷新、关闭重开、服务进程重启不支持恢复；未送达服务端的输入无法保证保留，已提交但未确认的操作需要用户核对。0.10.0 客户端新增同步屏障，须与服务端一起升级。

`POST /rum`（v0.21）：RUM 尾包通道——客户端 pagehide 时 sendBeacon 上报同 ping.rum 结构的会话数据（≤8KB 收口，落 [rum-beacon] 日志，204 应答；同源免预检）。

`/m/x/<secret>/<base64url(origin)>/path`（v0.25）：跨源 iframe 同源化的会话作用域资产代理——secret 每会话随机，origin 必须先列入宿主 `crossOriginFrameOrigins`，且注册表只收本会话实际抓取成功的嵌入源；默认不进行 Node 侧跨源抓取；扩展名/响应类型限制与 /m 一致。

## 资源和边界

`/m/*` 只代理固定 `ORIGIN_URL` 同源、扩展名在白名单内的表现层资源，拒绝重定向和 HTML/JSON/JS/XML 响应。`/m/obf/<sid>/*` 为混淆字体路径。CSS `url()`（含相对样式表地址的相对 url）与元素资源 URL 在快照采集时统一改写为上述代理路径，webfont/背景图在客户端不再因相对地址 404 回退系统字体。

`x-rbi-origin` 仅在 `RBI_ALLOWED_ORIGINS` 显式允许时接受；网关需剥除访客伪造头。多源会话的资源以 `/m/o/<base64url(origin)>/path` 下发（缺省源站仍是短式 `/m`），代理按该段路由到对应白名单源站——同一网关可同时镜像多个源站且互不串源。

HTML/CSS/属性和值可能携带业务数据。frame 并非纯像素保密协议，字体混淆也非加密。完整限制见 [README](../README.md)。

## 文件传输（0.13.0）

- 上传：客户端本地 File 经 WS 分块（原始字节 ≤32KiB/条）上行，服务端按宿主配置校验扩展名白名单（`upload.extensions`，默认文本/图片/办公文档/zip）与大小上限（`upload.maxBytes`，默认 8MiB），并限制会话总上传字节（`upload.maxTotalBytes`，默认两倍单文件上限，已完成文件也计入）、并发数（`upload.maxConcurrent`，默认 2）、空闲超时（`upload.idleTimeoutMs`，默认 30 秒）和每会话 64 个已完成/待传文件，落**会话私有临时目录**（文件名 basename 收口）后经 CDP `DOM.setFileInputFiles` 交给源站页面并派发 change；会话结束临时目录整体删除，不落盘留存。上传内容对源站表现为普通用户文件，源站自身的病毒扫描/配额策略照常生效。
- 下载：源站下载事件（`Page.downloadWillBegin/Progress`）落地同一会话临时目录，完成后按 ≤48KiB 分块下行并**立即删除**服务端副本；大小上限 `download.maxBytes`（默认 32MiB），进度超限请求取消，读取完整文件前检查磁盘大小，超限/取消以下行 error 通知。文件名 basename + 目录包含校验防路径逃逸；客户端以 Blob + `a[download]` 保存，不执行内容。
- 病毒扫描钩子不在协议范围内：宿主可在 `close` 之外对会话临时目录策略另行约束（目录生命周期即会话生命周期）。

## Shadow DOM、iframe 与 canvas（0.14.0）

- **Shadow DOM**：源站元素的 open shadowRoot 以声明式 `<template shadowrootmode="open">` 内联进镜像 HTML；客户端以 `setHTMLUnsafe` 解析重建影子树（`innerHTML` 不再解析声明式影子 DOM）。影子内变化上溯最外层 light 宿主重发 outer（整体替换重建影子树——影子内焦点会在重发时丢失，已知限制）。通过前置 attachShadow 包装器捕获的 closed 影子根也可序列化；解析器直接挂载且没有回调的声明式 closed 根仍是已知限制。影子内元素的输入/组合事件经 composedPath 取真实目标后按 id 转发；影子内 canvas 与滚动容器参与捕获与上报。attachShadow 被补丁，注入之后新建的组件影子根同样被观察。
- **同源 iframe**：内容序列化进 `srcdoc`（与主文档同一 sanitize：剥 script/事件属性、资源 URL 改写 /m 代理）；镜像 iframe 是独立浏览上下文，客户端在其文档上挂同一套转发监听（指针/输入/组合/功能键），元素 id 与主文档同一空间；iframe 内指针坐标按 frameElement 链换算到主视口。**跨域 iframe 默认不转发**：显示等尺寸占位块。宿主显式配置 `crossOriginFrameOrigins` 后，可由 Node 抓取该源 HTML、剥离脚本并复用字段过滤策略后放入 srcdoc；跨源内容不继承原站登录凭据。宿主仍须隔离 Chromium 和 Node 的出站网络，URL 白名单不能替代网络隔离。iframe 内部滚动的懒加载跟随为已知限制。
- **canvas 2D 指令流**：注入之后创建的 2D 上下文记录绘制指令（方法调用与样式属性赋值，渐变定义+色标、图像源、ImageData 均序列化），60ms 合并以 `canvas-ops` 下发，客户端在镜像 canvas 同序重放（图像异步加载完成后整环重放）。不可序列化参数（跨域图源/Pattern/滤镜/未知对象）的画布、注入前已创建的上下文与 WebGL 一律回退位图捕获。指令环上限 1024 条（超限截断，clearRect 循环类图表天然幂等）。宿主可用 `canvasStream:false` 关闭整条指令流（全部走位图）。

## 构造样式表与输入掩码（0.15.0）

- **adoptedStyleSheets**：`new CSSStyleSheet()` 构造并 adopted 的样式表对 style/link 观察器不可见——快照直接并入其规则文本（cssRules.cssText），1Hz CSS 指纹包含逐规则内容哈希，`replace/replaceSync` 改动内容（规则数不变也）触发全量重同步。影子根与 iframe 文档内的 adopted 样式表本版不追踪。
- **maskInputTypes**：宿主配置的输入类型（如 `['text','search']`）在快照/补丁中以最多 32 个 `*` 掩码下发（默认关闭；`hidden/password/file` 的整体剔除语义不变，优先于掩码）。交互不受影响：客户端本地输入为真实值并明文回传源站，掩码只作用于服务端下发侧；textarea 通过 `textarea` 类型单独配置。掩码不是加密——长度与输入行为仍可观测。
