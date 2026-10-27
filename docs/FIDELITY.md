# DOM 镜像保真模型与差距分类（v1，基于文献与实测）

> 目标：把"通用性/还原性"从主观描述变成可度量、可回归的工程对象。
> 方法：先定义保真维度 → 逐维度建立等价断言（verify-generality）→ 文献技术映射 → 分阶段实现。

## 一、保真模型（六个维度）

一个业务页面在镜像里的"还原度"分解为：

| 维度 | 定义 | 等价判据 | 现状（0.17.0 实测） |
|---|---|---|---|
| D1 结构 | DOM 树形状（元素/属性/文本） | 镜像树与源站树节点级等价（全量快照+outer 补丁） | ✅ 基准通过（2000 行大表全量到达） |
| D2 样式 | 计算样式一致 | 关键元素 computed style 逐项比对；级联顺序保持 | ✅ 文档序拼接修复后通过（含 @import/adopted/后挂 link） |
| D3 几何 | 视觉位置一致 | 元素 rect 误差 ≤2px | ✅ 元素 rect 全等（0px）：body 继承 pin（v0.20）+ line-height 比值化（v0.20.1）后，表单区 password/button/top-left-w-h 逐项与源站相同；残余像素 diff 0.214% 仅为标题字形边缘 2 条 4px 亚像素抗锯齿带（无颜色/布局差） |
| D4 状态 | 表单/媒体/滚动/选区等运行时状态 | 服务端真实状态回显黑盒断言 | ✅ 表单（含程序化改态，setter 劫持）；⚠️ 选区/多选 selected 未覆盖 |
| D5 交互 | 输入语义在源站正确生效 | 点击/键入/组合键/拖拽在源站产生预期副作用 | ✅ 指针/文本键/IME/滚轮；⚠️ 拖拽（HTML5 DnD）、触摸未覆盖 |
| D6 时序 | 动画/媒体播放与源站同步感 | 指令流画布逐帧、CSS 动画本地 60fps、媒体状态跟随 | ✅ CSS 动画本地原生；✅ 2D 指令流；⚠️ WebGL 位图轮询帧率有限；⚠️ 媒体状态同步已实现未断言 |

带宽维度（工程约束，不是保真维度但与目标绑定）：快照/补丁字节按消息类型计量（verify-generality bytes 输出）；交互回显延迟 = 零本地回显路径的 RTT（当前仅键盘型应用字符 ~1 RTT，输入框本地原生 0ms）。

## 二、文献技术映射（已读：rrweb observer/serialization/replay、Timelapse(Dolos)、DiffSync、Cloudflare/Menlo RBI）

| 技术 | 来源 | 对应维度 | 引擎落地 |
|---|---|---|---|
| 原型 setter 劫持捕获程序化 value/checked | rrweb observer.md | D4 | ✅ v0.17 dom-props |
| 输入在嵌入器 API 边界派发而非合成 DOM 事件 | Timelapse/Dolos | D5 | ✅ 早已采用（CDP Input.dispatch*） |
| 分歧检测：DOM 节点数/事件派发数指纹比对告警 | Timelapse/Dolos | D1 自愈 | ❌ 未做 → 阶段 P2 |
| 非确定性清单：窗口尺寸/焦点/解析器异步/嵌套 iframe 输入 | Timelapse 实测教训 | D3/D5 | 部分（视口 hello 已做；焦点差异、iframe 焦点未系统处理）→ P2 |
| 影子副本双侧 diff（shadow copy） | DiffSync | 带宽 | ❌ 当前 outer/inner 整段补丁 → P2 评估（文本节点级 diff） |
| 缺失节点池（乱序插入，neighbor id） | rrweb replay.md | D1/带宽 | 不适用（我们 outer 替换无乱序问题）；若细化到节点插入则采用 |
| :hover 模拟（规则改写+类切换） | rrweb replay.md | D2/D6 | 不需要（镜像为真实 DOM，:hover 原生生效；frame 模式有投机本地回显） |
| CSSOM 解析态序列化（cssRules 递归内联 import） | rrweb serialization.md | D2 | 部分（link 文本 fetch+url 改写；import 依赖客户端二次拉取）→ P1 改为服务端递归内联 |
| 媒体交互记录（play/pause/seek/mute） | rrweb | D6 | ✅ v0.17 已实现（未断言） |
| 鼠标轨迹双级节流 20ms/500ms+时间校正 | rrweb | D5/带宽 | 已有 40ms 单级（够用，无需改） |
| DOM 重建类 RBI 的固有限制（canvas/WebGL/指纹） | Cloudflare/Menlo 公开材料 | D6 | 混合模式（dom+frame 兜底）已是业界标准答案；深化 2D 指令流已超出业界通用做法 |

## 三、差距分类（按业务影响排序）

### P0（已闭合，基准覆盖）
- 相对路径资源/srcset/image-set 404（D1/D2）
- @import 级联（D2）
- contenteditable 键入（D5）
- 键盘型应用字符/功能键全丢（D5）
- 程序化表单态（D4）

### P1（实现中，验证完成后并入提交）
1. **媒体状态同步断言**（D6）：✅ 实现并断言（静音 WAV data-URI，两端 muted 自动播放允许；play/seek/pause 跟随）。有声播放受自动播放策略限制=已知边界。
2. **CSS 服务端递归内联 @import**（D2）：✅ cssInlineImports（深度≤3，同源才内联，跨源保留）。
3. **选区镜像**（D4）：✅ 改为矩形方案——镜像内容在客户端 shadow root 内，**文档级 Selection API 无法跨 shadow 边界设置**（实测），改为服务端下发 `Range.getClientRects()` 页面坐标矩形，客户端在 .xy-body 内绝对定位高亮层（随镜像文档流滚动）。

### P1.5 带宽（实现中）
4. **cssSame 快照**：SPA 路由切换的导航重拍不再重发 ~200KB 相同 css（cssSame 标记+客户端缓存；hello/恢复握手后必发全量）。
5. **WS permessage-deflate**（阈值 512B）：JSON 文本 5-10× 缩减，浏览器透明协商。

### P2（v0.19 全部落地，基准 7/7 绿）
6. **补丁粒度细化**（DiffSync 思想落地）：✅ 文本节点级补丁（{id,ti,text}）+ 追加型补丁（{id,append}，ID 注册表判别真追加——同父移动也是 add-only 记录，实测 node-id 回归拦截）。
7. **分歧检测自愈**（Timelapse/Dolos 技术）：✅ ping 携带镜像元素指纹（剔除引擎自建层与源站 script/spacer），漂移 >max(2,2%) 持续两拍且距上次自愈 >10s → 自动全量重同步（基准：删 3 节点 → 自动恢复）。
8. **拖拽/触摸**：✅ HTML5 DnD（dragstart/over/drop/end 合成 + text/plain 载荷）；✅ 触摸（touchstart/move/end → CDP dispatchTouchEvent，本地 preventDefault 防合成鼠标双事件）。
9. **WebGL 可见性门控**：✅（既有行为补断言锁定：off 屏动画画布零捕获，on 屏正常位图通道）。
10. **焦点同步**：✅ focus-sync（源站程序化聚焦跟随；访客文本输入中不抢）。多选 select 的 option.selected 劫持并入 dom-props.sel。

### v0.20 —— 量化与继承还原
- **body 继承样式还原**：镜像根此前继承"客户端外壳"的字体/颜色（源站 body{} 未显式设置的属性）；快照携带 body 可继承计算样式（font/color/letter-spacing 等 9 项）钉到 .xy-body。基准断言：裸元素拿到源站 body 的 Georgia/深红。
- **v0.20.1 修正（D3 定案）**：pin 的 line-height 初版用计算后的绝对 px，把源站"无单位比值"语义压平（14px 子元素源站 21px、镜像 24px）→ 表单区整体 +3px 漂移（实测 password top 462.3→465.3、vdiff 一度 1.213%）。改为**比值**（计算 px ÷ body 字号，normal 保持 normal）后：表单区元素 rect 与源站**逐项全等**，vdiff 回 0.214%（仅剩标题字形边缘 2 条 4px 亚像素带，几何与颜色无差）。裸元素探针（测试Abc123…）宽度 188.14px/行高 19px 与源站**逐位一致**。
- **带宽实测基线**（真 payload 量化的数字，非估算）：
  - deflate（ws permessage-deflate，zlib L3）：生产登录快照 216.8KB → 35.9KB，**6.04×**；小 payload（3.6KB vlist 快照）3.37×。
  - 虚拟列表（1 万行/20 行窗口）：每滚一窗补丁 ~0.85KB（压缩前，deflate 后 ~0.1KB 级）；单次滚动手势（28 窗连续更新）24KB 压缩前。
  - 键盘型应用首字符回显 RTT：基准 case 记录（容器内 ~几十 ms 量级，随网络变化）。
- 基准扩到 **8 case**（+gen-vlist 虚拟列表：滚动换窗功能 + 每滚补丁字节）。

### v0.21 —— 真实会话 RUM（性能/流畅度可观测）
- **采集通道**：客户端 240 帧滑窗帧时间、交互到视觉延迟（交互发送→首个被应用的下行消息，≤40 样本）、按消息类型字节；首拍即报、此后 10s 随 ping 心跳下发（[rum] 日志），pagehide 时 sendBeacon POST /rum（[rum-beacon]）；`window.__xyRum` 可外部抓取。基准含 gen_rum 断言（会话必须产生 RUM 日志）。
- **生产 RUM 基线**（v0.25 后大样本：18 会话/41 份报告，:81 登录流+仪表盘滚动+键盘悬停 / :82，7 种视口 1280×800~1920×1080 含 DPR2）：
  - **交互到视觉延迟 p50 16.6ms / p95 17.6ms**（14 个有交互样本的报告，min 13.1）——约一帧，跨 7 种视口稳定
  - **帧时间 p50 16.7ms / p95 16.7ms**（全会话 60fps 锁帧；极端单帧 66.7ms 仅现于会话建立期）
  - 字节构成（压缩前）：快照 12.19MB/77 份（登录流重复 css；deflate 后 ÷~6）+ 补丁 518KB/345 条
  - 真实访客流量随使用自然累积（网关 docker logs 过滤 [rum 行随时聚合）
- 后续优化以这组数据为基线。

### v0.23 —— 虚拟列表平移 diff（先量化后动工）
- **量化先行**（gen-vlist 1 万行/20 行窗，慢滚=每次 1 行×20 步、快滚=整页跳×4）：
  改造前慢滚 **14.8KB/步**、快滚 20.5KB/步（每步触发多次整窗 inner 替换；
  此前"每窗 0.85KB"为均值假象）。行级 diff 理论值慢滚 3.6KB——收益成立。
- **实现（窗口平移检测）**：inner 补丁序列化时与上次子元素序列比对（**规范化
  串**——剥离 data-xy-id，虚拟滚动每轮重建元素、id 必变，原文比对无效）；
  命中"old.slice(k)≡new 前段"（下移）发 `{delHead:k, append}`，反向发
  `{prepend, delTail:k}`，不命中回退整窗 inner；dedup 同步改用规范化串
  （内容相同的重建不再因 id 变化重复整窗下发）。
- **实测**：慢滚 **14.8→4.1KB/步（3.6×）**（其中 ~1.8KB/步为 spacer 高度的
  合法小 outer）；快滚 20.5→16.3KB（整窗变化全发是正确行为）。基准
  vlist_shiftdiff 断言 ≤5KB/步锁定。剩余 inner 回退为窗口边界/混合批次形态，
  记录为进一步优化空间。
- **v0.24 LCS 编辑脚本（边界/混合批次闭合）**：纯平移检测之外增补 kidKeep/
  kidIns（规范化串整数化 O(n·m) DP，n,m≤64；keep=旧序索引、ins=[新序位置,
  原始 html]，编码比整窗省 30%+ 才启用；仅元素子节点容器）——客户端按新序
  重排并**复用保留节点**（不重建）。慢滚进一步收敛 **4.1→2.6KB/步（较原始
  14.8KB 共 5.7×）**，窗口字节余量（vwin 通道）从 ~63KB/20 步 降至 ~32KB。
  任何校验失败按 patch-miss 走重同步（宁重不错）。

### v0.25 —— 跨源 iframe 同源化 + Vikunja CI 加固
- **跨源 iframe 同源化**（此前"已知边界：占位块"→ 已解决，带静态快照语义）：
  服务端代理抓取（无访客凭据；6s/512KB/仅 text/html；失败回退占位块）→ 页内
  sanitize（剥 script/事件属性；资产 URL 改写为 `/m/x/<secret>/<b64(origin)>/path`）
  → 以 srcdoc 内联，与同源 iframe 同一渲染路径。**会话作用域资产代理 /m/x**：
  secret 每会话随机（同 obf 字体路由安全模型），origin 注册表只收"本会话源站
  实际嵌入过的源"——防开放代理/SSRF；扩展名与响应类型限制与 /m 一致。
  基准 gen-xiframe 三断言：srcdoc 含 /m/x 非占位、嵌入内容真实渲染（徽标 +
  图片经代理加载 naturalWidth>0）、script 被剥离。限制（记录）：静态快照语义
  （postMessage 驱动的动态嵌入不更新）；需访客浏览器会话 Cookie 的跨源嵌入
  不适用（RBI 无访客 Cookie）。
- **Vikunja CI 冷启动加固**（本会话三次偶发红的根治）：app DB 写路径预热
  （首 /register 触发 sqlite 迁移）+ 镜像首 WS 会话预启动探测 + 客户端失败
  模式自动重试一次（冷 runner 首会话竞态实测 attempt-2 必过）。

### v0.26 —— RUM 大样本基线 + 跨源 iframe 动态刷新
- **RUM 生产基线扩样**（18 会话/41 份报告，:81 登录流+仪表盘滚动+键盘悬停 / :82，7 种视口 1280×800~1920×1080 含 DPR2）：交互到视觉延迟 **p50 16.6ms / p95 17.6ms**（min 13.1，约一帧跨视口稳定）；帧时间 p50/p95 = **16.7/16.7ms**（全会话 60fps 锁帧）；字节构成快照 12.19MB/77 份 + 补丁 518KB/345 条（压缩前）。
- **跨源 iframe 动态刷新通道**（静态快照语义 → 周期跟随）：`prepareXframes(force)` 提取为独立函数，会话级定时器（XFRAME_REFRESH_MS，默认 15s，基准 4s）周期重抓同源化条目；内容变化才动——推送宿主 iframe 的 outer 补丁（客户端整替，srcdoc 随新内容到达）。基准 tick 路由（origin-static /tick.html 每 5s 换版本号）：断言镜像内 TICK 版本随刷新变化（30s 窗口）。会话关闭清理定时器与 origin 注册表。

### v0.27 —— 两项边界定案（closed shadow root / 有声媒体）+ RUM 周度复评
**closed shadow root（定案：可观测范围已扩到规范极限）**
- 技术评估：`attachShadow({mode:'closed'})` 的引用只在创建时可截获——v0.27 以
  `evaluateOnNewDocument` 在**页面任何脚本之前**安装补丁（此前 helpers 在
  networkidle0 后注入，parse 期创建的 closed root 永远拿不到引用），注册表
  WeakMap(host→root)。两种时序（parse 期/注入后）均覆盖：序列化以声明式
  `<template shadowrootmode="closed">` 内联，客户端 `parseHtml`（div+setHTMLUnsafe，
  统一替换 template 惰性片段——声明式 shadow 在 template.content 插入时不被处理）
  解析期挂根。**规范上不可观测的残余**：声明式 `<template shadowrootmode=closed>`
  由 HTML 解析器直接挂载、不调 attachShadow、无任何回调——此类根走不了引用截获，
  唯一出路是位图兜底（像素捕获通道已有），按需再启用。
- 实证（gen-cshadow 四断言全绿）：parse 期 closed 内容渲染（绿色像素 5818）；
  注入后创建 closed 内容渲染（蓝色像素）；点击 closed 组件 → 服务端闭包翻转 →
  宿主 outer 补丁回传（report 更新 + 像素由绿变红 5808）。
- 顺带修复的历史缺陷：`window.__xyObserveShadow` 在 attachShadow 包装器中被调用
  但**从未被赋值**（空引用）——注入后创建的影子根（含 closed）一直没挂 observer。

**有声媒体（定案：用户激活语义下可完整跟随）**
- 技术评估：浏览器自动播放策略限制的是**无声激活页面**调 `play()` 有声媒体；
  访客在镜像内的真实交互（点击）为客户端页面授予用户激活——此后
  dom-props.media 的 `play()`（不静音）被策略放行。
- 实证（gen-media-audio 四断言全绿）：镜像内点击播放按钮（trusted 事件）→
  镜像音频**不静音播放、进度推进、暂停跟随**。残留：会话建立后访客从未交互
  即自动播放的有声媒体（策略硬限制，无解——静音跟随仍可用，与源站静音自动
  播放场景等效）。

**RUM 自然访客周度复评点**
- 工具：`tools/aggregate-rum.cjs`（读网关 `[rum]`/`[rum-beacon]` 日志行，聚合
  帧时间/交互到视觉延迟 p50/p95、字节构成、视口分布）。
- 流程：每周 `docker logs rbi-gateway 2>&1 | grep '\[rum' | node
  tools/aggregate-rum.cjs`，与 v0.26 基线（18 会话/41 报告）比对；样本
  ≥100 会话或分布显著漂移（p95 帧时间 >25ms / 交互延迟 p95 >30ms）时更新
  基线并排查回归。

### v0.28 —— 声明式 closed 模板位图兜底 + main 重构同步
- **声明式 closed shadow 位图兜底（最后一项规范不可观测残余的缓解落地）**：
  `<template shadowrootmode=closed>` 由 HTML 解析器直接挂载（不调 attachShadow、
  无回调）——识别谓词（无 light 子树/open 影子根/closed 注册表条目/自身可视盒样式，
  尺寸 16~3000px）在 **stamp 并行游走**中非破坏式标记（data-xy-elbit + 源站计算尺寸
  为 min 尺寸——镜像端空 div 高 0，位图需要盒子；获得真实内容时客户端自动清除标记/
  背景/min 尺寸）。位图复用 startCanvasWatch 的 region clip + 帧差跳过通道：fresh
  旁路 rAF 门保证静态内容首拍，变化后 ≥500ms 节流（120ms 全页截图在重应用上打满
  CPU）；客户端以 backgroundImage 叠加。**XY_ELBIT=0 可整体停用**（误捕逃生门）。
  开发中被回归套件拦下的两个关键缺陷：①live/clone 全量数组位序对照在 clone 剥
  script 后错位一格（#gap 标记落到 #outer-button，min-height:1200 撑坏布局）→
  移入 stamp 游走；②破坏式替换占位 img 会吞掉快照时空、后填充的 Vue 挂载点
  （Vikunja 整个登录表单消失）→ 非破坏式标记。
  ③（0045b04，逃过本地回归、被 CI 冷 runner 拦下）开关注入未插值——
  `const __xyElbitOn = config.elbit !== false` 在模板串中原样下发页面，无全局
  config 的页面 helpers-1 evaluate 抛 ReferenceError、会话必死（snaps:0、客户端
  20s 超时）；源站自带 window.config（Vue 站）恰好掩盖，故线上三症状与部分基准
  绿、scroll fixture 必死。教训：page-helpers 模板串引用服务端变量一律 ${} 构建
  期插值（canvasStream 开关同款），不得依赖源站全局名做巧合兜底。
- 实证（gen-cshadow 六断言全绿）：parse 期/注入后 closed 内容渲染、交互视觉回路、
  声明式宿主占位标记、位图首拍（绿像素 43825）、CSS 动画翻转跟随。
- **main 同步（144a9ec，11 提交重构）**：PAGE_HELPERS→lib/page-helpers.js、
  input dispatch/frame-codec/xframe/canvas 捕获辅助抽取、tarball 独立宿主回归；
  v0.28 elbit 三处已移植到新结构（lib/page-helpers 谓词+标记、lib/canvas 候选+
  record elbit 节流、server.js watch fresh 旁路）。合并树全量回归绿（Vikunja 3/3，
  xframe-policy 过；package-business 需宿主 node，由 CI 覆盖）。
- 周度 RUM 复评：见 v0.27 节流程（aggregate-rum.cjs）。

### v0.29 —— 低带宽三件套（真实业务验收驱动）
- **验收场景**：SoulBind（:82，源站 10.1.1.180）admin 真实登录 → SOC 仪表盘
  （1313 节点、17 画布）→ 侧边栏二次导航。真实指针输入（引擎点击走
  pointerdown/up 管线，合成 .click() 不派发——验收探针必须用坐标级真实点击）。
- **canvas 指令流字节预算**：每画布 10s 滚动窗口 100KB（config.canvasOpsBudget，
  0=不限），超限 opaque('rate-budget') 停发指令流、位图捕获接管（帧差+退避封顶）。
  定时器驱动（无 rAF）的重绘画布靠 hot 续期旁路 rAF 门——否则超预算后冻结
  （新基准断言拦下）。客户端 canvas→img 原位替换通道对齐快照占位形态。
- **attrs O(1) 补丁**：属性变更不再 outer 全量重发（图表动画 style 每 tick
  153KB 居带宽主导）。快路径与 stripAttributes/sanitizeData 同语义：表单控件/
  URL 承载属性回落 outer、on*/零明文载体剥离、style 经 cssUrlRewrite 改写——
  data-boundary 回归曾拦下 password value 绕过剥离直上 wire 的泄漏。
- **实测（RUM 30s，v0.28.1 → v0.29.0）**：canvas-ops 19.8MB 无上限 → ~0.8MB
  冻结；dom-patches 9.3MB → ~3MB；总带宽 ~35MB → ~6MB（**5.7×**）；交互延迟
  36-71ms。
- **vlist 基准阈值校准的病理发现**：旧 outer 路径替换 spacer 引发滚动回声放大
  （348px 滚出 first=228/updates=23，19×）；attrs 直发后回落 2×。updates 阈值
  10→5，first 断言不变。首次生产聚合执行
  （2026-10-27，v0.28.1 部署后即时）：7 beacon / snaps 7 / patches 0 / 帧时
  p50 66.6ms、p95 66.8ms（空闲页 beacon 采样节奏，非交互负载）/ 交互延迟暂无
  样本（容器刚重建，仅探针流量）——通道与工具链端到端可用。

### v0.30 —— 伪路由 URL 导航 + Chromium 实例池（PR #9/#10）
- **伪路由**：服务端 navigate/history 消息（白名单同请求拦截语义：相对地址
  按当前页解析、裸主机名补 http://、越权回 nav-blocked）；主框架导航（含 SPA
  pushState）即时同步 location；客户端地址栏生产模式为悬停唤出悬浮层（不占
  镜像可视区几何——fixed/inner-scroll 实测不受扰）。
- **实例池**（lib/browser-pool.js）：N 常驻 Chromium × 会话级 BrowserContext
  （cookie/存储隔离保持），browserPoolSize 默认 max(2, ceil(maxSessions/2))，
  0=回退一会话一浏览器。历史幽灵瓦片（同浏览器并发截图错位）以每浏览器截图
  互斥（三处 captureScreenshot 走 exclusive() 串行）兜底。下载按
  browserContextId 隔离；弹窗关闭限定本上下文；mirror.close() 清池。
- **池自愈四件套**（PR #10）：获取链全链 20s 竞速超时逐出、context.close 5s
  竞速、容量等待 20s 上限超发、宽限感知收割（readyState=3 连续 3s 无 close
  事件才收——state=2 主动断连握手不干预，2CPU 下立即 terminate 会掐断恢复
  测试的 500ms 重连窗口，CI 连续 5 次抖动即此竞速）。
- **既有缺陷修复**：浏览器页销毁后 ws 内部 CLOSED 但 close 事件不发出（v0.29
  靠 MAX_SESSIONS 冗余掩盖）——收割器轮询兜底。
- **验收**：SoulBind :82 真实登录→1320 节点仪表盘→地址栏跳转（已认证回弹
  属源站正确行为）/后退/越权拒绝（状态提示+内容保持）；MAX_SESSIONS=8 下
  chrome 主进程 2（v0.29 为 8）；零间隔快速连击 3 会话×3 轮 8/9（自愈前
  ~50% 超时）。
- 装置适配：generality 新增 nav case（7 断言）；package 宿主生命周期/汇总改
  contexts 语义；revocation/frame-baseline 装置显式 pool-off（进程级仪表化
  保持原 patch 面）；cleanup pool-off 恢复历史并行关闭形态（串行拆分悬挂
  mock 编排——CI 语法 job 卡死真根因）。

### 已知边界（记录在案，不计入缺口）
- 有声媒体播放受客户端自动播放策略限制（静音可跟随，进度始终同步）。
- 跨源 iframe 动态嵌入：周期重抓刷新已解决（v0.26，变化才推）；postMessage 双向驱动的嵌入仍为快照语义。
- closed shadow root（不可观测，规范如此）。

## 四、验证纪律（对齐用户要求）

- 每个 P1/P2 项：基准断言先行（红）→ 实现（绿）→ 12 组全量回归全绿 → 真实业务站点线上抽检 → 才进入提交队列。
- 提交按批次聚合，不在未验证状态推送。
