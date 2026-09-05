// A manifest that quietly reports `null` is worse than no manifest, because a
// report would still embed it and look complete. These tests fail instead.
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRuntimeManifest, expectedCaptureMode } from '../runtimeManifest.mjs';

test('the engine version is pinned exactly, not to a range', () => {
  const manifest = buildRuntimeManifest();
  assert.equal(manifest.engine.declaredVersion, manifest.engine.resolvedVersion);
  assert.equal(manifest.engine.pinnedExactly, true);
  assert.match(
    manifest.engine.declaredVersion,
    /^\d+\.\d+\.\d+$/,
    'a caret or tilde would let a capture run on a build no report names',
  );
});

test('every pixel-relevant dependency resolves to a concrete version', () => {
  const manifest = buildRuntimeManifest();
  const unresolved = Object.entries(manifest.dependencies)
    .filter(([, version]) => version === null)
    .map(([name]) => name);
  assert.deepEqual(unresolved, [], `unresolved dependencies: ${unresolved.join(', ')}`);
});

test('the lockfile is present and fingerprinted', () => {
  const manifest = buildRuntimeManifest();
  assert.equal(manifest.lockfile.present, true);
  assert.match(manifest.lockfile.sha256, /^[0-9a-f]{64}$/);
  assert.ok(manifest.lockfile.packageCount > 1);
});

test('BeginFrame capture is reported as Linux-only', () => {
  // The Windows finding, encoded so a future engine upgrade that silently
  // changes it shows up here rather than inside a determinism measurement.
  const linux = expectedCaptureMode('linux');
  assert.equal(linux.mode, 'beginframe');
  assert.equal(linux.deterministicPathAvailable, true);

  for (const platform of ['win32', 'darwin']) {
    const other = expectedCaptureMode(platform);
    assert.equal(other.mode, 'screenshot', `${platform} must not claim BeginFrame`);
    assert.equal(other.deterministicPathAvailable, false);
  }
});

test('the manifest is stable across calls in one run', () => {
  // Two reports from the same run must be diffable; a timestamp baked in here
  // would make every manifest differ from every other.
  assert.deepEqual(buildRuntimeManifest(), buildRuntimeManifest());
  assert.equal(buildRuntimeManifest().generatedAt, null);
});
