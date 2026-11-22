// @ts-check
// Media inspection: probing, thumbnails (how the agent "looks at" a video), shot detection and the
// persisted cut edits of the Découpage studio. Nothing here modifies a source file.

const { WAIT_PARAM } = require('./domain');
const { packShots, renderPage } = require('./shotGrid');

const MAX_IMAGES = 8;
const MAX_SCENES = 300;
const MAX_SUSPECTS = 150;
const UNIFORM_MIN_STEP = 5;
const UNIFORM_MAX_SLICES = 400;

/** @param {any} r */
const isErr = (r) => !!(r && typeof r === 'object' && r.error);

/**
 * Thumbnails of one file at the given times. Each lands in the thumbnail cache as an image the MCP
 * layer hands back to the model.
 * @param {string} path @param {any[]} times seconds (-1 = a representative frame)
 * @param {import('./domain').ActionCtx} ctx
 */
async function makeThumbs(path, times, ctx) {
  const list = (Array.isArray(times) ? times : []).map(Number).filter((n) => Number.isFinite(n)).slice(0, MAX_IMAGES);
  if (!list.length) return { ok: false, error: 'times[] must hold at least one number of seconds' };
  const out = await Promise.all(list.map(async (time) => {
    const r = await ctx.invoke('ffmpeg:thumbnail', [{ path, time, priority: 'high' }]);
    return { time, file: typeof r === 'string' ? r : null, error: isErr(r) ? String(r.error).slice(0, 200) : undefined };
  }));
  const images = out.map((o) => o.file).filter((f) => !!f);
  return {
    ok: images.length > 0,
    frames: out.map((o) => ({ time: o.time, path: o.file, ...(o.error ? { error: o.error } : {}) })),
    __images: images,
    ...(images.length ? {} : { error: out[0] && out[0].error }),
  };
}

/// The shots of a file, whichever source knows them: the search index, the cached detection, or
/// failing both a regular slicing so an undetected rush can still be scanned.
/** @param {string} path @param {import('./domain').ActionCtx} ctx */
async function shotsOf(path, ctx) {
  const indexed = await ctx.invoke('search:shots', [path]).catch(() => null);
  if (indexed && Array.isArray(indexed.shots) && indexed.shots.length) {
    return {
      source: 'index',
      shots: [...indexed.shots].sort((a, b) => a.start_frame - b.start_frame).map((s) => ({
        sceneIndex: s.scene_index, inFrame: s.start_frame, outFrame: s.end_frame, startSec: s.start_sec, endSec: s.end_sec,
      })),
    };
  }
  const cached = await ctx.invoke('ffmpeg:cachedScenes', [path, 'transnetv2']).catch(() => null);
  if (cached && Array.isArray(cached.scenes) && cached.scenes.length) {
    return {
      source: 'detection',
      shots: cached.scenes.map((/** @type {any} */ s, /** @type {number} */ i) => ({
        sceneIndex: i, inFrame: s.startFrame, outFrame: s.endFrame, startSec: s.start, endSec: s.end,
      })),
    };
  }
  const probe = await ctx.invoke('ffmpeg:probe', [path]);
  const duration = Number(probe && probe.duration) || 0;
  if (!duration) return { source: 'none', shots: [] };
  const step = Math.max(UNIFORM_MIN_STEP, duration / UNIFORM_MAX_SLICES);
  const shots = [];
  for (let t = 0; t < duration; t += step) shots.push({ sceneIndex: shots.length, startSec: t, endSec: Math.min(duration, t + step) });
  return { source: 'uniform', shots };
}

/// One page of a rush as a single image: each shot gets the frames it needs, placed where the picture
/// changes, unless the caller fixes their number.
/** @param {any} a @param {import('./domain').ActionCtx} ctx */
async function overview(a, ctx) {
  const { source, shots } = await shotsOf(a.path, ctx);
  if (!shots.length) return { ok: false, error: 'no shots and no duration: is this a readable video?' };
  const fixed = [2, 3, 4].includes(Number(a.framesPerShot)) ? Number(a.framesPerShot) : undefined;
  const planned = await ctx.invoke('ffmpeg:shotFrames', [{ path: a.path, shots, framesPerShot: fixed }]);
  if (!planned || !planned.ok) return planned;
  const pages = packShots(planned.plans);
  const pageNumber = Math.max(1, Math.min(pages.length, Math.round(Number(a.page)) || 1));
  const page = pages[pageNumber - 1];
  const image = await renderPage(shots.map((s) => ({ file: a.path, label: s.sceneIndex })), planned.plans, page, ctx);
  if (!image) return { ok: false, error: 'could not build the image of this page' };
  return {
    ok: true, source, page: pageNumber, pages: pages.length, totalShots: shots.length,
    framesPlacedBy: planned.analysed ? 'change' : 'time (analysis running, the next call will use it)',
    // The number written on the image is `sceneIndex`: a model reads a number, it miscounts cells.
    howToRead: 'Each shot starts a new row, with its sceneIndex written on its first frame; a busy shot gets more frames and may carry on to the next row. Identify a shot by that number, never by counting rows.',
    shots: page.shots.map((i) => shots[i]),
    ...(source === 'uniform' ? { note: 'No shot data for this file: these are regular slices, not real shots.' } : {}),
    ...(pageNumber < pages.length ? { next: `page ${pageNumber + 1} of ${pages.length}` } : {}),
    __images: [image],
  };
}

/** @type {import('./domain').DomainDef} */
module.exports = {
  name: 'netsu_media',
  summary: 'Look at and measure a video file. This is how the agent "looks at" footage. '
    + 'To understand what HAPPENS in a shot (an action, a movement), use sheet: many frames of the shot in one image, read left to right then top to bottom, for the price of one thumbnail. '
    + 'To know what a whole rush holds, use overview: a row of frames per shot, page by page. thumbnail(s) return full-size frames when detail matters. '
    + 'probe/info/audio_tracks give the technical facts, detect_scenes finds the shot boundaries. '
    + 'Every path is an absolute file path (see netsu_library for imported rushes). Times are in seconds.',
  actions: {
    probe: {
      risk: 'read',
      usage: 'probe(path) — {duration (s), width, height}',
      channel: 'ffmpeg:probe', args: (a) => [a.path],
    },
    info: {
      risk: 'read',
      usage: 'info(path) — {duration, codec, pix, fps, native}; fps is needed to turn frames into seconds',
      channel: 'player:info', args: (a) => [a.path],
    },
    audio_tracks: {
      risk: 'read',
      usage: 'audio_tracks(path) — tracks [{index (a:N), codec, channels, sampleRate, lang, title, langCode}]',
      channel: 'ffmpeg:audioTracks', args: (a) => [a.path],
    },
    thumbnail: {
      risk: 'read',
      usage: 'thumbnail(path, time?) — one frame as an image; time in seconds (default 1, -1 = a representative frame)',
      channel: 'ffmpeg:thumbnail', args: (a) => [{ path: a.path, time: a.time == null ? 1 : Number(a.time), priority: 'high' }],
      map: (r) => (typeof r === 'string' ? { path: r, __images: [r] } : { ok: false, error: (r && r.error) || 'thumbnail failed' }),
    },
    sheet: {
      risk: 'read',
      usage: 'sheet(path, inFrame+outFrame | start+end (s), cols?, rows?, width?) — one image holding the frames of a shot, evenly spread, in reading order (default 4x3); `frames` lists their numbers. The way to read an action or a movement',
      channel: 'ffmpeg:shotSheet',
      args: (a) => [{ path: a.path, inFrame: a.inFrame, outFrame: a.outFrame, start: a.start, end: a.end, cols: a.cols, rows: a.rows, width: a.width }],
      map: (r) => (r && r.ok && r.path ? { ...r, __images: [r.path] } : r),
    },
    overview: {
      risk: 'read',
      usage: 'overview(path, page?, framesPerShot? (2-4, leave out for smart)) — one image per page showing the shots of a rush in order, with the sceneIndex of each shot written on it and listed in `shots`. Each shot gets the frames it needs, more where more happens: it catches movement that search misses. The fast way to go through a rush',
      run: (a, ctx) => overview(a, ctx),
    },
    analyze: {
      risk: 'read', long: true,
      usage: 'analyze(path) — measure how much the picture changes through a file, which places the frames of sheets and overviews where things happen. Starts by itself when a file is first shown; about a minute per 20 minutes of video',
      channel: 'ffmpeg:analyzeMotion', args: (a) => [a.path],
    },
    check_cuts: {
      risk: 'read', long: true,
      usage: 'check_cuts(path) — where the shot detection looks wrong. falseCuts: the same picture on both sides (a fade often), reliable, fix with netsu_search merge_shots. missedCuts: jumps inside a shot, only about 1 in 5 is a real cut (the rest are flashes and fast motion), so LOOK at each with sheet before splitting with netsu_search split_shot. Takes a minute per 20 minutes of video the first time',
      run: async (a, ctx) => {
        const { source, shots } = await shotsOf(a.path, ctx);
        if (source === 'uniform' || source === 'none') return { ok: false, error: 'no shots yet: detect or index this file first' };
        const r = await ctx.invoke('ffmpeg:checkCuts', [{ path: a.path, shots }]);
        if (!r || !r.ok) return r;
        return { ok: true, source, totalShots: shots.length, falseCuts: r.falseCuts, missedCuts: r.missedCuts.slice(0, MAX_SUSPECTS), ...(r.missedCuts.length > MAX_SUSPECTS ? { note: `${r.missedCuts.length} jumps, the ${MAX_SUSPECTS} first shown` } : {}) };
      },
    },
    thumbnails: {
      risk: 'read',
      usage: `thumbnails(path, times[]) — up to ${MAX_IMAGES} frames as images in one call (a contact sheet of the video)`,
      run: (a, ctx) => makeThumbs(a.path, a.times, ctx),
    },
    detect_scenes: {
      risk: 'write', long: true,
      usage: 'detect_scenes(path, threshold?, model?, options?) — run shot detection (GPU, can take minutes) and cache it; '
        + 'scenes [{start, end (s), startFrame, endFrame (inclusive)}]. model: transnetv2 (default) | omnishotcut | autoshot; '
        + 'threshold default 0.5; options {minSceneFrames?}',
      channel: 'ffmpeg:detectScenes',
      args: (a) => [a.path, a.threshold == null ? 0.5 : Number(a.threshold), a.model || 'transnetv2', a.options || {}],
      map: (r) => trimScenes(r),
    },
    cached_scenes: {
      risk: 'read',
      usage: 'cached_scenes(path, model?, threshold?, options?) — the already-computed shot list (cached:false and no scenes when never detected)',
      channel: 'ffmpeg:cachedScenes', args: (a) => [a.path, a.model || 'transnetv2', a.threshold == null ? undefined : Number(a.threshold), a.options],
      map: (r) => trimScenes(r),
    },
    get_edits: {
      risk: 'read',
      usage: 'get_edits(path, model?, optionsKey?) — saved manual edits of the cut {merges[], removed[]} (spans {in, out, inFrame?, outFrame?})',
      channel: 'cut:getEdits', args: (a) => [a.path, a.model, a.optionsKey],
    },
    save_edits: {
      risk: 'write',
      usage: 'save_edits(path, edits {merges[], removed[]}, model?, optionsKey?) — REPLACES the saved edits of this rush and model',
      channel: 'cut:saveEdits', args: (a) => [a.path, a.model, a.edits || {}, a.optionsKey],
    },
    clear_edits: {
      risk: 'destructive',
      usage: 'clear_edits(path, model?, optionsKey?) — forget every saved merge and removal of this rush for the model',
      channel: 'cut:clearEdits', args: (a) => [a.path, a.model, a.optionsKey],
    },
  },
  params: {
    path: { type: 'string', description: 'Absolute path of the media file' },
    time: { type: 'number', description: 'Seconds from the start of the file' },
    times: { type: 'array', items: { type: 'number' }, description: `Seconds; at most ${MAX_IMAGES} are used` },
    inFrame: { type: 'number', description: 'sheet: first frame of the shot (inclusive)' },
    outFrame: { type: 'number', description: 'sheet: last frame of the shot (inclusive)' },
    start: { type: 'number', description: 'sheet: start in seconds, when frames are unknown' },
    end: { type: 'number', description: 'sheet: end in seconds' },
    cols: { type: 'number', description: 'sheet/overview: cells per row' },
    rows: { type: 'number', description: 'sheet: rows' },
    width: { type: 'number', description: 'sheet/overview: width of one cell in pixels (120-480)' },
    page: { type: 'number', description: 'overview: page, from 1' },
    framesPerShot: { type: 'number', enum: [2, 3, 4], description: 'overview: force this many frames per shot. Leave it out: each shot gets what it needs (2 to 6, up to 8 for a very long shot)' },
    threshold: { type: 'number', description: 'Detection sensitivity (default 0.5)' },
    model: { type: 'string', description: 'Detection model: transnetv2 (default) | omnishotcut | autoshot' },
    options: { type: 'object', description: 'Detection options, e.g. {minSceneFrames: 6}' },
    optionsKey: { type: 'string', description: 'Key of the detection options the edits belong to (optional)' },
    edits: {
      type: 'object',
      properties: {
        merges: { type: 'array', items: { type: 'object' } },
        removed: { type: 'array', items: { type: 'object' } },
      },
    },
    ...WAIT_PARAM,
  },
};

/** Caps the shot list: a feature-length rush holds thousands of shots. @param {any} r */
function trimScenes(r) {
  if (!r || !Array.isArray(r.scenes) || r.scenes.length <= MAX_SCENES) return r;
  return { ...r, scenes: r.scenes.slice(0, MAX_SCENES), totalScenes: r.scenes.length, note: `Showing the first ${MAX_SCENES} of ${r.scenes.length} shots.` };
}
