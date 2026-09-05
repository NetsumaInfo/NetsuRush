// What the cache key must never do: collide, or miss a change.
//
// The table below is the whole point. Every field that can change pixels gets
// perturbed once, and the key must move. A field that fails this test is a
// field that would let the cache serve a frame from before the change — the
// exact bug that is invisible in testing and obvious in a render.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FRAME_KEY_FIELDS,
  FrameKeyError,
  REVISION_FIELDS,
  canonicalize,
  frameKey,
  hashControlValues,
  hashProps,
  revisionKey,
} from '../frameKey.mjs';

function descriptor(overrides = {}) {
  return {
    protocolVersion: 1,
    engineId: 'hyperframes',
    engineAdapterVersion: '0.1.0-prototype',
    enginePackageVersion: '0.8.16',
    browserBuild: 'chrome-headless-shell/152.0.7977.54',
    projectRevision: 'rev-1',
    compositionId: 'netsuflow-fixture',
    propsRevision: 'props-1',
    propsHash: hashProps({ title: 'hello' }),
    controlSchemaRevision: 'controls-1',
    controlValuesHash: hashControlValues({ opacity: 1 }),
    frame: 42,
    width: 1920,
    height: 1080,
    renderScalePpm: 1_000_000,
    quality: 'final',
    pixelFormat: 'RGBA8',
    colorPolicy: 'srgb',
    alphaPolicy: 'straight',
    timelineMode: 'auto',
    timelineGraceMs: 3000,
    startDeadlineMs: 20_000,
    studioCompat: false,
    studioDeadlineMs: 10_000,
    capturePath: 'alpha',
    ...overrides,
  };
}

/// One perturbation per field, chosen to be a plausible real change rather than
/// a token difference.
const PERTURBATIONS = {
  protocolVersion: 2,
  engineId: 'remotion',
  engineAdapterVersion: '0.2.0',
  enginePackageVersion: '0.8.17',
  browserBuild: 'chrome-headless-shell/153.0.0.0',
  projectRevision: 'rev-2',
  compositionId: 'other-composition',
  propsRevision: 'props-2',
  propsHash: hashProps({ title: 'goodbye' }),
  controlSchemaRevision: 'controls-2',
  controlValuesHash: hashControlValues({ opacity: 0.5 }),
  frame: 43,
  width: 1280,
  height: 720,
  renderScalePpm: 500_000,
  quality: 'preview',
  pixelFormat: 'RGBA32F',
  colorPolicy: 'rec709',
  alphaPolicy: 'premultiplied',
  timelineMode: 'gsap',
  timelineGraceMs: 500,
  startDeadlineMs: 45_000,
  studioCompat: true,
  studioDeadlineMs: 25_000,
  capturePath: 'buffer',
};

test('every field in the key changes the key', () => {
  const base = frameKey(descriptor()).key;
  const seen = new Map([[base, 'base']]);

  for (const field of FRAME_KEY_FIELDS) {
    assert.ok(field in PERTURBATIONS, `${field} has no perturbation in this table`);
    const { key } = frameKey(descriptor({ [field]: PERTURBATIONS[field] }));
    assert.notEqual(key, base, `changing ${field} must change the key`);
    // Also: no two perturbations may land on each other, which would mean the
    // key cannot tell those two changes apart.
    assert.ok(!seen.has(key), `${field} collides with ${seen.get(key)}`);
    seen.set(key, field);
  }
});

test('the perturbation table cannot fall behind the field list', () => {
  // Without this, adding a field to FRAME_KEY_FIELDS and forgetting the table
  // would leave that field untested while the suite still passes.
  assert.deepEqual(
    FRAME_KEY_FIELDS.filter((field) => !(field in PERTURBATIONS)),
    [],
  );
  assert.deepEqual(
    Object.keys(PERTURBATIONS).filter((field) => !FRAME_KEY_FIELDS.includes(field)),
    [],
  );
});

test('the same request produces the same key regardless of property order', () => {
  const ordered = descriptor();
  const shuffled = Object.fromEntries(
    Object.entries(ordered).sort(([a], [b]) => (a < b ? 1 : -1)),
  );
  assert.equal(frameKey(ordered).key, frameKey(shuffled).key);
});

test('a missing field is an error, not an empty string', () => {
  // Hashing `undefined` would make two requests that mean different things
  // collide, which is the one failure a cache key must not have.
  const broken = descriptor();
  delete broken.propsHash;
  assert.throws(
    () => frameKey(broken),
    (error) => error instanceof FrameKeyError && error.details.missing.includes('propsHash'),
  );
});

test('an unknown field is an error', () => {
  // A field nobody added to FRAME_KEY_FIELDS is a field that changes pixels
  // without changing the key.
  assert.throws(
    () => frameKey({ ...descriptor(), lutRevision: 'lut-1' }),
    (error) => error instanceof FrameKeyError && error.details.unknown.includes('lutRevision'),
  );
});

test('numeric fields are range-checked rather than hashed as-is', () => {
  for (const bad of [-1, 1.5, '42', NaN]) {
    assert.throws(() => frameKey(descriptor({ frame: bad })), FrameKeyError, `frame ${bad}`);
  }
  for (const field of ['width', 'height', 'renderScalePpm']) {
    assert.throws(() => frameKey(descriptor({ [field]: 0 })), FrameKeyError, field);
  }
});

test('props hash is stable against key order and distinguishes absent from empty', () => {
  assert.equal(hashProps({ a: 1, b: 2 }), hashProps({ b: 2, a: 1 }));
  assert.equal(hashProps({ nested: { x: 1, y: 2 } }), hashProps({ nested: { y: 2, x: 1 } }));
  assert.notEqual(hashProps({}), hashProps(null));
  assert.notEqual(hashProps({ a: 1 }), hashProps({ a: '1' }));
  // Arrays are ordered data; reordering them is a real change.
  assert.notEqual(hashProps({ a: [1, 2] }), hashProps({ a: [2, 1] }));
});

test('canonicalize refuses values with no stable form', () => {
  for (const bad of [Number.NaN, Infinity, -Infinity]) {
    assert.throws(() => canonicalize(bad), FrameKeyError);
  }
  assert.throws(() => canonicalize({ a: undefined }), FrameKeyError);
  assert.throws(() => canonicalize({ a: () => {} }), FrameKeyError);
  // -0 and 0 are the same input to a renderer and must hash the same.
  assert.equal(canonicalize(-0), canonicalize(0));
});

test('the revision key ignores per-frame fields and tracks the rest', () => {
  const base = revisionKey(descriptor());

  // Frame, size, scale and quality must NOT change the revision: invalidating a
  // binding has to drop every frame of it, at every size.
  for (const field of ['frame', 'width', 'height', 'renderScalePpm', 'quality', 'protocolVersion']) {
    assert.equal(
      revisionKey(descriptor({ [field]: PERTURBATIONS[field] })),
      base,
      `${field} must not change the revision key`,
    );
  }

  for (const field of REVISION_FIELDS) {
    assert.notEqual(
      revisionKey(descriptor({ [field]: PERTURBATIONS[field] })),
      base,
      `${field} must change the revision key`,
    );
  }
});

test('two frames of one revision share a revision key but not a frame key', () => {
  const a = descriptor({ frame: 1 });
  const b = descriptor({ frame: 2 });
  assert.equal(revisionKey(a), revisionKey(b));
  assert.notEqual(frameKey(a).key, frameKey(b).key);
});

test('the canonical form is reported alongside the hash', () => {
  // A cache that can only report opaque hashes cannot be debugged.
  const { key, canonical } = frameKey(descriptor());
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.match(canonical, /"compositionId":"netsuflow-fixture"/);
  assert.match(canonical, /"timelineMode":"auto"/);
});
