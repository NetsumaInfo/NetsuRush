// The common conformance suite, run against the real HyperFrames adapter.
//
// docs/04-engine-contract.md lists what every adapter must do. This is that
// list, executed. A future Remotion adapter runs the same file with a different
// engine, which is the only way the abstraction stays real rather than nominal.
//
// Not part of `npm test`: every case starts a real Chrome, and the lifecycle
// case starts a hundred of them.
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { HyperFramesEngine, EngineError } from '../hyperframesEngine.mjs';
import { buildRuntimeManifest } from '../runtimeManifest.mjs';

const HERE = resolve(import.meta.dirname, '..');
const CHROME = join(
  HERE,
  '.browser',
  'chrome-headless-shell',
  'win64-152.0.7977.54',
  'chrome-headless-shell-win64',
  'chrome-headless-shell.exe',
);

const CYCLES = Number(process.env.NETSUFLOW_CONFORMANCE_CYCLES ?? 100);

const engine = new HyperFramesEngine({
  chromePath: CHROME,
  enginePackageVersion: buildRuntimeManifest().engine.resolvedVersion,
});

function binding(overrides = {}) {
  return {
    id: 'conformance',
    projectRoot: join(HERE, 'fixture'),
    entryPoint: 'index.html',
    compositionId: 'netsuflow-fixture',
    sourceRevision: 'rev-1',
    width: 1920,
    height: 1080,
    fps: { num: 30, den: 1 },
    timelineMode: 'auto',
    ...overrides,
  };
}

const results = [];

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`ok    ${name}${detail ? `  ${detail}` : ''}`);
  } catch (error) {
    results.push({ name, ok: false, detail: error?.message ?? String(error) });
    console.log(`FAIL  ${name}  ${error?.message ?? error}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function digest(pixels) {
  // Cheap content hash; the reference capture already does the byte-exact work.
  let h = 0x811c9dc5;
  for (let i = 0; i < pixels.length; i += 997) {
    h = Math.imul(h ^ pixels[i], 0x01000193) >>> 0;
  }
  return h.toString(16);
}

function frameMarker(pixels) {
  let value = 0;
  for (let i = 0; i < 4; i += 1) value = ((value << 8) | pixels[i * 4]) >>> 0;
  return value;
}

function scratchCount() {
  const dir = process.env.TEMP ?? process.env.TMPDIR ?? '/tmp';
  return readdirSync(dir).filter((n) => n.startsWith('netsuflow-hf-')).length;
}

// --- probe and descriptor ----------------------------------------------------

await check('probe reports a concrete engine version', async () => {
  const capabilities = await engine.probe();
  assert(capabilities.engineVersion, 'engineVersion must not be null');
  return `engine ${capabilities.engineVersion}, capture ${capabilities.captureMode}`;
});

await check('describe matches the fixture', async () => {
  const session = await engine.open(binding());
  try {
    const descriptor = await session.describe();
    assert(descriptor.width === 1920 && descriptor.height === 1080, 'wrong dimensions');
    assert(descriptor.fpsNumerator === 30 && descriptor.fpsDenominator === 1, 'wrong fps');
    assert(descriptor.durationFrames === 300, `durationFrames was ${descriptor.durationFrames}`);
    return `${descriptor.durationFrames} frames at ${descriptor.fpsNumerator}/${descriptor.fpsDenominator}`;
  } finally {
    await session.close();
  }
});

// --- arbitrary frame order ---------------------------------------------------

await check('first, repeated, sequential, reverse and random frames', async () => {
  const session = await engine.open(binding());
  try {
    const order = [0, 0, 1, 2, 3, 299, 150, 7, 299, 0, 88, 88];
    const seen = new Map();

    for (const frame of order) {
      const rendered = await session.renderFrame({ frame, deadlineMs: 20_000 });
      assert(rendered.pixelFormat === 'RGBA8', 'wrong pixel format');
      assert(rendered.alphaMode === 'straight', 'wrong alpha mode');
      assert(rendered.stride === 1920 * 4, `stride was ${rendered.stride}`);
      assert(rendered.pixels.length === 1920 * 1080 * 4, 'wrong pixel count');

      const marker = frameMarker(rendered.pixels);
      assert(marker === frame, `frame ${frame} painted marker ${marker}`);

      const hash = digest(rendered.pixels);
      if (seen.has(frame)) {
        assert(seen.get(frame) === hash, `frame ${frame} differed between two requests`);
      }
      seen.set(frame, hash);
    }
    return `${order.length} requests, ${seen.size} distinct frames, all idempotent`;
  } finally {
    await session.close();
  }
});

await check('the alpha capture path agrees with the buffer path', async () => {
  // Both paths must produce the same canonical bytes, or the switch is a
  // choice between two different pictures rather than two ways to the same one.
  const bufferSession = await engine.open(binding({ capturePath: 'buffer' }));
  let bufferHash;
  try {
    bufferHash = digest((await bufferSession.renderFrame({ frame: 150 })).pixels);
  } finally {
    await bufferSession.close();
  }

  const alphaSession = await engine.open(binding({ capturePath: 'alpha' }));
  try {
    const rendered = await alphaSession.renderFrame({ frame: 150 });
    assert(frameMarker(rendered.pixels) === 150, 'alpha path painted the wrong frame');
    const alphaHash = digest(rendered.pixels);
    return alphaHash === bufferHash
      ? 'identical'
      : `DIFFERENT (buffer ${bufferHash}, alpha ${alphaHash}) — worth understanding before either becomes the default`;
  } finally {
    await alphaSession.close();
  }
});

await check('alpha survives to the caller', async () => {
  const session = await engine.open(binding());
  try {
    const { pixels } = await session.renderFrame({ frame: 0 });
    const at = (x, y) => pixels.subarray((y * 1920 + x) * 4, (y * 1920 + x) * 4 + 4);
    const empty = at(1860, 1060);
    const half = at(1190, 260);
    assert(empty[3] === 0, `untouched area had alpha ${empty[3]}`);
    assert(half[3] === 128, `50% region had alpha ${half[3]}`);
    assert(half[0] === 255, 'straight alpha expected: premultiplied would have darkened the colour');
    return `empty rgba(${[...empty]}), half rgba(${[...half]})`;
  } finally {
    await session.close();
  }
});

// --- errors, deadlines, invalidation ----------------------------------------

await check('a broken composition fails with a named code, not a hang', async () => {
  const started = Date.now();
  try {
    const session = await engine.open(
      binding({ projectRoot: join(HERE, 'fixture-broken'), compositionId: 'netsuflow-fixture-broken' }),
    );
    await session.close();
    throw new Error('a composition that never exposes __hf must not open');
  } catch (error) {
    assert(error instanceof EngineError, `expected EngineError, got ${error?.name}: ${error?.message}`);
    assert(error.code === 'COMPOSITION_NOT_READY', `code was ${error.code}`);
    return `${error.code} after ${Math.round((Date.now() - started) / 1000)}s`;
  }
});

await check('an impossible deadline is refused promptly', async () => {
  const session = await engine.open(binding());
  try {
    const started = Date.now();
    try {
      await session.renderFrame({ frame: 42, deadlineMs: 1 });
      throw new Error('a 1 ms deadline should not have been met');
    } catch (error) {
      assert(error instanceof EngineError, `expected EngineError, got ${error}`);
      assert(error.code === 'FRAME_TIMEOUT', `code was ${error.code}`);
      assert(error.retryable === true, 'a timeout should be retryable');
      const elapsed = Date.now() - started;
      assert(elapsed < 2000, `took ${elapsed} ms to report a 1 ms deadline`);
      return `${error.code} in ${elapsed} ms`;
    }
  } finally {
    await session.close();
  }
});

await check('an aborted request is refused without rendering', async () => {
  const session = await engine.open(binding());
  try {
    const controller = new AbortController();
    controller.abort();
    try {
      await session.renderFrame({ frame: 5, signal: controller.signal });
      throw new Error('an aborted request should not render');
    } catch (error) {
      assert(error.code === 'FRAME_ABORTED', `code was ${error.code}`);
      return error.code;
    }
  } finally {
    await session.close();
  }
});

await check('invalidate reuses the session only when identity holds', async () => {
  const session = await engine.open(binding());
  try {
    const reused = await session.invalidate(binding({ id: 'another-binding-id' }));
    assert(reused.reused === true, 'an identity-preserving change should reuse the session');

    try {
      await session.invalidate(binding({ sourceRevision: 'rev-2' }));
      throw new Error('a source revision change must not reuse the session');
    } catch (error) {
      assert(error.code === 'SESSION_REBUILD_REQUIRED', `code was ${error.code}`);
    }
    return 'reuse and rebuild both correct';
  } finally {
    await session.close();
  }
});

await check('a closed session refuses work', async () => {
  const session = await engine.open(binding());
  await session.close();
  try {
    await session.renderFrame({ frame: 0 });
    throw new Error('a closed session should not render');
  } catch (error) {
    assert(error.code === 'SESSION_CLOSED', `code was ${error.code}`);
  }
  const second = await session.close();
  assert(second.alreadyClosed === true, 'close must be idempotent');
  return 'SESSION_CLOSED, and close is idempotent';
});

await check('the timeline shim reports when it took a decision', async () => {
  const session = await engine.open(binding({ timelineMode: 'auto' }));
  try {
    const { diagnostics } = await session.renderFrame({ frame: 0 });
    assert(diagnostics.length === 1, `expected one diagnostic, got ${diagnostics.length}`);
    assert(/stopped waiting for a GSAP timeline/.test(diagnostics[0]), 'wrong diagnostic');
    assert(/timelineMode: 'gsap'/.test(diagnostics[0]), 'the diagnostic must name the fix');
    return 'warned, and named the mode that removes the deadline';
  } finally {
    await session.close();
  }
});

await check('a composition that registers a timeline is not warned about', async () => {
  const session = await engine.open(
    binding({
      projectRoot: join(HERE, 'fixture-gsap'),
      compositionId: 'netsuflow-fixture-gsap',
      width: 960,
      height: 540,
      fps: { num: 30, den: 1 },
    }),
  );
  try {
    const { diagnostics } = await session.renderFrame({ frame: 10 });
    assert(diagnostics.length === 0, `unexpected diagnostics: ${diagnostics.join(' | ')}`);
    return 'no diagnostics, as it should be';
  } finally {
    await session.close();
  }
});

// --- lifecycle ---------------------------------------------------------------

await check(`${CYCLES} open/close cycles leak nothing`, async () => {
  const scratchBefore = scratchCount();
  const rssBefore = process.memoryUsage().rss;

  for (let i = 0; i < CYCLES; i += 1) {
    const session = await engine.open(binding({ sourceRevision: `rev-${i}` }));
    const rendered = await session.renderFrame({ frame: i % 300, deadlineMs: 30_000 });
    assert(rendered.pixels.length === 1920 * 1080 * 4, 'wrong frame size');
    const closed = await session.close();
    assert(closed.problems.length === 0, `close reported: ${closed.problems.join('; ')}`);
    // The live path must never touch the disk. Anything here is a finding.
    assert(
      closed.scratchFiles.length === 0,
      `the capture session wrote ${closed.scratchFiles.length} file(s) into its scratch outputDir`,
    );
  }

  const scratchAfter = scratchCount();
  assert(scratchAfter === scratchBefore, `leaked ${scratchAfter - scratchBefore} scratch directories`);

  const rssMb = Math.round((process.memoryUsage().rss - rssBefore) / 1024 / 1024);
  return `scratch dirs flat, adapter rss ${rssMb >= 0 ? '+' : ''}${rssMb} MiB`;
});

const failures = results.filter((r) => !r.ok);
console.log('');
console.log(`${results.length} checks, ${failures.length} failure(s)`);
console.log(failures.length === 0 ? 'PASS' : 'FAIL');
process.exit(failures.length === 0 ? 0 : 1);
