# 第十八轮驻留增长：离线归因线索与观测器减留存

本轮只分析上一轮冻结的[三十轮 jemalloc 原始证据](2026-10-26-jemalloc-candidate.md)，并补诊断工具。**没有运行新的浏览器工作负载，没有测得内存改善，原正常回收预算仍为 17/30 轮通过。** 本轮也不将 V8 扩容直接命名为泄漏或最终根因。

## 现有证据

以下值来自每个正常 postIdle checkpoint，单位 MiB。V8 physical 是同一 checkpoint 的 heap-space `physical_space_size` 之和；heap capacity 是 Node `heapTotal`，不能将容量当作 RSS。

| 轮次 | 匿名增长（较启动） | V8 physical | heap used | heap capacity | jemalloc resident |
| --- | ---: | ---: | ---: | ---: | ---: |
| 16 | 63.96 | 37.52 | 28.67 | 42.32 | 39.76 |
| 17 | 58.01 | 37.26 | 24.24 | 56.02 | 36.58 |
| 18 | 68.45 | 48.06 | 29.43 | 59.41 | 39.29 |
| 19 | 73.94 | 52.73 | 29.59 | 59.16 | 38.78 |
| 20 | 71.22 | 50.09 | 24.64 | 88.27 | 36.87 |
| 30 | 78.17 | 60.74 | 26.84 | 90.63 | 36.11 |

第 17→18 轮匿名内存增加 10.44MiB，V8 physical 增加 10.80MiB，jemalloc resident 增加 2.71MiB；第 18→19 轮匿名增加 5.49MiB，V8 physical 增加 4.67MiB，jemalloc resident 反而下降 0.51MiB。因此 **V8 heap 的扩容/驻留应优先调查**；不能只归结为 jemalloc 活跃分配不断堆积。V8 和 allocator 统计可能重叠，以上相关变化不允许直接相加、相减推导所有者。

第 20 轮 heap capacity 扩至 88.27MiB，末轮 90.63MiB，但末轮 heap used 只有 26.84MiB。全部正常 checkpoint 的 Node native contexts 均为 1；这没有显示该计数持续增长，但不排除 JS 引用、原生引用或 allocator/映射保留问题，也不是源站 Chromium context 数量。

正常轮次没有强制 GC。17→18 与 18→19 区间各观测到 65 个 GC 事件；GC 类型、存活对象与独立映射仍需进一步证据，事件多不意味着已完成完整回收。末尾 GC 与后续空闲使匿名内存最终降到 93.54MiB，仍不能解释全部剩余驻留。

原观测器保留 2642 条 sample、184 个 checkpoint、1891 条 GC 记录、90 个浏览器标量记录，其中 checkpoint 还带有逐步增长的浏览器状态数组。它们是确定存在的观测器留存，**记录数量不等于驻留字节数**，目前没有证据将其认定为全部增长的原因。原试验没有第 18 轮完整 smaps 或分配调用栈，无法事后补造它们。

[离线机器汇总](2026-10-26-memory-growth-summary.json)包含完整三十轮相关量、相邻变化、末尾诊断、输入 SHA-256 与测量源码摘要。原始试验数据与原报告保持不变。

## 新增观测方式

`MEMORY_TRACE_STORAGE=disk` 让服务端 sample、checkpoint、GC 记录立即写入独立 JSONL，不在 trace 数组中累计保留；`server.json` 保存记录计数与空数组。默认 `memory` 保留旧测量方式。汇总器离线读取落盘记录，并要求记录数准确，发现截断、缺失、未知模式或混合留存就失败。

落盘模式仍会产生临时采样、序列化对象和同步 I/O，也保留源站浏览器的标量状态；它不是零开销或完全恒定内存的观测器。普通 sample 落盘时不包含随后才采集的原生统计，完整 native/V8 数据在 checkpoint 中保存；两种模式的验收指标以相同 checkpoint 字段计算。

`MEMORY_MAP_CYCLES=16,17,18,19,20` 在指定轮次的 postIdle 额外保存完整 smaps/V8 快照；baseline、末轮及 finalSettled 原有快照继续保留。runner 在运行前将存储方式、快照轮次与新增 helper 的源码摘要写入不可覆盖计划；汇总器还检查约定快照文件存在且非空。此项仍是区段定位，**没有新增分配调用栈采集**。

这两项只影响独立诊断工具，不修改包入口、引擎、GC/cache 默认策略或原 64MiB 预算。新旧测量工具摘要不同；新模式必须与同一版工具下的 memory 模式做配对，不可直接拿旧结果减新结果宣称优化收益。

## 验证与复现

本轮 29 项 Node 测试通过；新增回归检查落盘后不保留 trace 行、完整读回、丢失/截断记录拒绝、既有证据兼容和配置校验。使用原始三十轮数据重编码为 memory/disk 两种存储，汇总的全部验收指标相同，丢失一条 sample 的负对照失败。该验证只检查存储/汇总兼容，**不代表新宿主已完成浏览器验收或实际降低 RSS**。

离线分析（只读输入，拒绝覆盖输出）：

```bash
node tools/analyze-memory-growth.cjs /path/to/jemalloc-thirty/default /path/to/new-growth-analysis.json
```

后续长测的命令已准备，本轮遵循仓库不启动后台长进程的约定，未执行。先用当前源码重新构建诊断镜像，再使用两个不同的 evidence 目录，固定相同镜像、allocator、负载和快照轮次，只改变 trace storage：

```bash
docker build -t dom-mirror:local .
docker build -f tools/Dockerfile.allocator --build-arg BASE_IMAGE=dom-mirror:local \
  -t dom-mirror:growth-diagnostic .

MEMORY_TRACE_STORAGE=memory MEMORY_MAP_CYCLES=16,17,18,19,20 \
  IMAGE=dom-mirror:growth-diagnostic EVIDENCE_DIR="$PWD/artifacts/growth/memory" \
  bash tools/run-jemalloc-long.sh
MEMORY_TRACE_STORAGE=disk MEMORY_MAP_CYCLES=16,17,18,19,20 \
  IMAGE=dom-mirror:growth-diagnostic EVIDENCE_DIR="$PWD/artifacts/growth/disk" \
  bash tools/run-jemalloc-long.sh
```

运行顺序与宿主负载会混杂结果；单次配对只作为定位线索，必要时反序重复。若 disk 模式仍有同类增长，应再针对变化的映射补 V8/原生分配生命周期证据；若明显下降，也须复验后才判断观测器的影响。不启用定时 GC，不切换包默认 allocator，不提前引入 Rust/Wasm。
