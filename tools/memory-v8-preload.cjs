'use strict';
// Startup evidence for explicitly selected diagnostic images, not a library import.
const fs = require('node:fs');
const path = require('node:path');
const v8 = require('node:v8');
const crypto = require('node:crypto');
const output = process.env.EVIDENCE_DIR || '/tmp/memory-v8-evidence';
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'v8-startup.json'), JSON.stringify({
  node: process.version, v8: process.versions.v8, execArgv: process.execArgv, argv: process.argv,
  bootstrapSha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
  entrySha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'memory-v8-entry.sh'))).digest('hex'),
  profile: { trace: process.env.MEMORY_V8_TRACE || '0', maxSemiSpaceMiB: process.env.MEMORY_MAX_SEMI_SPACE || null },
  heap: v8.getHeapStatistics(),
}, null, 2) + '\n', { flag: 'wx' });
if (process.env.MEMORY_V8_TRACE === '1') {
  const file = path.join(output, 'frame-sizes.jsonl');
  fs.writeFileSync(file, '', { flag: 'wx' });
  const puppeteer = require('puppeteer').default;
  const launch = puppeteer.launch.bind(puppeteer);
  puppeteer.launch = async options => {
    const browser = await launch(options);
    const newPage = browser.newPage.bind(browser);
    browser.newPage = async (...args) => {
      const page = await newPage(...args);
      const createSession = page.createCDPSession.bind(page);
      page.createCDPSession = async (...options) => {
        const session = await createSession(...options);
        session.on('Page.screencastFrame', ({ data }) => fs.appendFileSync(file,
          JSON.stringify({ ms: performance.now(), pngBase64Chars: data.length }) + '\n'));
        return session;
      };
      return page;
    };
    return browser;
  };
}
