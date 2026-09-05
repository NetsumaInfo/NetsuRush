import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_FRAME_DIMENSION,
  NO_FRAME_MARKER,
  diagnosticFrameByteSize,
  frameMarker,
  makeDiagnosticFrame,
} from '../diagnosticFrame.mjs';

test('frame size and marker match the native contract', () => {
  const spec = { width: 64, height: 32, frame: 42 };
  const pixels = makeDiagnosticFrame(spec);
  assert.equal(pixels.length, 64 * 32 * 4);
  assert.equal(frameMarker(pixels, spec), 42);
});

test('marker round trips across the uint32 range', () => {
  for (const frame of [0, 1, 255, 256, 65535, 16777215, 4294967294]) {
    const spec = { width: 16, height: 16, frame };
    assert.equal(frameMarker(makeDiagnosticFrame(spec), spec), frame);
  }
});

test('generation is deterministic and frame-sensitive', () => {
  const a = makeDiagnosticFrame({ width: 97, height: 61, frame: 12345 });
  const b = makeDiagnosticFrame({ width: 97, height: 61, frame: 12345 });
  const c = makeDiagnosticFrame({ width: 97, height: 61, frame: 12346 });
  assert.ok(a.equals(b));
  assert.ok(!a.equals(c));
});

test('alpha is fully opaque', () => {
  const pixels = makeDiagnosticFrame({ width: 40, height: 24, frame: 7 });
  for (let offset = 3; offset < pixels.length; offset += 4) {
    assert.equal(pixels[offset], 255);
  }
});

test('invalid specs produce nothing', () => {
  assert.equal(makeDiagnosticFrame({ width: 0, height: 32, frame: 1 }), null);
  assert.equal(makeDiagnosticFrame({ width: 32, height: 0, frame: 1 }), null);
  assert.equal(
    makeDiagnosticFrame({ width: MAX_FRAME_DIMENSION + 1, height: 32, frame: 1 }),
    null,
  );
  assert.equal(diagnosticFrameByteSize({ width: 0, height: 0 }), 0);
});

test('narrow frames report the marker sentinel', () => {
  const spec = { width: 3, height: 3, frame: 9 };
  assert.equal(frameMarker(makeDiagnosticFrame(spec), spec), NO_FRAME_MARKER);
});

// Literal golden values, asserted independently on both sides. The C++ suite
// pins the same numbers, so a drift in either implementation fails here with a
// clear culprit rather than showing up as an opaque end-to-end mismatch.
test('golden pixels', () => {
  const pixels = makeDiagnosticFrame({ width: 64, height: 40, frame: 5 });
  const at = (x, y) => {
    const offset = (y * 64 + x) * 4;
    return [pixels[offset], pixels[offset + 1], pixels[offset + 2], pixels[offset + 3]];
  };

  // Counter band, frame 5 == 0b101: cells 0 and 2 lit, cell 1 dark.
  // The first four red channels of row 0 carry the big-endian frame marker.
  assert.deepEqual(at(0, 0), [0, 255, 255, 255]);
  assert.deepEqual(at(3, 0), [5, 255, 255, 255]);
  assert.deepEqual(at(5, 0), [16, 16, 16, 255]);
  assert.deepEqual(at(9, 0), [255, 255, 255, 255]);

  // Pattern area below the band.
  assert.deepEqual(at(5, 30), [100, 219, 42, 255]);
});
