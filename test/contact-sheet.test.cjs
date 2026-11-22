// Contact sheets: an agent reads an action from many frames in one image. The maths of which frames
// end up where is pinned here, and the arguments stay what the prototype measured; the images
// themselves were checked by eye on real footage, as a test cannot tell an action from a still.

const test = require("node:test");
const assert = require("node:assert/strict");

const { sampleOffsets, gridLayout, shotSheetArgs, gridArgs, cleanLabel } = require("../core/contactSheet.js");
const { buildDomainTool } = require("../core/agent/tools/app/domain.js");
const { createJobs } = require("../core/agent/jobs.js");

test("frames are spread evenly, first and last of the shot included", () => {
  assert.deepEqual(sampleOffsets(63, 4), [0, 21, 41, 62]);
  assert.deepEqual(sampleOffsets(12, 12), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
});

test("a shot shorter than the sheet shows each of its frames once", () => {
  assert.deepEqual(sampleOffsets(3, 12), [0, 1, 2]);
  assert.deepEqual(sampleOffsets(1, 12), [0]);
});

test("one frame asked is the middle of the shot, not its edge", () => {
  assert.deepEqual(sampleOffsets(11, 1), [5]);
});

test("a short shot does not leave a strip of empty cells", () => {
  assert.deepEqual(gridLayout(3, 4), { cols: 3, rows: 1 });
  assert.deepEqual(gridLayout(12, 4), { cols: 4, rows: 3 });
  assert.deepEqual(gridLayout(13, 4), { cols: 4, rows: 4 });
});

test("a sheet seeks a quarter frame early and counts frames from the shot's start", () => {
  const args = shotSheetArgs({ input: "a.mkv", inFrame: 2431, fps: 24, offsets: [0, 62], cols: 2, rows: 1, width: 240 });
  assert.equal(args[args.indexOf("-ss") + 1], (2430.75 / 24).toFixed(5));
  const vf = args[args.indexOf("-vf") + 1];
  assert.match(vf, /select='eq\(n\\,0\)\+eq\(n\\,62\)'/);
  assert.match(vf, /tile=2x1/);
  assert.ok(args.includes("-map") && args.includes("0:v:0"), "only the first video stream");
});

test("a grid places each frame in its cell", () => {
  const args = gridArgs({ inputs: ["a", "b", "c"], cols: 2, width: 100, height: 56 });
  const filter = args[args.indexOf("-filter_complex") + 1];
  assert.match(filter, /xstack=inputs=3:fill=black:layout=0_0\|102_0\|0_58/);
  assert.match(filter, /force_original_aspect_ratio=decrease,pad=100:56/, "frames of another shape are not stretched");
  assert.equal(args.filter((x) => x === "-i").length, 3);
});

test("a shot's number is drawn on its first frame only, and cannot inject a filter", () => {
  const args = gridArgs({ inputs: ["a", "b"], cols: 2, width: 100, height: 56, labels: [27, null], font: "C:/Windows/Fonts/arial.ttf" });
  const filter = args[args.indexOf("-filter_complex") + 1];
  assert.equal((filter.match(/drawtext/g) || []).length, 1);
  assert.match(filter, /fontfile='C\\:\/Windows\/Fonts\/arial\.ttf':text='27'/);
  const hostile = gridArgs({ inputs: ["a"], cols: 1, width: 100, height: 56, labels: ["1':x=[evil]"], font: "f.ttf" });
  assert.doesNotMatch(hostile[hostile.indexOf("-filter_complex") + 1], /evil\]|\[evil/);
  assert.equal(cleanLabel("1':x=[evil]"), "1xevil");
});

test("with no font the grid simply goes unlabelled", () => {
  const args = gridArgs({ inputs: ["a"], cols: 1, width: 100, height: 56, labels: [27], font: null });
  assert.doesNotMatch(args[args.indexOf("-filter_complex") + 1], /drawtext/);
});

test("a grid of one frame needs no stacking, which ffmpeg would refuse", () => {
  const args = gridArgs({ inputs: ["a"], cols: 1, width: 100, height: 56 });
  assert.doesNotMatch(args[args.indexOf("-filter_complex") + 1], /xstack/);
});

function media(handlers) {
  const calls = [];
  const domain = require("../core/agent/tools/app/media.js");
  const tool = buildDomainTool(domain, {
    invoke: async (channel, args) => {
      calls.push([channel, args]);
      if (handlers[channel]) return handlers[channel](args);
      throw new Error(`unexpected channel ${channel}`);
    },
    jobs: createJobs(),
  });
  return { tool, calls };
}

const SHOTS = Array.from({ length: 45 }, (_, i) => ({
  scene_index: i, start_frame: i * 24, end_frame: i * 24 + 23, start_sec: i, end_sec: i + 1,
}));

test("a sheet comes back as an image the model can see", async () => {
  const { tool } = media({ "ffmpeg:shotSheet": () => ({ ok: true, path: "s.jpg", frames: [1, 2] }) });
  const r = await tool.handler({ action: "sheet", path: "a", inFrame: 1, outFrame: 2 }, {});
  assert.deepEqual(r.__images, ["s.jpg"]);
  assert.deepEqual(r.frames, [1, 2]);
});

const planEach = (n) => ([o]) => ({ ok: true, analysed: true, plans: o.shots.map((sh) => Array.from({ length: o.framesPerShot || n }, (_, i) => sh.startSec + (i + 0.5) / (o.framesPerShot || n))) });

test("an overview pages through the shots, with the number of each written on it", async () => {
  const { tool, calls } = media({
    "search:shots": () => ({ shots: SHOTS }),
    "ffmpeg:shotFrames": planEach(3),
    "ffmpeg:frameGrid": () => ({ ok: true, path: "g.jpg", cols: 4, rows: 9 }),
  });
  const r = await tool.handler({ action: "overview", path: "a", page: 2 }, {});
  assert.equal(r.source, "index");
  assert.equal(r.pages, 5, "9 rows per image");
  assert.equal(r.totalShots, 45);
  assert.equal(r.shots.length, 9);
  assert.equal(r.shots[0].sceneIndex, 9);
  assert.deepEqual(r.__images, ["g.jpg"]);
  assert.match(r.howToRead, /never by counting/);
  assert.equal(r.framesPlacedBy, "change");
  const grid = calls.find(([c]) => c === "ffmpeg:frameGrid")[1][0];
  assert.equal(grid.items.length, 27);
  assert.equal(grid.labels[0], 9, "the number on the image is the sceneIndex");
  assert.equal(grid.labels[3], 10);
  assert.deepEqual(grid.cells.slice(0, 4), [0, 1, 2, 4], "a shot of 3 frames leaves the end of its row empty");
});

test("a busy shot carries on to the next row, under its one number", async () => {
  const { tool, calls } = media({
    "search:shots": () => ({ shots: SHOTS.slice(0, 2) }),
    "ffmpeg:shotFrames": () => ({ ok: true, analysed: true, plans: [[0.1, 0.2, 0.3, 0.4, 0.5, 0.6], [1.5, 1.6]] }),
    "ffmpeg:frameGrid": () => ({ ok: true, path: "g.jpg", cols: 4, rows: 3 }),
  });
  await tool.handler({ action: "overview", path: "a" }, {});
  const grid = calls.find(([c]) => c === "ffmpeg:frameGrid")[1][0];
  assert.deepEqual(grid.cells, [0, 1, 2, 3, 4, 5, 8, 9]);
  assert.deepEqual(grid.labels, [0, null, null, null, null, null, 1, null]);
});

test("the caller can force 2, 3 or 4 frames, and nothing else", async () => {
  const { tool, calls } = media({
    "search:shots": () => ({ shots: SHOTS }),
    "ffmpeg:shotFrames": planEach(3),
    "ffmpeg:frameGrid": () => ({ ok: true, path: "g.jpg", cols: 4, rows: 9 }),
  });
  await tool.handler({ action: "overview", path: "a", framesPerShot: 4 }, {});
  assert.equal(calls.find(([c]) => c === "ffmpeg:shotFrames")[1][0].framesPerShot, 4);
  calls.length = 0;
  await tool.handler({ action: "overview", path: "a", framesPerShot: 1 }, {});
  assert.equal(calls.find(([c]) => c === "ffmpeg:shotFrames")[1][0].framesPerShot, undefined, "one frame cannot show an action");
});

test("a rush with no shot data is still scanned, and says so", async () => {
  const { tool } = media({
    "search:shots": () => ({ shots: [] }),
    "ffmpeg:cachedScenes": () => ({ scenes: [] }),
    "ffmpeg:probe": () => ({ duration: 100 }),
    "ffmpeg:shotFrames": planEach(2),
    "ffmpeg:frameGrid": () => ({ ok: true, path: "g.jpg", cols: 4, rows: 9 }),
  });
  const r = await tool.handler({ action: "overview", path: "a" }, {});
  assert.equal(r.source, "uniform");
  assert.match(r.note, /not real shots/);
  assert.equal(r.totalShots, 20);
});

test("check_cuts refuses a file with no shots, and caps the list of suspects", async () => {
  const none = media({ "search:shots": () => ({ shots: [] }), "ffmpeg:cachedScenes": () => ({ scenes: [] }), "ffmpeg:probe": () => ({ duration: 100 }) });
  assert.equal((await none.tool.handler({ action: "check_cuts", path: "a", waitSeconds: 1 }, {})).ok, false);
  const many = media({
    "search:shots": () => ({ shots: SHOTS }),
    "ffmpeg:checkCuts": () => ({ ok: true, falseCuts: [{ frame: 24, shots: [0, 1] }], missedCuts: Array.from({ length: 200 }, (_, i) => ({ frame: i })) }),
  });
  const r = await many.tool.handler({ action: "check_cuts", path: "a", waitSeconds: 1 }, {});
  assert.equal(r.falseCuts.length, 1);
  assert.equal(r.missedCuts.length, 150);
  assert.match(r.note, /200 jumps/);
});

test("search hits come as rows, many shots per image, and page further down", async () => {
  const domain = require("../core/agent/tools/app/search.js");
  const grids = [];
  const tool = buildDomainTool(domain, {
    invoke: async (channel, args) => {
      if (channel === "search:run") {
        return { hits: Array.from({ length: 25 }, (_, i) => ({ file_path: i % 2 ? "b" : "a", start_frame: i, end_frame: i + 9, start_sec: i, end_sec: i + 1, score: 1 - i / 100 })) };
      }
      if (channel === "ffmpeg:shotFrames") {
        const n = args[0].framesPerShot || 3;
        return { ok: true, analysed: true, plans: args[0].shots.map((sh) => Array.from({ length: n }, (_, i) => sh.startSec + (i + 0.5) / n)) };
      }
      if (channel === "ffmpeg:frameGrid") { grids.push(args[0]); return { ok: true, path: `g${grids.length}.jpg`, cols: 4 }; }
      throw new Error(channel);
    },
    jobs: createJobs(),
  });
  const r = await tool.handler({ action: "run", text: "x" }, {});
  assert.deepEqual(r.__images, ["g1.jpg", "g2.jpg"], "18 shots, 9 per image");
  assert.match(r.images, /its first image/);
  assert.equal(r.hits[10].label, "A10", "a letter per file plus the shot's first frame");
  assert.deepEqual(r.files, { A: "a", B: "b" });
  assert.equal(grids[0].cols, 4);
  assert.equal(grids[0].items.length, 27);
  assert.ok(grids[0].items[0].time > 0 && grids[0].items[2].time < 1, "inside the shot, never on its edge");
  assert.equal(grids[0].items.filter((it) => it.path === "b").length, 12, "hits of several files share an image");
  assert.deepEqual(grids[0].labels.slice(0, 4), ["A0", null, null, "B1"]);
  assert.equal(grids[1].labels[0], "B9", "the number belongs to the shot, whatever the image");
  assert.match(r.images, /never by counting rows/);
  assert.doesNotMatch(r.images, /being analysed/);

  grids.length = 0;
  const next = await tool.handler({ action: "run", text: "x", offset: 20, imageHits: 3, framesPerShot: 4 }, {});
  assert.equal(next.hits[0].inFrame, 20);
  assert.equal(next.hits[0].label, "A20", "a shot keeps its number from one search to the next");
  assert.equal(grids[0].items.length, 12);
  assert.doesNotMatch(String(next.note), /offset/, "nothing further down");
  const first = await tool.handler({ action: "run", text: "x", limit: 5 }, {});
  assert.match(first.note, /offset=5/);
});

test("a search can still ask for a sheet per hit, a still, or nothing", async () => {
  const domain = require("../core/agent/tools/app/search.js");
  const calls = [];
  const tool = buildDomainTool(domain, {
    invoke: async (channel, args) => {
      calls.push([channel, args]);
      if (channel === "search:run") {
        return { hits: [{ file_path: "a", start_frame: 10, end_frame: 40, start_sec: 1, end_sec: 2, score: 0.5 }] };
      }
      if (channel === "ffmpeg:shotSheet") return { ok: true, path: "s.jpg", frames: [10, 40] };
      if (channel === "ffmpeg:thumbnail") return "t.jpg";
      throw new Error(channel);
    },
    jobs: createJobs(),
  });
  const single = await tool.handler({ action: "run", text: "x", view: "none" }, {});
  assert.equal(single.hits[0].label, "10", "one file needs no letter");
  assert.equal(single.files, undefined);
  const sheet = await tool.handler({ action: "run", text: "x", view: "sheet" }, {});
  assert.deepEqual(sheet.__images, ["s.jpg"]);
  assert.deepEqual(sheet.hits[0].sheetFrames, [10, 40]);
  assert.match(sheet.images, /left to right/);
  assert.deepEqual((await tool.handler({ action: "run", text: "x", view: "frame" }, {})).__images, ["t.jpg"]);
  assert.equal((await tool.handler({ action: "run", text: "x", thumbnails: false }, {})).__images, undefined);
});
