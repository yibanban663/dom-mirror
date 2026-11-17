'use strict';
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const { selectValue } = require('./verify-vikunja.cjs');
(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    for (const mirror of [false, true]) {
      const page = await browser.newPage();
      await page.setContent('<div id="mirrorHost"></div>');
      await page.evaluate(mirror => {
        const root = mirror ? document.querySelector('#mirrorHost').attachShadow({ mode: 'open' }) : document.body;
        root.innerHTML = '<select><option value="0">Unset</option><option value="2">Medium</option></select>';
        window.events = [];
        for (const type of ['input', 'change']) root.addEventListener(type, event => window.events.push({ type, value: event.target.value }));
      }, mirror);
      const selector = (mirror ? '#mirrorHost >>> ' : '') + 'select';
      const stale = await page.$(selector);
      await page.evaluate(mirror => {
        const root = mirror ? document.querySelector('#mirrorHost').shadowRoot : document;
        const select = root.querySelector('select');
        select.replaceWith(select.cloneNode(true));
      }, mirror);
      assert.deepEqual(await stale.select('2'), ['2']);
      assert.deepEqual(await page.evaluate(() => window.events), [], 'Detached selection reports a value without reaching the root listener');
      assert.equal(await page.$eval(selector, element => element.value), '0');
      assert.equal(await selectValue(page, mirror, '2'), '2');
      assert.deepEqual(await page.evaluate(() => window.events), [{ type: 'input', value: '2' }, { type: 'change', value: '2' }]);
      await page.close();
    }
    console.log('Detached select negative control and atomic live selection passed in document and Shadow DOM');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
