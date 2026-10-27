// trimEditList: a stream copy into MP4/MOV presents the exact frames. ffmpeg's edit list already hides
// the keyframe head; its segment duration is shortened so the open-GOP tail is hidden too (measured on
// a BluRay x265 MKV: 75 frames presented for a 72-frame shot before the trim, 72 after).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { trimMoov, trimEditList, conformMoov, frameGrid, hasEditList } = require('../core/export/editList');

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const i32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const box = (type, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(body.length + 8), Buffer.from(type, 'latin1'), body]);
};
const full = (type, ...parts) => box(type, u32(0), ...parts); // version 0, flags 0

const mvhd = (scale, dur) => full('mvhd', u32(0), u32(0), u32(scale), u32(dur), Buffer.alloc(80));
const tkhd = (dur) => full('tkhd', u32(0), u32(0), u32(1), u32(0), u32(dur), Buffer.alloc(60));
const mdhd = (scale, dur) => full('mdhd', u32(0), u32(0), u32(scale), u32(dur), u32(0));
const hdlr = (kind) => full('hdlr', u32(0), Buffer.from(kind, 'latin1'), Buffer.alloc(13));
const elst = (entries) => full('elst', u32(entries.length), ...entries.flatMap(([d, m]) => [u32(d), i32(m), u32(0x00010000)]));
const stts = (runs) => full('stts', u32(runs.length), ...runs.flatMap(([c, d]) => [u32(c), u32(d)]));
const ctts = (runs) => full('ctts', u32(runs.length), ...runs.flatMap(([c, o]) => [u32(c), u32(o)]));

/**
 * Video at 24 fps in a 24000 media timescale (1000 per frame), movie timescale 1000 ms.
 * `samples` frames with a B-frame reorder pattern; the edit list starts at `mediaTime`.
 */
function movie({ samples, mediaTime, segment, audioSegment }) {
  const runs = [];
  for (let i = 0; i < samples; i++) runs.push([1, i % 3 === 0 ? 2000 : i % 3 === 1 ? 0 : 1000]);
  const video = box('trak', tkhd(segment), box('edts', elst([[segment, mediaTime]])),
    box('mdia', mdhd(24000, samples * 1000), hdlr('vide'),
      box('minf', box('stbl', stts([[samples, 1000]]), ctts(runs)))));
  const audio = box('trak', tkhd(audioSegment), box('edts', elst([[audioSegment, 0]])),
    box('mdia', mdhd(48000, audioSegment * 48), hdlr('soun'),
      box('minf', box('stbl', stts([[audioSegment, 48]])))));
  return box('moov', mvhd(1000, Math.max(segment, audioSegment)), video, audio);
}

const readDur = (moov, offset) => moov.readUInt32BE(offset);
function segmentOf(moov, trakIndex) {
  // walk: find the Nth 'elst' and read its first segment duration
  let at = -1;
  for (let n = 0; n <= trakIndex; n++) at = moov.indexOf('elst', at + 1, 'latin1');
  return readDur(moov, at + 12);
}

test('the video segment ends after exactly N presented frames', () => {
  // 30 samples, presentation starts on the sample whose pts is 10000 (frame 10), 3 extra frames copied
  // past the out point: the segment is shortened to 12 frames = 500 ms.
  const moov = movie({ samples: 30, mediaTime: 10000, segment: 875, audioSegment: 880 });
  assert.strictEqual(trimMoov(moov, 12), true);
  assert.strictEqual(segmentOf(moov, 0), 500);
});

test('the other tracks are clamped to the video length', () => {
  const moov = movie({ samples: 30, mediaTime: 10000, segment: 875, audioSegment: 880 });
  trimMoov(moov, 12);
  assert.strictEqual(segmentOf(moov, 1), 500);
});

test('the segment rounds DOWN so the excluded frame is never shown', () => {
  // 23.976 in a 1000 movie timescale: 72 frames = 3003.0 ms; 7 frames = 291.958 ms -> 291.
  const moov = movie({ samples: 200, mediaTime: 1000, segment: 9000, audioSegment: 9000 });
  const scale = moov.indexOf('mdhd', 0, 'latin1') + 16; // mdhd v0: timescale after 3 fields
  moov.writeUInt32BE(24000 * 1001 / 1000, scale); // 24024 per second: 1000 ticks = 41.708 ms
  assert.strictEqual(trimMoov(moov, 7), true);
  assert.strictEqual(segmentOf(moov, 0), Math.floor((7000 * 1000) / 24024));
});

test('nothing is touched when the copy already ends on the out point', () => {
  const moov = movie({ samples: 22, mediaTime: 10000, segment: 500, audioSegment: 500 });
  const before = Buffer.from(moov);
  assert.strictEqual(trimMoov(moov, 12), false);
  assert.deepStrictEqual(moov, before);
});

test('trimEditList rewrites the moov in place without changing the file size', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-elst-'));
  const file = path.join(dir, 'clip.mp4');
  const ftyp = box('ftyp', Buffer.from('isom', 'latin1'), u32(512));
  const mdat = box('mdat', Buffer.alloc(64));
  fs.writeFileSync(file, Buffer.concat([ftyp, mdat, movie({ samples: 30, mediaTime: 10000, segment: 875, audioSegment: 880 })]));
  const size = fs.statSync(file).size;
  assert.strictEqual(await trimEditList(file, 12), true);
  assert.strictEqual(fs.statSync(file).size, size);
  const moov = fs.readFileSync(file).subarray(ftyp.length + mdat.length);
  assert.strictEqual(segmentOf(moov, 0), 500);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('only MP4/MOV carry an edit list', () => {
  for (const c of ['mp4', '.mp4', 'MOV', 'm4v']) assert.strictEqual(hasEditList(c), true, c);
  for (const c of ['mkv', '.mkv', 'webm', 'avi', '']) assert.strictEqual(hasEditList(c), false, c);
});

// conformMoov: a copy out of an MKV keeps millisecond-rounded timestamps (41/42 ms at 23.976) and
// Resolve 21.1.2 read such an MP4 as 25 fps — measured on every remux of a BluRay x265 MKV, before
// and after the edit-list work. Snapped onto the 1001/24000 grid, Resolve reads 23.976 and the exact
// frame count (72/72, 20/20, 54/54, 175/175, 30/30).

/** A single video track, 24000 timescale, explicit decode and presentation times per sample. */
function rawMovie({ dts, pts, mediaTime, segment }) {
  const deltas = dts.map((d, i) => (i + 1 < dts.length ? dts[i + 1] - d : 1001));
  const video = box('trak', tkhd(segment), box('edts', elst([[segment, mediaTime]])),
    box('mdia', mdhd(24000, dts[dts.length - 1] + 1001), hdlr('vide'),
      box('minf', box('stbl', stts(deltas.map((d) => [1, d])), ctts(pts.map((p, i) => [1, p - dts[i]]))))));
  return box('moov', mvhd(1000, segment), video);
}

/** Decode times, presentation times and edit media time read back from a moov. */
function timesOf(moov) {
  const at = (type) => moov.indexOf(type, 0, 'latin1') + 4; // body start
  const sttsAt = at('stts');
  const dts = [];
  let t = 0;
  for (let i = 0, n = moov.readUInt32BE(sttsAt + 4); i < n; i++) {
    const count = moov.readUInt32BE(sttsAt + 8 + i * 8);
    const delta = moov.readUInt32BE(sttsAt + 12 + i * 8);
    for (let k = 0; k < count; k++) { dts.push(t); t += delta; }
  }
  const cttsAt = at('ctts');
  const pts = [];
  for (let i = 0, s = 0, n = moov.readUInt32BE(cttsAt + 4); i < n; i++) {
    const count = moov.readUInt32BE(cttsAt + 8 + i * 8);
    const off = moov.readInt32BE(cttsAt + 12 + i * 8);
    for (let k = 0; k < count; k++, s++) pts.push(dts[s] + off);
  }
  return { dts, pts, mediaTime: moov.readInt32BE(at('elst') + 12) };
}

test('millisecond timestamps are snapped onto the exact frame grid', () => {
  const ms = Array.from({ length: 10 }, (_, k) => Math.round((k * 1001) / 24) * 24); // 0, 1008, 2016, 3000…
  const out = conformMoov(rawMovie({ dts: ms, pts: ms, mediaTime: 0, segment: 417 }), 1001);
  assert.ok(out);
  const { dts, pts, mediaTime } = timesOf(out);
  assert.deepStrictEqual(pts, Array.from({ length: 10 }, (_, k) => k * 1001));
  assert.deepStrictEqual(dts, pts);
  assert.strictEqual(mediaTime, 0);
});

test('a hidden head with made-up timestamps is relabelled before the first visible frame', () => {
  // 4 hidden packets numbered one tick apart (what ffmpeg writes when the MKV gives no dts), then
  // 6 visible frames with B-frame reordering and millisecond rounding.
  const visible = [0, 3, 1, 2, 5, 4].map((k) => 100100 + k * 1001 + (k % 2 ? 7 : -7));
  const pts = [0, 1, 2, 3, ...visible];
  const dts = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const out = conformMoov(rawMovie({ dts, pts, mediaTime: 100093, segment: 250 }), 1001);
  assert.ok(out);
  const t = timesOf(out);
  for (let i = 1; i < t.dts.length; i++) assert.ok(t.dts[i] > t.dts[i - 1], 'decode times increase');
  t.pts.forEach((p, i) => assert.ok(p >= t.dts[i], 'never presented before it is decoded'));
  const shown = t.pts.slice(4).sort((a, b) => a - b);
  assert.strictEqual(shown[0], t.mediaTime, 'the edit starts on the first visible frame');
  shown.forEach((p, k) => assert.strictEqual(p - shown[0], k * 1001));
  t.pts.slice(0, 4).forEach((p) => assert.ok(p < t.mediaTime, 'hidden frames stay hidden'));
});

test('a variable-frame-rate source keeps its own timing', () => {
  const pts = [0, 1001, 2502, 3503];
  assert.strictEqual(conformMoov(rawMovie({ dts: pts, pts, mediaTime: 0, segment: 167 }), 1001), null);
});

test('frame grids express each rate in whole ticks', () => {
  assert.deepStrictEqual(frameGrid(24000 / 1001), { timescale: 24000, step: 1001 });
  assert.deepStrictEqual(frameGrid(23.976), { timescale: 24000, step: 1001 });
  assert.deepStrictEqual(frameGrid(60000 / 1001), { timescale: 60000, step: 1001 });
  assert.deepStrictEqual(frameGrid(25), { timescale: 10000, step: 400 });
  assert.strictEqual(frameGrid(0), null);
});

test('a hole at the tail of the copy does not stretch the segment', () => {
  // 30 fps web MP4: the copy kept the P frame shown at 14 frames but not the B frame at 13, so the
  // next copied sample sits two frames after the last wanted one. Measured: 14 frames shown for 13.
  const pts = [0, 334, 668, 1002, 1336, 1670, 2338];
  const moov = rawMovie({ dts: pts, pts, mediaTime: 0, segment: 900 });
  // movie timescale 1000, media 24000 in rawMovie: rescale the expectation accordingly
  assert.strictEqual(trimMoov(moov, 5), true);
  assert.strictEqual(segmentOf(moov, 0), Math.floor((1670 * 1000) / 24000));
});

test('a shot that reaches the end of the file still ends on its last frame', () => {
  // No sample after the out point, but the copy's segment overshoots it (Resolve read 52 for 51).
  const pts = [0, 1001, 2002, 3003, 4004];
  const moov = rawMovie({ dts: pts, pts, mediaTime: 1001, segment: 400 });
  assert.strictEqual(trimMoov(moov, 4), true);
  assert.strictEqual(segmentOf(moov, 0), Math.floor((4 * 1001 * 1000) / 24000));
});
