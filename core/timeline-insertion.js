// @ts-check

// Resolve's scripting API takes source ranges with an EXCLUSIVE end, whatever its README says.
// Measured on Resolve Studio 21.1.2 with a 34072-frame BluRay MKV: AppendToTimeline 494→548 lays 54
// frames, the last one shown is 547; 0→95 lays 95 frames; AddTake 1654→1708 fills 54 frames; an end
// one past the last frame (34072) is accepted. Passing our INCLUSIVE end dropped the last frame of
// every shot — a frame lost per shot, so a long insertion drifted by several frames. NetsuRush keeps
// inclusive ends everywhere; this is the only place they are converted.
function resolveRange(info) {
  if (!info || info.endFrame == null) return info;
  return { ...info, endFrame: Number(info.endFrame) + 1 };
}

// GetSourceEndFrame reports that same exclusive end, CLAMPED to the last frame of the file: a laid
// range 0→95 reads sef=95 for 95 frames, while a whole 34072-frame clip reads sef=34071 for 34072
// frames (and a whole 96-frame file sef=95 — the measurement that once made it look inclusive). The
// timeline span settles the ambiguous case; a retimed clip falls back on the exclusive reading.
// Returns the INCLUSIVE source out frame.
function sourceOutFrame(ssf, sef, span, maxFrame = Infinity) {
  if (Number.isFinite(span) && span > 0) {
    if (sef - ssf === span - 1) return sef;
    if (sef - ssf === span) return sef - 1;
  }
  return Number.isFinite(maxFrame) && sef >= maxFrame ? maxFrame : sef - 1;
}

// Detector frame → Resolve frame. Resolve often counts one or two frames more than were decoded
// (it takes the container duration, audio included): measured 1501 for 1500, 1799 for 1798, 2399 for
// 2397, with frame N showing the same picture as ffmpeg's frame N everywhere in the file. Stretching
// linearly over that tail moved every cut — +1 past frame 1000, +2 past 1800. The grids only really
// differ when Resolve reads the file at ANOTHER rate (a MOV read at 24 fps instead of 23.976: 187291
// frames for 187104); only then is the linear remap right. Unknown detector rate: a gap of a few
// frames is a tail, anything larger is a grid.
function frameRemap({ resFrames, detFrames, resFps, detFps }) {
  const identity = (f) => f;
  if (!(resFrames > 1 && detFrames > 1) || resFrames === detFrames) return { map: identity, mapped: false };
  const sameRate = resFps > 0 && detFps > 0 ? Math.abs(resFps - detFps) < 0.01 : Math.abs(resFrames - detFrames) <= 3;
  if (sameRate) return { map: identity, mapped: false };
  return { map: (f) => Math.round((f * (resFrames - 1)) / (detFrames - 1)), mapped: true };
}

function timecodeToFrames(tc, fps) {
  const m = String(tc || "").match(/^(\d+):(\d{2}):(\d{2})[:;](\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const sec = Number(m[3]);
  const frame = Number(m[4]);
  const nominal = Math.round(fps);
  let total = ((h * 60 + min) * 60 + sec) * nominal + frame;
  if (m[0].includes(";") && (Math.abs(fps - 29.97) < 0.02 || Math.abs(fps - 59.94) < 0.02)) {
    const drop = nominal === 60 ? 4 : 2;
    const totalMinutes = h * 60 + min;
    total -= drop * (totalMinutes - Math.floor(totalMinutes / 10));
  }
  return total;
}

function timelineRecordFrame(currentTimecode, startTimecode, startFrame, fps) {
  const current = timecodeToFrames(currentTimecode, fps);
  if (current == null) return startFrame;
  const start = timecodeToFrames(startTimecode, fps);
  return start == null ? current : startFrame + Math.max(0, current - start);
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function normalizedFrameRate(fps) {
  const value = Number(fps);
  if (!(value > 0)) return 0;
  const broadcastRates = [
    [23.976, 24000 / 1001],
    [29.97, 30000 / 1001],
    [47.952, 48000 / 1001],
    [59.94, 60000 / 1001],
    [119.88, 120000 / 1001],
  ];
  for (const [display, exact] of broadcastRates) {
    if (Math.abs(value - display) < 0.002) return exact;
  }
  return value;
}

function timelineClipLayout(infos, sourceFps, timelineFps) {
  const dst = normalizedFrameRate(timelineFps);
  const monoSourceFps = sourceFps?.length === 1 ? sourceFps[0] : null;
  let exactBoundary = 0;
  let frameBoundary = 0;
  const clips = infos.map((info, index) => {
    const sourceFrames = Math.max(1, Number(info.endFrame) - Number(info.startFrame) + 1);
    const src = normalizedFrameRate(sourceFps?.[index] ?? monoSourceFps);
    exactBoundary += src > 0 && dst > 0 ? sourceFrames * dst / src : sourceFrames;
    const nextBoundary = Math.max(frameBoundary + 1, Math.round(exactBoundary));
    const clip = { offset: frameBoundary, duration: nextBoundary - frameBoundary };
    frameBoundary = nextBoundary;
    return clip;
  });
  return { clips, totalDuration: frameBoundary };
}

function timelineClipDuration(info, sourceFps, timelineFps) {
  return timelineClipLayout([info], [sourceFps], timelineFps).totalDuration;
}

async function appendedVideoEnd(items, recordFrame, trackIndex) {
  let matchingVideoEnd = null;
  let fallbackEnd = null;
  for (const item of items) {
    try {
      const start = Number(await item.GetStart());
      const end = Number(await item.GetEnd());
      if (!Number.isFinite(start) || !Number.isFinite(end) || start !== recordFrame || end <= start) continue;
      if (fallbackEnd == null || end < fallbackEnd) fallbackEnd = end;
      let track = null;
      try { track = await item.GetTrackTypeAndIndex(); } catch (_) {}
      const type = String(track?.trackType ?? track?.[0] ?? "").toLowerCase();
      const index = Number(track?.trackIndex ?? track?.[1]);
      if (type === "video" && (trackIndex == null || !index || index === trackIndex)) {
        matchingVideoEnd = end;
        break;
      }
    } catch (_) {}
  }
  return matchingVideoEnd ?? fallbackEnd;
}

async function appendContiguousTimelineClips(mp, clipInfos, opts) {
  const appended = [];
  let cursor = Number(opts.recordFrame);
  for (let index = 0; index < clipInfos.length; index++) {
    const info = { ...clipInfos[index], recordFrame: cursor };
    if (opts.trackIndex != null) info.trackIndex = opts.trackIndex;
    const raw = await mp.AppendToTimeline([resolveRange(info)]);
    const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
    if (!items.length) return { ok: false, items: appended, endFrame: cursor };
    appended.push(...items);
    const actualEnd = await appendedVideoEnd(items, cursor, opts.trackIndex);
    const sourceFps = opts.sourceFps?.[index]
      ?? (opts.sourceFps?.length === 1 ? opts.sourceFps[0] : null);
    cursor = actualEnd ?? cursor + timelineClipDuration(info, sourceFps, opts.timelineFps);
  }
  return { ok: true, items: appended, endFrame: cursor };
}

function firstFreeVideoTrack(trackRanges, startFrame, endFrame) {
  let firstCandidate = 1;
  for (let i = 0; i < trackRanges.length; i++) {
    if (trackRanges[i].some((range) => range.start <= startFrame && range.end > startFrame)) {
      firstCandidate = i + 2;
    }
  }
  for (let index = firstCandidate; index <= trackRanges.length; index++) {
    const busy = trackRanges[index - 1].some((range) => rangesOverlap(startFrame, endFrame, range.start, range.end));
    if (!busy) return index;
  }
  return trackRanges.length + 1;
}

module.exports = {
  resolveRange, sourceOutFrame, frameRemap, timecodeToFrames, timelineRecordFrame, timelineClipDuration, timelineClipLayout, firstFreeVideoTrack,
  appendContiguousTimelineClips,
};
