# 阶段 1（进程经济）差距审计 · 2026-11-20

> 依据 `docs/roadmap-dom.md` 阶段 1 验收项，对现行代码（feat/rbi-dom, dd9dbc8）逐条核对。
> 结论先行：**四项里两项已在上游实现、一项基建就绪但默认关闭、一项不存在于现行代码**。
> 真正的工作是"部署配置激活 + 运行时验收"，不是从零造。

## 逐项核对

| 验收项 | 现状 | 证据 |
|---|---|---|
| 首屏不等 networkidle0 | ✅ **已实现（v0.31）** | `server.js:3261` "DCL 即开流"；所有 `page.goto` 均 `waitUntil:'domcontentloaded'` |
| 同源共壳 + 每访客 Context | ✅ **已实现（v0.30 实例池）** | `lib/browser-pool.js`：`browserPoolSize`(默认2) + `browserPoolTenants`(默认4) 多租户共享，租户即独立 BrowserContext |
| 空闲零 Chromium | 🟡 **基建就绪，默认关闭** | `browserPoolHibernateMs` 默认 0 → 池只回收超额实例（>size 且闲置≥120s），基线 2 个常驻；启用后 `browser.close()` 真退进程（`browser-pool.js:52-55`）。配套 `sessionIdleEvictMs`(默认0) 空闲页逐出+复活（v0.39，`server.js:1013-1111`） |
| 去掉断线占位 60 秒 | ⚪ **现行代码无此物** | 全库检索"占位/placeholder"：仅瓦片占位、iframe 回退、输入草稿窗(v0.78 `client:443`，60s 为草稿有效期)。推测该验收项来自旧版本行为，已在上游演进中消失 |

## 缺口与动作

1. **部署配置激活**（本提交给出推荐值，改 `.env` 生效）：
   - `BROWSER_POOL_HIBERNATE_MS=180000`（3 分钟无租户 → 关浏览器进程，空闲 Chromium 归零）
   - `SESSION_IDLE_EVICT_MS=300000`（5 分钟无操作 → 逐出页面，进程瘦身；复活路径 v0.39 已有）
2. **运行时验收**（需引擎在线后执行，记录进看板）：
   - 空闲 5 分钟后宿主 Chromium 进程数 = 0
   - 同源第二会话不新增浏览器壳（池 tenants 计数）
   - **跨访客 renderer 进程隔离实测（一票否决项）**：两 BrowserContext 同源各开页，核对 renderer PID 不相同；若共享，回退为同源第二访客独立实例（部分放弃省壳收益）
3. **多标签限制**：roadmap"禁止同上下文多标签"——池模型按会话=1 页设计，需在验收中确认无多页路径泄漏。

## 风险记录

- 休眠/逐出默认值改动会影响所有部署（冷启动首屏延迟 +1~2s 进程启动），故以部署配置而非代码默认值激活。
- 复活（revive）路径在 v0.39 后经过 v0.65 演进，激活前需在 186 灰度一轮。
