// buildFcpxml: a rush at another rate than the sequence ends each shot on the rounded CUMULATIVE
// boundary. Rounding each shot on its own drifted a frame every few shots on a long timeline.
const test = require('node:test');
const assert = require('node:assert');
const { buildFcpxml, fpsRational } = require('../core/fcpxml');

const durations = (xml, seqNum, seqDen) => [...xml.matchAll(/<asset-clip [^>]*duration="(\d+)\/(\d+)s"/g)]
  .map(([, n, d]) => (Number(n) * seqNum) / (Number(d) * seqDen));

test('shots of another rate add up to the exact total, not to the sum of rounded shots', () => {
  const seq = fpsRational(25);
  const clipFps = fpsRational(23.976);
  const shots = Array.from({ length: 200 }, (_, i) => ({ startFrame: i * 13, frames: 13 }));
  const xml = buildFcpxml({
    projectName: 'p',
    clips: [
      { src: 'file:///a.mp4', name: 'seq', fps: seq, totalFrames: 10, w: 1920, h: 1080, shots: [{ startFrame: 0, frames: 10 }] },
      { src: 'file:///b.mkv', name: 'b', fps: clipFps, totalFrames: 2600, w: 1920, h: 1080, shots },
    ],
  });
  const tl = durations(xml, seq.num, seq.den).slice(1);
  const exact = (200 * 13 * clipFps.den * seq.num) / (clipFps.num * seq.den);
  assert.strictEqual(tl.reduce((a, b) => a + b, 0), Math.round(exact));
  for (const f of tl) assert.ok(f === 13 || f === 14, `shot of ${f} frames`);
});

test('a rush at the sequence rate keeps its exact frame counts', () => {
  const fps = fpsRational(23.976);
  const xml = buildFcpxml({
    projectName: 'p',
    clips: [{ src: 'file:///a.mkv', name: 'a', fps, totalFrames: 500, w: 1920, h: 1080,
      shots: [{ startFrame: 0, frames: 7 }, { startFrame: 7, frames: 1 }, { startFrame: 8, frames: 300 }] }],
  });
  assert.deepStrictEqual(durations(xml, fps.num, fps.den), [7, 1, 300]);
});
