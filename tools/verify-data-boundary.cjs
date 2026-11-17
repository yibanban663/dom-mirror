'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { once } = require('node:events');
const puppeteer = require('puppeteer');
const { createMirror } = require('..');
const kinds = ['VISIBLE', 'INPUT', 'HIDDEN_INPUT', 'PASSWORD', 'DATASET', 'INLINE_CSS', 'HIDDEN_TEXT',
  'HTML_ATTR', 'BODY_ATTR', 'RESOURCE_URL', 'JS_GLOBAL', 'COOKIE', 'STORAGE', 'SCRIPT', 'TEMPLATE', 'NOSCRIPT', 'COMMENT'];
const token = (phase, kind) => `DM_TEST_${phase}_${kind}_END`;
const output = process.env.EVIDENCE_DIR;
if (!output) throw new Error('Set EVIDENCE_DIR; this tool only serves a local synthetic fixture');
fs.mkdirSync(output, { recursive: true });
const redactAttributes = process.env.BOUNDARY_REDACT === '1' ? ['data-private'] : [];
const enforce = process.env.BOUNDARY_ENFORCE === '1';
const report = { version: require('../package.json').version, capturedAt: new Date().toISOString(),
  enforce, redactAttributes, sourceEvents: [], cases: [],
  limits: 'Literal synthetic markers in WS text, serialized client DOM and tested resource bodies; no OCR, arbitrary encodings or general sanitizer audit.',
  sourceSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', 'server.js'))).digest('hex') };

function save(name, value) { fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + '\n'); }
async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
async function stop(server) {
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}
function observe(phase, wire, dom) {
  return Object.fromEntries(kinds.map(kind => [kind, {
    wire: wire.includes(token(phase, kind)), dom: dom.includes(token(phase, kind)),
  }]));
}
async function sourceState(page, phase) {
  const values = await page.evaluate(() => ({
    visible: document.querySelector('#visible').textContent,
    hidden: document.querySelector('#hidden-input').value,
    password: document.querySelector('#password').value,
    runtime: window.privateRuntimeValue, cookie: document.cookie,
    storage: localStorage.getItem('fixture_private'),
  }));
  assert.equal(values.visible, token(phase, 'VISIBLE'));
  assert.equal(values.hidden, token(phase, 'HIDDEN_INPUT'));
  assert.equal(values.password, token(phase, 'PASSWORD'));
  assert.equal(values.runtime, token(phase, 'JS_GLOBAL'));
  assert.ok(values.cookie.includes(token(phase, 'COOKIE')));
  assert.equal(values.storage, token(phase, 'STORAGE'));
  return values;
}

async function main() {
  let browser;
  const png = await require('sharp')({ create: { width: 24, height: 24, channels: 3, background: 'blue' } }).png().toBuffer();
  const source = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture');
    if (url.pathname === '/events') {
      let data = '';
      for await (const chunk of req) data += chunk;
      report.sourceEvents.push(JSON.parse(data));
      res.end('ok'); return;
    }
    if (url.pathname === '/fixture.css') {
      res.writeHead(200, { 'content-type': 'text/css' });
      res.end('.unused::before { content: "DM_TEST_CSS_UNUSED_END"; }\n'
        + '[data-theme="fixture-theme"]{border-left:3px solid blue}\n'
        + '@font-face{font-family:UnusedFixture;src:url("/font.woff2?hint=DM_TEST_FONT_URL_END")}'); return;
    }
    if (url.pathname === '/image.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      res.end('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><!-- DM_TEST_IMAGE_METADATA_END --><rect width="24" height="24" fill="blue"/></svg>'); return;
    }
    if (url.pathname === '/image.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(Buffer.concat([png, Buffer.from('DM_TEST_PNG_TRAILER_END')])); return;
    }
    if (url.pathname === '/opaque.png') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end('DM_TEST_OPAQUE_RESOURCE_END'); return;
    }
    if (url.pathname === '/redirect.png') { res.writeHead(302, { location: '/private.json' }); res.end(); return; }
    if (url.pathname === '/private.json' || url.pathname === '/json.png') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"private":"DM_TEST_JSON_RESOURCE_END"}'); return;
    }
    if (url.pathname === '/html.png') {
      res.writeHead(200, { 'content-type': 'text/html' }); res.end('DM_TEST_HTML_RESOURCE_END'); return;
    }
    if (url.pathname === '/fixture.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(fs.readFileSync(path.join(__dirname, '..', 'test/fixtures/data-boundary.html'))); return;
    }
    res.writeHead(404); res.end();
  });
  const origin = await listen(source);
  try {
    browser = await puppeteer.launch({ headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server'],
      defaultViewport: { width: 1280, height: 900, deviceScaleFactor: 1 } });
    const directContext = await browser.createBrowserContext();
    const direct = await directContext.newPage();
    await direct.goto(origin + '/fixture.html?case=direct', { waitUntil: 'networkidle0' });
    report.direct = { initial: await sourceState(direct, 'INITIAL') };
    await direct.click('#mutate');
    await direct.waitForFunction(() => document.querySelector('#phase').textContent === 'UPDATED');
    report.direct.updated = await sourceState(direct, 'UPDATED');
    await direct.click('#patch');
    await direct.waitForFunction(() => document.querySelector('#phase').textContent === 'PATCHED');
    report.direct.patched = await sourceState(direct, 'PATCHED');
    await directContext.close();

    for (const mode of ['dom', 'frame']) {
      const mirror = createMirror({ originUrl: origin + '/fixture.html?case=' + mode,
        defaultMode: mode, obfuscate: false, sessionGraceMs: 0, redactAttributes,
        logger: { log(...args) { if (process.env.BOUNDARY_VERBOSE) console.log(...args); } } });
      const server = http.createServer(mirror.handleRequest);
      server.on('upgrade', mirror.handleUpgrade);
      const url = await listen(server);
      const context = await browser.createBrowserContext();
      const frames = [];
      const item = { mode, phases: [], resources: [] };
      report.cases.push(item);
      try {
        const page = await context.newPage();
        const cdp = await page.createCDPSession();
        await cdp.send('Network.enable');
        cdp.on('Network.webSocketFrameReceived', ({ response }) => {
          try {
            const message = JSON.parse(response.payloadData);
            // Never save resume tokens or unrelated handshake messages.
            if (['dom-snapshot', 'dom-patches', 'anim-tiles'].includes(message.type)) frames.push(message);
          } catch {}
        });
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        for (const phase of ['INITIAL', 'UPDATED', 'PATCHED']) {
          if (phase === 'UPDATED') await page.click('#mirrorHost >>> #mutate');
          if (phase === 'PATCHED') await page.click('#mirrorHost >>> #patch');
          await page.waitForFunction(phase => document.querySelector('#connectionNotice').hidden
            && document.querySelector('#mirrorHost')?.shadowRoot?.querySelector('#phase')?.textContent === phase,
          { timeout: 30000 }, phase);
          // Allow asynchronous patch/full snapshot delivery, then demand the matching wire marker.
          const deadline = Date.now() + 5000;
          while (!JSON.stringify(frames).includes(token(phase, 'VISIBLE')) && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          const wire = JSON.stringify(frames);
          const dom = await page.evaluate(() => document.querySelector('#mirrorHost').shadowRoot.innerHTML);
          const observations = observe(phase, wire, dom);
          assert.ok(observations.VISIBLE.wire && observations.VISIBLE.dom, 'positive visible marker');
          assert.ok(observations.INPUT.wire && observations.INPUT.dom, 'positive input marker');
          if (phase === 'PATCHED') {
            assert.ok(JSON.stringify(frames.filter(message => message.type === 'dom-patches')).includes(token(phase, 'VISIBLE')),
              'PATCHED must exercise incremental HTML delivery, not only full snapshots');
          }
          for (const kind of ['JS_GLOBAL', 'COOKIE', 'STORAGE', 'SCRIPT', 'TEMPLATE', 'NOSCRIPT', 'COMMENT', 'PASSWORD']) {
            assert.equal(observations[kind].wire, false, `${mode}/${phase}/${kind} wire`);
            assert.equal(observations[kind].dom, false, `${mode}/${phase}/${kind} DOM`);
          }
          if (enforce) {
            assert.equal(observations.HIDDEN_INPUT.wire, false, 'hidden input wire value');
            assert.equal(observations.HIDDEN_INPUT.dom, false, 'hidden input DOM value');
            if (redactAttributes.length) for (const kind of ['DATASET', 'HTML_ATTR', 'BODY_ATTR']) {
              assert.equal(observations[kind].wire, false, `${kind} must respect host redaction in wire`);
              assert.equal(observations[kind].dom, false, `${kind} must respect host redaction in DOM`);
            }
          }
          item.phases.push({ phase, observations, wireMessages: frames.length,
            extra: { unusedCss: wire.includes('DM_TEST_CSS_UNUSED_END'), fontUrl: wire.includes('DM_TEST_FONT_URL_END') } });
          save(`${mode}-${phase.toLowerCase()}-dom.json`, { dom });
        }
        await page.type('#mirrorHost >>> #editable', 'hello', { delay: 70 });
        await page.waitForFunction(() => document.querySelector('#mirrorHost').shadowRoot.querySelector('#echo').textContent === 'Echo: hello');
        item.inputRoundTrip = true;
        item.publicAttribute = await page.evaluate(() => {
          const element = document.querySelector('#mirrorHost').shadowRoot.querySelector('#dataset');
          return { theme: element.getAttribute('data-theme'), border: getComputedStyle(element).borderLeftWidth };
        });
        assert.deepEqual(item.publicAttribute, { theme: 'fixture-theme', border: '3px' });
        item.clientStorage = await page.evaluate(() => ({ cookie: document.cookie,
          storage: localStorage.getItem('fixture_private'), runtime: window.privateRuntimeValue ?? null }));
        assert.equal(item.clientStorage.cookie, '');
        assert.equal(item.clientStorage.storage, null);
        assert.equal(item.clientStorage.runtime, null);
        for (const route of ['image.png', 'image.svg', 'fixture.css', 'opaque.png', 'private.json', 'json.png', 'html.png', 'redirect.png', '//outside.invalid/test.png']) {
          const response = await page.evaluate(async route => {
            const response = await fetch('/m/' + route);
            return { status: response.status, body: await response.text() };
          }, route);
          item.resources.push({ route, ...response });
          assert.equal(response.status, ['image.png', 'fixture.css', 'opaque.png'].includes(route) ? 200 : 403, route);
        }
        if (mode === 'frame') assert.ok(frames.some(message => (message.tiles?.length || message.frame?.length)), 'frame PNG positive control');
        save(`${mode}-wire.json`, frames.map(message => JSON.parse(JSON.stringify(message, (key, value) =>
          typeof value === 'string' && value.startsWith('data:image/') ? '[PNG/image omitted; literal markers inspected before omission]' : value))));
        item.pass = true;
      } finally {
        await context.close();
        await mirror.close();
        await stop(server);
      }
    }
    for (const mode of ['direct', 'dom', 'frame']) {
      assert.ok(report.sourceEvents.some(event => event.case === mode && event.phase === 'UPDATED'), 'independent source event: ' + mode);
      assert.ok(report.sourceEvents.some(event => event.case === mode && event.phase === 'PATCHED'
        && event.hidden === token('PATCHED', 'HIDDEN_INPUT')), 'source hidden input remains intact: ' + mode);
    }
    report.pass = true;
  } finally {
    await browser?.close();
    await stop(source);
    save('result.json', report);
  }
  console.log(JSON.stringify({ pass: report.pass, enforce, redactAttributes, cases: report.cases.map(item => ({ mode: item.mode, pass: item.pass })) }));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
