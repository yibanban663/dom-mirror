'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const input = require('../lib/input');

function fakeCdp() {
  const sent = [];
  return { sent, send: async (method, args) => { sent.push([method, args]); } };
}
function fakePage(result) {
  const calls = [];
  return { calls, evaluate: async (fn, ...args) => { calls.push(args); return result; } };
}

test('mouse applies the anchor offset measured on the source page', async () => {
  const cdp = fakeCdp();
  const page = fakePage({ dx: 5, dy: -3 });
  await input.mouse(page, cdp, { action: 'down', x: 10, y: 20, aid: 7, ax: 1, ay: 2 });
  assert.deepEqual(page.calls, [[7, 1, 2]]);
  assert.deepEqual(cdp.sent, [['Input.dispatchMouseEvent',
    { x: 15, y: 17, button: 'left', type: 'mousePressed', clickCount: 1, buttons: 1 }]]);
});

test('mouse without an anchor dispatches raw coordinates and skips the page', async () => {
  const cdp = fakeCdp();
  const page = fakePage(null);
  await input.mouse(page, cdp, { action: 'wheel', x: 1, y: 2, dy: 40 });
  assert.equal(page.calls.length, 0);
  assert.deepEqual(cdp.sent[0][1], { x: 1, y: 2, button: 'left', type: 'mouseWheel', deltaX: 0, deltaY: 40 });
});

test('named keys use virtual key codes and Enter carries a carriage return', async () => {
  const cdp = fakeCdp();
  await input.key(cdp, { key: 'Enter', action: 'down' });
  await input.key(cdp, { key: 'Enter', action: 'up' });
  await input.key(cdp, { key: 'x', text: 'x', action: 'down' });
  await input.key(cdp, { key: 'Shift' });
  assert.deepEqual(cdp.sent.map(([, a]) => a), [
    { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' },
    { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
    { type: 'keyDown', text: 'x', key: 'x', unmodifiedText: 'x' },
  ]);
});

test('touch end releases the reported points', async () => {
  const cdp = fakeCdp();
  await input.touch(cdp, { kind: 'end', pts: [[1.4, 2.6]] });
  assert.deepEqual(cdp.sent[0][1], { type: 'touchEnd', touchPoints: [], releaseTouchPoints: [{ x: 1, y: 3 }] });
  await assert.rejects(input.touch(cdp, { kind: 'move', pts: [null] }));
});

test('composition clamps the selection to the code point length and focuses the target', async () => {
  const cdp = fakeCdp();
  const page = fakePage();
  await input.composition(page, cdp, { id: 3, text: '中文', s: '-1', e: '9' });
  assert.deepEqual(page.calls, [[3]]);
  assert.deepEqual(cdp.sent, [['Input.imeSetComposition', { text: '中文', selectionStart: 0, selectionEnd: 2 }]]);
  await input.compositionCommit(fakePage(), cdp, { text: '好' });
  assert.deepEqual(cdp.sent[1], ['Input.insertText', { text: '好' }]);
});
