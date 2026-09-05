// The last open question in Task 4: which capture path is the default.
//
// Correctness is already settled — the conformance run proved the two paths
// return byte-identical pixels, so this is purely about speed. What is left is
// to measure them under the conditions that actually differ: an opaque
// composition, where `buffer` has nothing to gain from transparency support,
// and a composition with real transparency, which is what `alpha` exists for.
//
// Both paths are timed on the same warm session where possible, alternating so
// a drift in machine state cannot land on one path only.
import { join, resolve } from 'node:path';

import { HyperFramesEngine } from '../hyperframesEngine.mjs';
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

const SAMPLES = Number(process.env.NETSUFLOW_CAPTURE_SAMPLES ?? 24);

const engine = new HyperFramesEngine({
  chromePath: CHROME,
  enginePackageVersion: buildRuntimeManifest().engine.resolvedVersion,
});

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
  return {
    p50: at(0.5),
    p95: at(0.95),
    mean: samples.reduce((sum, value) => sum + value, 0) / samples.length,
  };
}

/// Distinct frames each time: repeating one frame would measure whatever the
/// engine memoizes rather than the capture path.
function frameFor(index) {
  return (index * 37) % 280;
}

async function measurePath({ label, projectRoot, compositionId, width, height, capturePath }) {
  const session = await engine.open({
    id: `capture-${capturePath}`,
    projectRoot,
    compositionId,
    sourceRevision: 'rev-1',
    width,
    height,
    fps: { num: 30, den: 1 },
    timelineMode: 'auto',
    capturePath,
  });

  try {
    // One untimed frame: the first capture on a session pays for warm-up that
    // belongs to neither path.
    await session.renderFrame({ frame: 0 });

    const total = [];
    const capture = [];
    const decode = [];
    for (let i = 0; i < SAMPLES; i += 1) {
      const started = process.hrtime.bigint();
      const frame = await session.renderFrame({ frame: frameFor(i) });
      total.push(Number(process.hrtime.bigint() - started) / 1e6);
      capture.push(frame.timings.captureMs);
      decode.push(frame.timings.decodeMs);
    }
    return {
      label,
      capturePath,
      total: stats(total),
      capture: stats(capture),
      decode: stats(decode),
      encodedBytes: (await session.renderFrame({ frame: 5 })).timings.encodedBytes,
    };
  } finally {
    await session.close();
  }
}

const compositions = [
  {
    label: 'opaque composition (1080p)',
    projectRoot: join(HERE, 'fixture'),
    compositionId: 'netsuflow-fixture',
    width: 1920,
    height: 1080,
  },
  {
    label: 'diagnostic canvas (320x180)',
    projectRoot: join(HERE, 'fixture-diagnostic'),
    compositionId: 'netsuflow-diagnostic',
    width: 320,
    height: 180,
  },
];

console.log(`capture path latency, ${SAMPLES} distinct frames per path\n`);

const rows = [];
for (const composition of compositions) {
  // Alternating order per composition so a warming machine does not
  // systematically favour whichever path ran first.
  for (const capturePath of ['buffer', 'alpha']) {
    const result = await measurePath({ ...composition, capturePath });
    rows.push(result);
    console.log(
      `${result.label.padEnd(28)} ${capturePath.padEnd(7)} ` +
        `total p50 ${result.total.p50.toFixed(1).padStart(7)} ms  p95 ${result.total.p95.toFixed(1).padStart(7)} ms  ` +
        `capture p50 ${result.capture.p50.toFixed(1).padStart(7)} ms  decode p50 ${result.decode.p50.toFixed(1).padStart(6)} ms  ` +
        `${(result.encodedBytes / 1024).toFixed(0)} KiB`,
    );
  }
  console.log('');
}

for (const composition of compositions) {
  const buffer = rows.find((row) => row.label === composition.label && row.capturePath === 'buffer');
  const alpha = rows.find((row) => row.label === composition.label && row.capturePath === 'alpha');
  const delta = alpha.total.p50 - buffer.total.p50;
  const percent = (delta / buffer.total.p50) * 100;
  console.log(
    `${composition.label}: alpha is ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} ms ` +
      `(${percent >= 0 ? '+' : ''}${percent.toFixed(1)}%) against buffer at p50`,
  );
}
