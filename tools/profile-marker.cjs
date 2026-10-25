'use strict';
// Synthetic source-side raster marker. Used only in isolated presentation probes.
module.exports = function installMarker() {
  let lastEnterAt = null;
  addEventListener('keydown', event => { if (event.key === 'Enter') lastEnterAt = performance.now(); }, true);
  document.addEventListener('DOMContentLoaded', () => {
    const marker = document.createElement('div');
    marker.id = 'profile-raster-marker';
    marker.style.cssText = 'all:initial;position:fixed;right:8px;top:8px;width:24px;height:24px;z-index:2147483000;pointer-events:none;opacity:1;filter:none;mix-blend-mode:normal;background:rgb(24,139,67)';
    document.body.appendChild(marker);
    let previous = -1;
    const update = () => {
      let index = -1;
      for (const e of document.querySelectorAll('a,span')) {
        const match = /^Measured task (\d{2})$/.exec(e.textContent.trim());
        if (match) index = Math.max(index, Number(match[1]));
      }
      if (index <= previous) return;
      previous = index;
      if (lastEnterAt !== null && window.__profileTaskMarker) window.__profileTaskMarker({ index, fromKeyMs: performance.now() - lastEnterAt }).catch(() => {});
      marker.style.background = 'rgb(' + (24 + (index + 1) * 7) + ',139,67)';
    };
    new MutationObserver(update).observe(document.body, { childList: true, characterData: true, subtree: true });
    update();
  }, { once: true });
};
