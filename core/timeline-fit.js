// @ts-check

const path = require("path");
const crypto = require("crypto");
const { NR_HOME, fsp, fileReady } = require("./config");
const { run, probeAudioTracks } = require("./ffmpeg");
const { encodeCutBounds } = require("./export/frameCut");

const FIT_DIR = path.join(NR_HOME, "fit-to-fill");

function atempoChain(speed) {
  const parts = [];
  let value = speed;
  while (value > 2) { parts.push(2); value /= 2; }
  while (value < 0.5) { parts.push(0.5); value /= 0.5; }
  parts.push(value);
  return parts.map((part) => `atempo=${part.toFixed(8).replace(/0+$/, "").replace(/\.$/, "")}`).join(",");
}

async function createFitToFillMedia({ input, startFrame, endFrame, sourceFps, targetFrames, targetFps, includeAudio }) {
  const sourceFrames = endFrame - startFrame + 1;
  if (!(sourceFrames > 0) || !(targetFrames > 0) || !(sourceFps > 0) || !(targetFps > 0)) {
    throw new Error("invalid Fit to Fill duration");
  }
  const sourceSeconds = sourceFrames / sourceFps;
  const targetSeconds = targetFrames / targetFps;
  const timelineScale = targetSeconds / sourceSeconds;
  const speed = sourceSeconds / targetSeconds;
  const key = crypto.createHash("sha256")
    .update(`v2|${input}|${startFrame}|${endFrame}|${sourceFps}|${targetFrames}|${targetFps}|${includeAudio ? 1 : 0}`)
    .digest("hex").slice(0, 24);
  const output = path.join(FIT_DIR, `${key}.mov`);
  if (await fileReady(output)) return output;

  await fsp.mkdir(FIT_DIR, { recursive: true });
  const tmp = path.join(FIT_DIR, `${key}.tmp.mov`);
  const audio = includeAudio && (await probeAudioTracks(input)).tracks.length > 0;
  // Same bounds as a frame-exact re-encode: seek a quarter frame early (an mkv 1/1000 timebase
  // stores the in point's pts just below it) and bound the video by frame count, not by duration.
  const bounds = encodeCutBounds(startFrame / sourceFps, (endFrame + 1) / sourceFps, sourceFps);
  const args = [
    "-v", "error", "-ss", String(bounds ? bounds.ss : startFrame / sourceFps),
    "-t", String(bounds ? bounds.duration : sourceSeconds), "-i", input,
    "-map", "0:v:0",
  ];
  if (audio) args.push("-map", "0:a:0");
  args.push("-vf", `setpts=${timelineScale}*PTS,fps=${targetFps}`, "-t", String(targetSeconds), "-frames:v", String(targetFrames));
  if (audio) args.push("-af", atempoChain(speed));
  args.push(
    "-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le",
    ...(audio ? ["-c:a", "pcm_s16le"] : ["-an"]),
    "-movflags", "+faststart", "-f", "mov", "-y", tmp,
  );
  try {
    await run("ffmpeg", args);
    await fsp.rename(tmp, output);
    return output;
  } catch (error) {
    try { await fsp.rm(tmp, { force: true }); } catch (_) {}
    throw error;
  }
}

module.exports = { atempoChain, createFitToFillMedia };
