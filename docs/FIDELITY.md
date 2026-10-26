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
- **生产 RUM 基线**（v0.22 后多场景采样：6 会话/24 份报告，:81 登录流+仪表盘滚动 / :82，视口 1280×800~1920×1080，含 DPR2）：
  - **交互到视觉延迟 p50 15.6ms / p95 17.4ms**（12 个有交互样本的会话，min 13.2）——约一帧，跨视口稳定
  - **帧时间 p50 16.7ms / p95 16.8ms**（全会话 60fps 锁帧；单个掉帧样本 33.3ms）
  - 字节构成（压缩前）：快照 8.07MB/54 份（登录流重复 css，deflate 后 ÷~6）+ 补丁 429KB/254 条
  - 真实访客流量随使用自然累积（网关 `docker logs | grep '\[rum'` 随时聚合）
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

### 已知边界（记录在案，不计入缺口）
- 有声媒体播放受客户端自动播放策略限制（静音可跟随，进度始终同步）。
- 跨源 iframe 内容（安全设计：占位符）。
- closed shadow root（不可观测，规范如此）。

## 四、验证纪律（对齐用户要求）

- 每个 P1/P2 项：基准断言先行（红）→ 实现（绿）→ 12 组全量回归全绿 → 真实业务站点线上抽检 → 才进入提交队列。
- 提交按批次聚合，不在未验证状态推送。
