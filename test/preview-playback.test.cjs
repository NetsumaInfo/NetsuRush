const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function load(file, globals = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports = {};
  new Function('exports', ...Object.keys(globals), js)(exports, ...Object.values(globals));
  return exports;
}

function scheduler() {
  let now = 0, id = 0;
  const frames = new Map();
  const pool = load('src/lib/previewVideoPool.ts', {
    requestAnimationFrame: (fn) => { frames.set(++id, fn); return id; },
    cancelAnimationFrame: (key) => frames.delete(key),
    performance: { now: () => now },
  });
  const tick = (ms = 1000 / 60) => {
    now += ms;
    const due = [...frames.values()]; frames.clear();
    due.forEach((fn) => fn());
  };
  return { pool, tick, frames };
}

test('visible starts precede speculative mounts and every visible card starts', () => {
  const { pool, tick, frames } = scheduler();
  const started = [];
  for (let i = 0; i < 20; i++) pool.requestPreloadMount(i, () => started.push('preload'));
  for (let i = 0; i < 96; i++) pool.requestPlaybackStart(i, () => started.push(i));
  tick();
  assert.ok(started.length > 0 && started.length <= 4, 'creation stays paced');
  assert.ok(started.every((n) => typeof n === 'number'));
  for (let i = 0; i < 120; i++) tick();
  assert.deepEqual(started.slice(0, 96), Array.from({ length: 96 }, (_, i) => i));
  assert.equal(started.length, 116);
  assert.equal(frames.size, 0, 'no idle animation loop');
});

test('scroll cancellation removes obsolete starts without cancelling another grid', () => {
  const { pool, tick, frames } = scheduler();
  const started = [];
  const cancel = pool.requestPlaybackStart(0, () => started.push('left'));
  pool.requestPlaybackStart(1, () => started.push('visible'));
  cancel(); cancel(); tick();
  assert.deepEqual(started, ['visible']);
  assert.equal(frames.size, 0);
});

test('visible videos reclaim the paused cache without evicting playing videos', () => {
  const { pool } = scheduler();
  let evicted = 0;
  for (let i = 0; i < 18; i++) pool.retainPausedVideo(() => evicted++);
  const release = Array.from({ length: 72 }, () => pool.retainPlayingVideo());
  assert.equal(evicted, 18);
  release.forEach((fn) => { fn(); fn(); });
  pool.retainPausedVideo(() => evicted++);
  assert.equal(evicted, 18, 'idempotent release restores room for preloading');
});

test('a full paused cache defers speculative creation but never a visible start', () => {
  const { pool, tick, frames } = scheduler();
  const release = Array.from({ length: 18 }, () => pool.retainPausedVideo(() => {}));
  const started = [];
  pool.requestPreloadMount(0, () => started.push('preload'));
  pool.requestPlaybackStart(1, () => started.push('visible'));
  tick(); tick();
  assert.deepEqual(started, ['visible']);
  assert.equal(frames.size, 0, 'wait for room instead of polling');
  release[0](); tick();
  assert.deepEqual(started, ['visible', 'preload']);
});

function media() {
  const listeners = new Map();
  const calls = [];
  const video = {
    paused: true, muted: false,
    play() {
      this.paused = false;
      return new Promise((resolve, reject) => calls.push({ resolve, reject }));
    },
    pause() { this.paused = true; },
    addEventListener(name, fn) { listeners.set(name, fn); },
    removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
  };
  return { video, calls, emit: (name) => listeners.get(name)?.(), listeners };
}

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
test('a rejected old play cannot restart a paused or replaced preview', async () => {
  const { startPreviewPlayback } = load('src/lib/previewPlayback.ts');
  const { video, calls, listeners } = media();
  const stop = startPreviewPlayback(video);
  stop(); video.pause();
  calls[0].reject({ name: 'NotAllowedError' }); await flush();
  assert.equal(calls.length, 1);
  assert.equal(video.paused, true);
  assert.equal(listeners.size, 0);
});

test('autoplay denial retries muted once, while abort waits for readiness', async () => {
  const { startPreviewPlayback } = load('src/lib/previewPlayback.ts');
  const { video, calls, emit } = media();
  const stop = startPreviewPlayback(video);
  video.paused = true;
  calls[0].reject({ name: 'NotAllowedError' }); await flush();
  assert.equal(calls.length, 2); assert.equal(video.muted, true);
  video.paused = true;
  calls[1].reject({ name: 'AbortError' }); await flush();
  assert.equal(calls.length, 2);
  emit('canplay'); assert.equal(calls.length, 3);
  calls[2].resolve(); await flush();
  emit('canplay'); assert.equal(calls.length, 3, 'already playing is untouched');
  stop();
});

test('PreviewVideo restores its source on effect replay and restarts after URL replacement', async () => {
  const { video, calls } = media();
  const attributes = new Map();
  let loads = 0, cursor = 0;
  const states = [], effects = [], changes = [];
  Object.assign(video, {
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute: (name, value) => {
      if (name === 'src' && attributes.get(name) !== value) video.paused = true;
      attributes.set(name, value);
    },
    removeAttribute: (name) => attributes.delete(name),
    load: () => { loads++; },
  });
  const react = {
    useRef: (initial) => { const i = cursor++; return states[i] ??= { current: initial }; },
    useState: (initial) => {
      const i = cursor++;
      if (!(i in states)) states[i] = initial;
      return [states[i], (value) => { states[i] = value; }];
    },
    useEffect: (setup, deps) => {
      const i = cursor++;
      const old = effects[i];
      if (!old || deps.some((dep, n) => !Object.is(dep, old.deps[n]))) changes.push({ i, setup, deps });
    },
  };
  const playback = load('src/lib/previewPlayback.ts');
  const { PreviewVideo } = load('src/components/player/PreviewVideo.tsx', {
    require: (name) => {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }) };
      if (name === '@/store') return { useApp: (select) => select({ hoverVolume: 0.5, hoverMuted: true, playerVolume: 1 }) };
      if (name === '@/lib/remote') return { IS_REMOTE: false };
      if (name === '@/lib/previewPlayback') return playback;
      throw new Error(`Unexpected import ${name}`);
    },
  });
  const render = (url, paused = false) => {
    cursor = 0;
    const node = PreviewVideo({ url, paused, label: '', onError: () => {} });
    node.props.ref.current = video;
    video.setAttribute('src', url); // React's DOM mutation precedes effect cleanup.
    for (const { i } of changes) effects[i]?.cleanup?.();
    for (const change of changes.splice(0)) effects[change.i] = { ...change, cleanup: change.setup() };
  };
  render('first.mp4');
  assert.equal(calls.length, 1);
  render('second.mp4');
  assert.equal(video.getAttribute('src'), 'second.mp4');
  assert.equal(calls.length, 2, 'a new URL explicitly starts');
  for (const effect of effects) effect?.cleanup?.();
  for (const effect of effects) if (effect) effect.cleanup = effect.setup();
  assert.equal(video.getAttribute('src'), 'second.mp4');
  assert.equal(calls.length, 3, 'development effect replay resumes playback');
  render('second.mp4', true);
  calls.forEach(({ reject }) => reject({ name: 'NotAllowedError' }));
  await flush();
  assert.equal(calls.length, 3, 'obsolete promises cannot undo pause');
  assert.equal(video.paused, true);
  for (const effect of effects) effect?.cleanup?.();
  assert.equal(video.getAttribute('src'), null);
  assert.equal(loads, 3, 'replay, replacement and unmount unload the media');
});
