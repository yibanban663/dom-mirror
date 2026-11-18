// lib/skp-stream.js — B 路线核心：从 Chromium 抓取 SkPicture 流（导航期全量+脏层增量）
// 已验证：cc.debug.picture → skp64（SkPicture 二进制），CanvasKit 可无损重放
'use strict';

const fs = require('fs');
const path = require('path');

// SkpStream：挂在一个 Puppeteer Page 上，收集所有 DisplayItemList:snapshot 事件
// 用法：
//   const skp = createSkpStream(page);
//   await skp.start();           // 开 tracing
//   await page.goto(url);        // 导航（首次绘制全量）
//   const layers = skp.layers(); // Map<rectKey, {skp64, rect}>
//   skp.drain();                 // 取走新层并清空标记
//   skp.stop();                  // 停 tracing
function createSkpStream(page, { logger = () => {} } = {}) {
  let session = null;
  let tracing = false;
  const events = [];       // 原始 snapshot 事件
  const layerMap = new Map(); // rectKey -> {skp64, rect, updatedAt}
  let newCount = 0;        // 自上次 drain 以来新/更新的层数

  async function start() {
    if (tracing) return;
    session = session || await page.target().createCDPSession();
    if (!session._xySkpHooked) {
      session.on('Tracing.dataCollected', (d) => {
        if (!d.value) return;
        for (const ev of d.value) {
          if (ev.name !== 'cc::DisplayItemList:snapshot') continue;
          const snap = ev.args && ev.args.snapshot;
          if (!snap || !snap.skp64) continue;
          const rect = (snap.params && snap.params.layer_rect) || [0, 0, 0, 0];
          const key = rect.join('x');
          const bytes = Math.round(snap.skp64.length * 3 / 4);
          // 同层取最大版本（内容最全）
          const prev = layerMap.get(key);
          if (!prev || snap.skp64.length > prev.skp64.length) {
            layerMap.set(key, { skp64: snap.skp64, rect, bytes });
            newCount++;
          }
        }
      });
      session._xySkpHooked = true;
    }
    await session.send('Tracing.start', {
      transferMode: 'ReportEvents',
      categories: 'disabled-by-default-cc.debug.picture'
    }).catch(e => logger('[skp] tracing start:', e.message));
    tracing = true;
  }

  async function stop() {
    if (!tracing || !session) return;
    await session.send('Tracing.end').catch(() => {});
    tracing = false;
  }

  function layers() { return layerMap; }

  function drain() {
    const out = [];
    for (const [key, l] of layerMap) {
      if (l._dirty) { out.push(l); l._dirty = false; }
    }
    // 简化：drain 返回全部层（当前层总量小）
    const all = [...layerMap.values()];
    newCount = 0;
    return all;
  }

  function stats() {
    let totalB = 0;
    for (const l of layerMap.values()) totalB += l.bytes;
    return { layers: layerMap.size, totalKB: +(totalB / 1024).toFixed(1), newCount };
  }

  return { start, stop, layers, drain, stats };
}

module.exports = { createSkpStream };
