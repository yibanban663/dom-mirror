'use strict';
// 竞态压力复现器：放大「打字补丁在途 × 重连快照」交错窗口，定位偶发草稿文本旋转
// （'Recovered dom X' → 'ed dom XReco'，~5% 概率、重试即恢复）。诊断工具，不进 CI。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const puppeteer = require('puppeteer');
const { api, button } = require('./verify-vikunja.cjs');
const output = process.env.EVIDENCE_DIR;
const field = '#mirrorHost >>> textarea[placeholder="Add a task…"]';
const ROUNDS = Number(process.env.RACE_ROUNDS || 10);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function online(page) {
  await page.waitForFunction(() => document.querySelector('#connectionNotice').hidden, { timeout: 30000 });
}
async function barrier(page) {
  await page.evaluate(() => new Promise((resolve, reject) => {
    const socket = window.__testSocket, t = Math.random();
    const timer = setTimeout(() => { socket.removeEventListener('message', receive); reject(new Error('Command barrier timeout')); }, 10000);
    function receive(event) {
      let m; try { m = JSON.parse(event.data); } catch { return; }
      if (m.type === 'pong' && m.t === t) { clearTimeout(timer); socket.removeEventListener('message', receive); resolve(); }
    }
    socket.addEventListener('message', receive);
    socket.send(JSON.stringify({ type: 'ping', t }));
  }));
}
async function reconnect(page) {
  const previous = await page.evaluate(() => {
    const n = window.__resumes || 0;
    window.__wsLog.push({ t: Date.now(), ev: 'CALL-close#' + (window.__testSocket.__wsId || '?') });
    window.__testSocket.close();
    return n;
  });
  try {
    await page.waitForFunction(n => window.__resumes > n, { timeout: 20000 }, previous);
  } catch (e) {
    const st = await page.evaluate(() => ({ resumes: window.__resumes || 0, proof: !!window.__sessionProof, noticeHidden: document.querySelector('#connectionNotice').hidden, sockState: window.__testSocket ? window.__testSocket.readyState : 'none' }));
    console.log('RECONNECT_STALL ' + JSON.stringify(st) + ' wsLog=' + JSON.stringify((await page.evaluate(() => (window.__wsLog || []).filter(x => !/^msg-(pong|sstats)/.test(x.ev)).slice(-40)))));
    throw e;
  }
  await online(page);
}
async function tab(browser) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.evaluateOnNewDocument(() => {
    const Native = WebSocket;
    window.WebSocket = class extends Native {
      constructor(...args) {
        super(...args);
        window.__testSocket = this;
        window.__wsSeq = (window.__wsSeq || 0) + 1;
        this.__wsId = window.__wsSeq;
        window.__wsLog = window.__wsLog || [];
        window.__wsLog.push({ t: Date.now(), ev: 'construct#' + this.__wsId });
        this.addEventListener('open', event => {
          window.__wsLog.push({ t: Date.now(), ev: 'open' });
          if (window.__blockReconnect) { event.stopImmediatePropagation(); this.close(); }
        });
        this.addEventListener('close', () => window.__wsLog.push({ t: Date.now(), ev: 'close#' + this.__wsId }));
        this.addEventListener('message', event => {
          let m; try { m = JSON.parse(event.data); } catch { return; }
          window.__wsLog.push({ t: Date.now(), ev: 'msg-' + m.type + (m.resumed !== undefined ? '-resumed:' + m.resumed : '') + '#' + this.__wsId });
          if (m.type === 'session') {
            if (m.resumed) {
              window.__sameSession = window.__sessionProof === m.token;
              window.__resumes = (window.__resumes || 0) + 1;
            }
            window.__sessionProof = m.token;
          }
        });
      }
    };
  });
  await page.goto(process.env.MIRROR_URL, { waitUntil: 'networkidle0', timeout: 30000 });
  await online(page);
  await page.waitForSelector('#mirrorHost >>> #username', { timeout: 30000 });
  return { context, page };
}
async function login(page, username, password, project) {
  await page.type('#mirrorHost >>> #username', username, { delay: 10 });
  await page.type('#mirrorHost >>> #password', password, { delay: 10 });
  await button(page, true, 'Login');
  await page.waitForSelector(field, { timeout: 30000 });
  const href = '/m/projects/' + project.id;
  await page.waitForSelector('#mirrorHost >>> a[href="' + href + '"]', { timeout: 20000 });
  await page.locator('#mirrorHost >>> a[href="' + href + '"]').setTimeout(20000).click();
  await page.waitForSelector('#mirrorHost >>> a[href^="' + href + '/"]', { timeout: 20000 });
}
const value = page => page.$eval(field, e => e.value);
async function clearField(page) {
  await page.evaluate(() => {
    const el = document.querySelector('#mirrorHost').shadowRoot.querySelector('textarea[placeholder="Add a task…"]');
    if (!el) return;
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

(async () => {
  if (output) fs.mkdirSync(output, { recursive: true });
  const username = 'race' + crypto.randomBytes(6).toString('hex');
  const password = crypto.randomUUID() + 'Aa9!';
  await api('/register', 'POST', { username, password, email: username + '@example.invalid' });
  const { token } = await api('/login', 'POST', { username, password });
  const project = await api('/projects', 'PUT', { title: 'Race dom' }, token);
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--no-proxy-server', '--disable-dev-shm-usage'], defaultViewport: { width: 1280, height: 900, deviceScaleFactor: 1 } });
  const results = [];
  try {
    const t = await tab(browser);
    await login(t.page, username, password, project);
    for (let i = 0; i < ROUNDS; i++) {
      const title = 'Race dom ' + crypto.randomBytes(4).toString('hex');
      const preWait = [0, 30, 60, 120][i % 4];
      const typeDelay = [15, 8, 4, 0][i % 4];
      try {
        await t.page.click(field);
        await t.page.type(field, title, { delay: typeDelay });
        await barrier(t.page);
        if (preWait) await sleep(preWait);
        await reconnect(t.page);
        const got = await value(t.page);
        assert.equal(got, title);
        results.push({ round: i, pass: true, preWait, typeDelay });
        console.log(JSON.stringify(results.at(-1)));
        await clearField(t.page);
        await barrier(t.page);
      } catch (error) {
        let dump = null;
        try {
          dump = await t.page.evaluate(() => {
            const root = document.querySelector('#mirrorHost').shadowRoot;
            const ta = root && root.querySelector('textarea');
            return ta ? { value: ta.value, childNodes: [...ta.childNodes].map(n => n.nodeType + ':' + JSON.stringify(n.textContent)) } : 'no textarea';
          });
        } catch (e) { dump = 'dump err ' + e.message; }
        const row = { round: i, pass: false, preWait, typeDelay, error: error.message, dump };
        results.push(row);
        console.log(JSON.stringify(row));
        await clearField(t.page).catch(() => {});
      }
    }
    await t.context.close();
  } finally { await browser.close(); }
  if (output) fs.writeFileSync(path.join(output, 'race-result.json'), JSON.stringify(results, null, 2));
  const fails = results.filter(r => !r.pass);
  console.log('RACE_SUMMARY total=' + results.length + ' fail=' + fails.length);
  process.exitCode = fails.length ? 1 : 0;
})().catch(error => { console.error(error.message); process.exitCode = 1; });
