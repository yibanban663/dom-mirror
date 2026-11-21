// DL A-route bridge: env-gated (XY_A_ROUTE=1) — spawns patched headless_shell on the
// session URL with XY_SKP_DUMP_DIR, watches dumps, pushes {type:'skp',b64} via cb.
// Follows session URL changes (nav) by re-navigating the shell via CDP.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

function createSkpBridge({ shellPath, logger = () => {} }) {
  const on = process.env.XY_A_ROUTE === '1';
  let proc = null;
  let dumpDir = null;
  let pollT = null;
  let navT = null;
  let sendFn = null;
  let url = null;
  let dbgPort = 0;
  let stopped = true;
  let lastSent = 0;
  let sendCount = 0;
  let oversizeStreak = 0;

  function send(obj) { if (sendFn) sendFn(obj); }

  function spawnShell() {
    if (proc) { try { proc.kill('SIGKILL'); } catch (e) {} proc = null; }
    dumpDir = '/tmp/xy-skpa-' + Date.now();
    fs.rmSync(dumpDir, { recursive: true, force: true });
    fs.mkdirSync(dumpDir, { recursive: true });
    const args = ['--no-sandbox', '--disable-gpu', '--window-size=1600,900'];
    if (dbgPort) args.push('--remote-debugging-port=' + dbgPort);
    args.push(url);
    proc = spawn(shellPath, args, { env: { ...process.env, XY_SKP_DUMP_DIR: dumpDir } });
    logger('[skp-bridge] shell pid=' + proc.pid + ' url=' + url);
    proc.on('exit', (c) => { if (!stopped) logger('[skp-bridge] shell exit ' + c); });
  }

  function sendLatest() {
    let files;
    try {
      files = fs.readdirSync(dumpDir).filter(f => f.endsWith('.skp')).map(f => {
        const st = fs.statSync(path.join(dumpDir, f));
        return { f, m: st.mtimeMs };
      }).sort((a, b) => a.m - b.m);
    } catch (e) { return; }
    if (!files.length) return;
    const newest = files[files.length - 1];
    const now = Date.now();
    if (now - lastSent < 300) return;  // ≤3.3 skp/s cap
    if (newest.sz > 4 * 1024 * 1024) {
      oversizeStreak++;
      if (oversizeStreak >= 4 && !stopped) {
        logger('[skp-bridge] frames >4MB x' + oversizeStreak + ' — page too heavy for whole-frame A-route v1, stopping bridge');
        stopped = true;
        if (pollT) clearInterval(pollT);
        if (navT) clearInterval(navT);
        if (proc) { try { proc.kill('SIGKILL'); } catch (e) {} }
      }
      return;
    }
    oversizeStreak = 0;
    // cleanup: keep newest 2 (Finalize 每帧落盘，防 cgroup 堆积)
    for (let i = 0; i < files.length - 2; i++) {
      try { fs.unlinkSync(path.join(dumpDir, files[i].f)); } catch (e) {}
    }
    try {
      const b64 = fs.readFileSync(path.join(dumpDir, newest.f)).toString('base64');
      lastSent = now;
      sendCount++;
      send({ type: 'skp', b64, n: sendCount });
    } catch (e) { logger('[skp-bridge] read err ' + e.message); }
  }

  function cdpNav() {
    // follow session URL changes: /json/list → page target → navigate
    http.get({ host: '127.0.0.1', port: dbgPort, path: '/json/list' }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const targets = JSON.parse(d).filter(t => t.type === 'page');
          if (!targets.length) return;
          const cur = targets[0].url;
          if (url && cur !== url && !cur.startsWith('devtools')) {
            logger('[skp-bridge] nav follow -> ' + url);
            http.get({ host: '127.0.0.1', port: dbgPort, path: '/json/new?' + encodeURIComponent(url) }, () => {}).on('close', () => {
              // close extra tabs beyond first page target
              http.get({ host: '127.0.0.1', port: dbgPort, path: '/json/list' }, (r2) => {
                let d2 = '';
                r2.on('data', c => d2 += c);
                r2.on('end', () => {
                  try {
                    const ts = JSON.parse(d2).filter(t => t.type === 'page');
                    for (const t of ts.slice(1)) http.get({ host: '127.0.0.1', port: dbgPort, path: '/json/close/' + t.id }, () => {});
                  } catch (e) {}
                });
              });
            });
          }
        } catch (e) {}
      });
    }).on('error', () => {});
  }

  return {
    get enabled() { return on; },
    start(sessionUrl, sender) {
      if (!on) { logger('[skp-bridge] disabled (XY_A_ROUTE!=1)'); return false; }
      sendFn = sender;
      url = sessionUrl;
      dbgPort = 9333;
      stopped = false;
      spawnShell();
      pollT = setInterval(sendLatest, 300);
      navT = setInterval(cdpNav, 2000);
      logger('[skp-bridge] started');
      return true;
    },
    setUrl(u) { url = u; },
    stop() {
      stopped = true;
      if (pollT) clearInterval(pollT);
      if (navT) clearInterval(navT);
      if (proc) { try { proc.kill('SIGKILL'); } catch (e) {} proc = null; }
      if (dumpDir) { try { fs.rmSync(dumpDir, { recursive: true, force: true }); } catch (e) {} }
      logger('[skp-bridge] stopped');
    },
  };
}

module.exports = { createSkpBridge };
