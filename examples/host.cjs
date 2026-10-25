'use strict';

const http = require('node:http');
const { createMirror } = require('..');

// Minimal local host. Add your own authentication before exposing HTTP or WS.
const mirror = createMirror({ originUrl: process.env.ORIGIN_URL || 'https://example.com/' });
const server = http.createServer(mirror.handleRequest);
server.on('upgrade', mirror.handleUpgrade);
server.listen(8088, '127.0.0.1');

let closing;
function close() {
  return closing ??= (async () => {
    const stopped = new Promise(resolve => server.close(resolve));
    await mirror.close();
    server.closeAllConnections();
    await stopped;
  })();
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { close().catch(error => { console.error(error); process.exitCode = 1; }); });
}
