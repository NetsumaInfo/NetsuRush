// The cache key, and the reason a stale frame cannot come back.
//
// docs/05-bridge-protocol-and-cache.md lists what a frame's identity is made of.
// It is deliberately larger than the plugin's own last-frame key, because time
// or binding alone cannot guarantee correctness: the same binding at the same
// frame renders differently after an engine upgrade, a props change, a control
// keyframe, or — measured in H02 — a change of `timelineMode`.
//
// Two rules hold this together and both are enforced rather than documented:
//
//   1. A missing field is an error, never an empty string. Hashing `undefined`
//      makes two requests that mean different things collide, which is exactly
//      the bug a cache key exists to prevent.
//   2. The field list is closed. An unknown field is an error too, so adding
//      something that changes pixels without adding it here fails loudly
//      instead of silently serving the old frame.
import { createHash } from 'node:crypto';

/// Every input that can change a frame's pixels, in a fixed order.
///
/// Order matters only for readability — the hash is over a labelled canonical
/// form, so reordering this list cannot change a key. The list being *complete*
/// is what matters.
export const FRAME_KEY_FIELDS = Object.freeze([
  'protocolVersion',
  'engineId',
  'engineAdapterVersion',
  'enginePackageVersion',
  'browserBuild',
  'projectRevision',
  'compositionId',
  'propsRevision',
  'propsHash',
  'controlSchemaRevision',
  'controlValuesHash',
  'frame',
  'width',
  'height',
  'renderScalePpm',
  'quality',
  'pixelFormat',
  'colorPolicy',
  'alphaPolicy',
  // Measured in H02, and the reason these are not "session plumbing": `auto`
  // can stop waiting for a timeline that `gsap` would have waited for, and the
  // two then produce different pixels for one frame. The start deadline joins
  // them because under `gsap` the engine's timeline wait warns rather than
  // throws when it expires.
  'timelineMode',
  'timelineGraceMs',
  'startDeadlineMs',
  'studioCompat',
  'studioDeadlineMs',
  // Both capture paths were measured byte-identical on this engine build. It is
  // still in the key: that equality is a fact about 0.8.16, not a promise, and
  // a key that assumes it would serve wrong pixels the day it stops holding.
  'capturePath',
]);

const FIELD_SET = new Set(FRAME_KEY_FIELDS);

export class FrameKeyError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'FrameKeyError';
    this.code = 'CACHE_KEY_INVALID';
    this.details = details;
  }
}

/// Deterministic serialization: sorted object keys, rejected non-finite
/// numbers, and no `undefined` anywhere.
///
/// `JSON.stringify` alone is not enough. It preserves insertion order, so two
/// prop objects with the same content hash differently depending on how they
/// were built, and it drops `undefined` members silently — which would make
/// `{a: 1, b: undefined}` and `{a: 1}` the same key when the engine may well
/// treat them differently.
export function canonicalize(value, path = '$') {
  if (value === null) return 'null';
  const type = typeof value;

  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw new FrameKeyError(`${path} is ${value}, which has no canonical form`);
    }
    // -0 and 0 are the same pixel input and must be the same key.
    return JSON.stringify(value === 0 ? 0 : value);
  }
  if (type === 'string' || type === 'boolean') return JSON.stringify(value);
  if (type === 'bigint') return `"${value.toString()}n"`;
  if (type === 'undefined') {
    throw new FrameKeyError(`${path} is undefined; omit the field or give it a value`);
  }
  if (type === 'function' || type === 'symbol') {
    throw new FrameKeyError(`${path} is a ${type}, which cannot be part of a cache key`);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item, index) => canonicalize(item, `${path}[${index}]`)).join(',')}]`;
  }

  const keys = Object.keys(value).sort();
  const members = keys.map(
    (key) => `${JSON.stringify(key)}:${canonicalize(value[key], `${path}.${key}`)}`,
  );
  return `{${members.join(',')}}`;
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/// Content hash of a composition's props, stable against key order.
export function hashProps(props) {
  if (props === undefined || props === null) return sha256('null');
  return sha256(canonicalize(props));
}

/// Content hash of the control values sampled from Fusion at render time.
///
/// Separate from props on purpose: props are the project's, controls are this
/// node instance's, and a keyframed slider changes the second without touching
/// the first. Both have to be in the key or a keyframe change serves the frame
/// from before it.
export function hashControlValues(values) {
  if (values === undefined || values === null) return sha256('null');
  return sha256(canonicalize(values));
}

/// Builds the canonical key for one frame request.
///
/// Returns the hash and the descriptor it was computed from, because a cache
/// that can only report opaque hashes cannot be debugged.
export function frameKey(descriptor) {
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    throw new FrameKeyError('a frame key descriptor object is required');
  }

  const missing = FRAME_KEY_FIELDS.filter((field) => descriptor[field] === undefined);
  if (missing.length > 0) {
    throw new FrameKeyError(`frame key is missing ${missing.join(', ')}`, { missing });
  }

  const unknown = Object.keys(descriptor).filter((field) => !FIELD_SET.has(field));
  if (unknown.length > 0) {
    // Not pedantry. A field nobody added to FRAME_KEY_FIELDS is a field that
    // changes pixels without changing the key.
    throw new FrameKeyError(`unknown frame key fields: ${unknown.join(', ')}`, { unknown });
  }

  if (!Number.isInteger(descriptor.frame) || descriptor.frame < 0) {
    throw new FrameKeyError(`frame must be a non-negative integer, got ${descriptor.frame}`);
  }
  for (const field of ['width', 'height', 'renderScalePpm']) {
    if (!Number.isInteger(descriptor[field]) || descriptor[field] < 1) {
      throw new FrameKeyError(`${field} must be a positive integer, got ${descriptor[field]}`);
    }
  }

  const canonical = canonicalize(
    Object.fromEntries(FRAME_KEY_FIELDS.map((field) => [field, descriptor[field]])),
  );
  return { key: sha256(canonical), canonical };
}

/// The subset of the key that identifies a binding revision.
///
/// Invalidating a binding must drop every frame of it regardless of frame
/// number, size, or quality, so the cache indexes entries by this as well.
export const REVISION_FIELDS = Object.freeze([
  'engineId',
  'engineAdapterVersion',
  'enginePackageVersion',
  'browserBuild',
  'projectRevision',
  'compositionId',
  'propsRevision',
  'propsHash',
  'controlSchemaRevision',
  'controlValuesHash',
  'timelineMode',
  'timelineGraceMs',
  'startDeadlineMs',
  'studioCompat',
  'studioDeadlineMs',
  'capturePath',
]);

export function revisionKey(descriptor) {
  const missing = REVISION_FIELDS.filter((field) => descriptor?.[field] === undefined);
  if (missing.length > 0) {
    throw new FrameKeyError(`revision key is missing ${missing.join(', ')}`, { missing });
  }
  return sha256(
    canonicalize(Object.fromEntries(REVISION_FIELDS.map((field) => [field, descriptor[field]]))),
  );
}
