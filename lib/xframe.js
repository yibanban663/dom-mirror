'use strict';
// v0.25/0.26 跨源 iframe 同源化：服务端代理抓取 → 页内 sanitize → 存 window.__xyXframe，
// sanitizeClone 的 iframe 分支用它替代占位块。listCandidates/storeSanitized 在 Chromium 页面内执行
const http = require('http');
const https = require('https');

// 页内：待抓取的跨源 iframe src（force=true 重抓既有条目），上限 16
function listCandidates(force) {
  try {
    if (!window.__xyXframe) window.__xyXframe = new Map();
    const out = [];
    for (const f of document.body.querySelectorAll('iframe')) {
      const s = f.src || '';
      if (!/^https?:/i.test(s)) continue;
      let same = false;
      try { same = new URL(s).origin === location.origin; } catch (e) {}
      if (same || (!force && window.__xyXframe.has(s)) || window.__xyXframe.size >= 16) continue;
      out.push(s);
    }
    return out.slice(0, 16);
  } catch (e) { return []; }
}

// 代理抓取：无访客凭据，6s/512KB，仅 2xx text/html；任何失败返回 null（保持占位回退）
function fetchHtml(abs, track) {
  const mod = abs.startsWith('https:') ? https : http;
  return new Promise((resolve) => {
    const req = track(mod.get(abs, { timeout: 6000, headers: { 'user-agent': 'rbi-mirror-xframe', accept: 'text/html' } }, (r) => {
      const ct = (r.headers['content-type'] || '').toLowerCase();
      if ((r.statusCode || 502) < 200 || (r.statusCode || 502) >= 300 || !/text\/html/.test(ct)) { r.resume(); resolve(null); return; }
      let len = 0;
      const chunks = [];
      r.on('data', (c) => { len += c.length; if (len > 512 * 1024) { r.destroy(); resolve(null); } else chunks.push(c); });
      r.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      r.on('error', () => resolve(null));
    }));
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// 页内：剥 script/事件属性，同源资产 URL 改写为 /m/x/<secret>/<b64(origin)>，
// 存 window.__xyXframe；返回内容发生变化的 url 列表
function storeSanitized(list, secret) {
  const changed = [];
  const XP = '/m/x/' + secret + '/';
  const b64 = (s2) => btoa(s2).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  for (const item of list) {
    try {
      const doc = new DOMParser().parseFromString(item.html, 'text/html');
      doc.querySelectorAll('script,noscript,template,link[rel="preload"],link[rel="prefetch"]').forEach((n2) => n2.remove());
      const ifrOrigin = new URL(item.url).origin;
      const toProxy = (v) => {
        if (!v || /^(data:|blob:|#|mailto:|tel:|javascript:|about:)/i.test(v) || /^\/\//.test('' + v)) return v;
        try {
          const abs = new URL(v, item.url);
          if (abs.origin === ifrOrigin) return XP + b64(ifrOrigin) + abs.pathname + abs.search;
          return v;
        } catch (e) { return v; }
      };
      for (const el of doc.querySelectorAll('*')) {
        for (const a of [...el.attributes]) {
          if (/^on/i.test(a.name) || a.name === 'srcdoc' || a.name === 'formaction' || a.name === 'integrity') { el.removeAttribute(a.name); continue; }
          if (a.name === 'src' || a.name === 'href' || a.name === 'poster') {
            try { el.setAttribute(a.name, toProxy(a.value)); } catch (e) {}
          } else if (a.name === 'srcset') {
            try { el.setAttribute('srcset', a.value.split(',').map((p2) => { const t2 = p2.trim(); const sp = t2.search(/\s/); const u2 = sp < 0 ? t2 : t2.slice(0, sp); return toProxy(u2) + (sp < 0 ? '' : t2.slice(sp)); }).join(', ')); } catch (e) {}
          } else if (a.name === 'style') {
            try { el.setAttribute('style', a.value.replace(/url\((['"]?)([^'")]+)\1\)/g, (w2, q2, u3) => { const p3 = toProxy(u3); return p3 === u3 ? w2 : 'url(' + q2 + p3 + q2 + ')'; })); } catch (e) {}
          }
        }
      }
      window.__xy.sanitizeData(doc.body);
      const styles = [...doc.querySelectorAll('style')].map((s3) => s3.textContent).join('\\n');
      const sd = '<!doctype html><html><head><style>' + styles + '</style></head>' + doc.body.innerHTML + '</html>';
      const prevSd = window.__xyXframe.get(item.url);
      window.__xyXframe.set(item.url, sd);
      if (prevSd !== undefined && prevSd !== sd) changed.push(item.url);
    } catch (e) {}
  }
  return changed;
}

module.exports = { listCandidates, fetchHtml, storeSanitized };
