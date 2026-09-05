// T03 end-to-end driver: the real native BridgeClient against the real fake
// renderer, over a real loopback socket.
//
// Run by CTest as `node bridge-e2e.mjs <path-to-BridgeClientHarness>`. It is a
// plain script rather than a node:test suite so CTest gets one unambiguous exit
// code and a readable transcript.
//
// What this proves: the native client's bounded parsing, deadlines, abort
// handling and reconnection behave correctly against a hostile server, and the
// pixels that survive the bridge are byte-identical to the local fixture.
//
// What this does NOT prove: anything about DaVinci Resolve. The in-host matrix
// in tests/T01, T02 and T03 remains a manual gate.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import process from 'node:process';

import { startFakeRenderer } from '../server.mjs';

// Note: this file lives outside test/ on purpose. It is a driver, not a
// node:test suite, and must not be picked up by `npm test`.

const harness = process.argv[2];
if (!harness || !existsSync(harness)) {
  console.error(`usage: node bridge-e2e.mjs <BridgeClientHarness>\nnot found: ${harness}`);
  process.exit(2);
}

const HD = ['1920', '1080'];
const UHD = ['3840', '2160'];

// T03 asks for at least 10,000 requests against a bounded cache. Both counts can
// be lowered for a quick local run without changing what the scenarios assert.
const SOAK_SAMPLES = Number(process.env.NETSUFLOW_E2E_SOAK ?? 10000);
const CACHE_HIT_SAMPLES = Number(process.env.NETSUFLOW_E2E_CACHE_HITS ?? 2000);

function runHarness(sessionFile, args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(harness, [sessionFile, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: null, stdout, stderr: `${stderr}\n[killed after ${timeoutMs} ms]` });
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function field(stdout, key) {
  const match = stdout.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return match ? match[1].trim() : undefined;
}

const results = [];

async function scenario(name, options, check) {
  const server = await startFakeRenderer(options);
  let outcome;
  try {
    outcome = await check(server);
  } catch (error) {
    outcome = { pass: false, detail: `threw: ${error.message}` };
  } finally {
    await server.close();
  }
  results.push({ name, ...outcome });
  const label = outcome.pass ? 'ok  ' : 'FAIL';
  console.log(`[${label}] ${name}${outcome.detail ? ` — ${outcome.detail}` : ''}`);
}

// --- Correctness -----------------------------------------------------------

await scenario('1080p frame matches the local fixture', {}, async (server) => {
  const { code, stdout } = await runHarness(server.sessionFile, ['frame', ...HD, '42']);
  return {
    pass: code === 0 && field(stdout, 'pixelsMatch') === 'true',
    detail: `status=${field(stdout, 'status')} pixelsMatch=${field(stdout, 'pixelsMatch')}`,
  };
});

await scenario('4K frame matches the local fixture', {}, async (server) => {
  const { code, stdout } = await runHarness(server.sessionFile, ['frame', ...UHD, '7']);
  return {
    pass: code === 0 && field(stdout, 'pixelsMatch') === 'true',
    detail: `bytes=${field(stdout, 'bytes')}`,
  };
});

await scenario('sequential scrub of 120 frames', {}, async (server) => {
  const { code, stdout } = await runHarness(server.sessionFile, ['sequence', ...HD, '120']);
  return {
    pass: code === 0,
    detail: `completed=${field(stdout, 'completed')} p50=${field(stdout, 'p50')}ms p95=${field(stdout, 'p95')}ms`,
  };
});

// The cache-hit path is the one docs/10 sets a latency target for: the service
// must not be regenerating the frame, so the same frame is requested repeatedly
// against a warm cache. This is the number to compare against the 20 ms p95.
await scenario('cache-hit round trip at 1080p', {}, async (server) => {
  const { code, stdout } = await runHarness(
    server.sessionFile,
    ['repeat', ...HD, '42', String(CACHE_HIT_SAMPLES)],
    { timeoutMs: 600000 },
  );
  const p95 = Number(field(stdout, 'p95'));
  return {
    pass: code === 0,
    detail:
      `n=${field(stdout, 'completed')} p50=${field(stdout, 'p50')}ms p95=${p95}ms ` +
      `p99=${field(stdout, 'p99')}ms rss=${field(stdout, 'rssStartKb')}->${field(stdout, 'rssEndKb')}KiB ` +
      `handles=${field(stdout, 'handlesStart')}->${field(stdout, 'handlesEnd')} ` +
      `[target p95<20ms: ${p95 < 20 ? 'met' : 'MISSED'}]`,
  };
});

await scenario(`random-access soak of ${SOAK_SAMPLES} frames`, {}, async (server) => {
  const { code, stdout } = await runHarness(
    server.sessionFile,
    ['soak', ...HD, String(SOAK_SAMPLES)],
    { timeoutMs: 1200000 },
  );
  return {
    pass: code === 0,
    detail:
      `completed=${field(stdout, 'completed')} p50=${field(stdout, 'p50')}ms ` +
      `p95=${field(stdout, 'p95')}ms p99=${field(stdout, 'p99')}ms ` +
      `rss=${field(stdout, 'rssStartKb')}->${field(stdout, 'rssEndKb')}KiB ` +
      `handles=${field(stdout, 'handlesStart')}->${field(stdout, 'handlesEnd')}`,
  };
});

// --- Hostile server behaviour ----------------------------------------------
// Every one of these must end in a clean, bounded failure. None may hang, and
// none may let unvalidated bytes through as pixels.

const hostile = [
  ['authentication is refused', { rejectAuth: true }],
  ['header with a bad magic value', { badMagic: true }],
  ['header with an unsupported version', { badVersion: true }],
  ['header with an unknown message type', { unknownType: true }],
  ['response for the wrong request id', { wrongRequestId: true }],
  ['metadata that does not parse', { malformedMetadata: true }],
  ['dimensions that do not match the request', { wrongDimensions: true }],
  ['stride smaller than one row', { wrongStride: true }],
  ['frame number that does not match the request', { wrongFrame: true }],
  ['body shorter than the declared length', { truncateBody: true }],
  ['declared body larger than what is sent', { declareOversizedBody: true }],
  ['disconnect immediately after the header', { disconnectAfterHeader: true }],
  ['disconnect before any response', { disconnectBeforeResponse: true }],
  ['explicit service error', { respondWithError: true }],
];

for (const [name, faults] of hostile) {
  await scenario(name, { faults }, async (server) => {
    const started = Date.now();
    const { code, stdout } = await runHarness(server.sessionFile, ['expect-error', ...HD, '1'], {
      timeoutMs: 30000,
    });
    const elapsed = Date.now() - started;
    // The harness exits 0 for expect-error when the client refused the response,
    // and 1 when connect itself failed, which is also a refusal.
    const refused = code === 0 || field(stdout, 'connect') !== 'Ok';
    return {
      pass: refused && elapsed < 25000,
      detail: `connect=${field(stdout, 'connect')} status=${field(stdout, 'status')} ${elapsed}ms`,
    };
  });
}

// --- Deadlines and cancellation --------------------------------------------

await scenario('a silent service hits the deadline instead of hanging', {
  faults: { neverRespond: true },
}, async (server) => {
  const started = Date.now();
  const { code, stdout } = await runHarness(server.sessionFile, ['expect-error', ...HD, '1'], {
    timeoutMs: 60000,
  });
  const elapsed = Date.now() - started;
  return {
    // The harness asks for a 5 s deadline; anything near the 60 s kill is a hang.
    pass: code === 0 && field(stdout, 'status') === 'Timeout' && elapsed < 20000,
    detail: `status=${field(stdout, 'status')} ${elapsed}ms`,
  };
});

await scenario('a slow header still completes within the deadline', {
  faults: { delayBeforeHeaderMs: 800 },
}, async (server) => {
  const { code, stdout } = await runHarness(server.sessionFile, ['frame', ...HD, '3']);
  return { pass: code === 0, detail: `status=${field(stdout, 'status')}` };
});

await scenario('a stalled body hits the deadline', {
  faults: { delayAfterHeaderMs: 30000 },
}, async (server) => {
  const started = Date.now();
  const { code, stdout } = await runHarness(server.sessionFile, ['expect-error', ...HD, '1'], {
    timeoutMs: 60000,
  });
  const elapsed = Date.now() - started;
  return {
    pass: code === 0 && field(stdout, 'status') === 'Timeout' && elapsed < 20000,
    detail: `status=${field(stdout, 'status')} ${elapsed}ms`,
  };
});

await scenario('host abort cancels promptly', {
  faults: { delayBeforeHeaderMs: 5000 },
}, async (server) => {
  const started = Date.now();
  const { code, stdout } = await runHarness(server.sessionFile, ['abort', ...HD, '1'], {
    timeoutMs: 30000,
  });
  const elapsed = Date.now() - started;
  return {
    pass: code === 0 && field(stdout, 'status') === 'Aborted' && elapsed < 3000,
    detail: `status=${field(stdout, 'status')} ${elapsed}ms`,
  };
});

// --- Reconnection ----------------------------------------------------------

// The advisory `revision` field is the one part of the metadata no schema rule
// constrains, so it is where a service would push an oversized string at the
// client's allocator. Two distinct contracts apply, and both are asserted.
await scenario('a long advisory revision still delivers the frame', {
  faults: { longRevision: true },
}, async (server) => {
  const { code, stdout } = await runHarness(server.sessionFile, ['frame', ...HD, '4']);
  return {
    pass: code === 0 && field(stdout, 'pixelsMatch') === 'true',
    detail: `status=${field(stdout, 'status')} (client caps the field at 128 chars)`,
  };
});

await scenario('an absurd advisory revision is refused cleanly', {
  faults: { absurdRevision: true },
}, async (server) => {
  const { code, stdout } = await runHarness(server.sessionFile, ['expect-error', ...HD, '4']);
  return {
    // Beyond the parser's per-string limit the whole document is illegal, so the
    // frame is rejected rather than partially trusted. It must not crash.
    pass: code === 0 && field(stdout, 'status') === 'ProtocolError',
    detail: `status=${field(stdout, 'status')}`,
  };
});

// A node in Bridge mode retries the connection on every render. Windows takes
// ~2.1 s of SYN retransmission to refuse a loopback connection to a closed port,
// so without a failure backoff each frame would stall for the whole connect
// timeout, for as long as the service is down. Measured in T01: the plugin's
// connect timeout is 1 s, so 20 frames would cost 20 s.
{
  const server = await startFakeRenderer({});
  const sessionFile = server.sessionFile;
  await server.close(); // descriptor stays on disk, nothing listening on the port

  const { stdout } = await runHarness(sessionFile, ['retry-storm', ...HD, '20'], {
    timeoutMs: 120000,
  });
  const totalMs = Number(field(stdout, 'totalMs'));
  // One attempt pays the timeout; the rest must be short-circuited.
  const pass = Number(field(stdout, 'attempts')) === 20 && totalMs < 4000;
  results.push({ name: 'connect backoff caps a retry storm', pass, detail: `${totalMs} ms for 20 renders` });
  console.log(`[${pass ? 'ok  ' : 'FAIL'}] connect backoff caps a retry storm — ${totalMs} ms for 20 renders`);
}

await scenario('reconnect without restarting the client', {}, async (server) => {
  const { code, stdout } = await runHarness(server.sessionFile, ['reconnect', ...HD, '11']);
  return {
    pass: code === 0,
    detail: `first=${field(stdout, 'first')} reconnect=${field(stdout, 'reconnect')} second=${field(stdout, 'second')}`,
  };
});

await scenario('a missing session descriptor fails fast', {}, async (server) => {
  const started = Date.now();
  const { stdout } = await runHarness(`${server.sessionFile}.absent`, ['frame', ...HD, '1'], {
    timeoutMs: 20000,
  });
  const elapsed = Date.now() - started;
  return {
    pass: field(stdout, 'connect') === 'NotConfigured' && elapsed < 5000,
    detail: `connect=${field(stdout, 'connect')} ${elapsed}ms`,
  };
});

// A service that went away between descriptor write and connect must not hang.
{
  const server = await startFakeRenderer({});
  const sessionFile = server.sessionFile;
  const port = server.port;
  // Close the listener but keep the descriptor on disk.
  await new Promise((resolveClose) => {
    server.close().then(resolveClose);
  });
  const started = Date.now();
  const { stdout } = await runHarness(sessionFile, ['frame', ...HD, '1'], { timeoutMs: 20000 });
  const elapsed = Date.now() - started;
  const pass = field(stdout, 'connect') !== 'Ok' && elapsed < 10000;
  results.push({ name: 'a stale descriptor fails fast', pass, detail: `port=${port} ${elapsed}ms` });
  console.log(`[${pass ? 'ok  ' : 'FAIL'}] a stale descriptor fails fast — ${elapsed}ms`);
}

// --- Summary ---------------------------------------------------------------

const failures = results.filter((result) => !result.pass);
console.log(`\n${results.length} scenario(s), ${failures.length} failure(s)`);
for (const failure of failures) {
  console.log(`  FAILED: ${failure.name} — ${failure.detail ?? ''}`);
}
process.exit(failures.length === 0 ? 0 : 1);
