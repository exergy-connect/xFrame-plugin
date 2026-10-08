const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/recordingRegion.js'), 'utf8'), context);
const region = { x: 100, y: 50, width: 200, height: 100, viewportWidth: 800, viewportHeight: 600 };
const rect = (...args) => JSON.parse(JSON.stringify(context.recordingRegionRect(...args)));

test('maps viewport coordinates to HiDPI video pixels', () => {
  assert.deepEqual(rect(region, 1600, 1200), { x: 200, y: 100, width: 400, height: 200 });
});
test('tracks the same proportional area when the tab is resized', () => {
  assert.deepEqual(rect(region, 800, 900), { x: 100, y: 75, width: 200, height: 150 });
});
test('clamps selection boundaries to the captured viewport', () => {
  assert.deepEqual(rect({ ...region, x: -10, y: 550, width: 100, height: 100 }, 800, 600),
    { x: 0, y: 550, width: 90, height: 50 });
});
test('rejects empty, nonfinite, missing, and out-of-bounds regions', () => {
  for (const invalid of [null, { ...region, width: 0 }, { ...region, x: NaN },
    { ...region, viewportWidth: 0 }, { ...region, x: 900 }, { ...region, height: 1 }]) {
    assert.throws(() => rect(invalid, 800, 600), /Invalid recording region|too small/);
  }
});
