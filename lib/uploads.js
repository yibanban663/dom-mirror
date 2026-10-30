'use strict';

const UPLOAD_CHUNK_BYTES = 32 * 1024;

function createUploads({ maxBytes, maxTotalBytes, maxConcurrent, idleTimeoutMs }) {
  const pending = new Map();
  let reserved = 0;
  let completed = 0;
  function drop(id) {
    const entry = pending.get(id);
    if (!entry) return;
    reserved -= entry.size;
    pending.delete(id);
  }
  return {
    begin(id, entry, now = Date.now()) {
      if (!id || id.length > 128 || pending.has(id)) throw new Error('invalid transfer id');
      if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > maxBytes) throw new Error('file size limit');
      if (pending.size >= maxConcurrent || completed + pending.size >= 64 || reserved + entry.size > maxTotalBytes) throw new Error('session upload limit');
      pending.set(id, { ...entry, got: 0, chunks: [], touched: now });
      reserved += entry.size;
    },
    append(id, encoded, now = Date.now()) {
      const entry = pending.get(id);
      if (!entry) throw new Error('unknown upload');
      try {
        if (typeof encoded !== 'string' || !encoded.length || encoded.length > Math.ceil(UPLOAD_CHUNK_BYTES / 3) * 4
          || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('invalid chunk');
        const chunk = Buffer.from(encoded, 'base64');
        if (!chunk.length || chunk.length > UPLOAD_CHUNK_BYTES || entry.got + chunk.length > entry.size
          || entry.chunks.length >= Math.ceil(entry.size / UPLOAD_CHUNK_BYTES)) throw new Error('chunk or size limit');
        entry.chunks.push(chunk);
        entry.got += chunk.length;
        entry.touched = now;
      } catch (error) { drop(id); throw error; }
    },
    finish(id) {
      const entry = pending.get(id);
      if (!entry) throw new Error('unknown upload');
      if (entry.got !== entry.size) { drop(id); throw new Error('size mismatch'); }
      pending.delete(id);
      completed++;
      // Completed files still occupy the session directory: keep their reservation.
      return entry;
    },
    expire(now = Date.now()) {
      const expired = [...pending].filter(([, entry]) => now - entry.touched >= idleTimeoutMs).map(([id]) => id);
      expired.forEach(drop);
      return expired;
    },
    // v0.39：空闲逐出的在途安全门——有未完成上传时不逐出页面
    hasPending() { return pending.size > 0; },
    clear() { pending.clear(); reserved = 0; completed = 0; },
  };
}

module.exports = { createUploads, UPLOAD_CHUNK_BYTES };
