'use strict';
// v0.16 三症状回归：CSS url() 代理改写 / 多源会话 / 快照同内容去重
//  A. 缺省源站会话：快照 css 中相对 url(font.woff2) 改写为短式 /m/font.woff2，
//     经网关代理取回缺省源站字节。
//  B. x-rbi-origin 白名单源（origin-b）：css 改写为 /m/o/<b64url(origin)>/font.woff2，
//     代理按该段路由到 origin-b（取回 origin-b 字节，而非缺省源站）。
//  C. 未白名单 x-rbi-origin：WS 升级被 403 拒绝。
//  D. 浏览器端：级联顺序（运行时 <style> 覆盖 <link>）不被拼接顺序翻转；
//     背景图/字体 URL 走 /m 代理可取回；同页导航触发服务端 3 次相同快照，
//     客户端整树重建 ≤1 次（"页面像刷新 3 次"回归）。

const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
const puppeteer = require('puppeteer');

const b64url = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// —— WS 会话探测：带自定义头连 /ws，收第一条 dom-snapshot（或连接被拒） ——
function wsProbe(baseUrl, headers, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const ws = new WebSocket(baseUrl.replace(/^http/, 'ws').replace(/\/+$/, '') + '/ws', { headers });
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve(r);
    };
    const timer = setTimeout(() => done({ timeout: true }), timeoutMs);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', dpr: 1, w: 1280, h: 800 })));
    ws.on('message', (raw) => {
      try {
        const j = JSON.parse(raw.toString());
        if (j.type === 'dom-snapshot') done({ snap: j });
      } catch {}
    });
    ws.on('error', (err) => done({ refused: String(err && err.message) }));
    ws.on('close', () => done({ closed: true }));
  });
}

async function main() {
  const mirror = process.env.MIRROR_URL;
  const originB = process.env.ORIGIN_B || 'http://origin-b:8000';
  if (!mirror) throw new Error('Set MIRROR_URL');
  const output = process.env.EVIDENCE_DIR;
  if (output) fs.mkdirSync(output, { recursive: true });
  const results = { pass: false };

  // A. 缺省源站：短式 /m
  const a = await wsProbe(mirror, {});
  results.A_snapshot = !!(a.snap && a.snap.css && a.snap.css.includes('url(/m/font.woff2)'));
  if (!results.A_snapshot) results.A_why = JSON.stringify({ refused: a.refused, timeout: a.timeout || undefined, closed: a.closed || undefined, cssSample: a.snap ? String(a.snap.css).slice(0, 160) : null });
  const fa = await fetch(mirror.replace(/\/$/, '') + '/m/font.woff2');
  const faBody = await fa.text().catch(() => '');
  results.A_proxy = fa.status === 200 && faBody === 'DEFAULT-ASSET-BYTES-0123456789';

  // B. 白名单多源：/m/o/<b64url(origin-b)>
  const bSeg = '/m/o/' + b64url(originB);
  const b = await wsProbe(mirror, { 'x-rbi-origin': originB });
  results.B_snapshot = !!(b.snap && b.snap.css && b.snap.css.includes('url(' + bSeg + '/font.woff2)'));
  if (!results.B_snapshot) results.B_why = JSON.stringify({ refused: b.refused, timeout: b.timeout || undefined, closed: b.closed || undefined, cssSample: b.snap ? String(b.snap.css).slice(0, 200) : null });
  const fb = await fetch(mirror.replace(/\/$/, '') + bSeg + '/font.woff2');
  const fbBody = await fb.text().catch(() => '');
  results.B_proxy = fb.status === 200 && fbBody === 'ORIGIN-B-ASSET-BYTES-9876543210';

  // 未白名单 origin 的 /m/o 代理必须 403
  const fe = await fetch(mirror.replace(/\/$/, '') + '/m/o/' + b64url('http://127.0.0.1:9') + '/font.woff2');
  results.B_forbiddenAsset = fe.status === 403;

  // C. 未白名单 x-rbi-origin：升级 403
  const c = await wsProbe(mirror, { 'x-rbi-origin': 'http://127.0.0.1:9' }, 8000);
  results.C_refused = !c.snap && (c.refused !== undefined || c.closed === true);
  if (!results.C_refused) results.C_why = JSON.stringify({ refused: c.refused, closed: c.closed, timeout: c.timeout || undefined });

  // D. 浏览器：级联顺序 / 资产 URL / 快照去重
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server'] });
  try {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      window.__snapCount = 0;
      const OrigWS = window.WebSocket;
      window.WebSocket = function (url, protos) {
        const ws = protos === undefined ? new OrigWS(url) : new OrigWS(url, protos);
        ws.addEventListener('message', (ev) => {
          try { if (JSON.parse(ev.data).type === 'dom-snapshot') window.__snapCount++; } catch {}
        });
        return ws;
      };
      window.WebSocket.prototype = OrigWS.prototype;
    });
    await page.goto(mirror, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const b2 = document.querySelector('#mirrorHost') && document.querySelector('#mirrorHost').shadowRoot && document.querySelector('#mirrorHost').shadowRoot.querySelector('.xy-body');
      return b2 && b2.querySelector('#order');
    }, { timeout: 25000 });

    // 级联顺序：<link> 红在先、<style> 绿在后 → 镜像必须绿
    results.D_cascade = await page.evaluate(() => {
      const el = document.querySelector('#mirrorHost').shadowRoot.querySelector('#order');
      return getComputedStyle(el).color;
    }) === 'rgb(0, 128, 0)';

    // 背景图改写为 /m 代理且可取回
    results.D_bgUrl = await page.evaluate(async () => {
      const el = document.querySelector('#mirrorHost').shadowRoot.querySelector('#bg');
      const bg = getComputedStyle(el).backgroundImage;
      if (!/\/m\/img\.png/.test(bg)) return false;
      const m2 = bg.match(/url\(["']?([^"')]+)["']?\)/);
      if (!m2) return false;
      try { const r = await fetch(m2[1], { cache: 'no-store' }); return r.ok && (await r.arrayBuffer()).byteLength === 70; } catch { return false; }
    });

    // @font-face 的 src 已改写为 /m 代理（假字体字节不注册 FontFace，改断言样式文本）
    results.D_fontFace = await page.evaluate(() => {
      const root = document.querySelector('#mirrorHost').shadowRoot;
      return [...root.querySelectorAll('style')].some((st) => /@font-face[^}]*url\((['"]?)(\/m\/font\.woff2)\1/.test(st.textContent));
    });

    // 快照去重：同页导航（服务端 nav+600ms+1500ms 共 3 次相同快照）
    await page.evaluate(() => {
      const root = document.querySelector('#mirrorHost').shadowRoot;
      window.__bursts = 0; window.__lastBurst = 0;
      new MutationObserver(() => {
        const now = Date.now();
        if (now - window.__lastBurst > 300) window.__bursts++;
        window.__lastBurst = now;
      }).observe(root, { childList: true });
      window.__snapAtCount = window.__snapCount;
    });
    await page.click('#mirrorHost >>> #self');
    await new Promise((r) => setTimeout(r, 3500));
    const d = await page.evaluate(() => ({ snaps: window.__snapCount - window.__snapAtCount, rebuilds: window.__bursts, stillThere: !!(document.querySelector('#mirrorHost').shadowRoot.querySelector('#order')) }));
    results.D_snapshots = d.snaps;
    results.D_rebuilds = d.rebuilds;
    results.D_alive = !!d.stillThere;
    results.D_dedupe = d.snaps >= 2 && d.rebuilds <= 1 && d.stillThere;
  } catch (error) {
    results.D_error = error.message;
  } finally {
    await browser.close();
  }

  results.pass = !!(results.A_snapshot && results.A_proxy && results.B_snapshot && results.B_proxy && results.B_forbiddenAsset && results.C_refused
    && results.D_cascade && results.D_bgUrl && results.D_fontFace && results.D_dedupe);
  if (output) fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
  if (!results.pass) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
