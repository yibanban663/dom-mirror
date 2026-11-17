'use strict';
// v0.64 接入向导：被白名单拦截的资源域收集与建议输出。
// 保真根因：源站资源被拦 → 服务端渲染不完整 → 镜像布局漂移（实测
// ruanyifeng 图床被拦 → 布局偏移 173px）。拦截日志里就有答案——聚合
// 成会话级建议，宿主据此补 requestOrigins。只做"发现+建议"，不做自动
// 放行（白名单边界不因流量自主扩大）。

function createBlockedOriginTracker({ topN = 10 } = {}) {
  const origins = new Map(); // origin -> count

  return {
    record(origin, _resourceType) {
      if (typeof origin !== 'string' || !origin) return;
      const n = origins.get(origin) || 0;
      origins.set(origin, n + 1);
    },
    rows() {
      return [...origins.entries()]
        .map(([origin, count]) => ({ origin, count }))
        .sort((a, b) => b.count - a.count || a.origin.localeCompare(b.origin));
    },
    top(n = topN) {
      return this.rows().slice(0, Math.max(0, n));
    },
    summary() {
      const rows = this.rows().slice(0, topN);
      if (!rows.length) return '';
      // 单行化：origin 来自外部 URL host，防御性压掉换行（日志注入面）
      const parts = rows.map(r => `${r.origin.replace(/[\r\n]+/g, '')}×${r.count}`);
      return `被拦截资源域 Top${rows.length}（若布局异常可加入 requestOrigins）: ${parts.join(', ')}`;
    },
  };
}

module.exports = { createBlockedOriginTracker };
