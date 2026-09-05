// Contract tests for the adapter that do not need a browser.
//
// The end-to-end conformance — sessions, arbitrary seeks, alpha, cleanup over
// 100 cycles — lives in tools/engine-conformance.mjs, because each case starts
// a real Chrome and that does not belong in `npm test`.
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  ADAPTER_VERSION,
  CAPTURE_PATHS,
  DEFAULT_CAPTURE_PATH,
  DEFAULT_START_DEADLINE_MS,
  EngineError,
  HyperFramesEngine,
  sessionIdentity,
} from '../hyperframesEngine.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = 'C:/nonexistent/chrome-headless-shell.exe';

function binding(overrides = {}) {
  return {
    id: 'binding-1',
    projectRoot: join(here, '..', 'fixture'),
    entryPoint: 'index.html',
    compositionId: 'netsuflow-fixture',
    sourceRevision: 'rev-1',
    width: 1920,
    height: 1080,
    fps: { num: 30, den: 1 },
    ...overrides,
  };
}

test('the engine refuses to guess where Chrome is', () => {
  // resolveHeadlessShellPath would fall back to ~/.cache. A packaged product
  // owns its runtime, and "whichever Chrome was cached" is not a build that can
  // appear in a report.
  for (const bad of [undefined, '', null, 42]) {
    assert.throws(
      () => new HyperFramesEngine({ chromePath: bad }),
      (error) => error instanceof EngineError && error.code === 'ENGINE_MISCONFIGURED',
    );
  }
});

test('probe reports the capabilities the contract asks for', async () => {
  // A synthetic version on purpose: this asserts the value is carried through
  // to the capabilities, not which version is installed. Reading it as the pin
  // is the mistake — the pin is asserted by runtimeManifest.test.mjs, which
  // compares the declared and resolved versions against each other.
  const capabilities = await new HyperFramesEngine({
    chromePath: CHROME,
    enginePackageVersion: '0.0.0-test',
  }).probe();

  assert.equal(capabilities.engine, 'hyperframes');
  assert.equal(capabilities.adapterVersion, ADAPTER_VERSION);
  assert.equal(capabilities.engineVersion, '0.0.0-test');
  assert.equal(capabilities.supportsRandomFrames, true);
  assert.equal(capabilities.supportsAlpha, true);
  assert.deepEqual(capabilities.captureFormats, ['RGBA8']);
  assert.deepEqual(capabilities.capturePaths, [...CAPTURE_PATHS]);
  // Not a guess: BeginFrame is Linux-only, and its compositor does not preserve
  // alpha, so an alpha workflow forces screenshot capture everywhere.
  assert.equal(capabilities.captureMode, 'screenshot');
});

test('a malformed binding is refused before anything starts', async () => {
  const engine = new HyperFramesEngine({ chromePath: CHROME });
  const cases = [
    [undefined, 'BINDING_INVALID'],
    [{}, 'BINDING_INVALID'],
    [binding({ id: '' }), 'BINDING_INVALID'],
    [binding({ sourceRevision: undefined }), 'BINDING_INVALID'],
    [binding({ width: 0 }), 'COMPOSITION_INVALID'],
    [binding({ height: 1.5 }), 'COMPOSITION_INVALID'],
    [binding({ fps: 30 }), 'COMPOSITION_INVALID'],
    [binding({ fps: { num: 0, den: 1 } }), 'COMPOSITION_INVALID'],
    [binding({ startDeadlineMs: 10 }), 'BINDING_INVALID'],
    [binding({ startDeadlineMs: 999_999 }), 'BINDING_INVALID'],
    [binding({ capturePath: 'jpeg' }), 'BINDING_INVALID'],
  ];

  for (const [input, code] of cases) {
    await assert.rejects(
      () => engine.open(input),
      (error) => {
        assert.ok(error instanceof EngineError, `expected EngineError, got ${error}`);
        assert.equal(error.code, code, `for ${JSON.stringify(input)?.slice(0, 60)}`);
        return true;
      },
    );
  }
});

test('session identity covers everything that changes what is rendered', () => {
  const base = sessionIdentity(binding());

  const changes = [
    ['projectRoot', { projectRoot: 'C:/elsewhere' }],
    ['entryPoint', { entryPoint: 'other.html' }],
    ['compositionId', { compositionId: 'other' }],
    ['sourceRevision', { sourceRevision: 'rev-2' }],
    ['propsRevision', { propsRevision: 'props-2' }],
    ['width', { width: 1280 }],
    ['height', { height: 720 }],
    ['fps', { fps: { num: 24, den: 1 } }],
    // Whichever path is not the default: naming one literally made this case
    // stop testing anything the day the default moved to it.
    ['capturePath', { capturePath: CAPTURE_PATHS.find((path) => path !== DEFAULT_CAPTURE_PATH) }],
    // These two look like plumbing and are not: auto can stop waiting for a
    // timeline gsap would have waited for, and the two then produce different
    // pixels for the same frame.
    ['timelineMode', { timelineMode: 'gsap' }],
    ['timelineGraceMs', { timelineGraceMs: 500 }],
    // Also identity, and for a subtler reason: under gsap mode the engine's
    // timeline wait warns rather than throws when it expires, so a shorter
    // deadline can change the pixels and not merely whether the session starts.
    ['startDeadlineMs', { startDeadlineMs: 5000 }],
  ];

  for (const [label, override] of changes) {
    assert.notEqual(sessionIdentity(binding(override)), base, `${label} must change session identity`);
  }
});

test('identity ignores what belongs to the request, not the session', () => {
  const base = sessionIdentity(binding());
  // A frame number or a deadline must never force a new browser.
  assert.equal(sessionIdentity(binding({ frame: 42 })), base);
  assert.equal(sessionIdentity(binding({ deadlineMs: 999 })), base);
  assert.equal(sessionIdentity(binding({ id: 'a-different-binding-id' })), base);
});

test('an invalid timeline mode fails as a binding error, not deep in the engine', async () => {
  const engine = new HyperFramesEngine({ chromePath: CHROME });
  await assert.rejects(
    () => engine.open(binding({ timelineMode: 'gsapp' })),
    (error) => error instanceof EngineError && error.code === 'BINDING_INVALID',
  );
  await assert.rejects(
    () => engine.open(binding({ timelineMode: 'auto', timelineGraceMs: -5 })),
    (error) => error instanceof EngineError && error.code === 'BINDING_INVALID',
  );
});

test('a failed start leaves nothing behind', async () => {
  // Chrome does not exist at that path, so createCaptureSession throws after
  // the project server and the scratch directory already exist. Both have to be
  // gone by the time the error reaches the caller.
  const before = readdirSync(tmpdirPath()).filter(isScratch).length;

  await assert.rejects(
    () => new HyperFramesEngine({ chromePath: CHROME }).open(binding()),
    (error) => {
      assert.ok(error instanceof EngineError, `expected EngineError, got ${error}`);
      assert.notEqual(error.code, undefined);
      return true;
    },
  );

  const after = readdirSync(tmpdirPath()).filter(isScratch).length;
  assert.equal(after, before, 'a failed start leaked a scratch directory');
});

function tmpdirPath() {
  return process.env.TEMP ?? process.env.TMPDIR ?? '/tmp';
}

function isScratch(name) {
  return name.startsWith('netsuflow-hf-');
}

test('a session start is bounded well below the engine default', () => {
  // Measured: a composition that throws during setup spent 46 s before the
  // engine reported it, because its own playerReadyTimeout is 45 s. Behind a
  // Resolve render that reads as a hang.
  assert.equal(DEFAULT_START_DEADLINE_MS, 20_000);
  assert.ok(DEFAULT_START_DEADLINE_MS < 45_000);
});

test('EngineError carries a code and a retryable flag', () => {
  const transient = new EngineError('SESSION_TRANSIENT', 'boom', { retryable: true });
  assert.equal(transient.code, 'SESSION_TRANSIENT');
  assert.equal(transient.retryable, true);
  assert.ok(transient instanceof Error);

  // The default matters: a caller that retries everything would hammer a
  // permanently broken project.
  assert.equal(new EngineError('PROJECT_UNAVAILABLE', 'nope').retryable, false);
});
