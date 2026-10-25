'use strict';
const fs = require('node:fs');
const path = require('node:path');
const kinds = ['samples', 'checkpoints', 'collections'];

function mappingCycles(value = '') {
  if (!value) return [];
  const cycles = value.split(',').map(Number);
  if (cycles.some(cycle => !Number.isInteger(cycle) || cycle < 1 || cycle > 60)) throw Error('Invalid MEMORY_MAP_CYCLES');
  return [...new Set(cycles)].sort((a, b) => a - b);
}

function createTrace(directory, storage = 'memory') {
  if (!['memory', 'disk'].includes(storage)) throw Error('Invalid MEMORY_TRACE_STORAGE');
  const rows = Object.fromEntries(kinds.map(kind => [kind, []]));
  const counts = Object.fromEntries(kinds.map(kind => [kind, 0]));
  const files = Object.fromEntries(kinds.map(kind => [kind, path.join(directory, kind + '.jsonl')]));
  for (const kind of kinds) {
    if (storage === 'disk' || kind === 'checkpoints') fs.writeFileSync(files[kind], '', { flag: 'wx' });
  }
  return {
    append(kind, row) {
      if (!kinds.includes(kind)) throw Error('Invalid trace kind');
      if (storage === 'memory') rows[kind].push(row);
      if (storage === 'disk' || kind === 'checkpoints') fs.appendFileSync(files[kind], JSON.stringify(row) + '\n');
      counts[kind]++;
    },
    snapshot: () => ({ traceStorage: storage, traceCounts: { ...counts }, ...rows }),
  };
}

function readTrace(directory, host) {
  if (host.traceStorage === undefined) return host; // Historical in-memory evidence.
  if (!['memory', 'disk'].includes(host.traceStorage)) throw Error('Invalid trace storage');
  const result = { ...host };
  for (const kind of kinds) {
    if (host.traceStorage === 'disk') {
      if (host[kind].length) throw Error('Disk trace retained rows');
      const raw = fs.readFileSync(path.join(directory, kind + '.jsonl'), 'utf8');
      if (raw && !raw.endsWith('\n')) throw Error('Truncated trace: ' + kind);
      result[kind] = raw ? raw.trimEnd().split('\n').map(line => JSON.parse(line)) : [];
    }
    if (!Number.isInteger(host.traceCounts[kind]) || result[kind].length !== host.traceCounts[kind]) throw Error('Trace count mismatch: ' + kind);
  }
  return result;
}
module.exports = { createTrace, readTrace, mappingCycles };
