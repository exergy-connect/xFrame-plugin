const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function harness() {
  const activations = [];
  const context = vm.createContext({
    document: { getElementById: () => null },
    window: { location: { search: '' } },
    URLSearchParams,
    console,
    // Leave the page bootstrap idle; exercise its media loader directly.
    getLastRecording: () => new Promise(() => {}),
    setTimeout: (fn, ms) => setTimeout(fn, ms === 30_000 ? 20 : ms),
    clearTimeout,
    chrome: {
      runtime: { sendMessage: async () => ({ ok: true }) },
      tabs: {
        getCurrent: async () => ({ id: 42 }),
        update: async (id, options) => activations.push({ id, options }),
      },
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/gifMaker.js'), 'utf8'), context);
  return { context, activations };
}

class Video extends EventTarget {
  readyState = 0;
  videoWidth = 0;
  videoHeight = 0;
  loads = 0;
  pauses = 0;
  load() { this.loads++; }
  pause() { this.pauses++; }
  metadata(width = 320, height = 180) {
    this.readyState = 1;
    this.videoWidth = width;
    this.videoHeight = height;
    this.dispatchEvent(new Event('loadedmetadata'));
  }
}

test('muted playback starts loading when preload does not produce metadata', async () => {
  const { context, activations } = harness();
  const video = new Video();
  video.play = async () => video.metadata();
  await context.loadRecordingVideo(video, 'blob:recording');
  assert.equal(video.loads, 1);
  assert.equal(video.pauses, 1);
  assert.equal(activations.length, 0);
});

test('stalled background loading retries after activating the maker tab', async () => {
  const { context, activations } = harness();
  const video = new Video();
  video.play = async () => { if (activations.length) video.metadata(); };
  await context.loadRecordingVideo(video, 'blob:recording');
  assert.equal(video.loads, 2);
  assert.equal(video.pauses, 2);
  assert.equal(activations[0].id, 42);
  assert.equal(activations[0].options.active, true);
});

test('audio-only metadata fails immediately without a visibility retry', async () => {
  const { context, activations } = harness();
  const video = new Video();
  video.play = async () => video.metadata(0, 0);
  await assert.rejects(context.loadRecordingVideo(video, 'blob:audio'), /no video frames/);
  assert.equal(video.loads, 1);
  assert.equal(video.pauses, 1);
  assert.equal(activations.length, 0);
});

test('autoplay rejection does not prevent metadata loading', async () => {
  const { context } = harness();
  const video = new Video();
  video.play = () => {
    queueMicrotask(() => video.metadata());
    return Promise.reject(new Error('Autoplay denied'));
  };
  await context.loadRecordingVideo(video, 'blob:recording');
  assert.equal(video.pauses, 1);
});

test('a second stalled load reports the timeout rather than retrying forever', async () => {
  const { context, activations } = harness();
  const video = new Video();
  video.play = async () => {};
  await assert.rejects(context.loadRecordingVideo(video, 'blob:recording'), /Timed out waiting for video metadata/);
  assert.equal(video.loads, 2);
  assert.equal(video.pauses, 2);
  assert.equal(activations.length, 1);
});

test('decoder errors fail immediately without a visibility retry', async () => {
  const { context, activations } = harness();
  const video = new Video();
  video.play = async () => {
    video.error = { code: 4 };
    video.dispatchEvent(new Event('error'));
  };
  await assert.rejects(context.loadRecordingVideo(video, 'blob:invalid'), /Could not load the recording \(code 4\)/);
  assert.equal(video.loads, 1);
  assert.equal(video.pauses, 1);
  assert.equal(activations.length, 0);
});
