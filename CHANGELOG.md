# Changelog

本文件记录 dom-mirror 的版本演进。协议破坏性变更见 docs/PROTOCOL.md。

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
