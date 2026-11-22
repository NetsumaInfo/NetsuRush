// @ts-check
// Contact sheets: many frames of a video in ONE image, so an agent can read an action or scan a rush
// instead of judging a single still. Two shapes:
//   shotSheet  frames evenly spread over one shot, in reading order: what happens in it.
//   frameGrid  frames picked anywhere, in one file or several: what a rush holds, or a list of search
//              hits with one row per shot (about 120 tokens per shot, against 350 for its own sheet).
//
// A sheet costs a model what one full thumbnail does (966x412 ≈ 530 tokens against 854x480 ≈ 546):
// the pixels go down per frame, not up per image. Measured on real footage, 12 frames of a shot take
// 0.15 s on an H.264 720p file and 0.76 s on a 10-bit H.265 BluRay.
//
// A short shot is decoded in one pass, since seeking once per frame would redo the same GOP each
// time. A long range goes through the shared thumbnail cache instead: one pass would decode it all.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getThumbDir, fsp, fileReady } = require('./config');
const { run, playInfo, probeMedia } = require('./ffmpeg');
const { thumbnail } = require('./thumbs');
const { cacheIndex } = require('./cacheIndex');

const ONE_PASS_MAX_SECONDS = 30;
const MAX_CELLS = 36;
const MIN_WIDTH = 120;
const MAX_WIDTH = 480;
const DEFAULT_WIDTH = 240;
const TIMEOUT_MS = 60000;

/// Cells carry a number drawn on the image. Told only "row 7 is shot 27", a model miscounts: on real
/// footage Haiku described the shot one row above and attributed it to the wrong frames. A number it
/// reads cannot be off by one. Any common font will do; with none, the grid goes unlabelled.
const FONT_CANDIDATES = [
  'C:/Windows/Fonts/arialbd.ttf', 'C:/Windows/Fonts/arial.ttf', 'C:/Windows/Fonts/segoeui.ttf',
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/System/Library/Fonts/Helvetica.ttc',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
];
/** @type {string|null|undefined} */
let labelFontCache;
function labelFont() {
  if (labelFontCache === undefined) labelFontCache = FONT_CANDIDATES.find((f) => fs.existsSync(f)) || null;
  return labelFontCache;
}

/// A filter value: the colon of a drive letter and the quotes must be escaped, spaces need the quotes.
/** @param {string} font */
const fontArg = (font) => `'${font.replace(/\\/g, '/').replace(/:/g, '\\:')}'`;

/** @param {any} label */
const cleanLabel = (label) => String(label == null ? '' : label).replace(/[^A-Za-z0-9#-]/g, '').slice(0, 8);

/// `count` offsets evenly spread over `span` frames, first and last included, no duplicates.
/** @param {number} span @param {number} count */
function sampleOffsets(span, count) {
  const frames = Math.max(1, Math.floor(span));
  const n = Math.max(1, Math.min(Math.floor(count), frames));
  if (n === 1) return [Math.floor((frames - 1) / 2)];
  return Array.from({ length: n }, (_, i) => Math.round((i * (frames - 1)) / (n - 1)));
}

/// Fewer cells than asked (a very short shot) must not leave a wide strip of black.
/** @param {number} cells @param {number} cols */
function gridLayout(cells, cols) {
  const c = Math.max(1, Math.min(Math.floor(cols) || 1, cells));
  return { cols: c, rows: Math.ceil(cells / c) };
}

/** @param {any} value @param {number} fallback @param {number} min @param {number} max */
function clampInt(value, fallback, min, max) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.max(min, Math.min(max, n)) : fallback;
}

/// One decode pass from the shot's first frame. Seeks a quarter frame early, like a re-encode cut
/// (core/export/frameCut.js): a stored timestamp rounded below the target would otherwise lose the
/// first frame. `n` then counts from the shot's first frame.
/** @param {{ input:string, inFrame:number, fps:number, offsets:number[], cols:number, rows:number, width:number }} o */
function shotSheetArgs(o) {
  const select = o.offsets.map((k) => `eq(n\\,${k})`).join('+');
  return [
    '-v', 'error', '-y',
    '-ss', ((o.inFrame - 0.25) / o.fps).toFixed(5),
    '-i', o.input,
    '-map', '0:v:0',
    '-vf', `select='${select}',scale=${o.width}:-2,tile=${o.cols}x${o.rows}:padding=2,format=yuvj420p`,
    '-frames:v', '1',
    '-q:v', '5',
    '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1',
  ];
}

/// Assembles already-extracted frames into fixed-size cells. Frames of different files may differ
/// in shape: each is fitted inside its cell, with black bars rather than stretched.
/** @param {{ inputs:string[], cols:number, width:number, height:number, labels?:any[], cells?:number[], font?:string|null }} o */
function gridArgs(o) {
  const cell = (/** @type {number} */ i) => (o.cells ? o.cells[i] : i);
  const n = o.inputs.length;
  const size = Math.max(14, Math.round(o.height / 6));
  const scaled = o.inputs.map((_, i) => {
    const label = o.font && o.labels ? cleanLabel(o.labels[i]) : '';
    const text = label
      ? `,drawtext=fontfile=${fontArg(/** @type {string} */ (o.font))}:text='${label}':x=4:y=4:fontsize=${size}:fontcolor=white:box=1:boxcolor=black@0.75:boxborderw=4`
      : '';
    return `[${i}:v:0]scale=${o.width}:${o.height}:force_original_aspect_ratio=decrease,`
      + `pad=${o.width}:${o.height}:(ow-iw)/2:(oh-ih)/2,setsar=1${text}[c${i}]`;
  }).join(';');
  const stack = n === 1
    ? '[c0]format=yuvj420p[out]'
    : `${o.inputs.map((_, i) => `[c${i}]`).join('')}xstack=inputs=${n}:fill=black:layout=${
      o.inputs.map((_, i) => `${(cell(i) % o.cols) * (o.width + 2)}_${Math.floor(cell(i) / o.cols) * (o.height + 2)}`).join('|')
    },format=yuvj420p[out]`;
  return [
    '-v', 'error', '-y',
    ...o.inputs.flatMap((input) => ['-i', input]),
    '-filter_complex', `${scaled};${stack}`,
    '-map', '[out]',
    '-frames:v', '1',
    '-q:v', '5',
    '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1',
  ];
}

/** @param {string} source @param {Buffer} buf @param {string} key */
async function store(source, buf, key) {
  const file = path.join(getThumbDir(), `sheet_${key}.jpg`);
  await fsp.writeFile(file, buf);
  cacheIndex().record({ kind: 'thumb', file, source, bytes: buf.length });
  return file;
}

/** @param {any[]} parts */
const hashKey = (parts) => crypto.createHash('md5').update(JSON.stringify(parts)).digest('hex').slice(0, 24);

/// A range given in frames or in seconds, with the rate that links them.
/** @param {any} o @param {number} fps */
function shotRange(o, fps) {
  const inFrame = o.inFrame != null ? Math.max(0, Math.round(Number(o.inFrame))) : Math.round(Number(o.start || 0) * fps);
  // `end` is an exclusive time, `outFrame` an inclusive frame.
  const outFrame = o.outFrame != null ? Math.round(Number(o.outFrame)) : Math.round(Number(o.end || 0) * fps) - 1;
  return { inFrame, outFrame: Math.max(inFrame, outFrame) };
}

/**
 * @param {{ path:string, inFrame?:number, outFrame?:number, start?:number, end?:number,
 *           cols?:number, rows?:number, width?:number }} o
 */
async function shotSheet(o) {
  const info = await playInfo(o.path);
  const fps = Number(info && info.fps);
  if (!(fps > 0)) return { ok: false, error: 'unknown frame rate: not a readable video' };
  const { inFrame, outFrame } = shotRange(o, fps);
  const wantCols = clampInt(o.cols, 4, 1, MAX_CELLS);
  const wantRows = clampInt(o.rows, 3, 1, MAX_CELLS);
  const width = clampInt(o.width, DEFAULT_WIDTH, MIN_WIDTH, MAX_WIDTH);
  const offsets = sampleOffsets(outFrame - inFrame + 1, Math.min(wantCols * wantRows, MAX_CELLS));
  const { cols, rows } = gridLayout(offsets.length, wantCols);
  const frames = offsets.map((k) => inFrame + k);
  const describe = {
    ok: true, cols, rows, fps, inFrame, outFrame,
    // Reading order: left to right, then top to bottom.
    frames,
  };

  const key = hashKey(['shot', o.path, inFrame, outFrame, cols, rows, width]);
  const cached = path.join(getThumbDir(), `sheet_${key}.jpg`);
  if (await fileReady(cached)) { cacheIndex().touch(cached); return { ...describe, path: cached }; }

  if ((outFrame - inFrame + 1) / fps > ONE_PASS_MAX_SECONDS) {
    /** @type {any} */
    const grid = await frameGrid({ path: o.path, times: frames.map((f) => (f + 0.5) / fps), cols, width });
    return grid.ok ? { ...describe, path: grid.path } : grid;
  }
  const buf = await run('ffmpeg', shotSheetArgs({ input: o.path, inFrame, fps, offsets, cols, rows, width }), {
    encoding: 'buffer', timeout: TIMEOUT_MS, background: true,
  });
  if (!buf || !buf.length) return { ok: false, error: 'ffmpeg produced no image' };
  return { ...describe, path: await store(o.path, buf, key) };
}

/// Frames of one file (`path` + `times`), or of several (`items`). `labels`, aligned on the frames,
/// draws a number on a cell (null for none); `cells` places each frame in a given cell.
/**
 * @param {{ path?:string, times?:number[], items?:{path:string, time:number}[], labels?:any[], cells?:number[], cols?:number, width?:number }} o
 */
async function frameGrid(o) {
  const items = (Array.isArray(o.items) ? o.items : (Array.isArray(o.times) ? o.times : []).map((time) => ({ path: String(o.path), time })))
    .map((it) => ({ path: it.path, time: Number(it.time) }))
    .filter((it) => it.path && Number.isFinite(it.time) && it.time >= 0)
    .slice(0, MAX_CELLS);
  if (!items.length) return { ok: false, error: 'no frame requested' };
  const width = clampInt(o.width, DEFAULT_WIDTH, MIN_WIDTH, MAX_WIDTH);
  const wantedCols = clampInt(o.cols, 5, 1, MAX_CELLS);
  const cells = Array.isArray(o.cells) && o.cells.length >= items.length ? o.cells.slice(0, items.length).map(Number) : undefined;
  const { cols, rows } = cells
    ? { cols: wantedCols, rows: Math.ceil((Math.max(...cells) + 1) / wantedCols) }
    : gridLayout(items.length, wantedCols);

  const labels = Array.isArray(o.labels) ? o.labels.slice(0, items.length) : undefined;
  const font = labels ? labelFont() : null;
  const key = hashKey(['grid', items, cols, width, labels, cells, font]);
  const cached = path.join(getThumbDir(), `sheet_${key}.jpg`);
  const describe = { ok: true, cols, rows, labelled: !!(labels && font), times: items.map((it) => it.time) };
  if (await fileReady(cached)) { cacheIndex().touch(cached); return { ...describe, path: cached }; }

  const inputs = await Promise.all(items.map((it) => thumbnail(it.path, it.time, 'high')));
  const usable = inputs.filter((p) => typeof p === 'string');
  if (usable.length !== inputs.length) return { ok: false, error: 'could not read every frame of the grid' };
  const info = await probeMedia(items[0].path).catch(() => null);
  const ratio = info && info.width && info.height ? Number(info.height) / Number(info.width) : 9 / 16;
  const height = Math.max(2, Math.round((width * ratio) / 2) * 2);
  const buf = await run('ffmpeg', gridArgs({ inputs: usable, cols, width, height, labels, cells, font }), {
    encoding: 'buffer', timeout: TIMEOUT_MS, background: true,
  });
  if (!buf || !buf.length) return { ok: false, error: 'ffmpeg produced no image' };
  return { ...describe, path: await store(items[0].path, buf, key) };
}

module.exports = { shotSheet, frameGrid, sampleOffsets, gridLayout, shotSheetArgs, gridArgs, cleanLabel, MAX_CELLS };
