'use strict';
const http = require('node:http');
const pages = {
  '/': '<a href="/page2" style="font-size:40px;padding:20px;display:inline-block">GO2</a><p>HOME</p>',
  '/page2': '<p style="font-size:40px">PAGE2-MARK</p>',
};
http.createServer((req, res) => {
  console.log('[origin] ' + req.method + ' ' + req.url);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!DOCTYPE html><html><body style="margin:0">' + (pages[req.url] || pages['/']) + '</body></html>');
}).listen(8099, '127.0.0.1', () => console.log('nav origin on 8099'));
