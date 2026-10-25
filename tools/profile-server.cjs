'use strict';
// Instrument an in-memory copy, leaving production source and protocol unchanged.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');
const filename = path.join(__dirname, '..', 'server.js');
let source = fs.readFileSync(filename, 'utf8');
function replace(before, after, count = 1) {
  if (source.split(before).length !== count + 1) throw new Error('Profile anchor changed: ' + before.slice(0, 90));
  source = source.split(before).join(after);
}
replace("const crypto = require('crypto');", "const crypto = require('crypto');\nconst __perf = require('./tools/profile-runtime.cjs');");
replace('const b = await launchSessionBrowser();', "const b = await __perf.measure('browser.launch', () => launchSessionBrowser());");
replace("await page.goto(sessionOrigin, { waitUntil: 'networkidle0', timeout: 20000 });", "if (process.env.PROFILE_PRESENTATION === '1') { await page.exposeFunction('__profileTaskMarker', value => __perf.sourceMarker(value)); await page.evaluateOnNewDocument(require('./tools/profile-marker.cjs')); }\n    await __perf.measure('origin.goto', () => page.goto(sessionOrigin, { waitUntil: 'networkidle0', timeout: 20000 }));");
replace('const clone = sanitizeClone(document.body);', 'const perfStart = performance.now();\n      const clone = sanitizeClone(document.body);\n      const perfCloneEnd = performance.now();');
replace("let docClass = '', docAttrs = '';", "const perfCssEnd = performance.now();\n      let docClass = '', docAttrs = '';");
replace("return { css: styleCss +", "return { __profile: { clone: perfCloneEnd - perfStart, css: perfCssEnd - perfCloneEnd, rest: performance.now() - perfCssEnd }, css: styleCss +");
replace("await withTimeout(cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }), 8000, 'frameSheet')", "await __perf.measure('snapshot.captureScreenshot', () => withTimeout(cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }), 8000, 'frameSheet'))");
replace("await withTimeout(page.evaluate((wf) => window.__xy.snapshotReal(wf), mode === 'frame'), 10000, 'snapshot');", "await __perf.measure('snapshot.evaluate', () => withTimeout(page.evaluate((wf) => window.__xy.snapshotReal(wf), mode === 'frame'), 10000, 'snapshot'));\n    for (const [name, ms] of Object.entries(snap.__profile)) __perf.record('snapshot.page.' + name, ms);");
replace('const diffFrame = async (b64) => {', 'const diffFrame = async (b64, pf) => {\n      const perfDecodeStart = performance.now();\n      __perf.consumedFrame();');
replace('const { info, data } = await img.raw().toBuffer({ resolveWithObject: true });', "const { info, data } = await img.raw().toBuffer({ resolveWithObject: true });\n      __perf.record('frame.decode', performance.now() - perfDecodeStart);\n      __perf.capture(b64);");
replace('const dirtyRows = new Uint8Array(H);', 'const perfScanStart = performance.now();\n      const dirtyRows = new Uint8Array(H);');
replace('if (!any) return { tiles: [] };', "__perf.record('frame.scan.' + (any ? 'changed' : 'unchanged'), performance.now() - perfScanStart);\n      if (!any) return { tiles: [] };");
replace("await frameCropInput(sharp, framePng, { info, data }).extract({ left: rx, top: ry, width: rw, height: rh }).png({ compressionLevel: 3 }).toBuffer()", "await __perf.measure('frame.cropEncode', () => __perf.codecInput(framePng, { info, data }).extract({ left: rx, top: ry, width: rw, height: rh }).png({ compressionLevel: 3 }).toBuffer())");
replace('diffFrame(pf.data)', 'diffFrame(pf.data, pf)');
replace('pendingFrame = { data, at: now };', 'pendingFrame = { data, at: now, profile: __perf.receivedFrame(!!pendingFrame) };');
replace('      return { tiles };', '      return { tiles, profile: __perf.traceFrame(data, info, pf, perfDecodeStart) };');
replace("tiles: out.tiles || [], holes:", "_profile: out.profile, tiles: out.tiles || [], holes:");
replace('const enqueue = (raw) => { cmdChain = cmdChain.then(() => handleRaw(raw)).catch(() => {}); };',
  'const enqueue = (raw) => { const receivedAt = performance.now(); cmdChain = cmdChain.then(() => { __perf.queued(raw, receivedAt); return handleRaw(raw); }).catch(() => {}); };');
for (const type of ['dom-snapshot', 'dom-patches', 'anim-tiles']) {
  replace("JSON.stringify({ type: '" + type + "'", "__perf.json({ type: '" + type + "'", type === 'anim-tiles' ? 2 : 1);
}
replace('await handleCommand(m);', "await __perf.measure('command.' + m.type, () => handleCommand(m));");
const codec = process.env.PROFILE_CODEC || 'production';
if (!['production', 'png', 'raw'].includes(codec)) throw new Error('PROFILE_CODEC must be production, png or raw');
const frameTick = Number(process.env.PROFILE_FRAME_TICK_MS || 16);
if (![4, 16].includes(frameTick)) throw new Error('PROFILE_FRAME_TICK_MS must be 4 or 16');
if (frameTick !== 16) replace('    }, 16);', '    }, ' + frameTick + ');');
const patchDelay = Number(process.env.PROFILE_PATCH_MS || 60);
if (![16, 60].includes(patchDelay)) throw new Error('PROFILE_PATCH_MS must be 16 or 60');
if (patchDelay !== 60) replace('            }, 60);', '            }, ' + patchDelay + ');');
new vm.Script(source, { filename });
if (process.argv.includes('--check')) {
  const start = source.indexOf('const PAGE_HELPERS = '), end = source.indexOf('\n// ---------- 静态文件', start);
  const helpers = vm.runInNewContext(source.slice(start, end) + '\nPAGE_HELPERS;', { ORIGIN_BASE: new URL('http://127.0.0.1:8077/'), config: { redactAttributes: [] } });
  new vm.Script(helpers);
  console.log('Profile instrumentation anchors and injected script compile');
} else {
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod._compile(source, filename);
  require('../demo/server').startDemo(mod.exports.createMirror).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
