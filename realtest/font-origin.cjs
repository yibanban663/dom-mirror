'use strict';
// 字体对齐测试源站: 中文本地字体栈(直通 FONT_ALIGN 的替换目标)
const http = require('node:http');
const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>FONT-TEST</title>
<style>
.t1 { font-family: "Microsoft YaHei", "微软雅黑", sans-serif; font-size: 24px; }
.t2 { font-family: "SimSun", "宋体", serif; font-size: 24px; }
.t3 { font-family: system-ui, -apple-system, sans-serif; font-size: 24px; }
.t4 { font-family: Georgia, serif; font-size: 24px; }
</style></head><body>
<div class="t1" id="t1">字体对齐测试第一行 Microsoft YaHei</div>
<div class="t2" id="t2">宋体测试第二行 SimSun</div>
<div class="t3" id="t3">系统字体第三行 system-ui</div>
<div class="t4" id="t4">Georgia serif fourth line</div>
</body></html>`;
http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(req.url === '/page2' ? '<!DOCTYPE html><html><body><p style="font-size:40px">PAGE2-MARK</p></body></html>' : PAGE);
}).listen(8098, '127.0.0.1', () => console.log('font origin on 8098'));
