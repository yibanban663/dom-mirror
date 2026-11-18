// lib/skp-watcher.js — 补丁 Chrome 的 skp dump 目录消费器
// 监听 XY_SKP_DUMP_DIR 目录，新 .skp 文件出现时读取并回调（引擎 WS 下发用）
'use strict';
const fs = require('fs');
const path = require('path');

function createSkpWatcher(dir, { logger = () => {} } = {}) {
  const callbacks = [];
  const seen = new Set();
  let watching = false;

  function on(event, cb) {
    if (event === 'layer') callbacks.push(cb);
  }

  function scan() {
    let files;
    try { files = fs.readdirSync(dir); } catch { return; }
    for (const f of files) {
      if (!f.endsWith('.skp') || seen.has(f)) continue;
      seen.add(f);
      try {
        const buf = fs.readFileSync(path.join(dir, f));
        if (buf.length < 50) continue;
        // 文件名: x_y_w_h_id.skp
        const m = f.replace('.skp', '').split('_');
        const rect = m.length >= 4 ? m.slice(0, 4).map(Number) : [0, 0, 0, 0];
        const layer = { rect, skpBase64: buf.toString('base64'), bytes: buf.length, file: f };
        for (const cb of callbacks) cb(layer);
      } catch (e) { logger('[skp-watch] read err:', f, e.message); }
    }
  }

  function start() {
    if (watching) return;
    watching = true;
    scan();
    // 轮询 200ms（fs.watch 对新文件不可靠）
    this._timer = setInterval(scan, 200);
    logger('[skp-watch] watching', dir);
  }

  function stop() {
    if (this._timer) clearInterval(this._timer);
    watching = false;
  }

  return { on, start, stop, scan };
}

module.exports = { createSkpWatcher };
