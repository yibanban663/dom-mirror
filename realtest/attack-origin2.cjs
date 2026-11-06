'use strict';
// 参数化恶意源站: PAYLOAD_SET="1,2,3" 环境变量选择载荷
const http = require('node:http');
const SET = new Set((process.env.PAYLOAD_SET || '').split(',').filter(Boolean).map(Number));
const P = {
  1: `<script>alert('P1')</script><span>PK1</span>`,
  2: `<img src=x onerror="alert('P2')"><span>PK2</span>`,
  3: `<a href="javascript:alert('P3')">PK3</a>`,
  4: `<a href=" javascript:alert('P4')">PK4</a>`,
  5: `<iframe src="javascript:alert('P5')" width=10 height=10></iframe><span>PK5</span>`,
  6: `<form action="javascript:alert('P6')"><button>PK6</button></form>`,
  7: `<svg><animate onbegin="alert('P7')" attributeName=x dur=1s></svg><span>PK7</span>`,
  9: `<img srcset="javascript:alert('P9')"><span>PK9</span>`,
  10: `<object data="javascript:alert('P10')"><span>PK10</span></object>`,
  11: `<video><source onerror="alert('P11')">PK11</video>`,
  12: `<meta http-equiv="refresh" content="0;url=javascript:alert('P12')"><span>PK12</span>`,
  13: `<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert('P13')>"><span>PK13</span>`,
  14: `<input type="hidden" value="SECRET"><span>PK14</span>`,
  15: `<div style="width:expression(alert('P15'))"><span>PK15</span></div>`,
  16: `<a href="JaVaScRiPt:alert('P16')">PK16</a>`,
  17: `<span data-xy-id="99999" data-xy-elbit="1">PK17</span>`,
};
const body = [...SET].sort((a, b) => a - b).map(k => P[k] || '').join('\n') + '<p>NORMAL-CONTENT</p>';
http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!DOCTYPE html><html><head><title>AT</title></head><body>' + body + '</body></html>'); }).listen(8099, '127.0.0.1', () => console.log('attack origin set=[' + [...SET].join(',') + '] on 8099'));
