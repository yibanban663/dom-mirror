# dom-mirror 测试指南

本仓库的测试分两层:**单元/集成测试**(`node:test`,本目录,可在 CI 无浏览器环境运行)与**端到端 harness**(`realtest/`,需系统 Chrome,验证完整镜像链路)。两者互补:单测锁纯函数与协议行为,端到端锁真实浏览器管线。

## 运行方式

```bash
npm test          # 全量 node:test(当前 85 用例)
npm run check     # 语法门:全部 JS + 注入脚本 + fixtures 编译检查
node --test test/rate-limit.test.js   # 单文件
```

端到端 harness(需系统 Chrome):

```bash
cd realtest
node clean-audit.cjs              # 端到端清洗审计(恶意载荷 → 镜像断言)
./run-bisect.sh "1,2"             # 载荷二分 harness(卡死定位)
node matrix-proxy.cjs             # 代理大资产内存矩阵(修复前/后对照)
node red-errmsg.cjs               # WS 错误消息透传断言
```

---

## 一、单元/集成测试清单(test/)

| 文件 | 用例数 | 覆盖 |
|---|---|---|
| revocation.test.js | 14 | 会话撤销/令牌轮换/scope 绑定/宽限语义/浏览器清理 |
| sessions.test.js | 7 | SessionStore:claim/rotate/宽限逐出/上限 |
| uploads.test.js | 8 | 上传状态机:分块/预算/过期/重复 id |
| uploads-defense.test.js | 3 | **纵深分层**:模块级拒路径穿越/空名/超 255 字节 |
| policy-report.test.js | 4 | **接入向导**:被拦资源域收集/排序/单行化/topN |
| policy.test.js | 6 | URL 白名单:通配/公共后缀拒绝/凭据拒绝 |
| proxy-asset-limit.test.js | 1 | **代理响应体 4MB 上限**(200MB 上游 → 502 且 RSS 平稳) |
| rum-log.test.js | 2 | **/rum 日志注入防线**:CRLF 单行化 + 跨源/无来源 403 |
| rate-limit.test.js | 2 | **限流双闸**:全局独立于 per-IP 开关 + per-IP 无回归 |
| subpath-proxy.test.js | 2 | 子路径源站解析(无双拼)+ HTML 403 锁定 |
| frame-codec / canvas / xframe / options / static / timers / browser-pool / warm-pages / identity / memory-trace 等 | 其余 | 各模块单元行为 |

合计 **85 用例**(随修复持续增长)。

---

## 二、端到端 harness(realtest/)

| harness | 验证内容 | 红信号 |
|---|---|---|
| run-bisect.sh + bisect-probe.cjs | 载荷二分:含 alert 载荷 → 会话必须就绪(dialog 修复回归) | 18s 未 sync-ready |
| clean-audit.cjs | 恶意载荷清洗:script/on*/javascript:/meta/秘密值 全零断言 | 任一非零 |
| red-errmsg.cjs | WS 错误消息不透传 CDP 细节 | 消息含 "Protocol error" |
| matrix-proxy.cjs | 代理大资产内存:200MB 上游 → 502 且 RSS 有界 | RSS 增长 >50MB |
| adv11-deeplink.cjs | 深链 20 向量:源站零跨域触达 | 跨源命中 |

---

## 三、方法论:反转验证(修复真实性证明)

**每个安全/功能修复都必须通过"反转验证"**:临时把源文件恢复到修复前版本 → 对应测试必须**变红** → 恢复修复 → **变绿**。这证明测试真的捕捉 bug,而非恒绿假测试。

`realtest/reversal-matrix.cjs` 自动化了这个流程(对 4 项核心修复批量执行)。

**红绿记录表**(全部实测存档,证据见 TESTLOG.md):

| 修复 | 修复前(反转) | 修复后 |
|---|---|---|
| 限流连坐(全局阈值 1) | fail 1(per-IP=0 时 2 连接全放行) | pass 2(第 2 连接 429) |
| 代理响应体上限(200MB 上游) | **RSS +495.0MB**,断言失败 | pass 1(502,RSS+22MB) |
| /rum 日志注入(CRLF) | fail 1(日志行含内嵌换行) | pass 2 |
| uploads 纵深(穿越/超长名) | fail 2(穿越名被接受) | pass 3(合法名 3/3 绿) |
| meta content 清洗(端到端) | 镜像 meta 残留 javascript: 载荷 | 无残留,弹窗 0 |
| 弹窗冻结 DoS(端到端) | alert 载荷 18s+ 永不就绪(×2) | 就绪(×2) |
| WS 错误消息透传(端到端) | 错误含 "Protocol error (Input.dispatchMouseEvent)" | 通用文案 |

---

## 四、seam 说明(诚实记录)

部分引擎逻辑位于**页内注入函数**(sanitizeClone/快照/补丁采集)与**闭包巨石函数**(runSession 的限流器/wsRateLimiter)内,无法用 node:test 直接锁定——这类修复的回归走端到端 harness。已知的 seam 缺失清单:

1. 限流器(wsRateLimiter)/ cmdChain——闭包私有
2. 快照管线(snapshotReal/sanitizeClone)——页内函数(端到端可测)
3. dialog 处理——已由 run-bisect.sh 端到端锁定

**长期解法**:refactor/split-server 分支的拆分方向(限流器/补丁管线提取为 lib 可测模块)落地后,上述端到端回归应逐个下沉为单测。

---

## 五、CI

`.github/workflows/ci.yml`:PR 触发 `npm run check` + `npm test`(900s 超时,`--test-force-exit`)。端到端 harness 目前**不在 CI**(需系统 Chrome)——列为后续改进(P0:回归护城河,见 TESTLOG 第 3 轮)。
