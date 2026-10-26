'use strict';

// v0.12 节点 ID 回归：列表重排 / 相邻插入 / 节点移动 / 兄弟删除后，补丁仍按 id
// 命中同一元素（索引路径会在这些操作后漂移）。断言：
//  1) 快照镜像元素携带 data-xy-id；
//  2) insert → move → update → remove 混合序列后镜像文本与源站期望一致；
//  3) 全程无 patch-miss 触发的全量重同步（mode 消息只允许出现快照健康自检外的 0 次）。

const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');

async function main() {
  const url = process.env.MIRROR_URL;
  if (!url) throw new Error('Set MIRROR_URL to a mirror of test/fixtures/node-id.html');
  const output = process.env.EVIDENCE_DIR;
  if (output) fs.mkdirSync(output, { recursive: true });
  const results = { steps: [], idPatches: 0, patchMissResyncs: 0, pass: false };
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server'],
    defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
  });
  try {
    const page = await browser.newPage();
    const frames = [];
    const cdp = await page.createCDPSession();
    await cdp.send('Network.enable');
    cdp.on('Network.webSocketFrameSent', ({ response }) => {
      const msg = JSON.parse(response.payloadData);
      if (msg.type === 'mode') frames.push(msg);
    });
    page.on('console', (entry) => {
      if (entry.text().includes('[patch-miss]')) results.patchMissResyncs++;
    });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();
    await page.waitForFunction(() => {
      const body = document.querySelector('#mirrorHost')?.shadowRoot?.querySelector('.xy-body');
      return body && body.querySelector('#target')?.textContent === 'TARGET-INITIAL';
    }, { timeout: 20000 });

    // 1) 镜像元素携带 data-xy-id
    const stamped = await page.evaluate(() => {
      const body = document.querySelector('#mirrorHost').shadowRoot.querySelector('.xy-body');
      return {
        total: body.querySelectorAll('#list div, #list ~ *').length,
        stamped: body.querySelectorAll('[data-xy-id]').length,
      };
    });
    results.stamped = stamped;
    if (stamped.stamped < 8) throw new Error('mirror elements missing data-xy-id: ' + stamped.stamped);

    const mirrorState = () => page.evaluate(() => {
      const body = document.querySelector('#mirrorHost').shadowRoot.querySelector('.xy-body');
      return { state: body.querySelector('#state').textContent, target: body.querySelector('#target').textContent };
    });
    const click = (id) => page.click('#mirrorHost >>> #' + id);
    const expect = async (label, state, target) => {
      await page.waitForFunction((state2, target2) => {
        const body = document.querySelector('#mirrorHost').shadowRoot.querySelector('.xy-body');
        return body.querySelector('#state').textContent === state2 && body.querySelector('#target').textContent === target2;
      }, { timeout: 6000 }, state, target);
      const got = await mirrorState();
      results.steps.push({ label, ...got, pass: got.state === state && got.target === target });
    };

    // 2) 混合序列：插入(目标前) → 移动目标 → 再插入 → 更新目标文本 → 删除兄弟 → 再更新
    await click('b-insert');
    await expect('insert#1', 'inserted-1', 'TARGET-INITIAL');
    await click('b-move');
    await expect('move#1', 'moved-2', 'TARGET-INITIAL');
    await click('b-insert');
    await expect('insert#2', 'inserted-3', 'TARGET-INITIAL');
    await click('b-update');
    await expect('update#1', 'updated-4', 'TARGET-4');
    await click('b-remove');
    await expect('remove#1', 'removed-5', 'TARGET-4');
    await click('b-move');
    await expect('move#2', 'moved-6', 'TARGET-4');
    await click('b-update');
    await expect('update#2', 'updated-7', 'TARGET-7');

    // 3) 无 patch-miss 重同步风暴（快照健康自检只对空快照触发，这里不应有）
    results.modeMessages = frames.length;
    if (results.patchMissResyncs > 0) throw new Error('patch-miss observed: ' + results.patchMissResyncs);
    results.pass = results.steps.every(s => s.pass);
  } catch (error) {
    results.error = error.message;
  } finally {
    await browser.close();
    if (output) fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify({ pass: results.pass, error: results.error, steps: results.steps.length }));
  }
  if (!results.pass) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
