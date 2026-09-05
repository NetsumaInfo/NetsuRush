// Captures the fixture's reference frames with the real pinned engine.
//
// "Standalone" here means without NetsuFlow's bridge, adapter, cache, or
// protocol — not without HyperFrames. Driving the real engine is the point:
// it proves the fixture actually satisfies `window.__hf` readiness and seeks
// as the engine expects, rather than as this repository's reading of the
// contract expects. Anything Task 4 later builds inherits that proof.
//
// It serves the fixture through the real project server, so every reference
// frame is captured over the same loopback-only, token-scoped, containment-
// checked path the adapter will use.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createCaptureSession,
  initializeSession,
  captureFrameToBuffer,
  closeCaptureSession,
  getCompositionDuration,
  getCapturePerfSummary,
  decodePng,
} from '@hyperframes/engine';

import { buildRuntimeManifest } from '../runtimeManifest.mjs';
import { startProjectServer } from '../projectServer.mjs';
import { buildTimelineShim } from '../timelineShim.mjs';

const HERE = resolve(import.meta.dirname, '..');
const FIXTURE = join(HERE, 'fixture');
const OUT = process.argv[2] ?? join(HERE, 'reference');
const CHROME = join(
  HERE,
  '.browser',
  'chrome-headless-shell',
  'win64-152.0.7977.54',
  'chrome-headless-shell-win64',
  'chrome-headless-shell.exe',
);

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;

/// Recovers the frame number the fixture painted, using the same convention as
/// the bridge's diagnostic frame: big-endian in the red channel of the first
/// four pixels of row 0.
function readFrameMarker(rgba) {
  let value = 0;
  for (let i = 0; i < 4; i += 1) value = ((value << 8) | rgba[i * 4]) >>> 0;
  return value;
}

function sampleAt(rgba, x, y) {
  const o = (y * WIDTH + x) * 4;
  return [rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3]];
}

/// The fixture's documented region map, so a difference can be named instead of
/// reported as a bare pixel count. Rectangles are [x, y, width, height].
const REGIONS = [
  ['machine band', 0, 0, 1920, 108],
  ['flat swatches', 80, 160, 920, 200],
  ['alpha edge', 1040, 160, 200, 200],
  ['text', 80, 420, 440, 100],
  ['css transform', 560, 420, 240, 240],
  ['svg', 880, 420, 240, 240],
  ['canvas 2d', 1200, 420, 240, 240],
  ['local image', 1520, 420, 240, 240],
  ['sweep bar', 80, 720, 600, 60],
  ['antialias probe', 1300, 720, 240, 240],
  ['clips', 80, 840, 900, 180],
  ['fader', 1000, 840, 260, 180],
];

/// The one region allowed to vary between two captures of the same frame.
/// Everything else is required to be byte-identical.
const TOLERANT_REGION = 'antialias probe';

function regionAt(x, y) {
  for (const [name, rx, ry, rw, rh] of REGIONS) {
    if (x >= rx && x < rx + rw && y >= ry && y < ry + rh) return name;
  }
  return 'background';
}

/// Names where two captures of one frame disagree. Without this, "the frames
/// differ" is unactionable: a difference in the text region means font
/// rendering, in the canvas region means the 2D context, and in the background
/// means something repainted that should not have.
function describeDifference(a, b) {
  const perRegion = new Map();
  let total = 0;
  let firstAt = null;
  let maxDelta = 0;

  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const o = (y * WIDTH + x) * 4;
      if (a[o] === b[o] && a[o + 1] === b[o + 1] && a[o + 2] === b[o + 2] && a[o + 3] === b[o + 3]) {
        continue;
      }
      total += 1;
      for (let c = 0; c < 4; c += 1) {
        const delta = Math.abs(a[o + c] - b[o + c]);
        if (delta > maxDelta) maxDelta = delta;
      }
      const region = regionAt(x, y);
      perRegion.set(region, (perRegion.get(region) ?? 0) + 1);
      if (!firstAt) {
        firstAt = { x, y, a: [a[o], a[o + 1], a[o + 2], a[o + 3]], b: [b[o], b[o + 1], b[o + 2], b[o + 3]] };
      }
    }
  }

  return { total, maxDelta, firstAt, perRegion: [...perRegion.entries()].sort((p, q) => q[1] - p[1]) };
}

/// One digest over every file that can change what the fixture paints. Stored
/// beside the references so a later run can tell "the engine changed" from
/// "the fixture changed" — without it, a stale reference set silently becomes
/// the baseline for a measurement it was never taken for.
function fixtureDigest() {
  const parts = ['index.html', 'styles.css', 'frame-code.js', 'assets/swatch.png'];
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(part);
    hash.update(readFileSync(join(FIXTURE, part)));
  }
  return hash.digest('hex');
}

// 'auto' is the product default, so the references are captured through the
// same path a real binding takes. The fixture registers no timeline, so the
// shim marks it after the grace and init costs ~3 s instead of 45 s.
const server = await startProjectServer({
  root: FIXTURE,
  headScripts: [buildTimelineShim({ mode: 'auto' })],
});
const url = server.url;
const scratch = mkdtempSync(join(tmpdir(), 'nf-refcap-'));
mkdirSync(OUT, { recursive: true });

let session;
const results = [];
let verdict = 0;

try {
  session = await createCaptureSession(
    url,
    scratch,
    { width: WIDTH, height: HEIGHT, fps: { num: FPS, den: 1 }, format: 'png', deviceScaleFactor: 1 },
    null,
    // forceScreenshot because BeginFrame's compositor does not preserve alpha.
    // On Windows the mode is screenshot regardless; saying so explicitly keeps
    // this script honest if it is ever run on Linux.
    { chromePath: CHROME, forceScreenshot: true },
  );
  await initializeSession(session);

  const duration = await getCompositionDuration(session);
  console.log(`server        ${server.origin} (token-scoped, loopback only)`);
  console.log(`__hf.duration ${duration}s (expected 10)`);
  if (duration !== 10) {
    console.log('MISMATCH: the page did not report the declared duration');
    verdict = 1;
  }

  // Order matters. Sequential first, then the same frames out of order, so a
  // difference between the two is attributable to seek order and nothing else.
  const sequential = [0, 1, 2, 30, 89, 150, 299];
  const outOfOrder = [299, 30, 0, 150, 1, 89, 2];

  const byFrame = new Map();

  for (const [label, frames] of [['sequential', sequential], ['out-of-order', outOfOrder]]) {
    for (const frame of frames) {
      const { buffer } = await captureFrameToBuffer(session, frame, frame / FPS);
      const png = createHash('sha256').update(buffer).digest('hex');
      const { width, height, data } = decodePng(buffer);
      if (width !== WIDTH || height !== HEIGHT) {
        console.log(`FAIL frame ${frame}: decoded ${width}x${height}`);
        verdict = 1;
      }
      const marker = readFrameMarker(data);
      const pixels = createHash('sha256').update(data).digest('hex');

      if (marker !== frame) {
        console.log(`FAIL frame ${frame} (${label}): band reports ${marker}`);
        verdict = 1;
      }

      const previous = byFrame.get(frame);
      if (previous && previous.pixels !== pixels) {
        const diff = describeDifference(previous.data, data);
        const outsideTolerance = diff.perRegion.filter(([region]) => region !== TOLERANT_REGION);
        const share = ((diff.total / (WIDTH * HEIGHT)) * 100).toFixed(4);
        const fatal = outsideTolerance.length > 0;

        console.log(
          `${fatal ? 'FAIL' : 'note'} frame ${frame}: ${previous.label} and ${label} differ in ` +
            `${diff.total} px (${share}%), max channel delta ${diff.maxDelta}`,
        );
        for (const [region, count] of diff.perRegion) {
          console.log(`        ${region}: ${count} px${region === TOLERANT_REGION ? ' (tolerated)' : ''}`);
        }
        if (fatal && diff.firstAt) {
          console.log(
            `        first at (${diff.firstAt.x},${diff.firstAt.y}) ` +
              `${previous.label}=rgba(${diff.firstAt.a.join(',')}) ${label}=rgba(${diff.firstAt.b.join(',')})`,
          );
          verdict = 1;
        }
      }
      byFrame.set(frame, { pixels, png, label, data });

      if (label === 'sequential') {
        writeFileSync(join(OUT, `frame-${String(frame).padStart(5, '0')}.png`), buffer);
        results.push({
          frame,
          pngSha256: png,
          pixelsSha256: pixels,
          bytes: buffer.length,
          marker,
          samples: {
            swatchRed: sampleAt(data, 180, 260),
            swatchGrey: sampleAt(data, 900, 260),
            alphaOpaque: sampleAt(data, 1090, 260),
            alphaHalf: sampleAt(data, 1190, 260),
            transparentGap: sampleAt(data, 1860, 1060),
          },
        });
      }
    }
  }

  // Idempotence with nothing in between. Sequential-versus-out-of-order tests
  // seek order; this tests whether one capture of one frame is even repeatable,
  // which is the weaker claim everything else rests on.
  const repeats = [];
  for (let i = 0; i < 3; i += 1) {
    const { buffer } = await captureFrameToBuffer(session, 150, 150 / FPS);
    repeats.push(decodePng(buffer).data);
  }
  for (let i = 1; i < repeats.length; i += 1) {
    const diff = describeDifference(repeats[0], repeats[i]);
    if (diff.total === 0) {
      console.log(`repeat ${i}      identical`);
      continue;
    }
    const outside = diff.perRegion.filter(([region]) => region !== TOLERANT_REGION);
    console.log(
      `repeat ${i}      ${diff.total} px differ (${diff.perRegion.map(([r, c]) => `${r}:${c}`).join(', ')})`,
    );
    if (outside.length > 0) {
      console.log('FAIL: back-to-back captures of one frame differ outside the tolerated region');
      verdict = 1;
    }
  }

  const alphaHalf = results[0].samples.alphaHalf;
  const transparent = results[0].samples.transparentGap;
  console.log(`alpha 50%     rgba(${alphaHalf.join(', ')})`);
  console.log(`empty area    rgba(${transparent.join(', ')})`);
  if (transparent[3] !== 0) {
    console.log('FAIL: the untouched area is not transparent, so alpha did not survive capture');
    verdict = 1;
  }

  const manifest = buildRuntimeManifest();
  writeFileSync(
    join(OUT, 'references.json'),
    `${JSON.stringify(
      {
        fixture: 'netsuflow-fixture',
        fixtureDigest: fixtureDigest(),
        width: WIDTH,
        height: HEIGHT,
        fps: { num: FPS, den: 1 },
        durationSeconds: duration,
        capture: { entryPoint: 'captureFrameToBuffer', format: 'png', forceScreenshot: true },
        engine: manifest.engine,
        node: manifest.node,
        captureMode: manifest.captureMode,
        browser: { build: '152.0.7977.54', binary: 'chrome-headless-shell' },
        frames: results,
      },
      null,
      2,
    )}\n`,
  );

  const perf = getCapturePerfSummary(session);
  console.log(`stage timings ${JSON.stringify(perf).slice(0, 300)}`);
  console.log(`\n${results.length} reference frames written to ${OUT}`);
  console.log(verdict === 0 ? 'PASS' : 'FAIL');
} finally {
  if (session) await closeCaptureSession(session);
  const leftover = readdirSync(scratch);
  if (leftover.length > 0) {
    console.log(`note: capture session wrote ${leftover.length} file(s) into its scratch outputDir`);
  }
  rmSync(scratch, { recursive: true, force: true });
  await server.close();
}

process.exit(verdict);
