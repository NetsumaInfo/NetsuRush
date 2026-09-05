// The disk store, and specifically the thing it did not do: reclaim.
//
// Correctness here was never in question — a stale frame has a different key,
// so it can never be served. What shipped was the storage side of that same
// fact: a different key is a *new file*, and nothing deleted the old one. The
// tests below are about deletion, because that is the half that had none.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFrameStore, BAKE_QUALITIES } from '../frameStore.mjs';

const GEN_A = 'a'.repeat(64);
const GEN_B = 'b'.repeat(64);

function frame(width = 4, height = 4, fill = 7) {
  return {
    width,
    height,
    stride: width * 4,
    pixels: Buffer.alloc(width * height * 4, fill),
  };
}

/// Frames are compressed now, so a solid fill weighs almost nothing on disk.
/// Anything testing a byte bound has to hand the store something it cannot
/// shrink, or the bound is never reached and the test proves nothing.
function noisyFrame(width, height, seed) {
  const pixels = Buffer.alloc(width * height * 4);
  let state = seed >>> 0;
  for (let i = 0; i < pixels.length; i += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    pixels[i] = state >>> 24;
  }
  return { width, height, stride: width * 4, pixels };
}

function withStore(run, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'nf-store-'));
  try {
    run(createFrameStore({ directory, ...options }), directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('a frame written in one generation is unreadable from another', () => {
  withStore((store) => {
    store.write('k', frame(), GEN_A);
    assert.ok(store.read('k', GEN_A));
    // Not merely absent: the same key in another generation must never resolve
    // to these pixels, which is the whole reason generations exist.
    assert.equal(store.read('k', GEN_B), null);
    assert.equal(store.has('k', GEN_B), false);
  });
});

test('dropping a generation deletes its frames from disk, not just from the index', () => {
  withStore((store, directory) => {
    for (let i = 0; i < 3; i += 1) store.write(`k${i}`, frame(), GEN_A);
    store.write('other', frame(), GEN_B);
    const before = store.bytes;
    assert.equal(store.count, 4);

    const dropped = store.dropGeneration(GEN_A);
    assert.equal(dropped.frames, 3);
    assert.ok(dropped.bytes > 0);
    assert.equal(store.count, 1);
    assert.equal(store.bytes, before - dropped.bytes);
    // The bookkeeping is not the claim being tested; the directory is.
    assert.deepEqual(readdirSync(directory), [GEN_B]);
    assert.ok(store.read('other', GEN_B));
  });
});

test('dropExcept keeps what is named and removes the rest', () => {
  withStore((store, directory) => {
    store.write('k', frame(), GEN_A);
    store.write('k', frame(), GEN_B);
    const removed = store.dropExcept([GEN_B]);
    assert.equal(removed.generations, 1);
    assert.equal(removed.frames, 1);
    assert.deepEqual(readdirSync(directory), [GEN_B]);
  });
});

test('clear empties the folder, including what the index never knew about', () => {
  withStore((store, directory) => {
    store.write('k', frame(), GEN_A);
    // A torn temporary and a folder from an older layout: "empty the cache"
    // has to mean the folder is empty, not that the bookkeeping agrees.
    writeFileSync(join(directory, 'stray.nfbk.1234.tmp'), 'x');
    mkdirSync(join(directory, 'not-a-generation'), { recursive: true });
    const removed = store.clear();
    assert.equal(removed.frames, 1);
    assert.equal(store.count, 0);
    assert.equal(store.bytes, 0);
    assert.deepEqual(readdirSync(directory), []);
  });
});

test('a generation is not a path the caller can choose', () => {
  withStore((store, directory) => {
    // Generations name directories. A value that is not a digest is refused
    // rather than concatenated into a path.
    for (const bad of ['..', 'a/../../b', '', 'GEN', 'zz', null, undefined]) {
      assert.equal(store.write('k', frame(), bad), false, String(bad));
      assert.equal(store.read('k', bad), null, String(bad));
      assert.deepEqual(store.dropGeneration(bad), { frames: 0, bytes: 0 }, String(bad));
    }
    assert.deepEqual(readdirSync(directory), []);
  });
});

test('an inventoried store comes back whole across a restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'nf-store-'));
  try {
    const first = createFrameStore({ directory });
    first.write('k0', frame(), GEN_A);
    first.write('k1', frame(), GEN_A);
    const bytes = first.bytes;

    // The measured 42 ms read against a 399 ms capture was taken after a
    // restart, so surviving one is a property worth pinning.
    const second = createFrameStore({ directory });
    assert.equal(second.count, 2);
    assert.equal(second.bytes, bytes);
    assert.equal(second.generationCount, 1);
    assert.ok(second.read('k0', GEN_A));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the byte cap still bounds a single generation that outgrows it', () => {
  // Generations are the reclaim mechanism, but they cannot help when one
  // generation alone is bigger than the bound, so the cap stays.
  withStore((store) => {
    for (let i = 0; i < 12; i += 1) store.write(`k${i}`, noisyFrame(16, 16, i + 1), GEN_A);
    assert.ok(store.bytes <= 8 * 1024, `bytes=${store.bytes}`);
    assert.ok(store.count < 12);
  }, { maxBytes: 8 * 1024 });
});

test('every tier returns the exact pixels it was given', () => {
  // The whole promise of the setting: it trades size against encode time and
  // never against quality. A tier that altered a byte would be a silent
  // downgrade of every frame the host renders.
  for (const quality of Object.keys(BAKE_QUALITIES)) {
    withStore((store) => {
      const written = noisyFrame(32, 24, 99);
      assert.equal(store.write('k', written, GEN_A), true, quality);
      const read = store.read('k', GEN_A);
      assert.ok(read, quality);
      assert.equal(read.width, 32);
      assert.equal(read.height, 24);
      assert.equal(read.stride, 32 * 4);
      assert.ok(read.pixels.equals(written.pixels), `${quality} altered the pixels`);
    }, { quality });
  }
});

test('a graphical frame costs a fraction of its raw size', () => {
  // The reason the codec is there at all. A flat 1080p frame is 8.29 MiB raw;
  // anything close to that on disk means the compression silently stopped.
  withStore((store) => {
    store.write('flat', frame(512, 512, 200), GEN_A);
    const raw = 512 * 512 * 4;
    assert.ok(store.bytes < raw / 20, `stored ${store.bytes} against ${raw} raw`);
  });
});

test('the raw tier really is uncompressed, and still reads back', () => {
  withStore((store) => {
    store.write('k', frame(64, 64, 3), GEN_A);
    // Header plus the pixels, and nothing else: proof the tier is honest about
    // what it does rather than compressing behind the setting's back.
    assert.equal(store.bytes, 24 + 64 * 64 * 4);
    assert.ok(store.read('k', GEN_A));
  }, { quality: 'raw' });
});

test('a frame from the previous raw-only format is refused, not misread', () => {
  // The header grew and the magic moved with it. An old file read with the new
  // layout would hand back pixels shifted by eight bytes — a picture, and the
  // wrong one. It has to miss instead, so the frame is simply re-rendered.
  withStore((store, directory) => {
    const old = Buffer.alloc(16 + 4 * 4 * 4);
    old.writeUInt32LE(0x4e46424b, 0);
    old.writeUInt32LE(4, 4);
    old.writeUInt32LE(4, 8);
    old.writeUInt32LE(16, 12);
    mkdirSync(join(directory, GEN_A), { recursive: true });
    writeFileSync(join(directory, GEN_A, 'legacy.nfbk'), old);
    assert.equal(store.read('legacy', GEN_A), null);
  });
});

test('inventory reports each generation separately', () => {
  withStore((store) => {
    store.write('k0', frame(), GEN_A);
    store.write('k1', frame(), GEN_A);
    store.write('k0', frame(), GEN_B);
    const inventory = store.inventory();
    assert.equal(inventory.length, 2);
    const byGeneration = new Map(inventory.map((entry) => [entry.generation, entry.frames]));
    assert.equal(byGeneration.get(GEN_A), 2);
    assert.equal(byGeneration.get(GEN_B), 1);
  });
});
