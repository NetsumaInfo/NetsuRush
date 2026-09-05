// A disk store for rendered frames, so a composition can be played back at
// speed instead of re-rendered.
//
// Why this exists: a fresh 1080p capture costs ~300 ms — about 3 fps — and no
// amount of tuning turns a browser screenshot into a 24 fps source. The memory
// cache fixes repeats, but it is byte-bounded, and a 15-second portrait
// composition is 894 frames at 8.3 MiB each: 7.4 GiB, which no sensible bound
// holds. The editor's own player is smooth because it never captures anything;
// the host has no such option, so the frames have to already exist.
//
// Not PNG, deliberately: the whole point is to remove work from the playback
// path, and a PNG decode is 30-60 ms per 1080p frame — the same order as the
// capture it replaces.
//
// That ruled out PNG. It did not rule out a codec built for speed, and storing
// raw RGBA instead cost 7.91 MiB per 1080p frame — 2.32 GiB for a 300-frame
// composition, which is what a user actually hit. Measured on this machine,
// 1920x1080 RGBA, sync zstd:
//
//   content                      level 1 ratio   encode   decode
//   engine fixture (flat/alpha)      685x        1.6 ms    6.4 ms
//   gradient + blocks (realistic)     81x        4.2 ms    7.9 ms
//   random noise (worst case)        1.0x        7.4 ms    5.6 ms
//   (a raw read, for comparison: 1.1 ms memcpy)
//
// So ~6 ms per frame buys 80x to 685x on anything graphical, and never costs
// size: zstd stores incompressible input verbatim. Against a 42 ms served
// frame or a ~300 ms fresh capture, 6 ms is noise. Level 1 is the default on
// both counts — level 3 measured *worse* on the realistic case (60x against
// 81x) while costing more, so higher is not monotonically better here.
//
// Every tier is lossless. Pixels come back bit-exact whatever the setting;
// what the setting trades is encode time against size, never quality.
//
// Keys are the scheduler's own frame keys, so revision, size, props and engine
// identity are already folded in: nothing here has to decide when a baked frame
// went stale, because a stale frame has a different name.
//
// That last sentence used to be the whole story, and it was only half of one.
// A different name means the old frame is never *served* — it does not mean the
// old frame is ever *deleted*. Measured on a 60-frame 1080x1920 composition:
// each parameter change added 60 files and 474 MiB and removed nothing, so
// three tweaks held 1.9 GiB of pixels that could never be read again. On a
// 15-second composition that is +7.2 GiB per tweak, until the byte cap
// eventually starts evicting at whatever bound it was given.
//
// So frames are grouped on disk by the generation they belong to — one
// directory per binding revision — and a generation is dropped as a unit the
// moment something supersedes it. The byte cap stays as a backstop for the one
// case generations cannot cover: a single generation larger than the bound.

import {
  mkdirSync, readFileSync, statSync,
  readdirSync, renameSync, unlinkSync, writeFileSync, existsSync, rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';

const HEADER_BYTES = 24;
const MAGIC = 0x3242464e; // "NFB2" — bumped with the header, so a frame written
                          // by the previous raw-only format fails the check and
                          // is re-rendered rather than read as pixels.

const CODEC_RAW = 0;
const CODEC_ZSTD = 1;

/// What the user picks, and what each one actually is. Names describe the
/// trade the setting makes — size against encode time — because there is no
/// quality axis to trade: all three are lossless.
export const BAKE_QUALITIES = Object.freeze({
  fast: { codec: CODEC_ZSTD, level: 1 },
  compact: { codec: CODEC_ZSTD, level: 9 },
  raw: { codec: CODEC_RAW, level: 0 },
});

export const DEFAULT_BAKE_QUALITY = 'fast';

function qualityOf(name) {
  return BAKE_QUALITIES[name] ?? BAKE_QUALITIES[DEFAULT_BAKE_QUALITY];
}

/// Generations name directories, so they are checked before they are used as a
/// path segment rather than trusted for being internally produced. `revisionKey`
/// returns a sha256 hex digest; anything else is not a generation.
const GENERATION_PATTERN = /^[0-9a-f]{16,64}$/;

/// A frame file is its own description: two different bindings can produce the
/// same frame index, and a truncated write must be detectable rather than
/// delivered as pixels. `rawBytes` is what the pixels weigh once decoded, so a
/// short or lying payload is caught before it reaches a caller as an image.
function encodeHeader(width, height, stride, codec, rawBytes) {
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32LE(MAGIC, 0);
  header.writeUInt32LE(width, 4);
  header.writeUInt32LE(height, 8);
  header.writeUInt32LE(stride, 12);
  header.writeUInt32LE(codec, 16);
  header.writeUInt32LE(rawBytes, 20);
  return header;
}

/// Level 1 unless the setting says otherwise. Sync on purpose: the async zlib
/// wrappers add a threadpool hop and an allocation that dominate at this size,
/// and this already runs off the request path inside the scheduler.
function pack(pixels, quality) {
  if (quality.codec === CODEC_RAW) return { codec: CODEC_RAW, body: pixels };
  const body = zstdCompressSync(pixels, {
    params: { [constants.ZSTD_c_compressionLevel]: quality.level },
  });
  return { codec: CODEC_ZSTD, body };
}

export function createFrameStore({
  directory,
  maxBytes = 12 * 1024 * 1024 * 1024,
  quality = DEFAULT_BAKE_QUALITY,
} = {}) {
  if (!directory) return null;
  mkdirSync(directory, { recursive: true });
  let activeQuality = quality;

  /// generation -> { files: Map<name, {bytes, at}>, bytes, at }
  const generations = new Map();
  let bytesOnDisk = 0;

  function generationEntry(generation) {
    let entry = generations.get(generation);
    if (!entry) {
      entry = { files: new Map(), bytes: 0, at: Date.now() };
      generations.set(generation, entry);
    }
    return entry;
  }

  // A restart must not lose what a bake already paid for, so the directory is
  // inventoried rather than cleared: an unchanged composition comes back to a
  // full store, which is where the measured 42 ms read against a 399 ms
  // capture actually comes from.
  try {
    for (const name of readdirSync(directory, { withFileTypes: true })) {
      if (!name.isDirectory() || !GENERATION_PATTERN.test(name.name)) continue;
      const entry = generationEntry(name.name);
      let newest = 0;
      for (const file of readdirSync(join(directory, name.name))) {
        if (!file.endsWith('.nfbk')) continue;
        const info = statSync(join(directory, name.name, file));
        entry.files.set(file, { bytes: info.size, at: info.mtimeMs });
        entry.bytes += info.size;
        bytesOnDisk += info.size;
        newest = Math.max(newest, info.mtimeMs);
      }
      entry.at = newest || entry.at;
      if (entry.files.size === 0) generations.delete(name.name);
    }
  } catch {
    // An unreadable store is an empty store, never a startup failure.
  }

  function removeGeneration(generation) {
    const entry = generations.get(generation);
    if (!entry) return { frames: 0, bytes: 0 };
    const removed = { frames: entry.files.size, bytes: entry.bytes };
    try {
      rmSync(join(directory, generation), { recursive: true, force: true });
    } catch {
      // Held open by a reader, or already gone. Either way this process stops
      // counting it: a file it cannot delete is not one it should serve.
    }
    generations.delete(generation);
    bytesOnDisk -= entry.bytes;
    if (bytesOnDisk < 0) bytesOnDisk = 0;
    return removed;
  }

  /// The backstop, not the mechanism. Generations are the mechanism; this only
  /// catches a store whose *current* generation outgrows the bound, and it
  /// evicts by file rather than by generation so a bake in progress loses its
  /// oldest frames instead of all of them.
  function prune() {
    if (bytesOnDisk <= maxBytes) return;
    const files = [];
    for (const [generation, entry] of generations) {
      for (const [name, file] of entry.files) files.push({ generation, name, file });
    }
    files.sort((a, b) => a.file.at - b.file.at);
    for (const { generation, name, file } of files) {
      if (bytesOnDisk <= maxBytes * 0.9) break;
      try {
        unlinkSync(join(directory, generation, name));
      } catch {
        // Already gone, or held open by a reader; either way stop counting it.
      }
      const entry = generations.get(generation);
      if (entry) {
        entry.files.delete(name);
        entry.bytes -= file.bytes;
        if (entry.files.size === 0) generations.delete(generation);
      }
      bytesOnDisk -= file.bytes;
    }
  }

  const usable = (generation) => typeof generation === 'string'
    && GENERATION_PATTERN.test(generation);

  return {
    get directory() { return directory; },
    get count() {
      let total = 0;
      for (const entry of generations.values()) total += entry.files.size;
      return total;
    },
    get bytes() { return bytesOnDisk; },
    get maxBytes() { return maxBytes; },
    get generationCount() { return generations.size; },
    get quality() { return activeQuality; },

    /// Changing the setting does not rewrite what is already on disk: every
    /// frame names its own codec in its header, so old and new tiers coexist
    /// and each is read the way it was written.
    setQuality(name) {
      activeQuality = name in BAKE_QUALITIES ? name : DEFAULT_BAKE_QUALITY;
      return activeQuality;
    },

    /// What is on disk, newest first, so the editor can show the user what
    /// their tweaking has actually cost.
    inventory() {
      return [...generations.entries()]
        .map(([generation, entry]) => ({
          generation, frames: entry.files.size, bytes: entry.bytes, at: entry.at,
        }))
        .sort((a, b) => b.at - a.at);
    },

    has(key, generation) {
      if (!usable(generation)) return false;
      return generations.get(generation)?.files.has(`${key}.nfbk`) ?? false;
    },

    /// Returns the frame, or null when it is absent or does not describe
    /// itself correctly. Null always means "render it", never "fail".
    read(key, generation) {
      if (!usable(generation)) return null;
      try {
        // One read rather than two positional ones: a compressed body has no
        // length known in advance, so there is no offset to seek the pixels to.
        const file = readFileSync(join(directory, generation, `${key}.nfbk`));
        if (file.length < HEADER_BYTES) return null;
        if (file.readUInt32LE(0) !== MAGIC) return null;
        const width = file.readUInt32LE(4);
        const height = file.readUInt32LE(8);
        const stride = file.readUInt32LE(12);
        const codec = file.readUInt32LE(16);
        const size = file.readUInt32LE(20);
        if (width === 0 || height === 0 || size === 0 || size > 0x7fffffff) return null;
        if (size !== stride * height) return null;

        const body = file.subarray(HEADER_BYTES);
        const pixels = codec === CODEC_ZSTD ? zstdDecompressSync(body) : body;
        // A payload that decodes to the wrong length is torn, truncated or from
        // another format. Handing it back would deliver uninitialised or
        // misaligned memory to the caller as an image.
        if (pixels.length !== size) return null;
        return { width, height, stride, pixelFormat: 'RGBA8', alphaMode: 'straight', pixels };
      } catch {
        // A damaged frame means "render it", never "fail": every caller treats
        // null as a miss, and a cache that throws is worse than no cache.
        return null;
      }
    },

    /// Write-then-rename, so a reader never sees a partial frame — including
    /// the reader in another process, which is the normal case here.
    write(key, frame, generation) {
      if (!usable(generation)) return false;
      if (!frame?.pixels || !frame.width || !frame.height) return false;
      const stride = frame.stride ?? frame.width * 4;
      const folder = join(directory, generation);
      const path = join(folder, `${key}.nfbk`);
      const temporary = `${path}.${process.pid}.tmp`;
      let bytes = 0;
      try {
        mkdirSync(folder, { recursive: true });
        const packed = pack(frame.pixels, qualityOf(activeQuality));
        const payload = Buffer.concat([
          encodeHeader(frame.width, frame.height, stride, packed.codec, frame.pixels.length),
          packed.body,
        ]);
        bytes = payload.length;
        writeFileSync(temporary, payload);
        renameSync(temporary, path);
      } catch {
        try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* best effort */ }
        return false;
      }
      const entry = generationEntry(generation);
      const known = entry.files.get(`${key}.nfbk`);
      if (known) {
        entry.bytes -= known.bytes;
        bytesOnDisk -= known.bytes;
      }
      entry.files.set(`${key}.nfbk`, { bytes, at: Date.now() });
      entry.bytes += bytes;
      entry.at = Date.now();
      bytesOnDisk += bytes;
      prune();
      return true;
    },

    /// Drops one generation as a unit. This is the reclaim path: a parameter
    /// change makes every frame of the previous value unreachable at once, so
    /// they are deleted at once rather than waiting for a byte cap.
    dropGeneration(generation) {
      if (!usable(generation)) return { frames: 0, bytes: 0 };
      return removeGeneration(generation);
    },

    /// Drops every generation except the ones named. Used to reclaim the
    /// leftovers of a previous run, which no live binding can ever ask for
    /// again but which nothing else would supersede.
    dropExcept(keep) {
      const kept = new Set(keep);
      const removed = { frames: 0, bytes: 0, generations: 0 };
      for (const generation of [...generations.keys()]) {
        if (kept.has(generation)) continue;
        const gone = removeGeneration(generation);
        removed.frames += gone.frames;
        removed.bytes += gone.bytes;
        removed.generations += 1;
      }
      return removed;
    },

    clear() {
      const removed = { frames: 0, bytes: 0, generations: generations.size };
      for (const generation of [...generations.keys()]) {
        const gone = removeGeneration(generation);
        removed.frames += gone.frames;
        removed.bytes += gone.bytes;
      }
      // Anything the inventory never knew about — a torn temporary, a
      // directory from an older layout — goes too. "Vider le cache" has to
      // mean the folder is empty, not that the bookkeeping says it is.
      try {
        for (const name of readdirSync(directory)) {
          rmSync(join(directory, name), { recursive: true, force: true });
        }
      } catch {
        // best effort
      }
      generations.clear();
      bytesOnDisk = 0;
      return removed;
    },
  };
}
