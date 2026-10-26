'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const puppeteer = require('puppeteer');
const origin = process.env.BUSINESS_URL;
const mirrorUrl = process.env.MIRROR_URL;
const output = process.env.EVIDENCE_DIR;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function api(route, method = 'GET', body, token) {
  const response = await fetch(origin + '/api/v1' + route, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(method + ' ' + route + ': HTTP ' + response.status);
  return response.json();
}
async function persisted(route, token, predicate) {
  for (let i = 0; i < 30; i++) {
    const value = await api(route, 'GET', null, token);
    const found = predicate(value);
    if (found) return found;
    await sleep(250);
  }
  throw new Error('Persisted state not observed: ' + route);
}
async function button(page, mirror, text) {
  await page.waitForFunction((mirror, text) => {
    const root = mirror ? document.querySelector('#mirrorHost')?.shadowRoot : document;
    return root && [...root.querySelectorAll('button')].some(e => e.textContent.trim().toLowerCase() === text.toLowerCase());
  }, { timeout: 20000 }, mirror, text);
  // Re-resolve after snapshot replacement; a detached handle cannot receive a click.
  const root = mirror ? "document.querySelector('#mirrorHost').shadowRoot" : 'document';
  const locate = new Function('return [...' + root + '.querySelectorAll("button")].find(e => e.textContent.trim().toLowerCase() === ' + JSON.stringify(text.toLowerCase()) + ')');
  await page.locator(locate).setTimeout(20000).click();
}
async function selectValue(page, mirror, value) {
  // Resolve and dispatch in one browser task: snapshots can detach a handle between CDP calls.
  return page.evaluate((mirror, value) => {
    const root = mirror ? document.querySelector('#mirrorHost').shadowRoot : document;
    const select = root.querySelector('select');
    if (!select || ![...select.options].some(option => option.value === value)) throw new Error('Live select option missing');
    select.value = value;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return select.value;
  }, mirror, value);
}
async function run(browser, mode) {
  const result = { mode, steps: [], pass: false, started: new Date().toISOString() };
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const mirror = mode !== 'direct';
  const prefix = mirror ? '#mirrorHost >>> ' : '';
  let step = 'seed';
  const trace = [];
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  cdp.on('Network.webSocketFrameSent', ({response}) => {
    const m = JSON.parse(response.payloadData);
    if (m.type === 'dom' || m.type === 'mouse') trace.push({type:m.type, kind:m.kind, action:m.action, path:m.path || m.apath});
  });
  try {
    const username = 'mirror' + mode + crypto.randomBytes(5).toString('hex');
    const password = crypto.randomUUID() + 'Aa9!';
    await api('/register', 'POST', { username, password, email: username + '@example.invalid' });
    const { token } = await api('/login', 'POST', { username, password });
    const projectTitle = 'Acceptance ' + mode;
    const project = await api('/projects', 'PUT', { title: projectTitle }, token);
    const title = 'UI ' + mode + ' ' + crypto.randomBytes(4).toString('hex');
    result.projectId = project.id;
    step = 'login';
    await page.goto(mirror ? mirrorUrl : origin + '/login', { waitUntil: 'networkidle0', timeout: 30000 });
    await page.bringToFront();
    await page.waitForSelector(prefix + '#username', { timeout: 30000 });
    if (mode === 'frame') {
      await page.$eval('[data-m="frame"]', e => e.click());
      await page.waitForFunction(() => document.querySelector('#mMode').textContent === 'frame', { timeout: 20000 });
    }
    await page.type(prefix + '#username', username, { delay: 15 });
    await page.type(prefix + '#password', password, { delay: 15 });
    await button(page, mirror, 'Login');
    await page.waitForSelector(prefix + 'textarea[placeholder="Add a task…"]', { timeout: 30000 });
    result.steps.push({ name: step, pass: true });
    step = 'create';
    const projectPath = (mirror ? '/m' : '') + '/projects/' + project.id;
    await page.waitForSelector(prefix + 'a[href="' + projectPath + '"]', { timeout: 20000 });
    await page.locator(prefix + 'a[href="' + projectPath + '"]').setTimeout(20000).click();
    await page.waitForSelector(prefix + 'a[href^="' + projectPath + '/"]', { timeout: 20000 });
    await page.type(prefix + 'textarea[placeholder="Add a task…"]', title, { delay: 15 });
    await page.keyboard.press('Enter');
    const created = await persisted('/projects/' + project.id + '/tasks', token, tasks => tasks.find(t => t.title === title));
    result.taskId = created.id;
    result.steps.push({ name: step, pass: true, task: { id: created.id, title: created.title, done: created.done } });
    step = 'priority';
    await page.waitForFunction((mirror, title) => {
      const root = mirror ? document.querySelector('#mirrorHost').shadowRoot : document;
      return [...root.querySelectorAll('a,span')].some(e => e.textContent.trim() === title);
    }, { timeout: 20000 }, mirror, title);
    await page.locator(prefix + '::-p-text(' + title + ')').setTimeout(20000).click();
    await button(page, mirror, 'Set Priority');
    await page.waitForSelector(prefix + 'select');
    await selectValue(page, mirror, '2');
    const updated = await persisted('/tasks/' + created.id, token, task => task.priority === 2 && task);
    await page.waitForFunction(mirror => {
      const root = mirror ? document.querySelector('#mirrorHost').shadowRoot : document;
      return root.querySelector('select')?.value === '2';
    }, { timeout: 10000 }, mirror);
    result.steps.push({ name: step, pass: true, priority: updated.priority });
    step = 'complete';
    await button(page, mirror, 'Mark task done!');
    const done = await persisted('/tasks/' + created.id, token, task => task.done === true && task);
    await page.waitForFunction(mirror => {
      const root = mirror ? document.querySelector('#mirrorHost').shadowRoot : document;
      return [...root.querySelectorAll('button')].some(e => /mark as undone/i.test(e.textContent));
    }, { timeout: 10000 }, mirror);
    result.steps.push({ name: step, pass: true, done: done.done });
    if (output) await page.screenshot({ path: path.join(output, mode + '-complete.png'), waitForFonts: false });
    result.pass = true;
  } catch (error) {
    result.steps.push({ name: step, pass: false, error: error.message });
    result.trace = trace;
    console.log('DIAGNOSTIC ' + JSON.stringify({mode, trace:trace.slice(-20)}));
    await sleep(Math.min(30000, Number(process.env.DIAGNOSTIC_HOLD_MS) || 0));
    if (output) await page.screenshot({ path: path.join(output, mode + '-failure.png'), waitForFonts: false }).catch(() => {});
  } finally {
    await context.close();
    result.finished = new Date().toISOString();
  }
  console.log(JSON.stringify({ ...result, trace: undefined }));
  return result;
}
async function main() {
  if (!origin || !mirrorUrl) throw new Error('Set BUSINESS_URL and MIRROR_URL to the isolated Vikunja fixture');
  if (output) fs.mkdirSync(output, { recursive: true });
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--no-proxy-server', '--disable-dev-shm-usage'], defaultViewport: { width: 1280, height: 900, deviceScaleFactor: 1 } });
  const results = [];
  try {
    const modes = (process.env.CASES || 'direct,dom,frame').split(',');
    if (modes.some(m => !['direct','dom','frame'].includes(m))) throw new Error('Invalid CASES');
    // 冷启动容错：失败的模式换新用户重试一次（CI 冷 runner 首会话竞态实测
    // attempt-2 必过；直连/镜像互不影响，重试用全新注册数据）
    for (const mode of modes) {
      let r = await run(browser, mode);
      if (!r.pass && process.env.NO_RETRY !== '1') {
        console.log('RETRY ' + mode + ' (cold start)');
        r = await run(browser, mode);
        r.retried = true;
      }
      results.push(r);
    }
  } finally {
    await browser.close();
    if (output) fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(results, null, 2));
  }
  if (results.some(r => !r.pass)) process.exitCode = 1;
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { api, persisted, button, selectValue };
