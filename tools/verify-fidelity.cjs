'use strict';
// v0.75 布局指纹对账回归（FIDELITY_MODE=ok|trap）
//  ok 模式（健康引擎）：
//   F1. 快照锚点充足 → fp-req 到达（ids ≥6）
//   F2. 按快照内联尺寸回执 → 服务端判通过：8s 内无 mode:frame、无第二次 fp-req
//   F3. style 属性内联背景图 url() 已改写为 /m 代理（v0.75 改写补漏）
//  trap 模式（XY_FIDELITY_TRAP=1 引擎 + 垃圾回执）：
//   F4. 两败 → {type:'mode',mode:'frame'}；连续 3 个会话各降级一次
//   F5. 同源站 3 次降级后第 4 会话直接 frame 起步，且不再下发 fp-req
const fs = require('node:fs');
const WebSocket = require('ws');

function session(baseUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(baseUrl.replace(/^http/, 'ws').replace(/\/+$/, '') + '/ws');
    const q = [];
    const waiters = [];
    let opened = false;
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('ws open timeout')); }, 45000);
    ws.on('open', () => {
      opened = true;
      resolve({
        send: (o) => ws.send(JSON.stringify(o)),
        wait: (pred, ttl, label) => new Promise((res, rej) => {
          const i = q.findIndex(pred);
          if (i >= 0) return res(q.splice(i, 1)[0]);
          const t = setTimeout(() => {
            const k = waiters.indexOf(w);
            if (k >= 0) waiters.splice(k, 1);
            rej(new Error('wait ' + label + ' timeout'));
          }, ttl || 20000);
          const w = { pred, res: (m) => { clearTimeout(t); res(m); } };
          waiters.push(w);
        }),
        close: () => { clearTimeout(timer); try { ws.close(); } catch {} },
      });
    });
    ws.on('message', (raw) => {
      let j = null;
      try { j = JSON.parse(raw.toString()); } catch { return; }
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].pred(j)) { waiters[i].res(j); waiters.splice(i, 1); return; }
      }
      q.push(j);
    });
    ws.on('error', (e) => { if (!opened) { clearTimeout(timer); reject(e); } });
  });
}

// 从快照 html 建 id→(w,h)：fixture 全部 box-sizing:border-box、无 padding/border
// → getBoundingClientRect == 内联 px 尺寸（属性顺序无关匹配）
function dimsFromSnapshot(html) {
  const dim = new Map();
  for (const t of String(html || '').matchAll(/<[a-zA-Z][^>]*>/g)) {
    const tag = t[0];
    const idm = /data-xy-id="(\d+)"/.exec(tag);
    const sm = /style="([^"]*)"/.exec(tag);
    if (!idm || !sm) continue;
    const w = /width:\s*(\d+(?:\.\d+)?)px/.exec(sm[1]);
    const h = /height:\s*(\d+(?:\.\d+)?)px/.exec(sm[1]);
    if (w && h) dim.set(+idm[1], { w: Math.round(+w[1]), h: Math.round(+h[1]) });
  }
  return dim;
}

async function main() {
  const mirror = process.env.MIRROR_URL;
  const mode = process.env.FIDELITY_MODE || 'ok';
  if (!mirror) throw new Error('Set MIRROR_URL');
  const output = process.env.EVIDENCE_DIR;
  if (output) fs.mkdirSync(output, { recursive: true });
  const results = { pass: false, mode };

  if (mode === 'ok') {
    const s = await session(mirror);
    await s.send({ type: 'hello', dpr: 1, w: 1280, h: 800 });
    const snap = await s.wait((j) => j.type === 'dom-snapshot', 30000, 'snapshot');
    results.F3_inline_style_proxy = /url\(['"]?\/m\/img\.png['"]?\)/.test(snap.html || '');
    const fpReq = await s.wait((j) => j.type === 'fp-req', 15000, 'fp-req');
    results.F1_fp_req = Array.isArray(fpReq.ids) && fpReq.ids.length >= 6;
    const dim = dimsFromSnapshot(snap.html);
    const samples = fpReq.ids.filter((id) => dim.has(id)).map((id) => ({ id, w: dim.get(id).w, h: dim.get(id).h }));
    results.F2_known_samples = samples.length >= 6;
    if (results.F2_known_samples) {
      await s.send({ type: 'fp', seq: fpReq.seq, samples });
      let bad = null;
      try { bad = await s.wait((j) => (j.type === 'mode' && j.mode === 'frame') || j.type === 'fp-req', 8000, 'no-downgrade'); } catch (e) {}
      results.F2_no_downgrade = !bad;
    }
    s.close();
  } else {
    // trap：3 会话各降级一次 → 第 4 会话 cooldown 直达 frame
    for (let round = 1; round <= 3; round++) {
      const s = await session(mirror);
      await s.send({ type: 'hello', dpr: 1, w: 1280, h: 800 });
      await s.wait((j) => j.type === 'dom-snapshot', 30000, 'snap#' + round);
      const fp1 = await s.wait((j) => j.type === 'fp-req', 15000, 'fp-req#' + round);
      await s.send({ type: 'fp', seq: fp1.seq, samples: fp1.ids.map((id) => ({ id, w: 999, h: 999 })) });
      const fp2 = await s.wait((j) => j.type === 'fp-req' && j.seq !== fp1.seq, 15000, 'fp-req2#' + round);
      await s.send({ type: 'fp', seq: fp2.seq, samples: fp2.ids.map((id) => ({ id, w: 999, h: 999 })) });
      const md = await s.wait((j) => j.type === 'mode' && j.mode === 'frame', 20000, 'mode-frame#' + round);
      results['F4_downgrade_' + round] = !!md;
      s.close();
    }
    const s4 = await session(mirror);
    await s4.send({ type: 'hello', dpr: 1, w: 1280, h: 800 });
    await s4.wait((j) => j.type === 'dom-snapshot', 30000, 'snap#4');
    const md4 = await s4.wait((j) => j.type === 'mode' && j.mode === 'frame', 15000, 'mode-frame#4');
    results.F5_cooldown_frame = !!md4;
    let lateFp = null;
    try { lateFp = await s4.wait((j) => j.type === 'fp-req', 4000, 'no-fp#4'); } catch (e) {}
    results.F5_no_fp_req = !lateFp;
    s4.close();
  }

  const need = mode === 'ok'
    ? ['F1_fp_req', 'F2_known_samples', 'F2_no_downgrade', 'F3_inline_style_proxy']
    : ['F4_downgrade_1', 'F4_downgrade_2', 'F4_downgrade_3', 'F5_cooldown_frame', 'F5_no_fp_req'];
  results.pass = need.every((k) => results[k] === true);
  if (output) fs.writeFileSync(output + '/fidelity-results.json', JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
  if (!results.pass) { console.error('FIDELITY-VERIFY-FAIL'); process.exit(1); }
  console.log('FIDELITY-VERIFY-PASS');
}

main().catch((e) => { console.error('FAIL', e && e.message); process.exit(1); });
