// How many frames a shot is shown with, and where. Calibrated on a real episode; the suspect-cut
// rates quoted in core/motion.js were judged by eye on its frames, which a test cannot do.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  frameCount, placeFrames, planShots, checkCuts, similarity, createAccumulator, shotChange, SCALE, FRAME_BYTES,
} = require("../core/motion.js");
const { packShots } = require("../core/agent/tools/app/shotGrid.js");

const flat = (length, value = 0) => new Uint8Array(length).fill(value * SCALE);

test("a nearly fixed shot gets 3 or 4 frames, whatever its length: enough to tell what kind it is", () => {
  assert.equal(frameCount(1, 0), 2, "too short for more");
  assert.equal(frameCount(4, 2), 3);
  assert.equal(frameCount(12, 2), 4);
  assert.equal(frameCount(19, 154), 4, "a slow 19 s pan adds up to a lot of change, thinly spread");
  assert.equal(frameCount(120, 3000), 4);
});

test("the more happens, the more frames, up to 6", () => {
  assert.equal(frameCount(3, 200), 4);
  assert.equal(frameCount(3, 500), 5);
  assert.equal(frameCount(3, 1000), 6);
  assert.equal(frameCount(15, 5000), 6, "6 is the ceiling of a normal shot");
});

test("only a very long shot goes past 6", () => {
  assert.equal(frameCount(19, 5000), 6);
  assert.equal(frameCount(20, 5000), 8);
  assert.equal(frameCount(95, 4712), 8);
  assert.equal(frameCount(30, 50), 4, "long but still stays cheap");
});

test("without an analysis, the length alone decides", () => {
  assert.equal(frameCount(1, null), 2);
  assert.equal(frameCount(3, null), 3);
  assert.equal(frameCount(10, null), 4);
});

test("a still shot comes out evenly spaced", () => {
  const [first, middle, last] = placeFrames(flat(100), 0, 99, 3);
  assert.ok(Math.abs(first - 16) <= 1 && Math.abs(middle - 50) <= 1 && Math.abs(last - 83) <= 1, `${first} ${middle} ${last}`);
});

test("from 4 frames on, the very start and end of the shot are shown", () => {
  const frames = placeFrames(flat(1000), 0, 999, 8);
  assert.equal(frames.length, 8);
  assert.ok(frames[0] <= 25, `a scene glued to the start is seen: ${frames}`);
  assert.ok(frames[7] >= 975, `a scene glued to the end is seen: ${frames}`);
});

test("frames gather where the picture changes", () => {
  const change = flat(100);
  for (let n = 60; n < 80; n += 1) change[n] = 30 * SCALE;
  const frames = placeFrames(change, 0, 99, 4);
  assert.equal(frames.length, 4);
  assert.equal(frames.filter((f) => f >= 60 && f < 80).length, 2, `the two free frames go there: ${frames}`);
  assert.ok(frames[0] < 60, "the rest of the shot is not forgotten");
});

test("one flash does not capture every frame", () => {
  const change = flat(100, 1);
  change[50] = 255;
  const frames = placeFrames(change, 0, 99, 4);
  assert.equal(frames.filter((f) => Math.abs(f - 50) <= 1).length <= 1, true, `frames: ${frames}`);
});

test("a shot hiding a cut gets frames on both sides of it", () => {
  const change = flat(200, 1);
  change[120] = 200;
  const frames = placeFrames(change, 0, 199, 4);
  assert.ok(frames.some((f) => f < 120) && frames.some((f) => f > 120), `frames: ${frames}`);
});

test("frames stay inside the shot, and are never repeated", () => {
  const frames = placeFrames(flat(100), 40, 42, 8);
  assert.deepEqual(frames, [40, 41, 42]);
  assert.deepEqual(placeFrames(flat(100), 7, 7, 4), [7]);
});

test("the first frame's change belongs to the cut before the shot, not to the shot", () => {
  const change = flat(100);
  change[10] = 255;
  assert.equal(shotChange(change, 10, 50), 0);
});

test("a plan uses the analysis when there is one, and fixes the count on request", () => {
  const motion = { change: flat(1000), fps: 25 };
  const shot = { inFrame: 100, outFrame: 199, startSec: 4, endSec: 8 };
  const [smart] = planShots([shot], motion);
  assert.equal(smart.length, 3, "a still 4 s shot");
  assert.ok(smart.every((t) => t >= 4 && t <= 8));
  assert.equal(planShots([shot], motion, 4)[0].length, 4);
  const [blind] = planShots([shot], null);
  assert.equal(blind.length, 3);
  assert.ok(blind[0] > 4 && blind[2] < 8, "inside the shot, never on its edge");
});

test("a shot beyond the analysed frames falls back on time", () => {
  const [plan] = planShots([{ inFrame: 5000, outFrame: 5100, startSec: 200, endSec: 204 }], { change: flat(100), fps: 25 });
  assert.equal(plan.length, 3);
});

test("a boundary with the same picture on both sides is a false cut, whatever its brightness does", () => {
  const likeness = new Uint8Array(100).fill(255);
  likeness[30] = Math.round(0.91 * 255);
  likeness[60] = Math.round(0.69 * 255);
  const { falseCuts } = checkCuts([{ inFrame: 0, outFrame: 29 }, { inFrame: 30, outFrame: 59 }, { inFrame: 60, outFrame: 99 }], { likeness, jumps: [] });
  assert.deepEqual(falseCuts, [{ frame: 30, shots: [0, 1] }], "the values measured on a real episode");
});

test("a fade keeps its likeness, a real cut and a uniform frame do not", () => {
  const a = scene(0.1);
  const brighter = a.map((v) => Math.min(255, v + 12));
  const black = new Uint8Array(FRAME_BYTES);
  const run = createAccumulator();
  [a, brighter, scene(0.37), black, a].forEach((frame) => run.push(frame));
  assert.ok(run.changes[1] > 10, "every pixel moved");
  assert.ok(run.likeness[1] > 0.99, "same picture");
  assert.ok(run.likeness[2] < 0.5, "another picture");
  assert.equal(run.likeness[3], 0, "black has no structure to compare");
  assert.equal(run.likeness[4], 0);
});

test("a jump is reported only inside a shot, not on its boundary", () => {
  const shots = [{ inFrame: 0, outFrame: 29 }, { inFrame: 30, outFrame: 99 }];
  const jumps = [{ frame: 15, similarity: 0.1 }, { frame: 30, similarity: 0.2 }, { frame: 31, similarity: 0.2 }, { frame: 70, similarity: 0.3 }];
  const { missedCuts } = checkCuts(shots, { likeness: new Uint8Array(100), jumps });
  assert.deepEqual(missedCuts.map((c) => c.frame), [15, 70]);
  assert.deepEqual([missedCuts[1].inFrame, missedCuts[1].outFrame], [30, 99]);
});

test("similarity ignores brightness, unlike a raw difference", () => {
  const picture = Array.from({ length: 100 }, (_, i) => (i * 7) % 50);
  assert.ok(similarity(picture, picture.map((v) => v + 100)) > 0.99, "a flash lightens, the picture stays");
  assert.ok(similarity(picture, picture.map((v) => 50 - v)) < 0, "another picture");
});

/// Synthetic frames: a smooth picture, then another from `at` on.
const scene = (seed) => Uint8Array.from({ length: FRAME_BYTES }, (_, i) => (Math.sin(i * seed) + 1) * 100);

test("the accumulator measures change and flags a lasting cut, not a flash", () => {
  const a = scene(0.1);
  const b = scene(0.37);
  const cut = createAccumulator();
  for (let n = 0; n < 80; n += 1) cut.push(n < 40 ? a : b);
  assert.deepEqual(cut.jumps.map((j) => j.frame), [40]);
  assert.equal(cut.changes[10], 0);
  assert.ok(cut.changes[40] > 6);

  const flash = createAccumulator();
  const white = new Uint8Array(FRAME_BYTES).fill(255);
  for (let n = 0; n < 80; n += 1) flash.push(n === 40 ? white : a);
  assert.deepEqual(flash.jumps, [], "the picture comes back after a flash");
});

test("shots pack into images by rows, a long one taking two, none split", () => {
  const plan = (n) => Array(n).fill(0);
  const pages = packShots([plan(3), plan(8), plan(2), plan(4), plan(2), plan(3), plan(2), plan(4), plan(2), plan(3)]);
  assert.deepEqual(pages[0].shots, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(pages[0].rows, 9);
  assert.deepEqual(pages[1].shots, [8, 9]);
  assert.equal(packShots([]).length, 0);
});
