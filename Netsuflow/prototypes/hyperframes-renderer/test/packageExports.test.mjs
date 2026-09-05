// The dependency-surface gate for the HyperFrames adapter.
//
// NetsuFlow wraps HyperFrames behind one adapter, and that only works if the
// functions the adapter needs are reachable from the package root. An internal
// path import (`@hyperframes/engine/dist/services/...`) would tie us to a file
// layout the project never promised to keep, so this file fails on the first
// such need rather than after it has spread.
//
// It also records the full root export list. HyperFrames is pre-1.0 and
// published 371 versions by 2026-08-27, so a version bump moving or removing a
// symbol is expected, not exceptional; the baseline turns that into a failing
// test instead of a runtime surprise.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';

import * as engine from '@hyperframes/engine';

const here = dirname(fileURLToPath(import.meta.url));
const baselinePath = join(here, 'exports-baseline.json');

/// Everything the documented session lifecycle needs. If one of these ever
/// leaves the package root, the adapter cannot be written against public API
/// and that decision has to be made deliberately.
const REQUIRED = [
  'acquireBrowser',
  'releaseBrowser',
  'createCaptureSession',
  'initializeSession',
  'captureFrameToBuffer',
  'closeCaptureSession',
];

/// Not required for a first frame, but each one replaces code we would
/// otherwise write ourselves. Their absence is a warning, not a failure.
const EXPECTED_HELPERS = [
  'getCompositionDuration',
  'getCapturePerfSummary',
  'prepareCaptureSessionForReuse',
  'buildChromeArgs',
  'resolveHeadlessShellPath',
  'drainBrowserPool',
  'classifyCaptureFailure',
  'isTransientBrowserError',
  'isMemoryExhaustionError',
];

test('every function the adapter needs is a package-root export', () => {
  for (const name of REQUIRED) {
    assert.equal(
      typeof engine[name],
      'function',
      `@hyperframes/engine must export ${name}() from its package root`,
    );
  }
});

test('the helpers that keep work out of NetsuFlow are still present', () => {
  const missing = EXPECTED_HELPERS.filter((name) => typeof engine[name] !== 'function');
  assert.deepEqual(
    missing,
    [],
    `these root exports disappeared, so NetsuFlow would have to reimplement them: ${missing.join(', ')}`,
  );
});

test('the root export surface has not drifted since it was pinned', () => {
  const actual = Object.keys(engine).sort();
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));

  assert.equal(
    baseline.package,
    '@hyperframes/engine',
    'the baseline was recorded for a different package',
  );

  const added = actual.filter((name) => !baseline.exports.includes(name));
  const removed = baseline.exports.filter((name) => !actual.includes(name));

  // Removals are the dangerous direction: something the adapter may lean on is
  // gone. Additions are reported too, because a new symbol usually means the
  // upstream lifecycle changed shape.
  assert.deepEqual(
    { added, removed },
    { added: [], removed: [] },
    `the ${baseline.version} export surface changed. Review the diff, then re-record the baseline deliberately.`,
  );
});
