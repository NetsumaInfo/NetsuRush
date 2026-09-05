// The revision hash is a cross-language contract: the plugin hashes its Code
// field in C++, the service hashes the spooled bytes in JavaScript, and a
// paste renders only if the two agree exactly.
//
// Both sides are pinned to the same published FNV-1a 64 vectors rather than to
// each other, because two implementations that agree on a wrong constant would
// pass a comparison test and still be wrong. The C++ half asserts the identical
// three values in `openfx/tests/ProtocolTests.cpp`.
//
// This existed as a bug first: the C++ offset basis was written in decimal and
// lost one of its twenty digits. It compiled, it hashed, it looked plausible,
// and every paste came back `stale-revision`.
import assert from 'node:assert/strict';
import test from 'node:test';

import { fnv1a64Hex } from '../server.mjs';

test('the revision hash matches the published FNV-1a 64 vectors', () => {
  assert.equal(fnv1a64Hex(''), 'cbf29ce484222325');
  assert.equal(fnv1a64Hex('a'), 'af63dc4c8601ec8c');
  assert.equal(fnv1a64Hex('foobar'), '85944171f73967e8');
});

test('the revision hash is always sixteen lowercase hex digits', () => {
  // A leading-zero hash truncated to fifteen characters would compare unequal
  // to the plugin's padded form for one input in sixteen.
  for (const input of ['', 'a', 'foobar', 'x'.repeat(5000), '<html>é</html>']) {
    assert.match(fnv1a64Hex(input), /^[0-9a-f]{16}$/);
  }
});

test('the revision hash is byte-exact, not text-normalising', () => {
  assert.notEqual(fnv1a64Hex('a\r\nb'), fnv1a64Hex('a\nb'));
  assert.notEqual(fnv1a64Hex('x'), fnv1a64Hex('x '));
  // Non-ASCII must hash as its UTF-8 bytes, which is what the plugin writes and
  // what readFileSync returns.
  assert.notEqual(fnv1a64Hex('eé'), fnv1a64Hex('e'));
});

test('the hash stays inside 64 bits over a realistic composition', () => {
  // 64-bit wraparound is the failure a BigInt implementation invites: without
  // the mask the value grows without bound and the hex grows past sixteen
  // characters somewhere in the middle of a real page.
  const page = `<!doctype html><html>${'<div>x</div>'.repeat(4000)}</html>`;
  assert.match(fnv1a64Hex(page), /^[0-9a-f]{16}$/);
});
