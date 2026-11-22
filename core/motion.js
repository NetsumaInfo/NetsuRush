// @ts-check
// How much the picture changes, frame by frame, in a video. Two uses:
//   - choosing which frames of a shot to show an agent: more frames where more happens, placed where
//     it happens, so a static 10 s shot costs 2 frames and a shot that hides a missed cut shows both
//     sides of it;
//   - flagging cuts to check: boundaries where nothing changes, jumps inside a shot.
//
// Measured on a 24 min BluRay episode, by eye against the frames. Comparing the STRUCTURE of the two
// sides of a boundary finds false cuts cleanly: a fade changes every pixel's brightness (12 grey levels
// per frame) yet keeps the picture, and no real cut scored above 0.69 where the 4 false ones scored
// 0.91 and more. A jump inside a shot is a real missed cut only about one time in five, the rest being
// flashes, impacts and fast animation, whichever way it is filtered. So jumps are never acted on here:
// they are hints an agent checks with its eyes, and the frame choice does not depend on them.
//
// The analysis decodes the whole file once at very low resolution, below the interface's priority,
// and is cached on disk: about three bytes per frame.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { ffBin, getThumbDir, fsp } = require('./config');
const { playInfo } = require('./ffmpeg');
const { cacheIndex } = require('./cacheIndex');
const { lowerPriority } = require('./backgroundPriority');

const FORMAT_VERSION = 2;
const WIDTH = 64;
const HEIGHT = 36;
const FRAME_BYTES = WIDTH * HEIGHT;
/// Change values are stored on one byte, at half a grey level each.
const SCALE = 2;
/// A frame's change counts at most this much: one flash must not outweigh a whole shot of movement.
const CHANGE_CAP = 40;

const JUMP_MIN = 6;
const JUMP_NEIGHBOURS = 8;
const JUMP_ISOLATION = 4;
const JUMP_MAX_SIMILARITY = 0.6;
const SIDE_FRAMES = 3;
const LATER_FRAMES = 24;
const RING = LATER_FRAMES + SIDE_FRAMES + 8;
/// Above this, the two sides of a boundary are the same picture.
const FALSE_CUT_LIKENESS = 0.85;
/// A nearly uniform frame (black, white) has no structure to compare: a fade through black is a cut.
const FLAT_FRAME_DEVIATION = 0.85;
const MIN_FRAMES = 2;
/// Below this much change per second a shot is nearly fixed: a held shot, a slow pan. 3 or 4 frames
/// show what kind of shot it is; more would only spend tokens on the same picture.
const NEARLY_FIXED_PER_SECOND = 45;
const MAX_FRAMES = 6;
/// Only a very long shot goes past the usual ceiling: past that length it often hides several shots.
const LONG_SHOT_SECONDS = 20;
const LONG_SHOT_MAX_FRAMES = 8;

/// Frames to show for a shot, from its length and from how much changes in it (the sum of the capped
/// frame changes). Calibrated on a real episode: 2 for a very short shot, 3 or 4 for a nearly fixed
/// one however long, 6 for a 15 s "shot" hiding three real ones, 8 for a 95 s busy one.
/** @param {number} seconds @param {number|null} [change] null when the file was not analysed */
function frameCount(seconds, change) {
  const base = seconds < 1.5 ? 2 : seconds < 6 ? 3 : 4;
  if (change == null) return base;
  if (change / Math.max(seconds, 0.1) < NEARLY_FIXED_PER_SECOND) return base;
  const extra = change < 120 ? 0 : change < 350 ? 1 : change < 800 ? 2 : change < 2000 ? 3 : 4;
  const ceiling = seconds >= LONG_SHOT_SECONDS && extra === 4 ? LONG_SHOT_MAX_FRAMES : MAX_FRAMES;
  return Math.max(MIN_FRAMES, Math.min(ceiling, base + extra));
}

/// Frames of a shot placed by change: equal shares of what happens rather than equal shares of time.
/// A floor keeps time in the balance, so a shot with one flash does not put every frame on the flash
/// and a still shot comes out evenly spaced. From 4 frames on, the first and last sit at the very ends
/// of the shot: a detection that glued a scene to the next one hides it there.
/** @param {Uint8Array} change @param {number} inFrame @param {number} outFrame @param {number} count */
function placeFrames(change, inFrame, outFrame, count) {
  const span = outFrame - inFrame + 1;
  const wanted = Math.max(1, Math.min(count, span));
  const weights = new Float64Array(span);
  let total = 0;
  for (let k = 1; k < span; k += 1) {
    const value = Math.min(CHANGE_CAP, (change[inFrame + k] || 0) / SCALE);
    weights[k] = value;
    total += value;
  }
  const floor = total / Math.max(1, span) / 2 + 0.3;
  let sum = 0;
  for (let k = 0; k < span; k += 1) { weights[k] += floor; sum += weights[k]; }
  /** @type {number[]} */
  const frames = [];
  let running = 0;
  let next = 0;
  for (let k = 0; k < span && next < wanted; k += 1) {
    running += weights[k];
    while (next < wanted && running >= sum * (wanted >= 4 ? 0.02 + (0.96 * next) / (wanted - 1) : (next + 0.5) / wanted)) {
      if (frames[frames.length - 1] !== inFrame + k) frames.push(inFrame + k);
      next += 1;
    }
  }
  return frames;
}

/** @param {Uint8Array} change @param {number} inFrame @param {number} outFrame */
function shotChange(change, inFrame, outFrame) {
  let total = 0;
  for (let n = inFrame + 1; n <= outFrame; n += 1) total += Math.min(CHANGE_CAP, (change[n] || 0) / SCALE);
  return total;
}

/**
 * The frames to show for each shot.
 * @param {{ inFrame?:number, outFrame?:number, startSec:number, endSec:number }[]} shots
 * @param {{ change:Uint8Array, fps:number }|null} motion null: placed by time alone
 * @param {number|null} [fixed] a fixed number of frames per shot instead of the smart one
 */
function planShots(shots, motion, fixed) {
  return shots.map((s) => {
    const seconds = s.endSec - s.startSec;
    const known = motion && typeof s.inFrame === 'number' && typeof s.outFrame === 'number' && s.outFrame < motion.change.length;
    if (known) {
      const inFrame = /** @type {number} */ (s.inFrame);
      const outFrame = /** @type {number} */ (s.outFrame);
      const count = fixed || frameCount(seconds, shotChange(motion.change, inFrame, outFrame));
      return placeFrames(motion.change, inFrame, outFrame, count).map((f) => (f + 0.5) / motion.fps);
    }
    const count = fixed || frameCount(seconds, null);
    return Array.from({ length: count }, (_, i) => s.startSec + (seconds * (i + 0.5)) / count);
  });
}

/// Boundaries that are not cuts, jumps that may be cuts.
/**
 * @param {{ inFrame:number, outFrame:number }[]} shots
 * @param {{ likeness:Uint8Array, jumps:any[] }} motion
 */
function checkCuts(shots, motion) {
  const sorted = [...shots].sort((a, b) => a.inFrame - b.inFrame);
  const falseCuts = [];
  const missedCuts = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const frame = sorted[i].inFrame;
    if (frame < motion.likeness.length && motion.likeness[frame] / 255 > FALSE_CUT_LIKENESS) falseCuts.push({ frame, shots: [i - 1, i] });
  }
  let s = 0;
  for (const jump of motion.jumps) {
    while (s < sorted.length && sorted[s].outFrame < jump.frame) s += 1;
    const shot = sorted[s];
    if (!shot || jump.frame <= shot.inFrame + 1 || jump.frame > shot.outFrame) continue;
    missedCuts.push({ frame: jump.frame, shot: s, inFrame: shot.inFrame, outFrame: shot.outFrame, similarity: jump.similarity });
  }
  return { falseCuts, missedCuts };
}

/** @param {ArrayLike<number>} a @param {ArrayLike<number>} b how alike two pictures are, brightness aside */
function similarity(a, b) {
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < a.length; i += 1) { ma += a[i]; mb += b[i]; }
  ma /= a.length;
  mb /= a.length;
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    ab += x * y;
    aa += x * x;
    bb += y * y;
  }
  const norm = Math.sqrt(aa * bb);
  return norm > 1e-3 ? ab / norm : 1;
}

/// How much a frame departs from its own average: 0 is a uniform picture.
/** @param {Uint8Array} frame */
function deviation(frame) {
  let mean = 0;
  for (let i = 0; i < frame.length; i += 1) mean += frame[i];
  mean /= frame.length;
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) sum += (frame[i] - mean) ** 2;
  return Math.sqrt(sum / frame.length);
}

/// Reads grey frames one at a time and keeps what the analysis needs of them.
function createAccumulator() {
  /** @type {number[]} */
  const changes = [];
  /** @type {number[]} */
  const likeness = [];
  /** @type {any[]} */
  const jumps = [];
  /** @type {Uint8Array[]} */
  const ring = new Array(RING);
  /** @type {Uint8Array|null} */
  let previous = null;
  let previousFlat = false;

  /** @param {number} from @param {number} to */
  const average = (from, to) => {
    const out = new Float32Array(FRAME_BYTES);
    for (let n = from; n <= to; n += 1) {
      const frame = ring[n % RING];
      for (let i = 0; i < FRAME_BYTES; i += 1) out[i] += frame[i];
    }
    return out;
  };

  /** @param {number} n a frame old enough for the frames after it to have been read */
  function judge(n) {
    if (n < SIDE_FRAMES || n + 1 >= changes.length) return;
    const jump = changes[n];
    if (jump < JUMP_MIN || jump < changes[n - 1] || jump < changes[n + 1]) return;
    const around = [];
    for (let k = Math.max(1, n - JUMP_NEIGHBOURS); k <= Math.min(changes.length - 1, n + JUMP_NEIGHBOURS); k += 1) {
      if (Math.abs(k - n) > 1) around.push(changes[k]);
    }
    around.sort((a, b) => a - b);
    const local = around.length ? around[Math.floor(around.length / 2)] : 0;
    if (jump / (local + 1.5) < JUMP_ISOLATION) return;
    const before = average(n - SIDE_FRAMES, n - 1);
    const after = similarity(before, average(n + 1, n + SIDE_FRAMES));
    if (after >= JUMP_MAX_SIMILARITY) return;
    // A flash comes back to what it was: still different a second later is what a cut looks like.
    if (similarity(before, ring[(n + LATER_FRAMES) % RING]) >= JUMP_MAX_SIMILARITY) return;
    jumps.push({ frame: n, similarity: Math.round(after * 100) / 100 });
  }

  /** @param {Uint8Array} frame */
  function push(frame) {
    const n = changes.length;
    let sum = 0;
    if (previous) for (let i = 0; i < FRAME_BYTES; i += 1) sum += Math.abs(frame[i] - previous[i]);
    changes.push(sum / FRAME_BYTES);
    const flat = deviation(frame) < FLAT_FRAME_DEVIATION;
    likeness.push(previous && !flat && !previousFlat ? Math.max(0, similarity(previous, frame)) : 0);
    previousFlat = flat;
    ring[n % RING] = frame;
    previous = frame;
    if (n >= LATER_FRAMES) judge(n - LATER_FRAMES);
  }

  return { push, changes, likeness, jumps };
}

/** @param {string} file */
async function cachePath(file) {
  const stat = await fsp.stat(file);
  const key = crypto.createHash('md5').update(JSON.stringify([file, stat.mtimeMs, stat.size, WIDTH, FORMAT_VERSION])).digest('hex').slice(0, 24);
  return path.join(getThumbDir(), `motion_${key}.json`);
}

/** @param {string} raw */
function decode(raw) {
  const saved = JSON.parse(raw);
  return {
    fps: saved.fps, frames: saved.frames, jumps: saved.jumps,
    change: new Uint8Array(Buffer.from(saved.change, 'base64')),
    likeness: new Uint8Array(Buffer.from(saved.likeness, 'base64')),
  };
}

/** @type {Map<string, any>} */
const loaded = new Map();
/** @type {Map<string, Promise<any>>} */
const running = new Map();
/** @type {string[]} */
const queue = [];
let active = false;

/** @param {string} file */
async function peek(file) {
  if (loaded.has(file)) return loaded.get(file);
  try {
    const motion = decode(await fsp.readFile(await cachePath(file), 'utf8'));
    loaded.set(file, motion);
    return motion;
  } catch { return null; }
}

/** @param {string} file */
function decodeAll(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffBin('ffmpeg'), [
      '-v', 'error', '-i', file, '-map', '0:v:0', '-an',
      '-vf', `scale=${WIDTH}:${HEIGHT}:flags=area,format=gray`,
      '-f', 'rawvideo', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    lowerPriority(child);
    const accumulator = createAccumulator();
    let pending = Buffer.alloc(0);
    let errors = '';
    child.stdout.on('data', (chunk) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let at = 0;
      while (pending.length - at >= FRAME_BYTES) {
        accumulator.push(new Uint8Array(pending.subarray(at, at + FRAME_BYTES)));
        at += FRAME_BYTES;
      }
      pending = pending.subarray(at);
    });
    child.stderr.on('data', (chunk) => { errors = (errors + chunk).slice(-500); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code) reject(new Error(errors || `ffmpeg exited with ${code}`));
      else resolve(accumulator);
    });
  });
}

/** @param {string} file */
async function run(file) {
  const started = Date.now();
  const info = await playInfo(file);
  const accumulator = /** @type {any} */ (await decodeAll(file));
  const change = Uint8Array.from(accumulator.changes, (/** @type {number} */ v) => Math.min(255, Math.round(v * SCALE)));
  const likeness = Uint8Array.from(accumulator.likeness, (/** @type {number} */ v) => Math.round(v * 255));
  const saved = { fps: info.fps, frames: change.length, jumps: accumulator.jumps, change: Buffer.from(change).toString('base64'), likeness: Buffer.from(likeness).toString('base64') };
  const target = await cachePath(file);
  await fsp.writeFile(target, JSON.stringify(saved));
  cacheIndex().record({ kind: 'thumb', file: target, source: file, bytes: fs.statSync(target).size });
  const motion = { fps: info.fps, frames: change.length, jumps: accumulator.jumps, change, likeness, seconds: Math.round((Date.now() - started) / 1000) };
  loaded.set(file, motion);
  return motion;
}

function pump() {
  if (active) return;
  const file = queue.shift();
  if (!file) return;
  active = true;
  const job = /** @type {any} */ (running.get(file));
  run(file).then(job.resolve, job.reject).finally(() => {
    running.delete(file);
    active = false;
    pump();
  });
}

/// The analysis of a file, computed if needed. One at a time: it is a full decode of each file.
/** @param {string} file */
async function analyze(file) {
  const known = await peek(file);
  if (known) return known;
  const ongoing = running.get(file);
  if (ongoing) return ongoing;
  /** @type {any} */
  let handlers;
  const promise = new Promise((resolve, reject) => { handlers = { resolve, reject }; });
  running.set(file, Object.assign(promise, handlers));
  promise.catch(() => {});
  queue.push(file);
  pump();
  return promise;
}

/// Frame plan of shots, starting the analysis in the background when it is missing: this answer is
/// placed by time alone, the next one will not be.
/** @param {{ path:string, shots:any[], framesPerShot?:number }} o */
async function shotFrames(o) {
  const motion = await peek(o.path);
  if (!motion) analyze(o.path).catch(() => {});
  const fixed = o.framesPerShot ? Math.max(MIN_FRAMES, Math.min(LONG_SHOT_MAX_FRAMES, Math.round(Number(o.framesPerShot)))) : null;
  return { ok: true, analysed: !!motion, plans: planShots(o.shots || [], motion, fixed) };
}

module.exports = {
  analyze, peek, shotFrames, checkCuts, frameCount, placeFrames, planShots, shotChange, similarity, createAccumulator, SCALE, FRAME_BYTES,
};
