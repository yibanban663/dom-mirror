'use strict';
// canvas 功能测试源站: 静态画布(画一次即停)+ 动态画布(持续重绘)+ 外链 css(@import)
const http = require('node:http');
const PAGE = `<!DOCTYPE html><html><head><title>CANVAS-TEST</title>
<link rel="stylesheet" href="/main.css">
</head><body style="margin:0">
<canvas id="static" width="200" height="120"></canvas>
<canvas id="dynamic" width="200" height="120"></canvas>
<h2 id="subcss">SUBCSS-MARK</h2><p id="mark">CANVAS-OK</p>
<script>
  // 静态画布: 画一次即停(v0.82 修复的目标场景——首镜像重建后曾恒空白)
  const sc = document.getElementById('static').getContext('2d');
  sc.fillStyle = '#ff0000'; sc.fillRect(10, 10, 100, 60);
  sc.fillStyle = '#0000ff'; sc.fillRect(30, 30, 100, 60);
  // 动态画布: 持续重绘(60ms 一次)
  const dc = document.getElementById('dynamic').getContext('2d');
  let f = 0;
  setInterval(() => { const c = ((f++ % 14) + 10).toString(16); dc.fillStyle = '#' + c + c + '0000'; dc.fillRect(0, 0, 200, 120); }, 60);
</script></body></html>`;
http.createServer((req, res) => {
  if (req.url === '/main.css') {
    res.writeHead(200, { 'content-type': 'text/css' });
    res.end('@import url("/sub.css");body{background:#f0f0f0}p{color:#333}');
    return;
  }
  if (req.url === '/sub.css') {
    res.writeHead(200, { 'content-type': 'text/css' });
    res.end('h2{color:#007700}');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
}).listen(8098, '127.0.0.1', () => console.log('canvas origin on 8098'));
