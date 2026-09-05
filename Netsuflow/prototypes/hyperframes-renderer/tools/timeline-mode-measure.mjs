// Measures what each timeline mode actually costs, against the real engine.
//
// The claim being tested is narrow and worth pinning: a composition that never
// registers a GSAP timeline should start in milliseconds, and one that does
// should still be waited for properly. Both halves matter — a shim that made
// everything fast by never waiting would silently capture GSAP compositions
// before their timelines were built.
//
// Run manually. Each case launches a browser, and the no-shim case deliberately
// pays the engine's full 45 s timeout, so this is not part of `npm test`.
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createCaptureSession,
  initializeSession,
  captureFrameToBuffer,
  closeCaptureSession,
  decodePng,
} from '@hyperframes/engine';

import { startProjectServer } from '../projectServer.mjs';
import { buildTimelineShim } from '../timelineShim.mjs';

const HERE = resolve(import.meta.dirname, '..');
const CHROME = join(
  HERE,
  '.browser',
  'chrome-headless-shell',
  'win64-152.0.7977.54',
  'chrome-headless-shell-win64',
  'chrome-headless-shell.exe',
);

/// Runs one composition under one mode and reports how long init took, whether
/// a frame came back, and what the shim decided.
async function measure({ label, fixture, mode, width, height, expectMarked, probeMarker = false, graceMs, expectTooEarly = false }) {
  const shim = mode === null ? null : buildTimelineShim(graceMs === undefined ? { mode } : { mode, graceMs });
  const server = await startProjectServer({
    root: join(HERE, fixture),
    headScripts: shim ? [shim] : [],
  });
  const scratch = mkdtempSync(join(tmpdir(), 'nf-timeline-'));
  let session;

  try {
    session = await createCaptureSession(
      server.url,
      scratch,
      { width, height, fps: { num: 30, den: 1 }, format: 'png', deviceScaleFactor: 1 },
      null,
      { chromePath: CHROME, forceScreenshot: true },
    );

    const started = process.hrtime.bigint();
    await initializeSession(session);
    const initMs = Number(process.hrtime.bigint() - started) / 1e6;

    const { buffer } = await captureFrameToBuffer(session, 10, 10 / 30);
    const report = await session.page.evaluate(() => window.__netsuflowTimelineShim ?? null);

    const marked = report?.marked ?? [];
    const kept = report?.kept ?? [];
    const markedAsExpected = expectMarked === null ? true : marked.length === expectMarked;

    // A shim that has not fired yet is not the same as one that ran and kept
    // the host. Both are safe, but conflating them would hide which happened.
    let shimState;
    if (!shim) shimState = 'not injected';
    else if (!report) shimState = 'injected, had not fired before capture';
    else shimState = `marked=[${marked}] kept=[${kept}]`;

    // The late fixture paints red until its timeline registers, so a capture
    // taken too early is visible in the pixels rather than only in diagnostics.
    const { data } = decodePng(buffer);
    const markerOffset = (150 * width + 100) * 4;
    const marker = [data[markerOffset], data[markerOffset + 1], data[markerOffset + 2]];
    const tooEarly = marker[0] > 200 && marker[1] < 80;

    console.log(
      `${markedAsExpected && tooEarly === expectTooEarly ? 'ok  ' : 'FAIL'} ${label.padEnd(38)} ` +
        `init ${Math.round(initMs).toString().padStart(6)} ms  ` +
        `shim ${shimState}` +
        (probeMarker
          ? `  marker rgb(${marker})${tooEarly ? '  captured before the timeline existed' : '  animation was ready'}`
          : ''),
    );

    return { label, mode, initMs, ok: markedAsExpected && tooEarly === expectTooEarly, marked, kept, tooEarly };
  } finally {
    if (session) await closeCaptureSession(session);
    rmSync(scratch, { recursive: true, force: true });
    await server.close();
  }
}

const cases = [
  // The baseline this whole thing exists to remove.
  {
    label: 'no timeline, no shim',
    fixture: 'fixture',
    mode: null,
    width: 1920,
    height: 1080,
    expectMarked: null,
  },
  {
    label: 'no timeline, auto',
    fixture: 'fixture',
    mode: 'auto',
    width: 1920,
    height: 1080,
    expectMarked: 1,
  },
  {
    label: 'no timeline, none',
    fixture: 'fixture',
    mode: 'none',
    width: 1920,
    height: 1080,
    expectMarked: 1,
  },
  // The half that must not regress: a composition that does register a timeline
  // has to be left alone.
  {
    label: 'registers a timeline, auto',
    fixture: 'fixture-gsap',
    mode: 'auto',
    width: 960,
    height: 540,
    expectMarked: 0,
  },
  {
    label: 'registers a timeline, gsap',
    fixture: 'fixture-gsap',
    mode: 'gsap',
    width: 960,
    height: 540,
    expectMarked: null,
  },
  // The case that decides whether auto can be trusted as a default: a timeline
  // that arrives after the grace period.
  {
    label: 'late timeline, auto (default grace)',
    fixture: 'fixture-gsap-late',
    mode: 'auto',
    width: 960,
    height: 540,
    expectMarked: null,
    probeMarker: true,
  },
  // The documented limitation, pinned so a change in behaviour is noticed. A
  // grace shorter than the composition's setup cuts the wait short and captures
  // an animation that does not exist yet, with nothing reporting an error.
  {
    label: 'late timeline, auto (grace 500 ms)',
    fixture: 'fixture-gsap-late',
    mode: 'auto',
    graceMs: 500,
    width: 960,
    height: 540,
    expectMarked: 1,
    probeMarker: true,
    expectTooEarly: true,
  },
  {
    label: 'late timeline, gsap',
    fixture: 'fixture-gsap-late',
    mode: 'gsap',
    width: 960,
    height: 540,
    expectMarked: null,
    probeMarker: true,
  },
];

const results = [];
for (const testCase of cases) {
  results.push(await measure(testCase));
}

const failures = results.filter((r) => !r.ok);
const noShim = results.find((r) => r.label === 'no timeline, no shim');
const auto = results.find((r) => r.label === 'no timeline, auto');

console.log('');
if (noShim && auto) {
  console.log(
    `auto saves ${Math.round(noShim.initMs - auto.initMs)} ms on a composition ` +
      `without a timeline (${Math.round(noShim.initMs / auto.initMs)}x)`,
  );
}

// A shim that marked a composition which had registered a timeline would be
// worse than no shim at all: captures would start before the animation was
// built, and nothing would report an error.
const gsapAuto = results.find((r) => r.label === 'registers a timeline, auto');
if (gsapAuto && gsapAuto.marked.length > 0) {
  console.log('FAIL: auto mode opted out a composition that had registered a timeline');
}

const cutOff = results.find((r) => r.label === 'late timeline, auto (grace 500 ms)');
if (cutOff?.tooEarly) {
  console.log(
    'known limitation, reproduced: a grace shorter than the composition setup captures it too early. ' +
      'The adapter warns whenever the shim marks a host, and gsap mode removes the deadline entirely.',
  );
}

console.log(failures.length === 0 ? 'PASS' : `FAIL (${failures.length})`);
process.exit(failures.length === 0 ? 0 : 1);
