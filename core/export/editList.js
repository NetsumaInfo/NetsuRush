// @ts-check
// Frame-exact bounds for a STREAM COPY into MP4/MOV, without re-encoding a single frame.
//
// A copy has to start on the keyframe before the in point, and an open GOP drags a few packets past
// the out point. MP4/MOV can hide both: the edit list (`elst`) says which span of the track is
// presented. ffmpeg already writes the head of it when `-avoid_negative_ts make_zero` is NOT passed
// (measured: first presented frame = the exact in point on a BluRay x265 MKV), but it sizes the
// segment from the packets it copied, so the tail still shows 1-3 extra frames. `trimEditList`
// rewrites that segment duration in place so it ends exactly after `frames` presented frames.
//
// The frames stay in the file: only a player or NLE that honours edit lists (Resolve, Premiere,
// QuickTime, ffmpeg, browsers) sees the exact cut. Matroska has no edit list, so an MKV remux keeps
// the keyframe snap.

const fs = require('fs');

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts']);

/** @param {Buffer} buf @param {number} start @param {number} end */
function children(buf, start, end) {
  /** @type {{ type: string, start: number, body: number, end: number }[]} */
  const out = [];
  let off = start;
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    let body = off + 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(off + 8)); body = off + 16; }
    else if (size === 0) size = end - off;
    if (size < 8 || off + size > end) break;
    out.push({ type, start: off, body, end: off + size });
    off += size;
  }
  return out;
}

/**
 * @param {Buffer} buf @param {{ start: number, body: number, end: number }} box @param {string[]} path
 * @returns {{ type?: string, start: number, body: number, end: number }|null}
 */
function find(buf, box, path) {
  let cur = box;
  for (const type of path) {
    const next = children(buf, cur.body, cur.end).find((c) => c.type === type);
    if (!next) return null;
    cur = next;
  }
  return cur;
}

/** Duration field of an mvhd/tkhd/mdhd box: offset, width and current value. */
function durationField(buf, box) {
  const v1 = buf[box.body] === 1;
  const at = box.type === 'tkhd'
    ? box.body + (v1 ? 28 : 20)
    : box.body + (v1 ? 24 : 16);
  return { at, v1, value: v1 ? Number(buf.readBigUInt64BE(at)) : buf.readUInt32BE(at) };
}

/** @param {Buffer} buf @param {{ at: number, v1: boolean }} field @param {number} value */
function writeDuration(buf, field, value) {
  if (field.v1) buf.writeBigUInt64BE(BigInt(value), field.at);
  else buf.writeUInt32BE(value, field.at);
}

/** mdhd/mvhd timescale. */
function timescale(buf, box) {
  return buf.readUInt32BE(box.body + (buf[box.body] === 1 ? 20 : 12));
}

/** Edit list entries with the offset of each segment-duration field. */
function readElst(buf, box) {
  const v1 = buf[box.body] === 1;
  const count = buf.readUInt32BE(box.body + 4);
  const entries = [];
  let p = box.body + 8;
  for (let i = 0; i < count; i++) {
    const durationAt = p;
    const duration = v1 ? Number(buf.readBigUInt64BE(p)) : buf.readUInt32BE(p);
    const mediaTime = v1 ? Number(buf.readBigInt64BE(p + 8)) : buf.readInt32BE(p + 4);
    entries.push({ durationAt, duration, mediaTime, v1 });
    p += v1 ? 20 : 12;
  }
  return entries;
}

/** Presentation timestamps of every sample, in media timescale, sorted. */
function presentationTimes(buf, stbl) {
  const stts = find(buf, stbl, ['stts']);
  if (!stts) return null;
  const dts = [];
  let t = 0;
  const n = buf.readUInt32BE(stts.body + 4);
  for (let i = 0; i < n; i++) {
    const count = buf.readUInt32BE(stts.body + 8 + i * 8);
    const delta = buf.readUInt32BE(stts.body + 12 + i * 8);
    for (let k = 0; k < count; k++) { dts.push(t); t += delta; }
  }
  const ctts = find(buf, stbl, ['ctts']);
  if (ctts) {
    const signed = buf[ctts.body] === 1;
    const m = buf.readUInt32BE(ctts.body + 4);
    let s = 0;
    for (let i = 0; i < m && s < dts.length; i++) {
      const count = buf.readUInt32BE(ctts.body + 8 + i * 8);
      const off = signed ? buf.readInt32BE(ctts.body + 12 + i * 8) : buf.readUInt32BE(ctts.body + 12 + i * 8);
      for (let k = 0; k < count && s < dts.length; k++) dts[s++] += off;
    }
  }
  return dts.sort((a, b) => a - b);
}

/** @param {Buffer} buf @param {any} trak */
function handlerType(buf, trak) {
  const hdlr = find(buf, trak, ['mdia', 'hdlr']);
  return hdlr ? buf.toString('latin1', hdlr.body + 8, hdlr.body + 12) : '';
}

/**
 * Shortens the edit list of a `moov` box so the video presents exactly `frames` frames, and clamps
 * the other tracks to the same length. Patches `moov` in place (no box changes size).
 * @param {Buffer} moov the whole `moov` box, header included
 * @param {number} frames
 * @returns {boolean} true when the edit list was rewritten
 */
function trimMoov(moov, frames) {
  if (!(frames > 0)) return false;
  const root = { start: 0, body: 8, end: moov.length };
  const mvhd = find(moov, root, ['mvhd']);
  if (!mvhd) return false;
  const movieScale = timescale(moov, mvhd);
  const traks = children(moov, root.body, root.end).filter((c) => c.type === 'trak');
  const video = traks.find((t) => handlerType(moov, t) === 'vide');
  if (!video) return false;

  const elst = find(moov, video, ['edts', 'elst']);
  const mdhd = find(moov, video, ['mdia', 'mdhd']);
  const stbl = find(moov, video, ['mdia', 'minf', 'stbl']);
  if (!elst || !mdhd || !stbl) return false;
  const entries = readElst(moov, elst);
  const shown = entries.filter((e) => e.mediaTime >= 0);
  // An empty edit (-1) may delay the start; one presented segment is what ffmpeg writes for a cut.
  if (shown.length !== 1) return false;
  const seg = shown[0];
  const delay = entries.filter((e) => e.mediaTime < 0).reduce((a, e) => a + e.duration, 0);
  const pts = presentationTimes(moov, stbl);
  if (!pts) return false;
  const first = pts.findIndex((p) => p >= seg.mediaTime);
  if (first < 0 || first + frames > pts.length || pts.length < 2) return false;
  const mediaScale = timescale(moov, mdhd);
  // The segment ends one frame after the last wanted frame, never on the next copied sample: the
  // copy can keep a P frame whose B neighbour was cut (a hole in the presentation times), and ending
  // on it showed one extra frame in Resolve (measured on a 30 fps web MP4: 14 frames for 13). A shot
  // that reaches the end of the file has no next sample; its segment still ends on that frame
  // (measured: Resolve read 52 frames for a 51-frame shot ending on the last frame).
  const last = pts[first + frames - 1];
  const step = frames > 1 ? last - pts[first + frames - 2]
    : first + 1 < pts.length ? pts[first + 1] - last : last - pts[first - 1];
  if (!(step > 0)) return false;
  const next = first + frames < pts.length ? pts[first + frames] : Infinity;
  const span = Math.min(next, last + step) - seg.mediaTime;
  const duration = Math.floor((span * movieScale) / mediaScale);
  if (!(duration > 0) || duration >= seg.duration) return false;

  const write = (entry, value) => {
    if (entry.v1) moov.writeBigUInt64BE(BigInt(value), entry.durationAt);
    else moov.writeUInt32BE(value, entry.durationAt);
  };
  write(seg, duration);
  const videoLength = delay + duration;
  const tkhd = find(moov, video, ['tkhd']);
  if (tkhd) writeDuration(moov, durationField(moov, tkhd), videoLength);

  let movieLength = videoLength;
  for (const trak of traks) {
    if (trak === video) continue;
    const other = find(moov, trak, ['edts', 'elst']);
    const otherTkhd = find(moov, trak, ['tkhd']);
    let length = otherTkhd ? durationField(moov, otherTkhd).value : 0;
    if (other) {
      let used = 0;
      for (const entry of readElst(moov, other)) {
        const room = Math.max(0, videoLength - used);
        if (entry.duration > room) write(entry, room);
        used += Math.min(entry.duration, room);
      }
      length = used;
      if (otherTkhd) writeDuration(moov, durationField(moov, otherTkhd), length);
    }
    movieLength = Math.max(movieLength, Math.min(length, videoLength));
  }
  writeDuration(moov, durationField(moov, mvhd), movieLength);
  return true;
}

/** Run-length table body: entry count + (count, value) pairs. */
function runLength(values, signed) {
  /** @type {[number, number][]} */
  const runs = [];
  for (const v of values) {
    const last = runs[runs.length - 1];
    if (last && last[1] === v) last[0]++;
    else runs.push([1, v]);
  }
  const body = Buffer.alloc(8 + runs.length * 8);
  body[0] = signed ? 1 : 0;
  body.writeUInt32BE(runs.length, 4);
  runs.forEach(([count, value], i) => {
    body.writeUInt32BE(count, 8 + i * 8);
    if (signed) body.writeInt32BE(value, 12 + i * 8);
    else body.writeUInt32BE(value, 12 + i * 8);
  });
  return body;
}

/**
 * Replaces one box's body, growing or shrinking every ancestor. Only safe when nothing after the
 * moov is addressed by offset — i.e. the moov is the last box of the file.
 * @param {Buffer} buf @param {{ start: number, body: number, end: number }[]} ancestors outermost first
 * @param {{ start: number, body: number, end: number }} box @param {Buffer} body
 */
function replaceBody(buf, ancestors, box, body) {
  const header = Buffer.from(buf.subarray(box.start, box.body));
  header.writeUInt32BE(header.length + body.length, 0);
  const delta = header.length + body.length - (box.end - box.start);
  const out = Buffer.concat([buf.subarray(0, box.start), header, body, buf.subarray(box.end)]);
  for (const a of ancestors) out.writeUInt32BE(out.readUInt32BE(a.start) + delta, a.start);
  return out;
}

/**
 * Snaps the video timestamps of a `moov` onto the exact frame grid (`step` ticks per frame in the
 * track timescale). A stream copied out of an MKV keeps its millisecond-rounded timestamps (41/42 ms
 * at 23.976), and Resolve reads such an MP4 as 25 fps — the shot is then conformed and drifts on a
 * 23.976 timeline. Only applied when every sample is already within a third of a frame of the grid:
 * a variable-frame-rate source keeps its own timing. The edit list follows its first frame.
 * Returns a NEW buffer (the tables change size) or null when the timing is left alone.
 * @param {Buffer} moov @param {number} step
 * @returns {Buffer|null}
 */
function conformMoov(moov, step) {
  if (!(step > 0)) return null;
  const root = { start: 0, body: 8, end: moov.length };
  const video = children(moov, root.body, root.end)
    .find((t) => t.type === 'trak' && handlerType(moov, t) === 'vide');
  if (!video) return null;
  const mdia = find(moov, video, ['mdia']);
  const minf = mdia && find(moov, mdia, ['minf']);
  const stbl = minf && find(moov, minf, ['stbl']);
  const stts = stbl && find(moov, stbl, ['stts']);
  const elst = find(moov, video, ['edts', 'elst']);
  if (!stbl || !stts || !elst) return null;

  const dts = [];
  let t = 0;
  for (let i = 0, n = moov.readUInt32BE(stts.body + 4); i < n; i++) {
    const count = moov.readUInt32BE(stts.body + 8 + i * 8);
    const delta = moov.readUInt32BE(stts.body + 12 + i * 8);
    for (let k = 0; k < count; k++) { dts.push(t); t += delta; }
  }
  const ctts = find(moov, stbl, ['ctts']);
  const offsets = new Array(dts.length).fill(0);
  if (ctts) {
    const signed = moov[ctts.body] === 1;
    let s = 0;
    for (let i = 0, m = moov.readUInt32BE(ctts.body + 4); i < m && s < dts.length; i++) {
      const count = moov.readUInt32BE(ctts.body + 8 + i * 8);
      const off = signed ? moov.readInt32BE(ctts.body + 12 + i * 8) : moov.readUInt32BE(ctts.body + 12 + i * 8);
      for (let k = 0; k < count && s < dts.length; k++) offsets[s++] = off;
    }
  }
  const pts = dts.map((d, i) => d + offsets[i]);
  const entries = readElst(moov, elst);
  const shown = entries.filter((e) => e.mediaTime >= 0);
  if (shown.length !== 1) return null;
  const visible = pts.map((p) => p >= shown[0].mediaTime);
  const onGrid = (v) => Math.abs(v / step - Math.round(v / step)) <= 1 / 3;
  if (!visible.some(Boolean) || !pts.every((p, i) => !visible[i] || onGrid(p))) return null;
  const snap = (v) => Math.round(v / step) * step;

  // Visible pictures keep their (snapped) times. The hidden head — the GOP before the in point —
  // often carries made-up timestamps: an MKV stores no dts, so ffmpeg numbers the packets it cannot
  // place one tick apart. Those pictures are decoded and discarded, so they only need distinct labels
  // BEFORE the first visible one; a label stays with its coded picture, never with its rank.
  const first = Math.min(...pts.filter((_, i) => visible[i]).map(snap));
  const hidden = visible.reduce((n, v) => n + (v ? 0 : 1), 0);
  let rank = 0;
  const newPts = pts.map((p, i) => (visible[i] ? snap(p) : first - (hidden - rank++) * step));
  if (new Set(newPts).size !== newPts.length) return null;
  // Decode times: the sorted presentation times shifted by the deepest reorder delay — increasing,
  // never after their own presentation time. Then rebased so the first sample decodes at 0.
  const sorted = [...newPts].sort((a, b) => a - b);
  const delay = Math.max(...newPts.map((p, i) => sorted[i] - p));
  const base = sorted[0] - delay;
  const newDts = sorted.map((p) => p - delay - base);
  const newOffsets = newPts.map((p, i) => p - base - newDts[i]);

  // Patch what keeps its size first (offsets stay valid), then swap the tables, innermost last.
  const out = Buffer.from(moov);
  const mediaTimeAt = shown[0].durationAt + (shown[0].v1 ? 8 : 4);
  if (shown[0].v1) out.writeBigInt64BE(BigInt(first - base), mediaTimeAt);
  else out.writeInt32BE(first - base, mediaTimeAt);
  const mdhd = find(out, mdia, ['mdhd']);
  if (mdhd) writeDuration(out, durationField(out, mdhd), newDts[newDts.length - 1] + step);

  const deltas = newDts.map((d, i) => (i + 1 < newDts.length ? newDts[i + 1] - d : step));
  const ancestors = [root, video, mdia, minf, stbl];
  const swaps = [{ box: stts, body: runLength(deltas, false) }];
  if (ctts) swaps.push({ box: ctts, body: runLength(newOffsets, newOffsets.some((o) => o < 0)) });
  // The box furthest in the file first: the earlier one's offsets stay valid.
  swaps.sort((a, b) => b.box.start - a.box.start);
  return swaps.reduce((buf, { box, body }) => replaceBody(buf, ancestors, box, body), out);
}

/**
 * Track timescale and ticks per frame for a frame rate: 23.976 → 24000 / 1001, 25 → 10000 / 400.
 * Passed to ffmpeg as `-video_track_timescale` so the grid is expressible in whole ticks.
 * @param {number} fps @returns {{ timescale: number, step: number }|null}
 */
function frameGrid(fps) {
  if (!(fps > 0)) return null;
  const ntsc = Math.round(fps * 1.001);
  let num; let den;
  if (Math.abs(fps - ntsc / 1.001) < 0.002 && Math.abs(fps - Math.round(fps)) > 0.002) { num = ntsc * 1000; den = 1001; }
  else if (Math.abs(fps - Math.round(fps)) < 0.002) { num = Math.round(fps); den = 1; }
  else return null;
  const k = Math.max(1, Math.ceil(10000 / num));
  return { timescale: num * k, step: den * k };
}

/**
 * Rewrites the `moov` of an MP4/MOV file so it presents exactly `frames` video frames. With `step`
 * (ticks per frame in the video track timescale) the timestamps are first snapped onto the frame
 * grid — only when the moov is the LAST box, since the tables change size. The media data is never
 * touched.
 * @param {string} file @param {number} frames @param {{ step?: number }} [opts]
 * @returns {Promise<boolean>}
 */
async function trimEditList(file, frames, opts = {}) {
  const fh = await fs.promises.open(file, 'r+');
  try {
    const { size } = await fh.stat();
    const head = Buffer.alloc(16);
    let off = 0;
    while (off + 8 <= size) {
      await fh.read(head, 0, 16, off);
      let boxSize = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      if (boxSize === 1) boxSize = Number(head.readBigUInt64BE(8));
      else if (boxSize === 0) boxSize = size - off;
      if (boxSize < 8) return false;
      if (type === 'moov') {
        const moov = Buffer.alloc(boxSize);
        await fh.read(moov, 0, boxSize, off);
        const last = off + boxSize === size;
        const conformed = last && opts.step ? conformMoov(moov, opts.step) : null;
        const target = conformed || moov;
        const trimmed = trimMoov(target, frames);
        if (!conformed && !trimmed) return false;
        await fh.write(target, 0, target.length, off);
        if (target.length !== boxSize) await fh.truncate(off + target.length);
        return true;
      }
      off += boxSize;
    }
    return false;
  } finally {
    await fh.close();
  }
}

/** True for containers whose muxer writes an edit list ffmpeg can be asked to keep. */
function hasEditList(container) {
  return /^(mp4|m4v|mov)$/i.test(String(container || '').replace(/^\./, ''));
}

module.exports = { trimEditList, trimMoov, conformMoov, frameGrid, hasEditList };
