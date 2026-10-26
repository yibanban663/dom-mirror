# v0.26.0

- 跨源 iframe 动态刷新通道：prepareXframes(force) 周期重抓（XFRAME_REFRESH_MS
  默认 15s），内容变化才推宿主 outer 补丁（客户端整替 iframe，srcdoc 随新内容
  到达）。基准 tick 路由（每 5s 换版本号）断言镜像内版本跟随变化。静态快照
  语义升级为周期跟随；postMessage 双向驱动仍为快照（记录）。
- RUM 生产基线扩样：18 会话/41 报告/7 视口——交互到视觉延迟 p50 16.6ms /
  p95 17.6ms（约一帧），帧时间 16.7/16.7ms 全会话 60fps 锁帧。

# v0.25.0

- 跨源 iframe 同源化（此前占位块）：服务端代理抓取（6s/512KB/text/html，
  失败回退占位）→ 页内 sanitize（剥 script/事件属性，资产改写为
  /m/x/<secret>/<b64(origin)>/path）→ srcdoc 内联。会话作用域资产代理 /m/x：
  secret 每会话随机、origin 注册表只收本会话实际嵌入过的源（防开放代理/
  SSRF），扩展名/响应类型限制与 /m 一致。基准 gen-xiframe 三断言（srcdoc
  非占位 / 内容真实渲染含图片经代理加载 / script 剥离）。
- Vikunja CI 冷启动加固：app DB 写路径预热 + 镜像首 WS 会话预启动 + 客户端
  失败模式重试一次（冷 runner 偶发红的根治）。

# v0.24.0

- 虚拟列表平移 diff 泛化（LCS 编辑脚本）：纯平移检测之外增补 kidKeep/kidIns
  ——规范化子串整数化 O(n·m) DP（n,m≤64），keep=旧序索引、ins=[新序位置,
  原始 html]，编码比整窗省 30%+ 才启用，仅元素子节点容器；客户端按新序重排
  并复用保留节点（不重建），校验失败按 patch-miss 重同步（宁重不错）。
  覆盖窗口边界/混合批次形态（此前回退整窗 inner 的余量）：慢滚补丁
  4.1→2.6KB/步，较 v0.22 基线 14.8KB/步累计 5.7×。

# v0.23.0

- 虚拟列表窗口平移 diff（先量化后动工：改造前慢滚实测 14.8KB/步）：inner 补丁
  与上次子元素序列比对（规范化串剥离 data-xy-id——整窗重建 id 必变），命中
  下移/上移形态发 {delHead,append}/{prepend,delTail} O(增量) 补丁，不命中回退
  整窗；补丁去重同步用规范化串。实测慢滚 14.8→4.1KB/步（3.6×），基准
  vlist_shiftdiff 断言 ≤5KB/步。RUM 生产基线（6 会话/24 报告：交互到视觉
  p50 15.6ms/p95 17.4ms，帧 16.7/16.8ms 60fps 锁帧）入档 FIDELITY.md。

# v0.22.0

- WebGL/位图画布自适应快档：可见且动画中的画布捕获节奏 450ms→120ms tick
  （实测 ~6.3 次/秒，此前 ~2.2）；静止画布指数退避不变（零流量）；离屏
  画布可见性门控不变（零捕获）。配套：忙守卫防 tick 重入、rAF 门改相邻 tick
  差分（去掉 260ms 阻塞窗）、捕获列表 600ms 缓存、每秒捕获总数预算 ≤12 封顶
  CPU。基准 gen-canvas 新增帧率断言（动画位 ≥4 次/秒、静态位 ≤2、离屏位 0）。
- FIDELITY.md：WebGL 从"已知边界"改为 D6 实测达标。

# v0.21.0

- 真实会话 RUM：客户端采集 240 帧滑窗帧时间（p50/p95）、交互到视觉延迟
  （交互发送→首个被应用的下行消息，p50/p95）、按消息类型字节与快照/补丁计数。
  首拍即报、此后 10s 随 ping 心跳下发（服务端 [rum] 日志），pagehide 时
  sendBeacon POST /rum（[rum-beacon]，≤8KB 收口）；window.__xyRum 可外部抓取。
- 基准新增 gen_rum 断言（会话必须产生 RUM 日志）。
- 生产首批真实会话数据（:81/:82 经 ingress）：帧 p50/p95=16.7/16.7ms（60fps
  锁帧）、交互到视觉延迟 16.6-17.5ms（约一帧）。FIDELITY.md 记录为优化基线。

# v0.20.1

- 修正 body 继承 pin 的 line-height 语义：计算值绝对 px 会把源站"无单位比值"
  压平（14px 子元素源站 21px、镜像 24px → 表单区整体 +3px 漂移，实测 password
  top 462.3→465.3）。改为比值（计算 px ÷ body 字号；normal 保持 normal）后
  表单区元素 rect 与源站逐项全等；生产像素 diff 0.214%（仅剩标题字形边缘
  2 条 4px 亚像素带，几何与颜色无差）。FIDELITY.md D3 维度据此定案 ✅。

# v0.20.0

- body 继承样式还原：快照携带源站 body 的可继承计算样式（字体/颜色/字距等
  9 项）钉到镜像根——裸元素不再继承客户端外壳样式（此前未显式设置的属性
  落到外壳主题色/字体，观感偏差与文本度量偏移成因之一）。
- 带宽实测基线（真 payload）：deflate 生产登录快照 216.8KB→35.9KB（6.04×，
  zlib L3）；虚拟列表（1 万行/20 行窗口）每滚一窗补丁 ~0.85KB（压缩前）。
  tools/measure-deflate.cjs 探针 + gen-vlist 基准 case 固化测量。
- 基准扩到 8 case：+虚拟列表（滚动换窗功能断言 + 每滚补丁字节数）；
  gen-style 增 body 继承断言；editor 增键盘型应用首字符回显 RTT 记录。

# v0.19.0

- 分歧检测自愈（Timelapse/Dolos 思想）：ping 携带镜像元素指纹（剔除引擎自建层
  与源站 script/spacer），与源站比对漂移 >max(2,2%) 持续两拍且距上次自愈 >10s
  时自动全量重同步——把"镜像悄悄坏了"变成"自愈+可观测"。
- HTML5 拖拽：镜像 dragstart/over/drop/end 合成到源站（DataTransfer 携带
  text/plain 载荷，over/drop 按坐标命中）；本地 preventDefault 保源站唯一事实源。
- 触摸转发：touchstart/move/end 触点 → CDP dispatchTouchEvent，本地
  preventDefault 防合成鼠标双事件（移动端访客手势语义）。
- 焦点同步（focus-sync）：源站程序化聚焦（autofocus/校验定位）镜像跟随；
  访客文本输入中不抢焦点。
- 多选 select 程序化改态：option.selected setter 劫持，以所属 select 为主体
  并入 dom-props.sel（修复 sel 独立下发时客户端不应用的嵌套分支缺陷）。
- WebGL 位图捕获可见性门控断言锁定（off 屏动画画布零捕获）。
- 基准新增 gen-dnd case（拖拽/触摸/焦点/自愈四断言），forms 增多选程序化改态
  断言，canvas 增离屏门控断言——7 case 全绿；全量回归 12 组通过。

# v0.18.0

- 同源 @import 服务端递归内联（cssInlineImports，深度≤3）：镜像首帧样式完整，
  客户端无需二次往返拉 import（跨源 @import 原样保留）。
- 媒体状态同步（dom-props.media）：play/pause/seek/音量经媒体事件捕获并随
  dom-props 下发，客户端静默跟随；有声播放受自动播放策略限制为已知边界。
  基准以静音 WAV（JS 构造）端到端断言 play/seek/pause。
- 选区镜像（dom-sel）：镜像内容在 shadow root 内、文档级 Selection API 无法
  跨边界设置（实测）——服务端下发 Range.getClientRects 页面坐标矩形，客户端
  在 .xy-body 内绝对定位高亮层，随镜像文档流滚动。
- 带宽·cssSame 快照：SPA 路由切换的导航重拍不再重发相同 css（实测生产登录流
  仪表盘重试快照 283KB→20.8KB/份，单次导航省 ~790KB 压缩前）；hello/恢复握手
  后必发全量。
- 带宽·WS permessage-deflate（阈值 512B）。
- 带宽·补丁粒度（DiffSync 思想）：文本节点级 {id,ti,text}（characterData 只发
  文本）与追加型 {id,append}（纯末尾新节点只发增量，同 sanitize 路径）；同父
  移动到末尾也是 add-only 记录，以"ID 注册表未登记"判别真追加，既有节点移动
  回落 inner 保正确（node-id 回归实证）。
- 基准新增断言：媒体 play/seek/pause、程序化选区、追加流+首行原位改文本、
  程序化表单态；新增流畅度基线输出（帧时间 p50/p95，不计入判定）。
  保真模型与差距分类落档 docs/FIDELITY.md（六维度+文献映射+分阶段路线）。

# v0.17.0

- 通用性基准 verify-generality：六类业务形态（表单全形态+程序化改态/富文本与键盘
  应用/响应式图片与媒体属性/固定栏+内层滚动+弹层+原生 dialog/动态样式 @import 与
  adopted 与后挂 link/2D 画布+WebGL+2000 行大表）以源站↔镜像等价断言回归，
  逐 case 断言走"服务端真实状态回显"黑盒出口。
- 相对路径资源改写：fixUrl 对无根斜杠的相对地址按文档基址解析后统一走 /m 代理
  （此前仅根绝对/绝对源站地址——相对 src 404）；srcset/imagesrcset 多候选逐项
  改写；CSS image-set("x.png" Nx) 引号串二次扫描覆盖。
- contenteditable 键入同步（kind `ce`）：客户端本地原生编辑保流畅，内容 120ms
  节流整体回传，服务端 setInnerHTML+派发 input；iframe 内同路径。
- 键盘分派上移 document 捕获层：合成 pointer 事件不产生原生聚焦，焦点常留
  body，keydown 不过 shadow root——键盘型应用（终端/游戏/canvas/页面级快捷键）
  的字符与功能键此前全量丢失。焦点在输入控件/富文本时仍走本地编辑+值同步
  （防双输入），并补发 keyup（按键状态类应用需要）。
- 程序化表单态捕获（rrweb 同款原型 setter 劫持）：源站 JS 直改 checked/value
  （全选/过滤器/回填）不触发 MutationObserver，此前镜像永久丢态。原型 setter
  包装捕获，60ms 合并 last-write-wins 下发 dom-props，客户端静默应用（焦点中
  元素的 value 跳过防打断）。
- PROTOCOL 0.17.0：dom-props/ce/key text 文档化；check.js 收录新 fixture。

# v0.16.0

- 同内容快照去重：服务端导航后 +600ms/+1500ms 兜底重拍在静态页上产出字节级相同
  的快照，客户端整树重建三连即"页面像刷新了 3 次"。css+html 与上次完全一致的
  快照跳过重建，仅跟随滚动/标题；内容变化路径不变。
- 快照 CSS 按文档序收集：此前 style 全量前置 + link 后置会翻转同特异性规则的
  级联胜负（运行时注入的 <style> 覆盖被 <link> 反杀）；adopted 样式表按规范
  排在其余作者样式之后。
- CSS url() 与资源 URL 代理改写收口：相对 url() 按其所属样式表地址解析后统一
  改写为 /m 代理（此前仅根绝对路径），webfont/背景图不再因客户端相对地址 404
  回退系统字体（观感差异的来源之一）。
- 多源会话资产路由：x-rbi-origin 白名单会话的资源以 /m/o/<base64url(origin)>/
  path 下发，代理按该段路由到对应白名单源站；短式 /m 固定路由 ORIGIN_URL。
  PAGE_HELPERS 按会话注入源站前缀（origin 占位符），同一网关可同时镜像多源站。
- 新增回归 verify-assets（短式/多源改写与路由、未白名单 403、级联顺序、快照
  去重 3→≤1）与 tools/check-helpers.cjs（注入代码语法校验）；CI 接入。

# v0.15.0

- adoptedStyleSheets 追踪：构造样式表（new CSSStyleSheet + adopted）对 style/link
  观察器不可见——快照并入 cssRules 规则文本，1Hz CSS 指纹改为逐规则内容哈希
  （replace/replaceSync 改内容不改规则数也能触发全量重同步）。
- 输入值掩码（maskInputTypes，默认关闭）：命中类型的输入值以等长 * 下发，
  hidden/password/file 的整体剔除语义优先；交互不受影响（客户端本地输入为真实值），
  掩码只作用于服务端下发侧。demo 以 MASK_INPUT_TYPES 环境变量配置。
- 新增回归 verify-enhance（adopted 收集/内容变化重同步/掩码等长断言）；
  CI 接入 0.12-0.15 全部六组新回归（node-id/longtail-p0/shadow/iframe/canvas2d/
  enhance）与证据上传；check.js 收录全部新 fixture 脚本编译。

# v0.14.0

- Shadow DOM：open 影子根以声明式 <template shadowrootmode> 内联（客户端 setHTMLUnsafe
  解析重建，innerHTML 已不解析声明式影子 DOM）；attachShadow 补丁覆盖注入后新建组件，
  现存影子根每快照兜底观察；影子内变化上溯最外层宿主重发 outer。修复产品级 shadow
  retargeting 缺陷：事件穿出影子边界时 e.target 被重定向为宿主，影子内输入此前永远
  不同步——所有输入类监听改以 composedPath()[0] 取真实目标。
- 同源 iframe：内容序列化进 srcdoc（同一 sanitize 与 /m 资源改写），客户端在 iframe
  文档挂同一套转发监听，元素 id 与主文档同一空间；iframe 内指针坐标按 frameElement
  链换算主视口。跨域 iframe 显示等尺寸占位块（不转发，文档声明）。
- canvas 2D 指令流：注入后创建的 2D 上下文记录绘制指令（方法/样式/渐变定义+色标/
  图像/ImageData 序列化），60ms 合并以 canvas-ops 下发，客户端同序重放（图像加载完成
  整环重放）。不可序列化画布、注入前上下文与 WebGL 回退位图捕获；canvasStream:false
  可整体关闭。渐变经 create*+addColorStop 指令与 @g 索引引用重建。
- 新增回归：shadow（声明式影子/影子内点击输入/延迟挂载/影子 canvas 捕获 5 步）、
  iframe（srcdoc 内联/iframe 内点击输入/跨域占位 4 步）、canvas2d（双模式像素/动画/
  带宽对比）。既有 node-id/P0/scroll/select/data-boundary/Vikunja 回归保持绿。

# v0.13.0

- IME 中文输入：客户端 compositionstart/update/end 镜像到源站——组合期 CDP
  Input.imeSetComposition 写入候选串（远端可见拼音过程），上屏 CDP Input.insertText；
  组合期间抑制普通 input 值同步，拼音串不会作为最终值写进源站字段。input/textarea
  覆盖，contentEditable 暂不覆盖（文档声明）。
- 镜像文件上传：本地 File 经 WS 分块（≤48KiB）上行，服务端按宿主配置校验扩展名
  白名单与大小上限（upload.maxBytes 默认 8MiB），落会话私有临时目录（basename 收口）
  后经 CDP setFileInputFiles 交给源站字段并派发 change；会话结束临时目录整体删除。
- 镜像文件下载：Browser.setDownloadBehavior(allow)+eventsEnabled，Page.enable 后订阅
  downloadWillBegin/downloadProgress；文件落地会话临时目录，完成后 ≤48KiB 分块下行并
  立即删除服务端副本，客户端 Blob + a[download] 保存；basename+目录包含校验防逃逸，
  超限/取消走下行 error（download.maxBytes 默认 32MiB）。
- 新增配置 upload/download（options 校验 + index.d.ts 类型）；协议文档同步
  composition/composition-commit/upload-*/download-* 消息。
- 新增回归 tools/verify-longtail-p0.cjs：IME 合成期回显与上屏断言、上传回环
  （客户端 File → 远端页面读到同名同内容）、下载回环（内容逐字校验）；CI 接入
  tools/verify-docker-longtail-p0.sh。既有 node-id/scroll/select/data-boundary/
  Vikunja(direct,dom,frame) 回归保持绿。

# v0.12.0

- 节点 ID 体系替换索引路径定位：源站序列化时按 WeakMap 双向映射分配递增数值
  id，镜像元素以 data-xy-id 携带，快照带 bodyId。元素移动/插入/删除后 id 不变，
  列表重排/相邻插入不再引起路径漂移（参考 rrweb Mirror 思路重写）。
- 补丁（inner/outer）、输入定位（input/change/click）、鼠标锚点（aid/ax/ay）、
  内部滚动容器（{id,top,left} 对象条目）、canvas 元素捕获（canvas-tile id）
  全部改按 id 命中；path 字段并行下发仅作过渡回退，下一版本删除。
- 客户端镜像维护 id→元素映射，结构替换时同步注销/登记子树 id；聚焦补丁挂起
  判定由路径前缀改为 DOM contains。
- 新增回归：tools/verify-node-id.cjs（插入/移动/更新/删除混合序列后补丁按 id
  命中、零 patch-miss、镜像元素携带 data-xy-id），CI 接入
  tools/verify-docker-node-id.sh；既有 scroll/select/data-boundary 回归保持绿。

# v0.11.0

- 完成两轮反序 memory/disk 各三十轮对照，保留四组预算失败结果；补 V8 页池/帧长度独立诊断及关闭额外诊断的 semi-space 参数对照，宿主显式 semi-space=4 通过 30/30 原内存预算和 Vikunja 核心/恢复验收，不修改库默认 allocator、GC/cache 或公共 API。
- 增加 frame 内存增长的离线分析、可选 sample/GC/checkpoint 落盘与指定轮次映射快照；校验落盘完整性及冻结观测参数，保留原预算和默认探针模式，尚未运行新模式长测或证明内存改善。
- 修正真实业务回归的 select 旧句柄竞态：在一次浏览器任务中重新定位并派发选择事件；保留离线节点负对照，不重试业务或放宽持久化断言，document/Shadow DOM 回归接入 CI。
- 增加 jemalloc 候选宿主三十轮续测及公开 API 真实业务验证工具：900 次操作通过，原 64MiB 正常回收预算仅通过 17/30 轮；独立记录末尾 GC、映射/V8 摘要与浏览器 allocator 隔离，不修改库默认配置。
- 增加同镜像 glibc/jemalloc 宿主配置与匿名映射对照：各十轮共 600 次操作通过，正常回收内存预算分别通过 1/10、10/10；补独立 trim 后映射、真实分配预检和 Chromium 未继承 preload 检查，候选配置十轮结果不代表更长运行通过。
- 增加候选宿主配置的三十轮回收续测工具及可选 glibc Node-API 诊断，记录全部 arena 统计、smaps 和末尾 GC/trim 独立对照；900 次操作通过，正常回收预算 0/30 轮通过，末尾 trim 确认约 41MiB 可归还驻留；正常轮次保持原内存预算，不在包入口加载或编译原生探针。
- 增加 frame 内存归属调查：四组各十轮生命周期对照、heap/external/cgroup/sharp 采样及独立分配器补充组；强制 GC 与关闭缓存不能解决匿名驻留，不修改宿主的默认全局配置或放宽回收预算。
- 修复 frame 首张差分帧已包含操作结果时仅建立基准、不下发更新的缺陷；首次/尺寸变化基准按完整视口 tile 发送。受控旧版负对照及修复后真实像素回归完成，加入 CI。
- 增加 1/3/6 会话的 DOM/frame 合成容量矩阵、冻结预算、独立压测容器、cgroup 采样和机器可读汇总；12 组功能检查通过，修正观测器后完整重跑，frame 单会话一轮及 3/6 会话回收后匿名内存超预算，保留失败判定，不调整默认会话上限。
- 修复主动撤销后客户端仍显示恢复中并反复重连：WS 使用 4001 / SESSION_REVOKED，客户端清空恢复 token、冻结交互并停止重连；关闭握手最多等待 1 秒后强制回收，新增无响应对端回归。
- 增加合成宿主 DOM/frame 真实 Chromium 注销回归，验证旧凭据和 token 拒绝、同身份在线/保留会话及待握手连接关闭、单会话撤销、页面与子进程回收和业务不重放；脚本及证据上传接入 CI。
- 新增 revokeSession(token) 与 revokeIdentity(identity)，宿主可撤销在线/断线保留会话及同身份待握手 WS；恢复 token 立即失效，等待初始化和资源清理，停止后续排队指令派发。新增本地 HTTP/WS、替身浏览器与打包接口回归；后续新连接仍由宿主鉴权决定。
- 新增可选 getSessionIdentity 同步宿主回调，在 WS 升级前拒绝无效身份，并把已验证的用户/租户键纳入恢复 scope；客户端身份字段不参与判定。未配置时保持匿名 Demo，HTTP 鉴权及活跃连接撤销仍由宿主负责。
- 增加跨用户、跨租户、已撤销身份及原用户恢复的单元测试和本地真实 Chromium 对照，检查业务提交不重放。
- 新增合成数据下发边界验收，区分 DOM/frame 的初始快照、更新及增量补丁，并检查静态资源响应；保存独立源站事件，默认和显式属性剔除两种配置接入 CI。
- 隐藏 input 的 value 不再下发；新增 redactAttributes 精确属性名列表，覆盖镜像快照、补丁及 html/body 元数据，不改源站值或删除交互节点。不提供隐藏文本、CSS、资源正文或像素敏感信息的自动识别。
- 将仓库定位为 Node.js 依赖包，公共入口导出 `createMirror(options)` 与 TypeScript 类型；引入包不监听、不启动浏览器、不注册进程信号。
- 实例提供 `handleRequest`、`handleUpgrade` 和幂等异步 `close`；配置及会话状态按实例隔离，关闭等待晚启动浏览器并回收会话定时器，不关闭宿主 HTTP 服务。
- 原有独立启动迁入 `demo/server.js`，保留 `npm start` 和 Docker Demo，环境变量由 Demo 读取；直接 `node server.js` 不再启动。
- 增加最小宿主、迁移与职责文档，以及包导入、生命周期和实际 tarball 安装集成检查；现有浏览器回归脚本改用 Demo 入口。
- 本次未内建用户系统或完成浏览器安全加固；身份绑定依赖宿主提供已验证身份，不改变镜像协议与编码算法。

# v0.10.1

- frame 差分条带复用已解码 RGBA，减少逐块 PNG 解码；输入 base64 只转换一次。
- 仅对无额外元数据的普通 8-bit RGB/RGBA PNG 使用快路径；透明键、色彩元数据、灰度及调色板等继续走原管线，保持颜色、alpha 和编码参数。
- 新增 RGB/RGBA 像素一致、透明键及其他 PNG 回退回归；保留源 PNG 路径用于性能对照。
- 增加单会话分段性能、PNG 回放及实际画布标记的调查工具和证据报告；PROFILE 默认测量生产路径，调查结果不代表整体业务加速或容量验收。

# v0.10.0

- 短时 WS 断线恢复：默认保留原独立浏览器 60 秒，恢复凭据仅存当前页面内存，恢复全量同步完成后才开放操作。
- 断线期间不缓存重放业务命令；已提交但未显示确认的结果由服务端全量快照校正。恢复表单运行时值与滚动位置，密码/文件不回填。
- 同账号页面保持独立会话；保留会话计入容量，过期、release 或浏览器退出后清理。过期提示手动重新开始，不自动新建。
- 新增会话生命周期单元测试与隔离 Vikunja DOM/frame 恢复回归，覆盖草稿、确认丢失、并发隔离和过期重建。
- 新增 SESSION_GRACE_MS（默认 60000，范围 0–300000）。客户端与服务端须同步升级；刷新、进程重启及持久会话不在恢复范围内。

# v0.9.0

- 新增固定 Vikunja 镜像的本地隔离业务验收脚本，覆盖直连、DOM、frame 的登录、创建、修改优先级和完成，使用独立 API 读取验证持久化。
- 同步 select 的运行时选中状态，避免服务端已保存、镜像仍显示默认选项。

- 元素路径改为 children 索引，修复 Vue 注释、空文本和相邻文本导致的路径漂移；与 0.8.x 路径不兼容，服务端和客户端须同步升级、重新连接。

- 将真实浏览器滚动回归接入 CI，使用 internal Docker 网络并自动保存证据、清理容器；增加分阶段验收路线图。

- 修复 DOM 模式滚动后首次点击可能丢失：pointerdown 前同步页面与目标祖先容器的当前滚动位置，沿用服务端串行队列先滚动再派发鼠标事件；输入聚焦使用 preventScroll。
- 增加真实浏览器回归用例，覆盖可见按钮、页面滚动和内部容器滚动后的首次点击。

# v0.8.4 — 交付与边界整理

- 更新 Puppeteer/ws/sharp 和对应浏览器基础镜像，Node 要求调整为 22.12+。
- package 版本对齐，声明并锁定 Puppeteer/ws/sharp 依赖；Docker 使用 npm ci，移除失效 setup 入口。
- 静态资源代理限制同源和无凭据 URL，拒绝重定向，增加超时和 nosniff。
- x-rbi-origin 改为显式 RBI_ALLOWED_ORIGINS 白名单，WS 上行限制为 64 KiB。
- 修复 frame 截图失败分支错误引用服务端 window、快照视口尺寸未跟随 hello。
- 移除输入值调试日志及 meta 中直接发送的源站 URL，忽略非对象上行 JSON。
- 重写 README、演示说明和协议，更新客户端安全说明，明确 DOM 数据和字体混淆边界。
- 增加资源/源站策略回归测试与客户端/注入脚本编译检查。
- 修复字体池烘焙失败时的二次异常及退出码，增加 Docker 构建上下文排除。

兼容变更：已有网关注入 x-rbi-origin 时必须配置 RBI_ALLOWED_ORIGINS；frame 不是纯像素隔离。历史性能和视觉数字未在本轮复验。

# v0.8.3 — site-owned fonts get PUA twins (artistic/brand fonts preserved)

Any @font-face the protected site itself ships (artistic display fonts,
brand fonts) is now detected from the page CSS, fetched server-side, and
rebuilt with the session's PUA twin codepoints appended to its own cmap
(tools/build_obf_twins.py). The twin face is registered under the site's
family name with unicode-range U+F0000-10FFFF, so encoded text styled with
an artistic webfont renders from THAT font - glyph-identical to native -
while the DOM stays scrambled. Verified on the bundled demo origin with
ZCOOL KuaiLe: the hand-drawn art title renders correctly in the mirror
with all 9 title chars PUA-encoded. Build failures degrade gracefully
(text falls to the next stack family, never tofu). Up to 6 site fonts per
session, LRU-cached per (url, seed).

# v0.8.2 — obfuscation font base switched to MiSans (TrueType)

Baked the seed pool from MiSans (free-commercial, TrueType, hinted) instead
of Noto Sans SC (CFF, unhinted): on Windows clients where native rendering
resolves to local Microsoft YaHei, the CJK glyph difference vs native drops
from "perceptible" to "side-by-side scrutiny only" (digits/latin already
pixel-identical via unicode-range; line metrics unchanged). Pool size per
weight also halves (~3.3MB woff2 vs ~7.9MB). The bake pipeline is
base-font agnostic: tools/build_obf_font.py + tools/bake_pool.py accept any
subsettable TTF/OTF; per-platform pools (e.g. HarmonyOS Sans for mac-leaning
user bases) can be baked the same way.

# v0.8.1 — universal font handling: unicode-range-scoped obfuscation faces

The obfuscation @font-face rules are now scoped with
`unicode-range: U+F0000-10FFFF`: the obfuscated font only renders the
scrambled (PUA) codepoints; every other character - latin, digits,
punctuation, unencoded CJK - falls through to the visitor's LOCAL fonts,
pixel-identical to native (previously the faces shadowed whole family
names, forcing a Noto-based webfont everywhere and visibly changing
typography on machines where e.g. Microsoft YaHei resolves natively).

Font families are now extracted dynamically from the page's own CSS
(font-family declarations, generic keywords skipped, fallback list
included) instead of a hardcoded 5-name list - any site's font stack is
covered. Verified on a real external Windows Chromium, same view/state:
latin/digit regions 0.0-0.4% pixel diff vs native, no line-height shift,
CJK glyph difference reduced to designer-level (open-font ceiling).

# v0.8.0 — remove jpeg/webp/h264 pixel-stream channels

The engine is now dom + frame only:
- dom (default): real-text DOM mirror with client-native rendering and
  event-driven patches; anti-scrape via the font-obfuscation encode layer
- frame: compositor-frame-diffed PNG band fallback (no video codec)

Removed: CDP screencast jpeg/webp direct streaming, the h264 pipeline
(ffmpeg image2pipe -> libx264 -> Annex-B over WS -> client WebCodecs), the
client-side H.264 decoder and jpeg/webp frame blitter, quality selector,
ffmpeg from both Dockerfiles and CI pre-download, get-ffmpeg.sh.

# v0.7.3 — fix: repo Dockerfile is self-contained (CI docker job green again)

The previous pushes overwrote the repo Dockerfile with the production one,
which COPYs the production-only ck/ directory - the CI docker build failed on
every commit since v0.6.0 while in-production builds (where ck/ exists) kept
passing. The repo Dockerfile now: omits ck/, expects bin/ffmpeg to be fetched
by get-ffmpeg.sh (CI already does), and documents that the obfuscation font
pool (assets/obf) is baked locally via tools/ - absent pool degrades to
OBFUSCATE off automatically.

# v0.7.2 — fix: lazy-loaded stylesheets never reached the mirror (all entrance animations dead)

Root cause chain (found on a real external browser, invisible to in-container
acceptance): the app loads its second stylesheet (17 of 30 keyframes: view/
message entrance animations) into <head> seconds after login; the login POST
is a real navigation so the +600/+1500ms re-snapshots all run before the
injection, the MutationObserver's noPath:HEAD full-trigger gets swallowed by
the in-flight-snapshot guard (consumed, never requeued), and the els-drift
radar was dead code (async elCount race -> sstats.els always 0). Result: the
mirror's css froze at the login-page state forever - every entrance/ambient
animation gone while static layout kept working.

Fixes:
- css-set fingerprint fallback: 1Hz stylesheet manifest comparison in the
  stats tick; any change triggers a full resync (retries until a snapshot
  confirms the new set; independent of observer/navigation races)
- swallowed-trigger requeue: full-patch triggers arriving during an in-flight
  snapshot now set pendingFull and are re-scheduled after it completes
- observer mounts BEFORE the snapshot (kills the no-observer window across
  secondary navigations); helpers injection gets a timeout
- sstats.els async race fixed (client els-drift resync radar revived)

Verified on a real external Chromium through the production ingress: fresh
login now delivers 30/30 keyframes (264KB css), computed-style census shows
sr-fade-in/sr-view-in/sr-spin running in the mirror, and a 4-frame
burst during view switch measures 6.6%/7.3%/3.5% pixel change (was 0.000%).

# v0.7.1 — fix: obfuscation fonts must register at document level

@font-face declared inside the mirror shadow root is not applied by some
Chromium builds (reproduced on Windows): the font stack falls through to a
LOCAL font (e.g. Microsoft YaHei), plane-15 PUA codepoints have no glyph
there, and the whole page renders tofu. Container-internal Chrome happens
to honor shadow-scoped @font-face, which is why in-container acceptance
passed while real browsers showed boxes.

Fix: the client additionally injects the same @font-face rules into the
document head (standard, engine-independent); document-level faces are
visible to shadow content. Verified end-to-end through the production
ingress path on a real external Windows Chromium: login + report pages
render native-quality Chinese while the DOM remains PUA-encoded.

# v0.7.0 — 真文本 DOM 镜像 + 防抓取字体混淆（编码-解码范式）

## v4 真文本镜像（dom 模式重写）
- 镜像 DOM 携带真实文本，客户端以源站同款 CSS 原生渲染：布局/CSS 动画/悬停/图标/输入全部原生，零文本截图
- 快照开销与页面复杂度解耦（此前 4000 元素页瓦片级联 3s 的根因消除）；canvas 仍按需位图化
- 结构补丁：60ms 合并 + 祖先后代去重 + 逐批去重；全量重同步 700ms 防抖
- 同引擎对比（同 Chrome/视口/DPR）：登录页 0.145%、报表 6.3%、烽火台 3.3%、对话输入 1.34%（差异均为数据漂移/动画相位/抗锯齿）

## 防抓取字体混淆（服务端编码 → 客户端解码）
- 会话种子置换：CJK 域码点 -> PUA-A(0xF0000+) 双映射字体（原码点保留，输入框明文/域外字符照常渲染）
- CFF 轮廓原样保留（fontTools，format12 cmap 重建）——渲染与原生逐位一致
- 构建期种子池（tools/build_obf_font.py + tools/bake_pool.py），会话轮换，URL 绑定会话 id；OBFUSCATE=0 可关
- DOM/复制/爬虫视角：全部乱码（实测登录页 79 PUA / 0 可读 CJK）

## v0.6.0 — v3 元素锚定解码引擎（纯客户端 DOM 渲染）

**dom 模式彻底移除帧流**：快照 + 补丁是唯一更新通道，页面静止时零消息零流量，不存在任何帧率概念。

- 瓦片元素锚定：文字/输入框/下拉框像素以内联 background-image 锚进镜像文档流——随布局/滚动/悬停原生联动，无坐标同步、无叠加画布、无穿孔
- 结构补丁：MutationObserver → 60ms 合并窗（outer 优先去重）→ 联合矩形 clip 截图 → 子树 tileize → inner/outer 下发（零明文）
- 逐字节相同补丁跳过；轮询自更新类应用 CPU 从 ~50% 降至 ~9%（应用自身开销量级）
- 滚动：客户端本地原生滚动 + 事件上报；服务端跟随并打回声抑制标记（无回拽抖动）
- canvas 元素按需捕获：rAF 活动门 + 指数退避（450ms→3.6s），静止画布零流量
- 全量快照 700ms 防抖：根治 SPA 登录/路由切换的重同步风暴（实测 4 秒 6 次全量快照互相吞点击）
- 零明文收口：HTML 注释、aria-*、option value、根表单控件属性、明文 snapshot() 死代码全部剥除
- 路径编号与净化树对齐：script/noscript/template/注释节点在 live 与镜像两侧一致跳过
- 帧差分通道仅保留给显式 frame（像素直出）模式；frame→dom 切换彻底杀死差分循环
- 进程级 unhandledRejection 兜底，单会话故障不再击穿网关

# Changelog

本文件记录 dom-mirror 的版本演进。协议破坏性变更见 docs/PROTOCOL.md。

## v0.4.1（2026-10-23）

### Added — 网关(生产)模式的干净呈现
- `x-rbi-origin` 会话（WAF转交）自动进入生产呈现：访客只看到业务页面本身，
  演示壳（模式切换/指标面板/攻击者自测/提示条）全部隐藏，镜像铺满窗口。
- 视口自适应：客户端上报 DPR+视口尺寸，服务端按访客视口重新模拟渲染并全量重发瓦片；
  拉窗口/缩放/跨屏都跟随（构造性一致保持：瓦片始终按访客设备像素 1:1 落位）。
- `hello` 消息扩展 `w/h` 字段。

## v0.3.2（2026-10-22）

### Security / Robustness（第二轮代码审查：自查 + 独立复审）
- **资源代理白名单**：`/m/*` 只放行表现层静态资源扩展名 + 响应类型过滤，HTML/JSON/接口
  一律 403——此前 `GET /m/` 可直接拉到源站整页明文（含页面内密钥）。
- **畸形 URL 容错**：`decodeURIComponent`/`URL` 解析失败返回 400，不再打崩进程。
- **会话清理顶置**：`close`/`error` 监听先于一切 await 注册，setup 期（最长 ~23s）断连
  也释放会话槽/page/定时器——此前 3 次断连即耗尽 MAX_SESSIONS，且未监听的 error 事件
  会打崩整个进程。
- **明文快照通道彻底移除**：交互失败回退在所有模式下都不再发送 `snapshot()`。
- **客户端瓦片补丁崩溃修复**：补丁分支变量名错误（`tile` 未定义）导致每个补丁抛错并
  触发全量重同步，配合时钟形成 1Hz 重同步风暴。
- **变更不丢失且无风暴**：位图化期间的页面变更入队（有界 200 条），快照完成后走常规
  补丁链补发（此前版本直接丢弃；中间版本的"尾随全量重同步"方案会自我延续成风暴，已替换）。
- **重入保护**：`startDomMirror` 单飞（in-flight 去重），并发快照不再互相污染底板。
- ffmpeg spawn 失败降级不再打崩进程；命令串行派发；补丁截图前等 `document.fonts.ready`；
  补丁 clip 原点吸附设备像素网格；TEXTAREA 走输入瓦片路径；DOM 替换改用 `replaceWith`；
  dom 模式忽略 quality 指令；会话中 DPR 变化热更新（重新按新 DPR 渲染）；
  客户端补丁先清旧瓦片矩形（布局位移不再留影）。

## v0.3.1（2026-10-22）

### Fixed（代码审查产出）
- **live 页 select 永久破坏**：快照时把真实页面的下拉框透明化并清空选项且不恢复，
  第二次快照起底板里下拉框标签消失。现在 live 页只做等大占位，透明化只发生在克隆。
- **属性级明文泄漏**：克隆未清理 `input value` 默认值（服务端预填表单即业务数据）、
  `input[type=hidden]`（CSRF/ID）、`img alt`/`title`。瓦片模式下视觉已由像素承载，
  这些属性全部剥除。
- **无瓦片 select 的选项文本泄漏**：兜底剥除不再跳过 SELECT 子树。
- **补丁分支引用未定义变量**：`__xyPatch` 内 `ws.send(payload)` 落在块外（每个补丁
  ReferenceError 被吞，功能侥幸可用）。删除重复发送。
- **补丁瓦片服务端重采样**：clip 原点未吸附设备像素网格，分数坐标先被 CDP 重采样。
- **会话关闭双扣**：`sessions--` 在 close 与 catch 两路都可能执行 → 计数变负。
- **客户端画布增高清空**：canvas.height 重设会清空已画内容，增高时先拷贝回填。

## v0.3.0（2026-10-22）

### Added — DOM 通道升级为"服务端像素瓦片"架构（默认推荐）
- **100% 一致（构造性）**：所有可见文字/图表/下拉框/输入框外观 = 服务端按访客 DPR
  （`hello` 消息上报，`Emulation.setDeviceMetricsOverride` 模拟）渲染的原始像素，
  PNG 无损下发，客户端在设备分辨率 canvas 上以整数设备坐标 1:1 位块拷贝——
  访客看到的就是服务端渲染的那些像素本身，不存在"像不像"。
- **零明文（实测）**：镜像 DOM textContent 业务可见字符 = 0；WS 下行仅 PNG 瓦片。
  明文快照的所有发送路径已焊死（全量重同步/交互回退均强制走瓦片化）。
- 输入框：背景瓦片显示 placeholder/默认值像素，键入时客户端隐藏背景、键入内容本机渲染。
- 残差实测（DPR 1.25、同引擎、冻结时钟）：整页 1.34–1.46 /255，仅剩输入类交互元素
  的本机渲染与骨架描边 AA；文字区域构造性一致。
- 已知边界：select 下拉展开列表、输入框键入文字为本机渲染；IME 合成同前。

### Fixed
- 消息队列提到会话初始化最顶端：冷启动（Chrome 拉起数秒）期间到达的 hello/mode
  不再被 ws 库丢弃（此前首个会话 DPR 恒为 1、模式切换可能失效）。
- PAGE_HELPERS 模板内换行转义、文本节点量测（Range 而非 getBoundingClientRect）。

## v0.2.1（2026-10-22）

### Fixed
- **文字残差归零**：源站经 fontconfig 系统字体路径渲染，镜像走 webfont 路径，FreeType 参数
  不同导致文字区 ~1/255 残差。现在服务端 Chrome 加载源站后注入与镜像同款的 @font-face
  （/f/* 路由开放 CORS），三条渲染链（服务端/镜像/客户端 webfont）完全同源。
  实测（冻结时钟、同引擎）：整页平均差 0.707 → 0.0086，静态区 1.20 → 0.019，
  表格文字区 1.00 → **0（逐位相同）**。访客端剩余差异仅为其操作系统文字栈
  （如 Windows DirectWrite 的 gamma/contrast）——无任何网页 API 可控，见 README 安全边界。

## v0.2.0（2026-10-22）

### Removed（破坏性）
- 移除 `dombitmap`（DOM+文字位图）与 `skiadom`（DOM+引擎文字）两个实验通道，产品聚焦 DOM 镜像；
  像素通道（jpeg/webp/h264）保留作保真基准与重交互页面兜底。完整实现见 git 历史 v0.1.x。
- 移除 CanvasKit 引擎下发（`/ck/*`、`get-canvaskit.sh`）与引擎字体路由（`/f/noto`、`/f/noto-bold-otf`）；
  npm 包从 35.5MB 减至 ~16MB（保留 DOM 模式所需的 Regular/Bold WOFF2）。

### 升级
- `DEFAULT_MODE` 与 WS `mode` 取值不再接受 `dombitmap` / `skiadom`，传旧值会回退 `jpeg`。

## v0.1.1（2026-10-22）

### Fixed
- **镜像整体布局偏移**：canvas→img 兜底未保留原盒子的 display/尺寸，源站 `canvas{display:block}`
  等选择器在镜像中匹配不到 img，inline 空隙使图表以下内容整体偏移（实测 +5px，skiadom 文字与
  骨架错位）。现在内联保留 display/width/height——逐元素实测 dom/skiadom 全部 Δ=0，
  对无损真基准像素差 0.70/0.75（avg per 255）。
- **button/inline-block 内文字的占位高度**：Chrome 对其 range rect 返回字体盒而非行盒，
  占位直接采用会使行盒塌陷（按钮 38→34px）。现改用父元素内容盒高度。
- skiadom：下拉框（select）在镜像中显示为空——option 文本被占位/清空导致原生控件标签消失。
  现在 SELECT 子树不参与 runs 收集，克隆时仅保留选中项标签（其余 option 文本不下发）。
- 三个 runs 收集器跳过 SCRIPT/STYLE 等标签时未计数，导致后续兄弟节点路径错位
  （dombitmap 下可能造成个别文本替换静默失败）。

### 性能
- 静态资源按 Accept-Encoding 协商 gzip 并按文件缓存（canvaskit.wasm 7→3.3MB）+
  Cache-Control immutable + 客户端在 WS 建立时后台预取引擎资源（切换 skiadom 即秒开）。
- 字体下发从 fontconfig TTC（21MB×2，含全部 CJK 语言字形）改为 SC 单面提取 + 与 Regular
  同覆盖子集（30,890 字位）+ WOFF2（Regular 6.1MB / Bold 10.2MB）；引擎通道保留 OTF（gzip 传输）。

### 工程
- package.json 公开化：scoped 包名 `@lizhen-xxaq/dom-mirror`（npm 上 `dom-mirror` 已被占用），
  files 清单补 `get-canvaskit.sh`，`npm run setup` 一键取回 ffmpeg/CanvasKit。

## v0.1.0（2026-10-22）

首个发布版本：RBI 引擎 + 五通道演示，Apache-2.0。

### 通道
- `jpeg` / `webp`：CDP screencast 直发（30fps 节流、仅变化推帧、q10-95 运行时可切）
- `h264`：screencast → ffmpeg(x264 ultrafast/zerolatency) → Annex-B over WS → WebCodecs 解码
  （关键参数 `-analyzeduration 0 -probesize 1M`：稀疏输入首帧即出流）
- `dom`：DOM 镜像——海关序列化（剥 script/事件属性、URL 重写、canvas→位图）、元素级补丁、
  路径回传事件、字体一致性（服务端 fontconfig TTC 下发，FontFace API 按字重注册）
- `dombitmap`：DOM+文字位图——文本替换为服务端渲染裁切（inline 放置 + 实测 relative 归位，
  布局零扰动），不可见文本剥除；镜像零明文

### 实测（1280×800，内网）
- 交互延迟：dom/dombitmap 4–8ms；jpeg 27–30ms；h264 30–33ms
- 交互流量：dombitmap 位图补丁 KB 级；dom ~1.4KB/次；h264 456KB；jpeg 2050KB（同场景）
- 一致性：dombitmap 服务端自渲染 vs 无损真基准 avg 3.16/255，文本区 0.0

### 工程设施
- WS 协议 v0.1 文档化（docs/PROTOCOL.md），依赖包化契约
- GitHub Actions CI：语法/结构/协议检查 + Docker 构建 + 冒烟探活
- Docker 一键运行，内置演示源站；支持 `ORIGIN_URL` 指向任意真实站点

### 已知边界
见 README"已知边界"清单（表格行 1-2px 偏移、虚拟滚动页面建议像素通道、IME/深链接待做等）。

### 路线
- v0.2：npm 依赖包形态 + Go（chromedp）实现
- v0.3：浏览器池/会话管理与产品化接入
