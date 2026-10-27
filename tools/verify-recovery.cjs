'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const puppeteer = require('puppeteer');
const { api, persisted, button } = require('./verify-vikunja.cjs');
const output = process.env.EVIDENCE_DIR;
const field = '#mirrorHost >>> textarea[placeholder="Add a task…"]';
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
  await barrier(page);
  const previous = await page.evaluate(() => {
    const n = window.__resumes || 0;
    window.__testSocket.close();
    return n;
  });
  await page.waitForFunction(n => window.__resumes > n, { timeout: 20000 }, previous);
  await online(page);
  assert.equal(await page.evaluate(() => window.__sameSession), true, 'resume must retain the same session');
}
async function tab(browser, mode) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.evaluateOnNewDocument(() => {
    const Native = WebSocket;
    window.WebSocket = class extends Native {
      constructor(...args) {
        super(...args);
        window.__testSocket = this;
        // Test-only interruption: never log or persist the session proof.
        this.addEventListener('open', event => {
          if (window.__blockReconnect) { event.stopImmediatePropagation(); this.close(); }
        });
        this.addEventListener('close', () => { window.__holdUpdates = false; });
        this.addEventListener('message', event => {
          let m; try { m = JSON.parse(event.data); } catch { return; }
          if (m.type === 'session') {
            if (m.resumed) {
              window.__sameSession = window.__sessionProof === m.token;
              window.__resumes = (window.__resumes || 0) + 1;
            }
            window.__sessionProof = m.token;
          }
          if (window.__holdUpdates && ['dom-patches', 'dom-snapshot', 'anim-tiles', 'canvas-tile', 'doc-class', 'scroll-sync'].includes(m.type)) event.stopImmediatePropagation();
        });
      }
    };
  });
  await page.goto(process.env.MIRROR_URL, { waitUntil: 'networkidle0', timeout: 30000 });
  await online(page);
  await page.waitForSelector('#mirrorHost >>> #username', { timeout: 30000 });
  if (mode === 'frame') {
    await page.$eval('[data-m="frame"]', e => e.click());
    await page.waitForFunction(() => document.querySelector('#mMode').textContent === 'frame');
  }
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
async function value(page) { return page.$eval(field, e => e.value); }
async function release(tab) {
  await tab.page.evaluate(() => {
    window.__blockReconnect = true;
    if (window.__testSocket.readyState === 1) window.__testSocket.send(JSON.stringify({ type: 'release' }));
  }).catch(() => {});
  await tab.context.close();
}
async function run(browser, mode) {
  const result = { mode, pass: false, steps: [] }, tabs = [];
  let step = 'seed';
  try {
    const username = 'recover' + crypto.randomBytes(6).toString('hex');
    const password = crypto.randomUUID() + 'Aa9!';
    await api('/register', 'POST', { username, password, email: username + '@example.invalid' });
    const { token } = await api('/login', 'POST', { username, password });
    const project = await api('/projects', 'PUT', { title: 'Recovery ' + mode }, token);
    step = 'login';
    const first = await tab(browser, mode); tabs.push(first);
    const page = first.page;
    await login(page, username, password, project);
    step = 'login-route-draft';
    const title = 'Recovered ' + mode + ' ' + crypto.randomBytes(4).toString('hex');
    await page.type(field, title, { delay: 15 });
    await reconnect(page);
    assert.equal(await value(page), title);
    result.steps.push({ name: step, pass: true });

    step = 'committed-without-ui-confirmation';
    await page.evaluate(() => { window.__holdUpdates = true; });
    await page.click(field);
    await page.keyboard.press('Enter');
    const created = await persisted('/projects/' + project.id + '/tasks', token, tasks => tasks.find(t => t.title === title));
    assert.equal(await page.evaluate(title => [...document.querySelector('#mirrorHost').shadowRoot.querySelectorAll('a,span')].some(e => e.textContent.trim() === title), title), false);
    await reconnect(page);
    await page.waitForFunction(title => [...document.querySelector('#mirrorHost').shadowRoot.querySelectorAll('a,span')].some(e => e.textContent.trim() === title), { timeout: 20000 }, title);
    assert.equal(await value(page), '', 'authoritative snapshot must clear a submitted draft');
    const tasks = await api('/projects/' + project.id + '/tasks', 'GET', null, token);
    assert.equal(tasks.filter(t => t.title === title).length, 1, 'never replay the submission');
    result.steps.push({ name: step, pass: true, taskId: created.id, count: 1 });

    step = 'same-account-isolation';
    const second = await tab(browser, mode); tabs.push(second);
    // A new tab starts at login, even while another tab has logged into the same source.
    assert.ok(await page.evaluate(() => window.__sessionProof) !== await second.page.evaluate(() => window.__sessionProof), 'independent tabs must use different sessions');
    await login(second.page, username, password, project);
    await page.type(field, 'Draft A');
    await second.page.type(field, 'Draft B');
    await barrier(second.page);
    await reconnect(page);
    assert.equal(await value(page), 'Draft A');
    assert.equal(await value(second.page), 'Draft B');
    await release(first); tabs.shift();
    await second.page.click(field);
    await second.page.keyboard.press('Enter');
    await persisted('/projects/' + project.id + '/tasks', token, tasks => tasks.find(t => t.title === 'Draft B'));
    result.steps.push({ name: step, pass: true });

    step = 'expiry-and-explicit-restart';
    const oldProof = await second.page.evaluate(() => {
      window.__blockReconnect = true;
      window.__testSocket.close();
      return window.__sessionProof;
    });
    await second.page.waitForFunction(() => !document.querySelector('#connectionNotice').hidden && document.querySelector('#mirrorScroll').inert);
    await sleep(Number(process.env.SESSION_GRACE_MS || 60000) + 500);
    await second.page.evaluate(() => { window.__blockReconnect = false; });
    await second.page.waitForFunction(() => !document.querySelector('#newSession').hidden, { timeout: 20000 });
    assert.equal(await second.page.evaluate(() => document.querySelector('#mirrorScroll').inert), true);
    assert.ok(await second.page.evaluate(() => window.__sessionProof) === oldProof, 'expired sessions must not silently become new ones');
    await second.page.click('#newSession');
    await online(second.page);
    await second.page.waitForSelector('#mirrorHost >>> #username', { timeout: 30000 });
    assert.ok(await second.page.evaluate(() => window.__sessionProof) !== oldProof, 'manual restart must create a new session');
    result.steps.push({ name: step, pass: true });
    if (output) await second.page.screenshot({ path: path.join(output, mode + '-restarted.png'), waitForFonts: false });
    result.pass = true;
  } catch (error) {
    result.steps.push({ name: step, pass: false, error: error.message });
    try {
      result.dump = await tabs.at(-1).page.evaluate(() => {
        const root = document.querySelector('#mirrorHost') && document.querySelector('#mirrorHost').shadowRoot;
        if (!root) return 'no mirror root';
        const ta = root.querySelector('textarea');
        if (!ta) return 'no textarea';
        return {
          value: ta.value,
          childNodes: [...ta.childNodes].map(n => n.nodeType + ':' + JSON.stringify(n.textContent)),
          outerStart: ta.outerHTML.slice(0, 300),
        };
      });
    } catch (e) { result.dump = 'dump err ' + e.message; }
    if (output && tabs.length) await tabs.at(-1).page.screenshot({ path: path.join(output, mode + '-failure.png'), waitForFonts: false }).catch(() => {});
  } finally {
    for (const t of tabs) await release(t);
  }
  console.log(JSON.stringify(result));
  return result;
}
async function main() {
  const grace = Number(process.env.SESSION_GRACE_MS);
  if (!process.env.BUSINESS_URL || !process.env.MIRROR_URL || !(grace > 0 && grace <= 5000)) throw new Error('Use the isolated business fixture with SESSION_GRACE_MS between 1 and 5000');
  if (output) fs.mkdirSync(output, { recursive: true });
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--no-proxy-server', '--disable-dev-shm-usage'], defaultViewport: { width: 1280, height: 900, deviceScaleFactor: 1 } });
  const results = [];
  try {
      for (const mode of ['dom', 'frame']) {
        let r = await run(browser, mode);
        if (!r.pass && process.env.NO_RETRY !== '1') {
          console.log('RETRY ' + mode + ' (cold start)');
          r = await run(browser, mode);
          r.retried = true;
        }
        results.push(r);
      }
    }
  finally {
    await browser.close();
    if (output) fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(results, null, 2));
  }
  if (results.some(r => !r.pass)) process.exitCode = 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
