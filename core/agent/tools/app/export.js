// @ts-check
// Export and transfer: cut shots out of a source file (lossless remux or re-encode, optionally with a
// processing pass), render a Resolve timeline to After Effects, and move a timeline between Resolve,
// Premiere Pro and After Effects. Every action that writes files returns them as `__files`.

const nodePath = require('node:path');
const { WAIT_PARAM } = require('./domain');

const FOLDER_NAME = 'NetsuRush extracts';

/** Default lossless profile: a stream copy into MP4 (the "file, no re-encode" profile of the UI). */
const REMUX_PROFILE = {
  id: 'remux-mp4', name: 'Remux', workflow: 'video_remux', codec: 'h264_high', audioMode: 'copy',
  container: 'mp4', mergeEnabled: false, encoderMode: 'gpu', speed: 'balanced',
};

/** @type {Record<string, string>} */
const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.wav': 'audio/wav', '.png': 'image/png',
};

/** @param {string} file @returns {{ path: string, name: string, mimeType: string }} */
function fileEntry(file) {
  const ext = nodePath.extname(file).toLowerCase();
  return { path: file, name: nodePath.basename(file), mimeType: MIME[ext] || 'application/octet-stream' };
}

/** @param {any[]|undefined} files @returns {any[]} */
const toFiles = (files) => (Array.isArray(files) ? files.filter((f) => typeof f === 'string' && f).map(fileEntry) : []);

/** Keeps the produced-file list small and attaches it for the MCP layer. @param {any} r */
function exportResult(r) {
  if (!r || typeof r !== 'object') return r;
  const { outs, ...rest } = r;
  return { ...rest, ...(Array.isArray(r.files) && r.files.length ? { __files: toFiles(r.files) } : {}) };
}

/** @param {any} r */
function withOutputFiles(r) {
  if (!r || typeof r !== 'object') return r;
  const files = [r.file, r.output, r.out, ...(Array.isArray(r.files) ? r.files : [])].filter((f) => typeof f === 'string' && f);
  return files.length ? { ...r, __files: toFiles(files) } : r;
}

/** @type {import('./domain').DomainDef} */
module.exports = {
  name: 'netsu_export',
  summary: 'Cut and export media, and move timelines between editing apps. extract() is the one-call way to cut a piece '
    + 'out of a file. export_clips is the full engine (profile-driven, per-shot files or one merged file). '
    + 'LOSSLESS cuts (remux, -c copy) snap to keyframes and are NOT frame-exact; a re-encode cuts exactly on the frame. '
    + 'Produced files are returned as files. Ranges here are in SECONDS unless a parameter says frames.',
  actions: {
    capabilities: {
      risk: 'read',
      usage: 'capabilities(force?) — encoders and codecs this machine can really encode {codecs, cpuCodecs, hasGpuEncoder, hwEncoders}',
      channel: 'export:capabilities', args: (a) => [{ force: !!a.force }],
    },
    preview_name: {
      risk: 'read',
      usage: 'preview_name(profile, baseName?, clip?, index?, total?) — the file name a profile template would produce {name, merged, tokens}',
      channel: 'export:previewName', args: (a) => [{ profile: a.profile || {}, baseName: a.baseName, clip: a.clip, index: a.index, total: a.total }],
    },
    export_clips: {
      risk: 'write', long: true,
      usage: 'export_clips(clips[], profile?, dir, merge?, baseName?, concurrency?) — write one file per clip (or one merged file). '
        + 'clips: [{input (abs path), start, end (seconds, end exclusive), label?, audioTrack? (a:N index)}]. '
        + 'profile: {workflow: "video_remux"|"video_encode", codec, audioMode, container: "mp4"|"mkv"|"mov", name?, '
        + 'naming? (template with {base} {source} {index} {start} {end} {label} {codec} {date}...), '
        + 'encoderMode?: "gpu"|"nvenc"|"amf"|"qsv"|"cpu", speed?: "fast"|"balanced"|"quality"|"max", folderTarget? (sub-folder created in dir), '
        + 'mergeGap? (ms of black between merged shots), audioSelect?: {mode:"auto"|"language"|"track", language? ("ja"), track?}, '
        + 'process? (upscale/interpolate/depth pass, video_encode only)}. '
        + 'Default (profile omitted) = lossless {workflow:"video_remux", codec:"h264_high", audioMode:"copy", container:"mp4"}. '
        + 'Re-encode example: {workflow:"video_encode", codec:"h264_high", audioMode:"aac", container:"mp4", encoderMode:"gpu"}. '
        + 'audioMode: copy|none|aac_128|aac|aac_256|aac_320|ac3|ac3_640|mp3_192|mp3|pcm16. '
        + 'Audio language: audioSelect mode "language" keeps the track whose tag/title matches (ja, fr, en...), guessing untagged tracks by ear; '
        + 'it falls back to every track, never to silence. merge:true concatenates all clips into ONE file. '
        + 'Call capabilities first before choosing a non-default codec.',
      channel: 'export:clips',
      args: (a) => [{
        clips: a.clips || [], profile: a.profile || REMUX_PROFILE, dir: a.dir || a.outDir, merge: !!a.merge,
        baseName: a.baseName, concurrency: a.concurrency,
      }],
      map: exportResult,
    },
    extract: {
      risk: 'write', long: true,
      usage: 'extract(path, inFrame?, outFrame?, startSec?, endSec?, outDir?, reencode?) — cut ONE piece of a file with the default lossless profile. '
        + 'Range = inFrame..outFrame (INCLUSIVE source frames) or startSec..endSec; no range = the whole file. '
        + 'Lossless snaps to the previous keyframe and is NOT frame-exact; reencode=true (H.264 + AAC) cuts exactly on the frame. '
        + 'outDir defaults to a "NetsuRush extracts" folder next to the source.',
      run: async (a, ctx) => {
        if (!a.path) return { ok: false, error: 'path is required' };
        const info = await ctx.invoke('player:info', [a.path]);
        const fps = Number(info && info.fps) || 0;
        const duration = Number(info && info.duration) || 0;
        let start = a.startSec == null ? undefined : Number(a.startSec);
        let end = a.endSec == null ? undefined : Number(a.endSec);
        if (a.inFrame != null || a.outFrame != null) {
          if (!fps) return { ok: false, error: 'Cannot convert frames: the frame rate of this file is unknown. Use startSec/endSec.' };
          if (a.inFrame != null) start = Number(a.inFrame) / fps;
          if (a.outFrame != null) end = (Number(a.outFrame) + 1) / fps;
        }
        if (start == null) start = 0;
        if (end == null) end = duration;
        if (!(end > start)) return { ok: false, error: `Empty range (start ${start}s, end ${end}s${duration ? `, file length ${duration}s` : ''}).` };
        /** @type {any} */
        const profile = a.reencode
          ? { ...REMUX_PROFILE, id: 'extract-h264', name: 'Extract H.264', workflow: 'video_encode', audioMode: 'aac' }
          : { ...REMUX_PROFILE };
        const dir = a.outDir || nodePath.dirname(a.path);
        if (!a.outDir) profile.folderTarget = FOLDER_NAME;
        const r = await ctx.invoke('export:clips', [{
          clips: [{ input: a.path, start, end }], profile, dir, baseName: nodePath.parse(a.path).name,
        }]);
        return { ...exportResult(r), range: { start, end, fps: fps || undefined }, exact: !!a.reencode };
      },
    },
    ae_export: {
      risk: 'write', long: true,
      usage: 'ae_export(timelineName?, compName?, outDir?, videoMode?, codec?, audio?, transformMode?, nestedMode?, deliver?, handleSec?, precomp?, folders?) — '
        + 'send a Resolve timeline to After Effects as a comp. videoMode: "copy" (default, links the original files) | "remux" | "reencode"; '
        + 'codec default "prores_422"; audio "copy" default; transformMode: "none"|"ae" (keep zoom/position as AE keyframes)|"bake" (cut into the files, forces re-encode); '
        + 'nestedMode: "flatten"|"comp"|"render"; deliver: "auto"|"panel"|"launch". outDir is REQUIRED whenever files are produced (re-encode, bake, render). '
        + 'Needs Resolve open with the project and After Effects installed.',
      channel: 'ae:export',
      args: (a) => [{
        timelineName: a.timelineName || null, compName: a.compName || null, outDir: a.outDir || null,
        ...(a.videoMode ? { videoMode: a.videoMode } : {}), ...(a.codec ? { codec: a.codec } : {}), ...(a.audio ? { audio: a.audio } : {}),
        ...(a.transformMode ? { transformMode: a.transformMode } : {}), ...(a.nestedMode ? { nestedMode: a.nestedMode } : {}),
        ...(a.deliver ? { deliver: a.deliver } : {}), ...(a.handleSec != null ? { handleSec: Number(a.handleSec) } : {}),
        ...(a.precomp != null ? { precomp: !!a.precomp } : {}), ...(a.folders != null ? { folders: !!a.folders } : {}),
      }],
      map: withOutputFiles,
    },
    transfer_sources: {
      risk: 'read',
      usage: 'transfer_sources(host) — timelines / sequences / comps on a host: "resolve" | "ppro" (Premiere Pro) | "aeft" (After Effects)',
      channel: 'transfer:sources', args: (a) => [{ host: a.host }],
    },
    transfer_read: {
      risk: 'read',
      usage: 'transfer_read(host, timelineName?, to?) — preview of a timeline (clips, tracks, duration, missing sources) and, with `to`, what the target would lose (fidelity)',
      channel: 'transfer:read', args: (a) => [{ host: a.host, timelineName: a.timelineName, to: a.to }],
    },
    transfer_run: {
      risk: 'write', long: true,
      usage: 'transfer_run(from, to, timelineName?, name?, mode?, target?, videoOnly?, mediaMode?, codec?, audio?, container?, outDir?, animation?, vehicle?) — '
        + 'rebuild a timeline in another app. Supported pairs: resolve->ppro, resolve->aeft, ppro->resolve. '
        + 'mode: "new" (default) | "append" (into the `target` timeline); mediaMode: "copy" (link originals, default) | "remux" | "reencode" (the last two need outDir); '
        + 'animation:false skips keyframes; vehicle: "api" | "import" (Premiere native import). Both apps must be open.',
      channel: 'transfer:run',
      args: (a) => [{
        from: a.from, to: a.to, timelineName: a.timelineName, name: a.name, mode: a.mode, target: a.target,
        videoOnly: a.videoOnly, mediaMode: a.mediaMode, codec: a.codec, audio: a.audio, container: a.container,
        outDir: a.outDir || null, animation: a.animation, vehicle: a.vehicle,
      }],
    },
  },
  params: {
    path: { type: 'string', description: 'Absolute path of the source media file' },
    inFrame: { type: 'number', description: 'First source frame to keep (inclusive)' },
    outFrame: { type: 'number', description: 'Last source frame to keep (inclusive)' },
    startSec: { type: 'number', description: 'Range start in seconds' },
    endSec: { type: 'number', description: 'Range end in seconds' },
    outDir: { type: 'string', description: 'Absolute output folder (created if missing)' },
    dir: { type: 'string', description: 'Absolute output folder for export_clips (alias of outDir)' },
    reencode: { type: 'boolean', description: 'extract: re-encode to H.264/AAC for a frame-exact cut' },
    clips: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          input: { type: 'string' }, start: { type: 'number' }, end: { type: 'number' },
          label: { type: 'string' }, audioTrack: { type: 'number' },
        },
        required: ['input', 'start', 'end'],
      },
    },
    profile: { type: 'object', description: 'Export profile; see export_clips usage. Omitted = default lossless remux' },
    merge: { type: 'boolean', description: 'Concatenate all clips into one file' },
    baseName: { type: 'string' },
    concurrency: { type: 'number' },
    force: { type: 'boolean', description: 'Re-probe encoders instead of using the cache' },
    clip: { type: 'object' },
    index: { type: 'number' },
    total: { type: 'number' },
    host: { type: 'string', enum: ['resolve', 'ppro', 'aeft'] },
    from: { type: 'string', enum: ['resolve', 'ppro', 'aeft'] },
    to: { type: 'string', enum: ['resolve', 'ppro', 'aeft'] },
    timelineName: { type: 'string', description: 'Timeline / sequence name; omitted = the current one' },
    compName: { type: 'string' },
    name: { type: 'string', description: 'Name of the timeline created on the target' },
    mode: { type: 'string', enum: ['new', 'append'] },
    target: { type: 'string', description: 'Existing timeline to append to (mode "append")' },
    videoOnly: { type: 'boolean' },
    mediaMode: { type: 'string', enum: ['copy', 'remux', 'reencode'] },
    videoMode: { type: 'string', enum: ['copy', 'remux', 'reencode'] },
    codec: { type: 'string' },
    audio: { type: 'string' },
    container: { type: 'string' },
    animation: { type: 'boolean' },
    vehicle: { type: 'string', enum: ['api', 'import'] },
    transformMode: { type: 'string', enum: ['none', 'ae', 'bake'] },
    nestedMode: { type: 'string', enum: ['flatten', 'comp', 'render'] },
    deliver: { type: 'string', enum: ['auto', 'panel', 'launch'] },
    handleSec: { type: 'number' },
    precomp: { type: 'boolean' },
    folders: { type: 'boolean' },
    ...WAIT_PARAM,
  },
};
