# Chromium PaintOp 全量导出补丁 — 构建与使用指南

## 补丁内容

`chromium_paintop_export.patch` — 约 80 行 C++，打在 Chromium 156 源码的 `src/cc/paint/display_item_list.cc`。

**原理**：`DisplayItemList::Finalize()` 是 Chromium 所有显示列表的必经点（首屏/静默层/变更层全经过）。在这里把 `PaintOpBuffer` 录制为 `SkPicture` 并序列化落盘。

**零开销设计**：不设环境变量 `XY_SKP_DUMP_DIR` 时不执行任何额外代码（一个 bool 判断）。

## 构建（信创/标准 x86_64）

```bash
# 1) 拉源码（156 分支）
fetch chromium
cd src && git checkout 156.0.8078.47
gclient sync

# 2) 打补丁
git apply /path/to/chromium_paintop_export.patch

# 3) 构建（约 2-4 小时，信创用对应工具链）
gn gen out/Release --args='is_official_build=false is_debug=false'
autoninja -C out/Release chrome

# 4) 产物
out/Release/chrome
```

## 使用

```bash
# 启动打补丁的 Chrome（skp 导出开启）
XY_SKP_DUMP_DIR=/tmp/skp ./chrome --headless --no-sandbox \
  --remote-debugging-port=9222 http://10.1.1.192/

# /tmp/skp/ 下会产出：
#   0x0x1280x720_1.skp    ← 整页层
#   0x0x800x91_2.skp      ← 顶栏层
#   0x0x400x300_3.skp     ← hero区层
#   ...
```

## 引擎消费（dom-mirror 接入）

```javascript
// server.js 中
const { createSkpWatcher } = require('./lib/skp-watcher');

// 启动打补丁的 Chrome，指定 dump 目录
const skp = createSkpWatcher('/tmp/skp');
skp.on('layer', (layer) => {
  // layer = { rect: [x,y,w,h], skpBase64: '...', bytes: 502 }
  // → 下发 WS 帧 {type:'skp', rect, data: skpBase64}
  ws.send(JSON.stringify({ type: 'skp', rect: layer.rect, data: layer.skpBase64 }));
});

// 客户端（CanvasKit）
// skp 帧 → CK.MakePicture(base64ToBuffer(data)) → canvas.drawPicture(pic)
// → 100% 无损重放（浏览器本人的绘制命令）
```

## 预期指标

| 指标 | 一代（现状） | 二代（本补丁） |
|---|---|---|
| 保真度 | ~90%（手工近似） | **~100%**（浏览器本人指令） |
| 服务端成本 | 0.5-2s/拍（DOM 查询） | **~0**（本来就要生成） |
| 帧率 | 0.3-0.5 fps | **可 60fps**（每次重绘都有） |
| 带宽 | 49-281 KB/帧 | **几 KB/层**（矢量指令） |
| 分辨率 | 无关 | **无关**（Skia 重光栅） |

## 版本绑定风险与信创优势

| 风险 | 影响 | 缓解 |
|---|---|---|
| Chromium 4 周一版，PaintOp 内部会变 | 补丁可能需要跟进 | **信创环境锁版本**（不联网升级），一次打版长期稳定 |
| Skia 序列化格式跨版本不兼容 | 客户端 CanvasKit 需匹配 | 固定 CanvasKit 版本 = 固定 Skia 版本 |
| fork 维护成本 | 每次升级需重打补丁 | 补丁只动 1 个文件 80 行，rebase 成本极低 |

**大厂不走这条路是因为 SaaS 必须多版本兼容；信创锁版本交付，恰好化解此风险。**
