// H03, executed: cache, scrubbing, and soak against the real engine.
//
// tests/engines/hyperframes/H03-cache-scrubbing-soak.md asks whether HyperFrames
// stays useful and bounded under Resolve-like frame traces, and
// research/hyperframes/H03-session-performance.md asks which session lifecycle
// survives it. This runs both, against the same bridge server the OpenFX plugin
// talks to, so what is measured is the product's path and not a laboratory one.
//
// It is not part of `npm test`: it starts real browsers, and the soak phase
// issues ten thousand requests.
//
// Phases can be selected with NETSUFLOW_H03_PHASES=a,b,f (default: all).
import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { HyperFramesEngine } from '../hyperframesEngine.mjs';
import { buildRuntimeManifest } from '../runtimeManifest.mjs';
import { startBridgeServer } from '../server.mjs';

const execFileAsync = promisify(execFile);

const HERE = resolve(import.meta.dirname, '..');
const CHROME = join(
  HERE,
  '.browser',
  'chrome-headless-shell',
  'win64-152.0.7977.54',
  'chrome-headless-shell-win64',
  'chrome-headless-shell.exe',
);

const SOAK_REQUESTS = Number(process.env.NETSUFLOW_H03_SOAK ?? 10_000);
const PHASES = (process.env.NETSUFLOW_H03_PHASES ?? 'a,b,c,d,e,f,g,h')
  .split(',')
  .map((name) => name.trim().toLowerCase());

const engineVersion = buildRuntimeManifest().engine.resolvedVersion;
const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

async function check(name, fn) {
  try {
    record(name, true, await fn());
  } catch (error) {
    record(name, false, error?.message ?? String(error));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function stats(samples) {
  if (samples.length === 0) return { p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
  return {
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted[sorted.length - 1],
    mean: samples.reduce((sum, value) => sum + value, 0) / samples.length,
  };
}

const ms = (value) => `${value.toFixed(1)} ms`;
const line = (label, s) =>
  `${label.padEnd(30)} p50 ${ms(s.p50).padStart(9)}  p95 ${ms(s.p95).padStart(9)}  p99 ${ms(s.p99).padStart(9)}  max ${ms(s.max).padStart(9)}`;

/// Only the browsers this prototype launched. Filtering by executable path
/// matters: the machine may well be running other Chrome builds, and counting
/// or killing those would be both wrong and rude.
async function browserProcesses() {
  try {
    const { stdout } = await execFileAsync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='chrome-headless-shell.exe'\" | " +
          'Select-Object ProcessId,WorkingSetSize,HandleCount,ExecutablePath | ConvertTo-Json -Compress',
      ],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
    );
    const text = stdout.trim();
    if (text === '') return [];
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.filter((entry) => (entry.ExecutablePath ?? '').replace(/\\/g, '/').startsWith(HERE.replace(/\\/g, '/')));
  } catch {
    return [];
  }
}

async function processSnapshot() {
  const browsers = await browserProcesses();
  return {
    count: browsers.length,
    workingSetMiB: browsers.reduce((sum, entry) => sum + (entry.WorkingSetSize ?? 0), 0) / (1024 * 1024),
    handles: browsers.reduce((sum, entry) => sum + (entry.HandleCount ?? 0), 0),
    rssMiB: process.memoryUsage().rss / (1024 * 1024),
  };
}

function bindingFor({ width, height, revision = 'rev-1', fixture = 'fixture', id = 'b' }) {
  const isDiagnostic = fixture === 'fixture-diagnostic';
  return {
    // The bridge sets this from the binding table key; the direct-adapter paths
    // here have no table, and the adapter requires it either way.
    id,
    projectRoot: join(HERE, fixture),
    compositionId: isDiagnostic ? 'netsuflow-diagnostic' : 'netsuflow-fixture',
    sourceRevision: revision,
    width,
    height,
    fps: { num: 30, den: 1 },
    timelineMode: 'auto',
  };
}

function newEngine() {
  return new HyperFramesEngine({ chromePath: CHROME, enginePackageVersion: engineVersion });
}

/// Times one adapter render, bypassing the bridge. Used where the question is
/// about the engine rather than about the wire.
async function timed(fn) {
  const start = process.hrtime.bigint();
  const value = await fn();
  return { value, ms: Number(process.hrtime.bigint() - start) / 1e6 };
}

console.log(`H03: cache, scrubbing, and soak — engine ${engineVersion}, Node ${process.version}`);
console.log(`phases: ${PHASES.join(', ')}, soak requests: ${SOAK_REQUESTS}\n`);

const startingProcesses = await processSnapshot();
console.log(`browsers owned by this prototype at start: ${startingProcesses.count}\n`);

// ---------------------------------------------------------------------------
// Phase A — cold, warm miss, and memory hit, at 1080p and 4K.
// ---------------------------------------------------------------------------
if (PHASES.includes('a')) {
  console.log('— Phase A: cold / warm miss / memory hit —');

  for (const [label, width, height, misses] of [
    ['1080p', 1920, 1080, 20],
    ['4K', 3840, 2160, 8],
  ]) {
    await check(`${label}: cold, warm miss, and memory hit`, async () => {
      const engine = newEngine();
      const server = await startBridgeServer({
        engine,
        bindings: { b: bindingFor({ width, height }) },
      });
      try {
        // Cold: everything from nothing — browser launch, page, composition
        // ready, first capture. This happens once per binding revision, and it
        // is the number that decides whether a mode can be called Live.
        const cold = await timed(async () => {
          await server.warm('b');
        });

        const session = await (async () => {
          // Drive the adapter directly for the stage timings; the bridge adds
          // its own cost and Phase B measures that separately.
          const s = await engine.open(bindingFor({ width, height, revision: 'rev-stage' }));
          return s;
        })();

        try {
          await session.renderFrame({ frame: 0 });

          const missTotals = [];
          const captures = [];
          const decodes = [];
          for (let i = 0; i < misses; i += 1) {
            const { value, ms: total } = await timed(() => session.renderFrame({ frame: 3 + i * 11 }));
            missTotals.push(total);
            captures.push(value.timings.captureMs);
            decodes.push(value.timings.decodeMs);
          }

          const hitTotals = [];
          const client = await connectClient(server);
          try {
            // Prime, then repeat: the second and later requests are decoded
            // memory hits, which is the target the risk register names.
            await client.frame({ frame: 7, width, height });
            for (let i = 0; i < 30; i += 1) {
              const { ms: total } = await timed(() => client.frame({ frame: 7, width, height }));
              hitTotals.push(total);
            }
          } finally {
            client.destroy();
          }

          const miss = stats(missTotals);
          const hit = stats(hitTotals);
          console.log(`  ${line(`${label} warm miss (adapter)`, miss)}`);
          console.log(`  ${line(`${label} capture stage`, stats(captures))}`);
          console.log(`  ${line(`${label} decode stage`, stats(decodes))}`);
          console.log(`  ${line(`${label} memory hit (bridge)`, hit)}`);

          if (label === '1080p') {
            // The risk register's provisional targets, checked rather than
            // quoted: decoded memory hit p95 below 33 ms, warm miss below 250 ms.
            assert(hit.p95 < 33, `1080p memory hit p95 ${ms(hit.p95)} exceeds the 33 ms target`);
            assert(miss.p95 < 250, `1080p warm miss p95 ${ms(miss.p95)} exceeds the 250 ms provisional target`);
          }

          return `cold ${ms(cold.ms)}, miss p95 ${ms(miss.p95)}, hit p95 ${ms(hit.p95)}`;
        } finally {
          await session.close();
        }
      } finally {
        await server.close();
      }
    });
  }
  console.log('');
}

/// A protocol client that speaks the same wire the plugin does.
async function connectClient(server) {
  const { connect } = await import('node:net');
  const { MessageReader, MessageType, encodeMessage } = await import('../../fake-renderer/protocol.mjs');

  const socket = connect({ host: '127.0.0.1', port: server.port });
  socket.setNoDelay(true);
  const reader = new MessageReader();
  const inbox = [];
  const waiters = [];
  socket.on('data', (chunk) => {
    reader.push(chunk);
    for (const message of reader.drain()) {
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(message);
      else inbox.push(message);
    }
  });
  const fail = (error) => {
    for (const waiter of waiters.splice(0)) waiter.reject(error ?? new Error('connection closed'));
  };
  socket.on('close', () => fail());
  socket.on('error', (error) => fail(error));

  const next = () =>
    inbox.length > 0
      ? Promise.resolve(inbox.shift())
      : new Promise((resolvePromise, reject) => waiters.push({ resolve: resolvePromise, reject }));

  let requestId = 0;
  await new Promise((resolvePromise, reject) => {
    socket.once('connect', resolvePromise);
    socket.once('error', reject);
  });
  socket.write(
    encodeMessage({
      type: MessageType.HELLO,
      requestId: ++requestId,
      metadata: { token: server.token, client: 'h03', instanceId: 'h03' },
    }),
  );
  const helloOk = await next();
  if (helloOk.header.type !== MessageType.HELLO_OK) throw new Error('HELLO refused');

  return {
    async frame({ binding = 'b', frame, width, height, sourceRevision = 'rev-1', quality = 'preview' }) {
      socket.write(
        encodeMessage({
          type: MessageType.FRAME,
          requestId: ++requestId,
          metadata: {
            binding,
            sourceRevision,
            frame,
            width,
            height,
            renderScalePpm: 1_000_000,
            pixelFormat: 'RGBA8',
            alphaMode: 'straight',
            quality,
            deadlineMs: 30_000,
          },
        }),
      );
      const response = await next();
      if (response.header.type !== MessageType.FRAME_OK) {
        const error = new Error(response.metadata?.detail ?? response.metadata?.code ?? 'frame refused');
        error.code = response.metadata?.code;
        throw error;
      }
      return response;
    },
    destroy: () => socket.destroy(),
  };
}

/// Reads the frame marker the diagnostic fixture paints, so a trace can assert
/// it got the frame it asked for rather than merely a fast answer.
function frameMarker(pixels) {
  let value = 0;
  for (let i = 0; i < 4; i += 1) value = ((value << 8) | pixels[i * 4]) >>> 0;
  return value;
}

// ---------------------------------------------------------------------------
// Phase B — Resolve-like traces: sequential, reverse, seeded random, loop.
// ---------------------------------------------------------------------------
if (PHASES.includes('b')) {
  console.log('— Phase B: scrub traces, every frame verified —');

  await check('sequential, reverse, random and loop traces return the frame asked for', async () => {
    const engine = newEngine();
    const server = await startBridgeServer({
      engine,
      bindings: { b: bindingFor({ width: 320, height: 180, fixture: 'fixture-diagnostic' }) },
      cacheBytes: 8 * 1024 * 1024,
    });
    const client = await connectClient(server);
    try {
      await server.warm('b');

      const traces = {
        sequential: Array.from({ length: 300 }, (unused, i) => i),
        reverse: Array.from({ length: 300 }, (unused, i) => 299 - i),
        loop: Array.from({ length: 300 }, (unused, i) => 100 + (i % 25)),
        random: (() => {
          let state = 0x12345678;
          return Array.from({ length: 1000 }, () => {
            state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
            return (state >>> 8) % 4096;
          });
        })(),
      };

      const summary = [];
      for (const [name, frames] of Object.entries(traces)) {
        const samples = [];
        let wrong = 0;
        for (const frame of frames) {
          const { value, ms: total } = await timed(() =>
            client.frame({ frame, width: 320, height: 180 }),
          );
          samples.push(total);
          if (frameMarker(value.body) !== frame) wrong += 1;
        }
        const s = stats(samples);
        console.log(`  ${line(`${name} (${frames.length})`, s)}`);
        assert(wrong === 0, `${name}: ${wrong} frames did not match the frame requested`);
        summary.push(`${name} p50 ${ms(s.p50)}`);
      }

      const hitRate = (server.schedulerStats.cacheHits / server.schedulerStats.requests) * 100;
      return `${summary.join(', ')}, cache hit rate ${hitRate.toFixed(1)}%`;
    } finally {
      client.destroy();
      await server.close();
    }
  });
  console.log('');
}

// ---------------------------------------------------------------------------
// Phase C — two and four bindings at once.
// ---------------------------------------------------------------------------
if (PHASES.includes('c')) {
  console.log('— Phase C: concurrent bindings —');

  for (const count of [2, 4]) {
    await check(`${count} bindings render concurrently without crossing frames`, async () => {
      const engine = newEngine();
      const bindings = {};
      for (let i = 0; i < count; i += 1) {
        bindings[`b${i}`] = bindingFor({
          width: 320,
          height: 180,
          fixture: 'fixture-diagnostic',
          revision: `rev-${i}`,
        });
      }
      const server = await startBridgeServer({ engine, bindings, cacheBytes: 16 * 1024 * 1024 });
      const client = await connectClient(server);
      try {
        const before = await processSnapshot();
        const samples = [];
        let wrong = 0;
        for (let round = 0; round < 25; round += 1) {
          for (let i = 0; i < count; i += 1) {
            const frame = round * 7 + i;
            const { value, ms: total } = await timed(() =>
              client.frame({ binding: `b${i}`, frame, width: 320, height: 180, sourceRevision: `rev-${i}` }),
            );
            samples.push(total);
            // Each binding has its own revision, so a frame from the wrong
            // binding is a key collision. The marker proves it did not happen.
            if (frameMarker(value.body) !== frame) wrong += 1;
          }
        }
        assert(wrong === 0, `${wrong} frames came back for the wrong request`);
        const after = await processSnapshot();
        const s = stats(samples);
        console.log(`  ${line(`${count} bindings`, s)}`);
        return `${count} browsers expected, ${after.count} running, ${after.workingSetMiB.toFixed(0)} MiB working set (was ${before.workingSetMiB.toFixed(0)})`;
      } finally {
        client.destroy();
        await server.close();
      }
    });
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// Phase D — no stale frames after a revision change.
// ---------------------------------------------------------------------------
if (PHASES.includes('d')) {
  console.log('— Phase D: revision changes —');

  await check('rapid invalidation never returns a frame from before the change', async () => {
    const engine = newEngine();
    const server = await startBridgeServer({
      engine,
      bindings: { b: bindingFor({ width: 320, height: 180, fixture: 'fixture-diagnostic' }) },
    });
    const client = await connectClient(server);
    try {
      await server.warm('b');
      let renders = 0;
      for (let i = 0; i < 40; i += 1) {
        const before = server.schedulerStats.renders;
        const response = await client.frame({ frame: 11, width: 320, height: 180 });
        assert(frameMarker(response.body) === 11, 'wrong frame after invalidation');
        const { dropped } = server.invalidate('b');
        // Every request after an invalidation must be a real render: if any of
        // them were served from cache, the cache outlived the revision.
        if (server.schedulerStats.renders > before) renders += 1;
        assert(dropped <= 1, `invalidate dropped ${dropped} entries for one cached frame`);
      }
      assert(renders === 40, `only ${renders} of 40 post-invalidation requests re-rendered`);
      return '40 invalidations, 40 fresh renders, 0 stale frames';
    } finally {
      client.destroy();
      await server.close();
    }
  });
  console.log('');
}

// ---------------------------------------------------------------------------
// Phase E — the deadline, not cancellation, is what protects the caller.
// ---------------------------------------------------------------------------
if (PHASES.includes('e')) {
  console.log('— Phase E: bounded waits —');

  await check('an impossible deadline fails fast instead of blocking the caller', async () => {
    const engine = newEngine();
    const session = await engine.open(bindingFor({ width: 1920, height: 1080 }));
    try {
      const { ms: elapsed } = await timed(async () => {
        try {
          await session.renderFrame({ frame: 12, deadlineMs: 1 });
          throw new Error('the impossible deadline was not enforced');
        } catch (error) {
          if (error.code !== 'FRAME_TIMEOUT') throw error;
        }
      });
      // T01 measured that Resolve never aborts a render, so this bound is the
      // only thing standing between a slow engine and a stuck host thread.
      assert(elapsed < 500, `deadline enforcement took ${ms(elapsed)}`);
      return `FRAME_TIMEOUT in ${ms(elapsed)}`;
    } finally {
      await session.close();
    }
  });
  console.log('');
}

// ---------------------------------------------------------------------------
// Phase F — the soak. Bounded caches, then ten thousand requests.
// ---------------------------------------------------------------------------
if (PHASES.includes('f')) {
  console.log(`— Phase F: ${SOAK_REQUESTS}-request soak —`);

  await check(`${SOAK_REQUESTS} requests after the cache bound is reached`, async () => {
    const engine = newEngine();
    const server = await startBridgeServer({
      engine,
      bindings: { b: bindingFor({ width: 320, height: 180, fixture: 'fixture-diagnostic' }) },
      // Deliberately small: the point of the soak is what happens *after* the
      // cache is full, so it has to fill in the first few hundred requests.
      cacheBytes: 4 * 1024 * 1024,
    });
    const client = await connectClient(server);
    try {
      await server.warm('b');

      const samples = [];
      const trend = [];
      let wrong = 0;
      let failures = 0;
      let state = 0x2545f491;
      let held = 0;
      let frame = 0;
      const repeatShaped = (process.env.NETSUFLOW_H03_SOAK_TRACE ?? 'repeat') !== 'uniform';

      const started = Date.now();
      for (let i = 0; i < SOAK_REQUESTS; i += 1) {
        // A Resolve-shaped trace rather than uniform noise: T01 measured 21
        // requests for one frame, so the real workload is dominated by repeats
        // with occasional jumps.
        //
        // `NETSUFLOW_H03_SOAK_TRACE=uniform` selects uniform random instead,
        // which is the harsher bound test: almost nothing hits the cache, so
        // every request is a real browser capture.
        if (held > 0) {
          held -= 1;
        } else {
          state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
          held = repeatShaped ? 3 + ((state >>> 20) % 18) : 0;
          frame = (state >>> 8) % 4000;
        }

        try {
          const { value, ms: total } = await timed(() =>
            client.frame({ frame, width: 320, height: 180 }),
          );
          samples.push(total);
          if (frameMarker(value.body) !== frame) wrong += 1;
        } catch {
          failures += 1;
        }

        if ((i + 1) % 1000 === 0) {
          const snapshot = await processSnapshot();
          trend.push({ at: i + 1, ...snapshot, cacheMiB: server.cacheBytes / (1024 * 1024) });
          console.log(
            `  ${String(i + 1).padStart(6)} requests  browsers ${snapshot.count}  ` +
              `browser ws ${snapshot.workingSetMiB.toFixed(0).padStart(4)} MiB  handles ${String(snapshot.handles).padStart(5)}  ` +
              `node rss ${snapshot.rssMiB.toFixed(0).padStart(4)} MiB  ` +
              `cache ${(server.cacheBytes / (1024 * 1024)).toFixed(1)} MiB`,
          );
        }
      }
      const elapsedS = (Date.now() - started) / 1000;

      const s = stats(samples);
      console.log(`  ${line('soak', s)}`);

      assert(wrong === 0, `${wrong} responses were not the frame requested`);
      assert(failures === 0, `${failures} requests failed`);

      const first = trend[0];
      const last = trend[trend.length - 1];
      // Bounded, not flat. A little growth is allocator behaviour; growth
      // proportional to the request count is a leak.
      const browserGrowth = last.workingSetMiB - first.workingSetMiB;
      const handleGrowth = last.handles - first.handles;
      const rssGrowth = last.rssMiB - first.rssMiB;
      assert(last.count === first.count, `browser count moved from ${first.count} to ${last.count}`);
      assert(
        server.cacheBytes <= 4 * 1024 * 1024,
        `cache grew past its bound: ${(server.cacheBytes / (1024 * 1024)).toFixed(1)} MiB`,
      );

      const hitRate = (server.schedulerStats.cacheHits / server.schedulerStats.requests) * 100;
      return (
        `${(elapsedS).toFixed(0)}s, p50 ${ms(s.p50)} p95 ${ms(s.p95)} p99 ${ms(s.p99)}, ` +
        `hit rate ${hitRate.toFixed(1)}%, browser ws ${browserGrowth >= 0 ? '+' : ''}${browserGrowth.toFixed(0)} MiB, ` +
        `handles ${handleGrowth >= 0 ? '+' : ''}${handleGrowth}, node rss ${rssGrowth >= 0 ? '+' : ''}${rssGrowth.toFixed(0)} MiB`
      );
    } finally {
      client.destroy();
      await server.close();
    }
  });
  console.log('');
}

// ---------------------------------------------------------------------------
// Phase G — the browser dies mid-session.
// ---------------------------------------------------------------------------
if (PHASES.includes('g')) {
  console.log('— Phase G: browser kill and recovery —');

  await check('a killed browser is reported, and the next binding recovers without a restart', async () => {
    const engine = newEngine();
    const server = await startBridgeServer({
      engine,
      bindings: {
        b: bindingFor({ width: 320, height: 180, fixture: 'fixture-diagnostic' }),
      },
    });
    const client = await connectClient(server);
    try {
      await server.warm('b');
      const ok = await client.frame({ frame: 5, width: 320, height: 180 });
      assert(frameMarker(ok.body) === 5, 'baseline frame was wrong');

      const before = await browserProcesses();
      assert(before.length > 0, 'no browser process found to kill');
      for (const entry of before) {
        // Only ours: filtered by executable path inside this prototype.
        await execFileAsync('taskkill', ['/PID', String(entry.ProcessId), '/T', '/F']).catch(() => {});
      }

      // The frame after the kill must fail with a named, retryable error rather
      // than hang: a hang behind a Resolve render is indistinguishable from a
      // crash, and T01 measured that Resolve will wait forever.
      let reported = null;
      const { ms: failMs } = await timed(async () => {
        try {
          // The cached frame 5 would still answer, so ask for a new one.
          await client.frame({ frame: 6, width: 320, height: 180 });
        } catch (error) {
          reported = error;
        }
      });
      assert(reported !== null, 'a request after the browser was killed still succeeded');
      assert(failMs < 60_000, `the failure took ${ms(failMs)} to report`);

      // Recovery without restarting the service: a fresh binding opens a new
      // browser in the same process.
      const recovery = await startBridgeServer({
        engine,
        bindings: { b: bindingFor({ width: 320, height: 180, fixture: 'fixture-diagnostic', revision: 'rev-2' }) },
      });
      const recovered = await connectClient(recovery);
      try {
        const response = await recovered.frame({ frame: 9, width: 320, height: 180, sourceRevision: 'rev-2' });
        assert(frameMarker(response.body) === 9, 'the recovered frame was wrong');
      } finally {
        recovered.destroy();
        await recovery.close();
      }

      return `killed ${before.length} browser process(es), reported in ${ms(failMs)} as ${reported.code ?? 'error'}, recovered`;
    } finally {
      client.destroy();
      await server.close().catch(() => {});
    }
  });
  console.log('');
}

// ---------------------------------------------------------------------------
// Phase H — the bridge must not change a single pixel.
// ---------------------------------------------------------------------------
if (PHASES.includes('h')) {
  console.log('— Phase H: standalone versus bridge —');

  await check('frames through the bridge are byte-identical to the adapter’s own', async () => {
    // Everything between the adapter and the caller — PNG decode, the RGBA
    // normalizer, the cache, the framing, the socket — is a chance to alter or
    // truncate pixels. The comparison is the whole point of having both paths
    // available in one process.
    const engine = newEngine();
    const binding = bindingFor({ width: 1920, height: 1080, revision: 'rev-compare' });
    const server = await startBridgeServer({ engine, bindings: { b: { ...binding } } });
    const client = await connectClient(server);
    const session = await engine.open({ ...binding, id: 'standalone' });
    try {
      // Repeated, sequential, reverse and random, and one frame twice so a
      // cached answer is compared as well as a freshly rendered one.
      const frames = [0, 1, 2, 150, 299, 42, 42, 7];
      let compared = 0;
      let alphaChecked = 0;
      for (const frame of frames) {
        const direct = await session.renderFrame({ frame });
        const viaBridge = await client.frame({ frame, width: 1920, height: 1080, sourceRevision: 'rev-compare' });

        assert(
          viaBridge.metadata.width === direct.width && viaBridge.metadata.height === direct.height,
          `frame ${frame}: dimensions differ`,
        );
        assert(viaBridge.metadata.stride === direct.stride, `frame ${frame}: stride differs`);
        assert(viaBridge.metadata.alphaMode === direct.alphaMode, `frame ${frame}: alpha mode differs`);
        assert(
          Buffer.from(direct.pixels).equals(viaBridge.body),
          `frame ${frame}: pixels differ between the adapter and the bridge`,
        );
        compared += 1;

        // Alpha specifically: a premultiplying step anywhere in the chain would
        // survive a shape check and destroy compositing.
        if (viaBridge.body.some((value, index) => index % 4 === 3 && value !== 255)) alphaChecked += 1;
      }
      assert(alphaChecked > 0, 'no frame carried partial alpha, so alpha was not actually compared');
      return `${compared} frames byte-identical, ${alphaChecked} carrying partial alpha`;
    } finally {
      client.destroy();
      await session.close();
      await server.close();
    }
  });
  console.log('');
}

const ending = await processSnapshot();
console.log(`browsers owned by this prototype at end: ${ending.count} (started with ${startingProcesses.count})`);

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length} checks, ${failed.length} failure(s)  ${failed.length === 0 ? 'PASS' : 'FAIL'}`);
process.exit(failed.length === 0 ? 0 : 1);
