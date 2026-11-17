'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(process.argv[2]);
const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const archive = read('archive.json');
const negative = read('provenance-negative.json');
assert.equal(negative.pass, true);
assert.deepEqual(negative.checks.map(row => row.name),
  ['changed-archive', 'changed-installed-file', 'source-directory-fallback', 'node-path-fallback']);
assert.ok(negative.checks.every(row => row.rejected));
const suites = {};
for (const [suite, modes, browsers] of [['core', ['direct', 'dom', 'frame'], 2], ['recovery', ['dom', 'frame'], 6]]) {
  const results = read(suite + '/result.json');
  assert.deepEqual(results.map(row => row.mode), modes);
  assert.ok(results.every(row => row.pass && row.steps.length && row.steps.every(step => step.pass)));
  for (const row of results) assert.deepEqual(row.steps.map(step => step.name), suite === 'core'
    ? ['login', 'create', 'priority', 'complete']
    : ['login-route-draft', 'committed-without-ui-confirmation', 'same-account-isolation', 'expiry-and-explicit-restart']);
  const lifecycle = read(suite + '/package-lifecycle.json');
  assert.equal(lifecycle.pass, true);
  assert.equal(lifecycle.activeSessionClosed, true);
  assert.equal(lifecycle.repeatedClosePassed, true);
  assert.equal(lifecycle.hostRemainsAlive, true);
  assert.equal(lifecycle.closedMirrorStatus, 503);
  for (const [key, count] of [['before', browsers], ['after', browsers + 1]]) {
    const state = lifecycle[key];
    assert.equal(state.archiveSha256, archive.archiveSha256);
    assert.equal(state.integrity, archive.integrity);
    assert.equal(state.name, archive.name);
    assert.equal(state.version, archive.version);
    assert.equal(state.verifiedArchiveFiles, Object.keys(archive.files).length);
    assert.equal(state.sourceCheckoutAbsent, true);
    assert.equal(state.loadedModulesInsideConsumer, true);
    // v0.30 池化：会话资源=上下文（浏览器常驻）——reclaimed 断言移到 contexts
    assert.ok(state.contexts.length >= count, 'contexts ' + state.contexts.length + ' < ' + count);
    assert.ok(state.contexts.every(row => row.closed));
    assert.equal(state.lockSha256, crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(root, suite, 'consumer-lock.json'))).digest('hex'));
  }
  const containers = read(suite + '/containers.json');
  assert.equal(containers.length, 2);
  assert.ok(containers.every(container => !container.State.OOMKilled));
  assert.equal(containers[1].State.ExitCode, 0);
  assert.equal(containers[0].Image, containers[1].Image);
  suites[suite] = { results, lifecycle, image: containers[0].Image, noOOM: true };
}
assert.equal(suites.core.image, suites.recovery.image);
assert.equal(suites.core.lifecycle.before.lockSha256, suites.recovery.lifecycle.before.lockSha256);
const result = { pass: true, name: archive.name, version: archive.version, archiveSha256: archive.archiveSha256,
  integrity: archive.integrity, negative, suites };
fs.writeFileSync(path.join(root, 'summary.json'), JSON.stringify(result, null, 2) + '\n');
console.log('Packed consumer: core 3/3, recovery 2/2, provenance and lifecycle passed');
