'use strict';

const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');

for (const name of ['client/index.html', 'protected/index.html', 'test/fixtures/scroll.html', 'test/fixtures/data-boundary.html', 'test/fixtures/node-id.html', 'test/fixtures/longtail-p0.html', 'test/fixtures/shadow.html', 'test/fixtures/iframe.html', 'test/fixtures/iframe-child.html', 'test/fixtures/canvas2d.html', 'test/fixtures/enhance.html', 'test/fixtures/gen-forms.html', 'test/fixtures/gen-editor.html', 'test/fixtures/gen-media-pix.html', 'test/fixtures/gen-layout.html', 'test/fixtures/gen-style.html', 'test/fixtures/gen-canvas-key.html', 'test/fixtures/gen-dnd.html', 'tools/fixtures/capacity.html']) {
  const html = fs.readFileSync(path.join(root, name), 'utf8');
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    new vm.Script(match[1], { filename: name });
  }
}

for (const name of ['tools/capacity-host.cjs', 'tools/capacity-client.cjs', 'tools/summarize-capacity.cjs',
  'tools/memory-host.cjs', 'tools/memory-client.cjs', 'tools/summarize-memory.cjs', 'tools/verify-frame-baseline.cjs',
  'tools/summarize-allocator.cjs', 'tools/verify-allocator.cjs', 'tools/verify-select.cjs', 'tools/allocator-business-host.cjs',
  'tools/memory-trace.cjs', 'tools/analyze-memory-growth.cjs', 'tools/summarize-trace-pair.cjs', 'tools/memory-v8-preload.cjs',
  'tools/summarize-v8-memory.cjs', 'tools/summarize-v8-pair.cjs', 'tools/prepare-package-business.cjs',
  'tools/package-business-host.cjs', 'tools/verify-package-lifecycle.cjs', 'tools/verify-package-provenance.cjs',
  'tools/summarize-package-business.cjs', 'tools/verify-xframe-policy.cjs', 'lib/uploads.js', 'tools/generality-result.cjs', 'tools/verify-generality.cjs', 'tools/verify-chromium-sandbox.cjs', 'tools/verify-request-policy.cjs']) {
  new vm.Script(fs.readFileSync(path.join(root, name), 'utf8'), { filename: name });
}

// Compile the actual injected template after evaluating its server-side interpolation.
const { pageHelpers } = require('../lib/page-helpers');
new vm.Script(pageHelpers({ redactAttributes: [], maskInputTypes: [], canvasStream: true }), { filename: 'PAGE_HELPERS' });
console.log('Client, demo and injected scripts compile');
