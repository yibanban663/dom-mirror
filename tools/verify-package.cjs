'use strict';

// Verify the actual npm tarball from a separate consumer, with no real Chromium.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.join(__dirname, '..');
const consumer = fs.mkdtempSync(path.join(os.tmpdir(), 'dom-mirror-consumer-'));
const env = { ...process.env, PUPPETEER_SKIP_DOWNLOAD: 'true' };
try {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', consumer], {
    cwd: root, env, timeout: 30000, encoding: 'utf8',
  }))[0];
  for (const file of ['index.js', 'index.d.ts', 'server.js', 'demo/server.js', 'lib/options.js',
    'lib/static.js', 'lib/timers.js', 'lib/page-helpers.js', 'lib/input.js', 'lib/xframe.js', 'lib/canvas.js', 'lib/frame-codec.js', 'client/index.html', 'protected/index.html']) {
    if (!packed.files.some(entry => entry.path === file)) throw new Error('Missing package file: ' + file);
  }
  fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ private: true }));
  execFileSync('npm', ['install', '--prefer-offline', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund',
    path.join(consumer, packed.filename)], { cwd: consumer, env, timeout: 120000, stdio: 'pipe' });
  const smoke = String.raw`
    const assert = require('node:assert/strict');
    const http = require('node:http');
    const { once } = require('node:events');
    const { WebSocket } = require('ws');
    const signals = ['SIGINT', 'SIGTERM', 'unhandledRejection'];
    const before = signals.map(event => process.listeners(event));
    const originalListen = http.Server.prototype.listen;
    http.Server.prototype.listen = () => { throw new Error('import listened'); };
    const { createMirror } = require('@lizhen-xxaq/dom-mirror');
    http.Server.prototype.listen = originalListen;
    signals.forEach((event, i) => assert.deepEqual(process.listeners(event), before[i]));
    const mirrors = [], servers = [], clients = [];
    async function listen(server) {
      servers.push(server);
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      return 'http://127.0.0.1:' + server.address().port;
    }
    (async () => {
      try {
        for (const value of ['first source', 'second source']) {
          const originUrl = await listen(http.createServer((req, res) => {
            assert.equal(req.url, '/asset.png?test=1');
            res.writeHead(200, { 'content-type': 'image/png' });
            res.end(value);
          }));
          const mirror = createMirror({ originUrl, obfuscate: false, logger: { log() {} } });
          mirrors.push(mirror);
          assert.equal(await mirror.revokeSession('unknown'), false);
          assert.equal(await mirror.revokeIdentity('unknown'), 0);
          const server = http.createServer((req, res) => {
            if (req.url === '/host') { res.end('host'); return; }
            mirror.handleRequest(req, res);
          });
          server.on('upgrade', mirror.handleUpgrade);
          const url = await listen(server);
          assert.match(await (await fetch(url)).text(), /mirrorHost/);
          assert.equal(await (await fetch(url + '/m/asset.png?test=1')).text(), value);
          const socket = new WebSocket(url.replace('http:', 'ws:') + '/ws');
          clients.push(socket);
          await once(socket, 'open');
          const message = once(socket, 'message');
          socket.send(JSON.stringify({ type: 'invalid-handshake' }));
          assert.equal(JSON.parse((await message)[0]).code, 'INVALID_HANDSHAKE');
          await mirror.close();
          assert.equal((await fetch(url)).status, 503);
          assert.equal(await (await fetch(url + '/host')).text(), 'host');
        }
        console.log('Packed package: import, assets, WS rejection, two instances and host ownership passed');
      } finally {
        for (const socket of clients) socket.terminate();
        await Promise.all(mirrors.map(mirror => mirror.close()));
        await Promise.all(servers.map(server => new Promise(resolve => {
          server.close(resolve);
          server.closeAllConnections();
        })));
      }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  execFileSync(process.execPath, ['-e', smoke], { cwd: consumer, env, timeout: 15000, stdio: 'inherit' });
} finally {
  fs.rmSync(consumer, { recursive: true, force: true });
}
