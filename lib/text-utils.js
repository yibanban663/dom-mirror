'use strict';
// v0.76 抽取：壳 HTML 注释剥离（纯函数，单元测试锚点；v0.55 中文注释
// 跨行泄漏事故的看门人）。server.js 启动期消费。
function stripClientComments(html) {
  let out = html.replace(/<!--[\s\S]*?-->/g, '');
  // 引擎身份串不外泄（指纹化目标）：标题/页头等处的产品名统一中性化
  out = out.replace(/dom-mirror/gi, 'mirror');
  const kept = [];
  let inBlock = false;
  for (const line of out.split('\n')) {
    if (inBlock) {
      const c = line.indexOf('*/');
      if (c < 0) continue; // 块内整行丢弃
      inBlock = false;
      const rest = line.slice(c + 2);
      if (rest.trim() && !rest.trim().startsWith('//')) kept.push(rest); // 块尾同行残余代码保留
      continue;
    }
    let s = line;
    for (;;) {
      const o2 = s.indexOf('/*');
      if (o2 < 0) break;
      const c2 = s.indexOf('*/', o2 + 2);
      if (c2 >= 0) { s = s.slice(0, o2) + ' ' + s.slice(c2 + 2); continue; } // 行内完整对
      s = s.slice(0, o2); // 跨行块：保留 /* 前代码，进入块模式
      inBlock = true;
      break;
    }
    if (s.trim().startsWith('//')) continue; // 行首 // 整行
    kept.push(s);
  }
  return kept.join('\n');
}

module.exports = { stripClientComments };
