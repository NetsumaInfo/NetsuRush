const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  timecodeToFrames,
  timelineRecordFrame,
  timelineClipDuration,
  timelineClipLayout,
  appendContiguousTimelineClips,
  frameRemap,
  resolveRange,
  firstFreeVideoTrack,
} = require("../core/timeline-insertion");
const { atempoChain } = require("../core/timeline-fit");

test("converts non-drop and drop-frame timecodes", () => {
  assert.equal(timecodeToFrames("01:00:01:12", 24), 86436);
  assert.equal(timecodeToFrames("00:01:00;02", 29.97), 1800);
});

test("maps the playhead without adding the timeline start twice", () => {
  assert.equal(timelineRecordFrame("01:00:10:00", "01:00:00:00", 86400, 24), 86640);
  assert.equal(timelineRecordFrame("00:00:10:00", "00:00:00:00", 0, 24), 240);
});

test("maps an incoming source duration to the timeline frame rate", () => {
  assert.equal(timelineClipDuration({ startFrame: 489, endFrame: 517 }, 30, 24), 23);
  assert.equal(timelineClipDuration({ startFrame: 0, endFrame: 24 }, 30, 24), 20);
});

test("quantizes mixed-fps clip boundaries cumulatively without gaps or drift", () => {
  const infos = Array.from({ length: 3 }, () => ({ startFrame: 0, endFrame: 28 }));
  const layout = timelineClipLayout(infos, [30, 30, 30], 24);
  assert.deepEqual(layout.clips, [
    { offset: 0, duration: 23 },
    { offset: 23, duration: 23 },
    { offset: 46, duration: 24 },
  ]);
  assert.equal(layout.totalDuration, 70);
});

test("normalizes broadcast frame rates before mapping clip boundaries", () => {
  const layout = timelineClipLayout(
    [{ startFrame: 0, endFrame: 999 }, { startFrame: 1000, endFrame: 1999 }],
    [29.97, 29.97],
    23.976,
  );
  assert.deepEqual(layout.clips, [
    { offset: 0, duration: 800 },
    { offset: 800, duration: 800 },
  ]);
});

test("applies a mono-source fps to every clip in the batch", () => {
  const infos = Array.from({ length: 3 }, () => ({ startFrame: 0, endFrame: 28 }));
  assert.deepEqual(
    timelineClipLayout(infos, [30], 24),
    timelineClipLayout(infos, [30, 30, 30], 24),
  );
});

test("keeps every supported source/timeline fps layout contiguous", () => {
  const rates = [23.976, 24, 25, 29.97, 30, 50, 59.94];
  const infos = [
    { startFrame: 0, endFrame: 28 },
    { startFrame: 100, endFrame: 141 },
    { startFrame: 900, endFrame: 952 },
  ];
  for (const sourceFps of rates) {
    for (const timelineFps of rates) {
      const layout = timelineClipLayout(infos, infos.map(() => sourceFps), timelineFps);
      let boundary = 0;
      for (const clip of layout.clips) {
        assert.equal(clip.offset, boundary, `${sourceFps} -> ${timelineFps}`);
        assert.ok(clip.duration > 0, `${sourceFps} -> ${timelineFps}`);
        boundary += clip.duration;
      }
      assert.equal(layout.totalDuration, boundary, `${sourceFps} -> ${timelineFps}`);
    }
  }
});

test("uses Resolve's actual appended end for the next mixed-fps clip", async () => {
  const calls = [];
  const actualDurations = [23, 23, 23, 23];
  const mp = {
    async AppendToTimeline(infos) {
      const info = infos[0];
      const duration = actualDurations[calls.length];
      calls.push(info.recordFrame);
      return [{
        async GetStart() { return info.recordFrame; },
        async GetEnd() { return info.recordFrame + duration; },
        async GetTrackTypeAndIndex() { return { trackType: "video", trackIndex: 1 }; },
      }];
    },
  };
  const result = await appendContiguousTimelineClips(mp, [
    { mediaPoolItem: "a", startFrame: 0, endFrame: 28 },
    { mediaPoolItem: "a", startFrame: 29, endFrame: 57 },
    { mediaPoolItem: "a", startFrame: 58, endFrame: 86 },
    { mediaPoolItem: "a", startFrame: 87, endFrame: 115 },
  ], { recordFrame: 100, trackIndex: 1, sourceFps: [30, 30, 30, 30], timelineFps: 24 });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [100, 123, 146, 169]);
  assert.equal(result.endFrame, 192);
});

test("keeps mono-source fps fallback correct when Resolve cannot report an end", async () => {
  const calls = [];
  const mp = {
    async AppendToTimeline(infos) {
      calls.push(infos[0].recordFrame);
      return [{}];
    },
  };
  const infos = Array.from({ length: 3 }, () => ({ mediaPoolItem: "a", startFrame: 0, endFrame: 28 }));
  const result = await appendContiguousTimelineClips(mp, infos, {
    recordFrame: 100, sourceFps: [30], timelineFps: 24,
  });
  assert.deepEqual(calls, [100, 123, 146]);
  assert.equal(result.endFrame, 169);
});

test("place on top chooses the first free track above clips at the playhead", () => {
  const ranges = [
    [{ start: 0, end: 100 }],
    [{ start: 120, end: 180 }],
    [{ start: 0, end: 40 }],
  ];
  assert.equal(firstFreeVideoTrack(ranges, 50, 90), 2);
  assert.equal(firstFreeVideoTrack(ranges, 20, 70), 4);
});

test("place on top reuses V1 on an empty timeline", () => {
  assert.equal(firstFreeVideoTrack([[]], 0, 25), 1);
});

test("Fit to Fill builds valid chained atempo filters for extreme speed ratios", () => {
  assert.equal(atempoChain(4), "atempo=2,atempo=2");
  assert.equal(atempoChain(0.25), "atempo=0.5,atempo=0.5");
  assert.equal(atempoChain(1.5), "atempo=1.5");
});

test("Resolve insertion never deletes and rebuilds existing timeline clips", () => {
  const root = path.join(__dirname, "..");
  const timelineSource = fs.readFileSync(path.join(root, "core", "timeline.js"), "utf8");
  const insertionCoreSource = fs.readFileSync(path.join(root, "core", "timeline-insertion.js"), "utf8");
  const insertionSource = fs.readFileSync(path.join(root, "src", "features", "timeline", "insertion.ts"), "utf8");
  assert.doesNotMatch(timelineSource, /DeleteClips\(/);
  assert.doesNotMatch(timelineSource, /withLinkedItems|appendShiftedSnapshots/);
  assert.doesNotMatch(insertionCoreSource, /planInsert|planOverwrite|planRippleOverwrite/);
  assert.match(insertionSource, /resolve:\s*\["replace",\s*"fit",\s*"above",\s*"end"\]/);
});

test("an explicit Resolve timeline target never falls back or creates a replacement", () => {
  const root = path.join(__dirname, "..");
  const timelineSource = fs.readFileSync(path.join(root, "core", "timeline.js"), "utf8");
  const guardedTargets = timelineSource.match(/if \(!tl\) return \{ ok: false, error: t\("withDetail", \{ message: t\("timelineMissing"\), detail: targetName \}\) \};/g) || [];
  assert.equal(guardedTargets.length, 2, "mono-source and multi-source sends must reject a missing explicit target");
  assert.doesNotMatch(timelineSource, /if \(targetName\) tl = await getTimelineByName\(proj, targetName\);\s*if \(!tl\) tl = await proj\.GetCurrentTimeline\(\);/);
});

test("video-only timeline policy reaches every sender and host", () => {
  const root = path.join(__dirname, "..");
  const derushSource = fs.readFileSync(path.join(root, "src", "store", "derush.ts"), "utf8");
  const hostSource = fs.readFileSync(path.join(root, "src", "lib", "host.ts"), "utf8");
  const bridgeSource = fs.readFileSync(path.join(root, "src", "lib", "bridge.ts"), "utf8");
  const pproSource = fs.readFileSync(path.join(root, "adobe-cep", "jsx", "host-ppro.jsx"), "utf8");
  const aeftSource = fs.readFileSync(path.join(root, "adobe-cep", "jsx", "host-aeft.jsx"), "utf8");

  assert.match(derushSource, /timelineBuildOptsFromProfile/);
  assert.match(derushSource, /videoOnly/);
  assert.match(hostSource, /nr\.adobeBuildTimeline\([\s\S]*videoOnly:\s*opts\.videoOnly/);
  assert.match(bridgeSource, /interface AdobeBuildOpts[\s\S]*videoOnly\?: boolean/);
  assert.match(pproSource, /p\.videoOnly/);
  assert.match(aeftSource, /if \(p\.videoOnly\) lyr\.audioEnabled = false/);
});

// Resolve takes an EXCLUSIVE source end (measured on 21.1.2: 494→548 lays 54 frames, last shown 547).
// Our inclusive end went through as is and every shot lost its last frame.
test("hands Resolve an exclusive end so the last frame of each shot is laid", async () => {
  const sent = [];
  const mp = {
    async AppendToTimeline(infos) {
      sent.push({ startFrame: infos[0].startFrame, endFrame: infos[0].endFrame });
      return [{}];
    },
  };
  const infos = [
    { mediaPoolItem: "a", startFrame: 494, endFrame: 547 },
    { mediaPoolItem: "a", startFrame: 34000, endFrame: 34071 }, // ends on the file's last frame
  ];
  await appendContiguousTimelineClips(mp, infos, { recordFrame: 0, sourceFps: [24], timelineFps: 24 });
  assert.deepEqual(sent, [{ startFrame: 494, endFrame: 548 }, { startFrame: 34000, endFrame: 34072 }]);
  assert.equal(infos[0].endFrame, 547, "the caller's inclusive range is left untouched");
});

test("a whole clip without bounds is passed through", () => {
  const info = { mediaPoolItem: "a" };
  assert.equal(resolveRange(info), info);
});

// Resolve counts a frame or two more than were decoded (container duration): 1501 for 1500, with
// frame N showing ffmpeg's frame N everywhere. A linear stretch over that tail moved cuts by +1 past
// frame 1000. Only a different rate (a MOV read at 24 instead of 23.976) is a real grid change.
test("a tail difference in frame counts does not remap", () => {
  const { map, mapped } = frameRemap({ resFrames: 1501, detFrames: 1500, resFps: 25, detFps: 25 });
  assert.equal(mapped, false);
  assert.equal(map(1000), 1000);
  assert.equal(frameRemap({ resFrames: 2399, detFrames: 2397, resFps: 59.94, detFps: 60000 / 1001 }).map(1800), 1800);
});

test("a file read at another rate is remapped linearly", () => {
  const { map, mapped } = frameRemap({ resFrames: 187291, detFrames: 187104, resFps: 24, detFps: 24000 / 1001 });
  assert.equal(mapped, true);
  assert.equal(map(2000), 2002);
});

test("without a detector rate, a few frames of difference is a tail", () => {
  assert.equal(frameRemap({ resFrames: 1501, detFrames: 1500 }).mapped, false);
  assert.equal(frameRemap({ resFrames: 187291, detFrames: 187104 }).mapped, true);
});
