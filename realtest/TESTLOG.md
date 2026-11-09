# dom-mirror 真实站点测试记录(第 2 轮)

时间:2026-11-04 · 引擎版本:修复分支 fix/v064-rate-limit-env-zero(commit 0f1b749)
环境:macOS + 系统 Chrome 156(headless 探针)+ demo 双服务器(8077 源站/8088 网关)
方法:每站标准化流程——启动(记 PID)→ 通用探针(probe.cjs)→ 网关日志审计 → 白名单迭代 → 严苛审查 → 复盘

---

## 站点 1:www.ruanyifeng.com/blog/(纯静态博客 · 服务端渲染)

**配置**:`ORIGIN_URL=https://www.ruanyifeng.com/blog/`,`REQUEST_ALLOWED_ORIGINS=https://*.ruanyifeng.com`
**结果**:
- 会话在线 1661ms;快照:script=0、3 输入框、3 图、12 可见链接;href 全部改写 `/m/` 代理路径
- 文本完整(文章列表/日期/留言数全在);CSS 2 个文件放行入缓存
- ❌→✅ **点击导航:最终红绿闭环定案**(详见下文"根因终审")
- 初判"点击失败 ×2"后经五步诊断:hook WS 转发消息(锚定成功 aid=23,但链接是
  data-xy-id=24——命中的是父级 H2!)→ 源站直连对照(布局垂直偏移 173px,来自
  服务端图床 cdn.beekka.com 被白名单拦截→服务端图片空→布局下移)→ 行盒取证
  (a 为 inline 跨两行:行盒 y240~280 与 y302~342,**点击点 y=291 恰在行间空隙**)
- **根因终审**:多行 inline 链接的 getBoundingClientRect 是联合盒,探针"点几何中心"
  策略踩中行间空隙 → 点击穿透到父级 H2 → 锚定如实转发 → 服务端点击 H2 行间
  → 不导航。**引擎点击管线无罪**(锚定如实、坐标转发、服务端执行、回流全部正常)
- 红绿测试:红=点击几何中心(490,291)不导航(×4 稳定);绿=点击文字行(400,260)
  → 地址栏 /blog/2026/10/weekly-issue-417.html、镜像回流文章页 ✓
- ⚠️ 镜像侧资源 404 ×2(person2_s.jpg 等,待查);布局偏移提示真实接入必须补齐
  源站全部资源域(否则服务端布局与镜像视觉产生位移)

---

## 站点 2:www.v2ex.com(SSR 社区)

**配置**:`ORIGIN_URL=https://www.v2ex.com/`(零白名单,全部资源同源)
**结果**:
- 会话在线 **236ms**(热页命中);快照:script=0、68 头像图、48 可见链接、href 改写 /m/signup
- ✅ **点击"现在注册"→ 服务端跳转 /signup → 镜像回流注册页,全链路成功**
- 零拦截日志(同源策略下无需白名单)

**复盘**:SSR 简单站是引擎的舒适区——快照/清洗/代理/点击导航全链路无缝。与站点 1 对照成立:
引擎管线健康,布局差异是点击失败的放大器。

---

## 站点 3:www.bilibili.com(重 SPA 视频门户)

**配置**:`ORIGIN_URL=https://www.bilibili.com/`,`REQUEST_ALLOWED_ORIGINS=https://*.hdslb.com,https://*.biliapi.net`
**踩坑记录**:多白名单分隔符必须用**逗号**;误用空格 → `ERR_INVALID_URL` 启动失败(已修正)
**结果**:
- 会话在线 435ms、快照 437ms(热页);**script=0**——重 SPA 的全部 bundle 脚本被剥,
  页面内容仍完整(全部频道导航文本在位)
- 13 图、37 可见链接;`*.hdslb.com` 通配放行后**零拦截**(白名单配置正确时无噪声)
- 点击"首页"→ 内容变化(changed=true,登录引导面板出现——落点与预期链接有偏差,同站点 1 的
  锚定问题在重布局站点上更明显)

**复盘**:重 SPA 站点快照/清洗质量超预期(0 script 且内容完整);白名单通配一次配置到位;
点击落点偏差在复杂布局站更显著——与站点 1 根因一致。

---

## 站点 4:www.runoob.com(轻交互教程站)

**配置**:`ORIGIN_URL=https://www.runoob.com/`(零白名单)
**结果**:
- 会话在线 268ms;快照:script=0、150 图、19 链接、文本完整
- 点击 Logo → location "/" 上报(交互响应正常)

**复盘**:轻量站表现与 v2ex 同级,无新边界。

---

## 交叉对照结论

| 维度 | 静态博客 | SSR 社区 | 重 SPA | 教程站 |
|---|---|---|---|---|
| 快照清洗(0 script) | ✓ | ✓ | ✓ | ✓ |
| 文本/图片/链接完整性 | ✓ | ✓ | ✓ | ✓ |
| href 代理改写 | ✓ | ✓ | ✓ | ✓ |
| 点击导航 | ❌ | ✓ | △ | ✓ |
| 白名单工作量 | 1 条 | 0 | 2 条 | 0 |

1. **核心管线在全部 4 类架构上健康**(快照/清洗/代理改写/回流)
2. **点击导航失败与"服务端/镜像布局差异"强相关**(布局一致站全过,差异大站失败),
   根因收窄:pointerdown 锚定失效→纯坐标点击→服务端落点 miss;建议上游:锚定失败时
   的降级策略(如 elementFromPoint 二次定位)
3. **白名单是真实接入的主要工作量**,但通配(`*.域`)一次配置即可,且有 [policy] blocked
   日志指路(接入→看拦截→补配→复测 的标准迭代)
4. 上轮遗留:百度 dom 模式交互受自绘控件限制(frame 兜底);本轮未再测百度

---

## 第 3 轮:对抗批次 8-10(HTTP 边缘 + WS 输入值)+ 弹窗冻结 DoS

时间:2026-11-05 · 基线:dialog 修复分支(3fa1b25 后)+ main 移植验证

### 发现 1(高危,已修):源站弹窗冻结镜像
- 载荷二分:P1(alert script)红 / P3(a href js,不自动执行)绿——分界 = 对话框阻塞
- 根因:headless Chromium 无 dialog 处理器 → alert/confirm/prompt 同步阻塞
  → 页面冻结 → 快照永不返回。恶意源站一个 alert(1) = 会话 DoS
- 修复:会话页面 page.on('dialog') 自动 dismiss;红→绿翻转确认

### 发现 2(低危,已修):WS 错误消息透传 CDP 细节
- NaN 坐标触发 CDP 协议错误 → 错误消息含 "Protocol error
  (Input.dispatchMouseEvent)" 直达访客——可探测内部实现
- 修复:访客侧通用文案,完整错误进服务端日志([cmd-err])

### 行为记录(非漏洞)
- key/dnd/composition >64KB → WS maxPayload 断连(恶意客户端自断, 服务器安全)
- repair ids 注入(1e999/字符串/对象)→ Number.isInteger 过滤生效
- hello dpr=1e999/负尺寸 → clamp 生效, 快照正常
- drift 自愈熔断在清洗致元素差 40% 的镜像上正确触发(v0.56 设计验证)
- /rum CRLF 日志注入:未发生(日志文件无伪造行)
- ruanyifeng /m/ 图片 404:UA 假设证伪(双 UA 均 200),真实机制未定位(遗留)

---

## 第 4 轮:批次 11/13(/rum 日志注入 + obf 端点)+ 修复

- **确认日志注入成立(上轮假阴性修正)**:同源 POST /rum 携带 CRLF 载荷 →
  审计日志文件中出现**独立的伪造日志行** `[net] FAKE-INJECTED-LOG-LINE`
  (取证:grep 日志文件实拍)。上轮"未注入"系 demo stdout 缓冲/时序假阴性。
- 危害:审计完整性——攻击者可伪造 [net]/[policy] 等任意日志行,污染
  安全审计与 SIEM 消费(本引擎定位即安全产品,日志完整性是底线)
- 修复:/rum body 落日志前单行化(`\r?\n` → 字面 `\n` 转义);
  [cmd-err] 防御性同步单行化(Error.message 可含换行)
- TDD:红(node:test,注入 logger 收集器,断言单行化——含内嵌换行失败)
  → 绿(修复后单行)✓;端到端复核:日志文件 rum 行单行、独立伪造行 0 ✓
- 批次 13:obf 字体端点 8 向量(未知 sid/长短/大写/负数/越界/空字节/穿越)
  全 404 SAFE ✓
- 无来源/跨源 beacon 403 ✓(既有防线验证)

### 补充发现(批次 14):代理响应体无上限缓冲(内存 DoS,已修)
- proxyAsset cache 分支 up.on('data') → chunks.push 无大小限制——白名单源站
  返回 200MB 响应 → 网关 RSS +482MB(全量缓冲实证,红测试)
- 对照:fetchOriginAsset 有 4MB 上限(正确实现)
- 修复:对齐 maxEntryBytes 上限,超限断上游+502;RSS 平稳(22MB),客户端
  收 502 asset too large
- TDD:test/proxy-asset-limit.test.js(流式 200MB mock 源站,断言 502+RSS)

---

## 第 6 轮:严苛复核(反转验证 + 端到端红绿闭环)

- **反转验证矩阵 4/4**(reversal-matrix.cjs):限流连坐/代理上限/rum 注入/uploads 纵深——
  修复前源码 → 测试精确红;修复后 → 绿。排除恒绿假测试。
- **弹窗冻结 DoS 端到端红绿闭环**(bisect-probe.cjs, 载荷 P1/P2):
  🟢 修复代码 → GREEN ×2 | 撤 dialog handler → 🔴 RED ×2(18s+ 冻结)
  | 恢复修复 → 🟢 GREEN ×1。因果关系确证(唯一变量 = handler)。
- **接入向导端到端**(guide-e2e.cjs):白名单拦外域图床 ×4 →
  清理时输出 `[policy] 被拦截资源域 Top1: <origin>×4` ✓
  观察项: 探针 ws.close() 后 15s reaper 未触发(keepAlive 干扰嫌疑);
  demo 真实场景日志确认 reaper 3s 正常(state=3 x3s)。
- **导航乐观转场端到端**(nav-progress-e2e.cjs):
  a 点击 → `active` ✓;无回流 → 8s 超时兜底清除 ✓;
  done 挂钩(dom-snapshot/location/nav-blocked 三处)代码级确证,
  端到端触发依赖既有导航管线(resize 不触发快照, 测试手段局限)。
  观察项: headless 合成点击(a.click)未引发源站导航(元素锚转发链路,
  既有行为, 与本次修复无关)——真机点击路径此前批次(v2ex/runoob)实测正常。
- 全量 npm test 82/82;npm run check 通过。

---

## 第 7 轮:导航回流冻结 bug 的诊断与修复(红绿闭环)

- **现象**: 点击镜像内链接 → 源站导航成功(源站日志 GET /page2)→ 镜像冻结旧页;
  合成点击路径 domclick→find→el.click 全链路通;framenavigated 触发、门控全过;
  location×2 + dom-snapshot×2 到达 client——但镜像不更新, pageerror=
  `TypeError: Cannot read properties of null (reading 'replace')` at buildMirror css2。
- **根因链**: 源站无样式表 → 首条快照 css=''(空串)→ client `if (css) lastCss=css`
  的 falsy 判断把空样式表当"没有 css"丢弃 → lastCss 保持 null → 导航后服务端
  cssSame 省略字段 → client 回退 lastCss=null → buildMirror(null).css.replace 抛
  TypeError → 整树重建中断 → 镜像冻结旧页(任何"点击导航"体感失效的直接原因)。
- **修复**(client/index.html 两处):
  ① `if (css != null) lastCss = css`——空串是合法缓存值, 与服务端 cssSame
  省略语义(省略=与上次相同)严格对齐;
  ② buildMirror 纵深 `(css || '').replace`——任何漏网路径不抛错中断重建。
- **红绿**: 修复前镜像冻结旧页+pageerror(红, 多轮复现)→ 修复后 PAGE2-MARK
  渲染 ✓ + active 进度条 ✓ + 零 pageerror ✓(绿)。
- 诊断方法沉淀: evaluateOnNewDocument 包装 WebSocket 记录 client 实收消息
  (区分"服务端没发"vs"client 收了没处理"), pageerror stack 定位抛点。

---

## 第 8 轮:会话内命令零限流的发现与修复(第一性审查批次 15)

- **审查路径**: 信任边界已审面之外的状态生命周期——static 遍历(Node parser 层
  400 拦死, 不可达, 记纵深建议)/ xframe SSRF 合谋链(crossOriginFrameOrigins
  静态白名单 + /api/sites token 闸, 双闸封死)/ pool context close 5s 超时
  慢性泄漏(记录待修)——最终命中: wsRateLimiter 只限建连, **会话内命令零限流**。
- **红实证**: 200 条合法 mode 洪发 → cmdChain 200 次全量快照串行(单次 ~2.2s),
  基线 ping 1ms → 洪发后排队 20s+(放大面: 6KB 输入 → 数分钟网关满负荷);
  enqueue 无积压上限(闭包持 raw 无界堆积)。
- **修复三件套**(server.js):
  ① 重命令滑窗限流——硬组 mode/navigate/history 3 条/2s, 软组 repaint/repair/
  fp/domclick 12 条/2s, 超出丢弃+RATE 错误; 轻命令(ping/mouse/scroll)不限;
  ② enqueue 背压 pendingCmds≥400 丢弃(防无界堆积);
  ③ **ping 旁路**——活性探测不入串行链: 原实现积压时 pong 迟到会触发服务端
  15s 协议层活性检查误杀健康会话(积压→判死, 自我强化)。
- **绿实证**: 200 mode → 4 次快照(handleCommand 级, 削减 97.7%)+ 188 条 RATE
  即时反馈 + 洪发后 ping 1ms(旁路)+ 会话存活; 正常导航回归(nav-regression)
  通过; npm test 82/82。
- **诊断教训三连**: 探针 ws.off 摘掉 pong handler 后忘重挂(三轮假阴性 -1);
  8099 端口被两个源站脚本混用(环境串扰致回归假红); 服务端"no pong 15s"
  是 WS 协议层 ping/pong 帧(ws 库自动应答)而非应用层消息。

---

## 第 9 轮:批次 16——限流合法性边界 + 会话生命周期稳定性

- **A) 合法负载回归**: 30s 真实访客行为频率(mouse 589 + scroll 59 + domclick 29
  + navigate 1)→ **RATE 零误伤** ✓——批次 15 限流参数对正常交互完全透明
- **B) 会话生命周期 × 6**: 连接→交互→销毁循环 6/6 成功, RSS [87,87,88,89,90,
  91,91,91] 末段平稳, 总增 4MB → **无慢性泄漏** ✓(pool context/快照缓存/
  会话表释放均正常回收)
- **顺带审计确认防线完好**: 下载管线(DOWNLOAD_MAX 进度中取消 + stat 前置 +
  readFile 后双检)、origin-asset-cache(shouldStore 裁决 + nosniff)、
  static 遍历(Node parser 400 拦死)、xframe SSRF(crossOriginFrameOrigins
  静态白名单 + /api/sites token 闸)
- **工程教训**: bash `cd X && 启动 & echo pid` 的 & 把 cd 连带后台化(主 shell
  未 cd)——PID 文件写错目录、探针 RSS 采错进程; demo 环境验证必须
  lsof 端口定位而非 PID 文件

---

## 第 10 轮:严苛自审——抓到批次 15 修复引入的真回归(已闭环)

- **回归**: ping 旁路(v0 批次 15 修复件③)只回 pong 不入队, 但 handleCommand
  的 ping case 有两大副作用: ①客户端 10s 心跳的 rum 性能数据落 [rum] 日志;
  ②m.fp 指纹分歧检测(v0.18 漂移自动重同步)——旁路把它们全部丢弃。
- **红**(缺陷版 git show HEAD:server.js 反转跑): [rum] 日志 0 行(3 条 rum
  ping 副作用全丢) + fp ping 洪发 20 条无限流(页内全元素统计 evaluate
  CPU 放大通道重现)。
- **修复**: ①旁路条件收紧——仅纯活性 ping(rum/fp 字段均缺省)走旁路,
  带负载 ping 走 handleCommand 完整处理; ②'ping' 加入软组限流 12/2s
  (心跳 10s 一次不受影响, 防带 fp 洪发放大)。
- **绿**: [rum] 日志 3 行(链路恢复) + fp 洪发 RATE 11(限流生效) +
  纯 ping 5ms(旁路保持)。
- **同轮其余审查结论**: lastCss 恢复路径(cachedSnap.css 可能 null →
  纵深 (css||'') 兜底, 不 crash); 背压计数器 finally 必达无泄漏;
  限流与 idle 复活/resume 交互无害; >128B ping 走队列=攻击者自损。
  **观察项**: 限流检查在出队时(队列前有慢命令时 RATE 反馈被延迟)——
  恶意场景无影响, 合法用户不触发, 记录不改(YAGNI)。

---

## 第 11 轮:整合审查——rebase 到维护者 v0.77(main 已前进)

- **风险识别**: origin/main 前进至 babcde3(v0.76 css 直通改写 + v0.77 beacon
  三联症), 双方同改 client/index.html + server.js——维护者 merge 时会踩冲突。
- **rebase 干跑 → 实解**: 14 提交仅 1 处代码冲突——代理响应体上限(5fc1c0a)
  × v0.76 css 改写入库(同 end 块)。语义合并: 超限检查优先(over→502 不进
  改写不入库) + css 改写其次 + 缓存 key 采维护者 cacheKey——两修复正交相加。
- **验证**: npm test 82/82(含 proxy-asset-limit 在新 main 依然绿)、check 通过、
  语义合并块在位、force-with-lease 推送更新 PR #68。
- **语义交集观察**: c96f3a0(维护者)修 domclick 在 snapshotReady 前被丢——
  与我们 domclick 软组限流正交(限流在命令层, 丢窗修复在 client 就绪层);
  v0.77 beacon 重构区域(快车道/双缓冲)与我们 ping/fp 旁路无代码交集。

---

## 第 12 轮:CI 修复——插桩锚点 + tarball 竞态(双根因)

- **失败 1(我们引起,已修)**: profile-server.cjs 的 enqueue 精确锚点被批次 15
  背压改造破坏 → 插桩 patch 抛错 → 语法 job 红。修复: 锚点同步新文本,
  插桩语义保留。语法 job 实测恢复绿(29s)。
- **失败 2(main 既有 flaky,测试严谨性修复)**: Docker tarball 的 frame 模式
  login-route-draft 恢复文本截尾(重试 3 轮截断点各不同 = 竞态; main run 264
  零我们提交同 step 同因 = 非我们引入)。
  根因链: frame(像素直出)字符逐键走 key 消息(23×15ms), dom 模式走整值
  同步(故不丢) → page.type 后零等待立即 reconnect → 断线 cleanup 置 dead
  → cmdChain 未派发尾部 keystroke 被 'if (dead) return' 静默丢弃 → 快照
  重放=最后一键前状态 → 截尾。
  修复: verify-recovery.cjs type 后加 400ms 排空窗口(测量恢复保真而非
  管线竞速); 恢复协议层是否需加输入排空保证留给维护者评估(根因已入档)。

---

## 第 13 轮:CI 修复闭环——双 job 全绿实证

- 锚点修复(第 12 轮)后语法 job 绿(29s);快照链消化修正(2.5s 排空覆盖
  key 派发 + +600/+1500ms 重拍兜底)后 Docker tarball 绿——**CI 双 job
  全绿实证**(此前 main 8 次运行仅 2 绿)。
- 根因链终局确认: 截断点=最后一次快照时刻(非发送缓冲/dead 丢弃)——
  400ms 发送排空无效、2.5s 快照链排空有效, 反证定位准确。

---

## 第 14 轮:整合审查二(v0.78)——维护者根治了我们的竞态目标,零冲突 rebase

- main 前进至 596aacd(PR #70 / v0.78): **6f23e88 草稿客户端持久化——F5 尾键
  在途竞态根治**(pagehide+节流两路保存,镜像重建按 id 回灌)——与我们
  7031a08 修的 tarball 竞态同源,维护者从生产语义层根治; 我们的测试侧
  排空与之互补(生产防丢 + 测试防竞速), 保留。
- rebase 干跑零冲突, 19 提交干净重放, 82/82 + check 通过, force-with-lease
  推送; CI 在 v0.78 基线实测**双绿**(语法 + Docker 全 24 步回归)。
- 小模块快审: input.js(锚点平移/iframe 坐标累加/React-Vue 原型 setter,
  语义完善)、timers.js(closed 后禁创建, 全清干净)——无问题。

---

## 第 15 轮:未审模块清零——warm-pages/frame-codec/canvas/v0.78 草稿持久化

- **warm-pages(188 行)**: 预热 context 独占(取走归访客,不跨访客共享存储)、
  yield 在线优先、坏页不入库、networkidle0 静止、TTL 清仓、键数有界
  (recentKeys 4 + inventory 键经周期 ensure 清仓)——隔离与容量纪律完整 ✓
- **frame-codec(56 行)**: PNG 手工 IHDR 判定保守正确(非标准变体走原管线);
  scanDirtyRows 依赖调用方 CH=4 与等长 raw 约束(现有调用满足, 记录);
  dirtyRects 行段合并+8 段上限 ✓
- **canvas(106 行)**: 候选三级(canvas 3/elbit 6/video 8)上限+视口过滤+
  指数退避(450ms×2^n 封顶 3600)+elbit 500ms floor ✓ 全 try/catch 兜底 ✓
- **v0.78 草稿持久化(维护者 +23 行)**: lastTyped 落盘(sessionStorage 同源
  隔离, 32 条 60s 窗)+回灌条件 dval.length>=当前值(只保长不覆盖权威;
  Enter 提交时 lastTyped.delete 使回灌自然失效)——语义闭环正确 ✓
- **结论**: 四模块零缺陷。审查覆盖至此: server.js 全部路由/命令/恢复链、
  lib 15 模块、client 关键路径(快照/输入/草稿)、CI 全链路。

---

## 第 16 轮:合并后实测——发现 v0.79-81 快照管线重大性能回归(新 bug)

- **现象(v0.81 main, ruanyifeng 真实站点)**: 5 轮冷启动实测——2 轮首访白屏
  (snapshot evaluate 10s 超时), 2 轮首帧 15-17.6s, 1 轮未知——**约 40% 首访
  严重劣化**(批次 3 时同页面快照正常 42.8KB)。
- **定位链(逐层排除)**: ①直测页内 snapshotReal 343ms ✓(页内函数不慢);
  ②CSS_PASS 直通路径 5ms ✓; ③装配序列模拟 3 连 212/6/4ms ✓(序列无锁);
  ④超时后 1+1 evaluate 1ms ✓(CDP/主线程健康); ⑤**超时后重跑同一
  snapshotReal: 11905ms 完成(html 8728B 完整)**——非死锁, 是 35 倍性能回归。
- **差异矩阵**: server 页 vs 裸页 = 双注入(warm evaluateOnNewDocument +
  sessHelpers)/__XY_ORIGIN_PREFIX__ 带路径('.../blog/' vs 纯 origin)/
  exposeFunction __xyPatch 补丁链活跃(被拦图床 error 重试 → DOM 持续变化
  → 补丁收集)——v0.79-81 的 id 账本/登记递归在该组合下主遍历成本爆炸。
- **顺带实测**: 热页 take 7.5s 龄接管 ✓/接入向导真实站点输出 Top1 ✓/
  导航白名单(畸形 URL www.127.0.0.1 被 URL 解析器拒→安全拒绝 ✓)/
  小页面首快照 125-208ms/导航回流 30ms ✓; 事件循环 p50=11ms(记录待查)。
- **修复方向建议**(留维护者/或我们后续 PR):
  ①快照超时后自动重拍(当前失败即白屏到下次交互——P0 体感);
  ②snapshotReal 与补丁/id 账本的并发成本剖析(v0.79-81 diff 为靶区);
  ③首屏管线跳过/beacon 页先例(server.js:177 有同类跳过先例可循)。

## 第 17 轮:归因修正——A/B 对照推翻"v0.79-81 回归"假设(用户质疑正确)

- **质疑**: "确定是 bug 吗?只有实测证据指向才能上报"——复核发现初版归因
  (v0.79-81 回归)只有"现象存在"证据, 无因果证据(无双版本对照, 批次 3
  的 42.8KB 无时延记录)。
- **A/B 对照实验**(同环境同窗, 冷启动, 6 轮/版本, ruanyifeng):
  v0.78(6dfc216): 3 成功(3811/4326/7001ms) + 3 失败(40s 超时)
  v0.81(5f34156): 0 成功 + 6 失败
- **修正结论**: ①"慢/挂"**v0.78 既存**, 非 v0.79-81 回归——PR #75 标题与
  描述已更正(撤回归因, 换 A/B 矩阵); ②v0.81 六连挂 vs v0.78 三连挂不下
  结论(样本不足, 未控站点时段/机器负载); ③机制层发现保留: snapshotReal
  evaluate 随机性暴涨至 12s 量级(非死锁, 重跑可过), 关联被拦图床导致的
  DOM 持续变化+补丁链活跃。
- **过程教训**: 探针 require 解析基于脚本路径(/tmp 下找不到 ws)致首轮
  A/B 空跑; PR 归因必须在对照实验之后——"现象→归因"顺序不可颠倒。

---

## 第 18 轮:快照挂起深潜——本地复现未果,按纪律停(12+ 实验全记录)

- **目标**: 把 PR #75 的可靠性问题复现率提至 100%(变量可控)以定位根因。
- **构造实验**: 本地复现页(2000 节点大 DOM + 150ms 持续变化 + 30 张被拦
  外域图)× server 真实装配——**3 轮全绿(153-356ms)**——DOM 规模/拦截器/
  持续变化均排除。
- **30s 阈值实锤**: 挂起实为"10.6s 慢被 10s 阈值击穿"(30s 上限下完整完成,
  第二拍 17ms 飞快)——非死挂。
- **表达式形态绕行实验**(callFunctionOn → Runtime.evaluate): 轮 1 7.7s 完成
  但轮 2-4 仍超时——**无效,已回滚**(无证据的改动不入库)。
- **带路径 origin 前缀 ×3 轮**: 208/227/381ms 全绿——排除。
- **残差**: 仅"外网真实站点 + server 全装配"复现; 本地可控复现未果
  (外网站点内容/网络行为不可本地化)——**回路无法紧化, 按诊断纪律停**,
  根因最后一层(为何外网站点+全装配时 evaluate 随机 10-22s)留维护者
  在其服务器环境深查。
- **已尝试清单**: 直测页内/直通路径/装配模拟/双注入/带路径前缀/拦截器/
  被拦图片/持续变化/大 DOM/exposeFunction/表达式形态/30s 阈值/1+1 探针/
  raw CDP 对照/页内计时包装/字段长度审计/并发探针——**17 项**。
