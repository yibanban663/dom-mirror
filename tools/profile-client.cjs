'use strict';
// Observe actual canvas pixels; mirrored HTML alone cannot satisfy this probe.
module.exports = function installClientProbe() {
  let pending;
  const imageMetadata = new WeakMap(), urls = new Map();
  const NativeSocket = WebSocket;
  window.WebSocket = class extends NativeSocket {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', event => {
        const receivedAt = performance.now();
        let message; try { message = JSON.parse(event.data); } catch { return; }
        if (!pending || message.type !== 'anim-tiles' || message._profile?.op !== pending.index) return;
        for (const tile of message.tiles || []) urls.set(tile.url, { server: message._profile, receivedAt });
      });
    }
    send(raw) {
      let message; try { message = JSON.parse(raw); } catch { return super.send(raw); }
      if (pending && message.type === 'key' && message.action === 'down' && message.key === 'Enter') {
        message._profileOp = pending.index;
        raw = JSON.stringify(message);
      }
      return super.send(raw);
    }
  };
  const srcDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    ...srcDescriptor,
    set(value) {
      const metadata = urls.get(value);
      if (metadata) {
        const record = { ...metadata, assignedAt: performance.now(), loadedAt: null };
        imageMetadata.set(this, record);
        this.addEventListener('load', () => { record.loadedAt = performance.now(); }, { once: true });
      }
      srcDescriptor.set.call(this, value);
    },
  });
  const original = CanvasRenderingContext2D.prototype.drawImage;
  function inspect(context, image, drawCallStart, drawCallEnd) {
    const p = pending;
    if (!p || p.keyAt === null || p.drawAt !== null) return;
    const readbackStart = performance.now();
    const pixel = context.getImageData(1260, 20, 1, 1).data;
    if (pixel[0] !== p.red || pixel[1] !== 139 || pixel[2] !== 67 || pixel[3] !== 255) return;
    p.drawAt = performance.now();
    p.pixelReadbackMs = p.drawAt - readbackStart;
    p.drawCallMs = drawCallEnd - drawCallStart;
    p.drawCallEnd = drawCallEnd;
    const metadata = imageMetadata.get(image);
    if (metadata?.server.op === p.index) p.trace = metadata;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (pending === p) p.paintAt = performance.now();
    }));
  }
  CanvasRenderingContext2D.prototype.drawImage = function (...args) {
    const layer = this.canvas.classList.contains('xy-tiles');
    if (layer && pending?.skipDraw) return;
    const callStart = performance.now();
    const result = original.apply(this, args);
    const callEnd = performance.now();
    if (layer) inspect(this, args[0], callStart, callEnd);
    return result;
  };
  addEventListener('keydown', event => {
    if (event.key === 'Enter' && pending && pending.keyAt === null) pending.keyAt = performance.now();
  }, true);
  window.__profileArm = (title, index, skipDraw) => {
    pending?.observer.disconnect();
    urls.clear();
    const root = document.querySelector('#mirrorHost').shadowRoot;
    const p = { title, index, red: 24 + (index + 1) * 7, skipDraw, keyAt: null, domAt: null, drawAt: null, paintAt: null, trace: null };
    p.observer = new MutationObserver(() => {
      if (p.keyAt === null || p.domAt !== null) return;
      if ([...root.querySelectorAll('a,span')].some(e => e.textContent.trim() === title)) p.domAt = performance.now();
    });
    p.observer.observe(root, { subtree: true, childList: true, characterData: true });
    pending = p;
  };
  window.__profileSetSkip = skip => { pending.skipDraw = skip; };
  window.__profileRead = () => {
    const p = pending;
    if (!p) return null;
    const elapsed = at => at !== null && p.keyAt !== null ? at - p.keyAt : null;
    const t = p.trace;
    return {
      keydownObserved: p.keyAt !== null, domMs: elapsed(p.domAt), drawMs: elapsed(p.drawAt), paintOpportunityMs: elapsed(p.paintAt),
      correlation: t ? {
        server: t.server, keyToReceiveMs: t.receivedAt - p.keyAt,
        receiveToImageSrcMs: t.assignedAt - t.receivedAt,
        imageSrcToLoadMs: t.loadedAt === null ? null : t.loadedAt - t.assignedAt,
        loadToDrawMs: t.loadedAt === null ? null : p.drawAt - t.loadedAt,
        receiveToDrawMs: p.drawAt - t.receivedAt,
        canvasDrawCallMs: p.drawCallMs, pixelReadbackMs: p.pixelReadbackMs,
        loadToDrawCallEndMs: t.loadedAt === null ? null : p.drawCallEnd - t.loadedAt,
        residualMs: t.receivedAt - p.keyAt - t.server.enterReceivedToSerializeMs,
      } : null,
    };
  };
};
