// @ts-check
// "NetsuRush" tools: expose the EXISTING core modules (Resolve, detection, search, timeline, proxy,
// thumbnails, AE export) to the AI agent. Reuses the same functions as core/rpc.js — no duplicated
// business logic. Resolve ops go through the `guarded`/`rOp` brackets (same invariants as rpc.js:
// safe reset of the handle registry, poll paused).

const os = require('os');
const path = require('path');

/**
 * @param {{
 *   resolveMod:any, timeline:any, sidecars:any, thumbs:any, ffmpeg:any,
 *   aeExporter:any, ev:any, guarded:(fn:any)=>any, rOp:(fn:any)=>any
 * }} deps
 */
function createNetsuRushTools(deps) {
  const { resolveMod, timeline, sidecars, thumbs, ffmpeg, aeExporter, ev, guarded, rOp } = deps;

  /** @type {import('./registry').ToolDef[]} */
  const tools = [
    {
      name: 'resolve_status',
      description: 'DaVinci Resolve status: bridge connection, open project and timeline, version. '
        + 'Call it first to know whether project actions are possible.',
      risk: 'read',
      inputSchema: { type: 'object', properties: {} },
      handler: rOp(() => resolveMod.resolveStatus()),
    },
    {
      name: 'list_media_pool',
      description: 'Lists the Media Pool clips of the current Resolve project (name, path, duration, fps, resolution).',
      risk: 'read',
      inputSchema: { type: 'object', properties: {} },
      handler: rOp(() => resolveMod.listMediaPool()),
    },
    {
      name: 'import_media',
      description: 'Imports files into the Media Pool of the current Resolve project.',
      risk: 'write',
      inputSchema: {
        type: 'object',
        properties: { paths: { type: 'array', items: { type: 'string' }, description: 'Absolute paths of the files to import' } },
        required: ['paths'],
      },
      handler: guarded((/** @type {{paths:string[]}} */ a) => resolveMod.importToMediaPool(a.paths || [])),
    },
    {
      name: 'detect_scenes',
      description: 'Detects the shots of a video and caches them. Models: transnetv2, omnishotcut, autoshot.',
      risk: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path of the video' },
          threshold: { type: 'number' },
          model: { type: 'string', enum: ['transnetv2', 'omnishotcut', 'autoshot'] },
          options: { type: 'object', description: 'Advanced settings specific to the model.' },
        },
        required: ['path'],
      },
      handler: (/** @type {any} */ a) => sidecars.detectScenes(ev, a.path, a.threshold ?? 0.5, a.model || 'transnetv2', a.options || {}),
    },
    {
      name: 'cached_scenes',
      description: 'Reads the shots already detected and cached for a video (instant, no recomputation).',
      risk: 'read',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, model: { type: 'string', enum: ['transnetv2', 'omnishotcut', 'autoshot'] }, options: { type: 'object' } },
        required: ['path'],
      },
      handler: (/** @type {any} */ a) => sidecars.getCachedScenes(a.path, a.model || 'transnetv2', a.threshold, a.options),
    },
    {
      name: 'search_clips',
      description: 'SEMANTIC search (SigLIP 2) of the VISUAL CONTENT of shots (e.g. "sea", "car at '
        + 'night", "face close-up") — NOT the file name. This is the tool to use for "find the '
        + 'footage/shots of <subject>". Returns the closest shots {file_path, frames in/out, score 0..1}. '
        + 'Searches shots ALREADY INDEXED: if 0 results, index the footage first with index_clip.',
      risk: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Natural-language query' },
          topK: { type: 'number' },
          minScore: { type: 'number' },
        },
        required: ['text'],
      },
      handler: async (/** @type {any} */ a) => {
        const raw = await sidecars.queryReq('search', { text: String(a.text || ''), neg_text: '', refs: [], top_k: a.topK || 30, min_score: a.minScore || 0, beta: 0.4, aesthetic: false });
        // Normalized into a clean, sorted array with explicit fields (ready for build_timeline).
        const arr = Array.isArray(raw) ? raw : (raw && (raw.hits || raw.results)) || [];
        const hits = arr.map((/** @type {any} */ h) => ({
          file: h.file_path || h.file || h.path,
          inFrame: h.in ?? h.inFrame ?? null,
          outFrame: h.out ?? h.outFrame ?? null,
          score: Number(h.score ?? h.similarity ?? 0),
        })).filter((/** @type {any} */ h) => h.file).sort((/** @type {any} */ x, /** @type {any} */ y) => y.score - x.score);
        const top = hits[0] ? hits[0].score : 0;
        // SigLIP: a real match exceeds ~0.05. Below that = no shot matches OR the index is empty/poor.
        const note = hits.length === 0
          ? 'No results: the footage is probably not indexed. Run index_clip on each clip, then search again.'
          : top < 0.05
            ? 'Very low scores: no shot really matches the subject (or the index is poor). Do NOT build a timeline from this; tell the user.'
            : undefined;
        return { ok: true, query: String(a.text || ''), count: hits.length, topScore: top, hits, ...(note ? { note } : {}) };
      },
    },
    {
      name: 'index_clip',
      description: 'Indexes a video for semantic search (detects the shots, then computes the embeddings).',
      risk: 'write',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, precise: { type: 'boolean' } },
        required: ['path'],
      },
      handler: guarded((/** @type {any} */ a) => sidecars.searchIndex(ev, 'index', { path: a.path, force: false, precise: !!a.precise })),
    },
    {
      name: 'list_timelines',
      description: 'Lists the timelines of the Resolve project (and which one is current).',
      risk: 'read',
      inputSchema: { type: 'object', properties: {} },
      handler: rOp(() => timeline.listTimelines()),
    },
    {
      name: 'read_timeline',
      description: 'Reads the edited shots of an existing Resolve timeline (source + in/out frames). '
        + 'timelineName omitted = open timeline.',
      risk: 'read',
      inputSchema: { type: 'object', properties: { timelineName: { type: 'string' } } },
      handler: guarded((/** @type {any} */ a) => timeline.readTimelineCuts({ timelineName: a.timelineName })),
    },
    {
      name: 'build_timeline',
      description: 'Creates a frame-accurate timeline from segments of a video (references the '
        + 'original MediaPoolItem, out is INCLUSIVE). mode "new" (default) creates, "append" adds to the current one.',
      risk: 'write',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          input: { type: 'string', description: 'Path of the source video' },
          mode: { type: 'string', enum: ['new', 'append'] },
          whole: { type: 'boolean' },
          srcFrames: { type: 'number' },
          segments: {
            type: 'array',
            items: {
              type: 'object',
              properties: { in: { type: 'number' }, out: { type: 'number' }, inFrame: { type: 'number' }, outFrame: { type: 'number' } },
            },
          },
        },
        required: ['name', 'input'],
      },
      handler: guarded((/** @type {any} */ a) => timeline.buildTimeline(a)),
    },
    {
      name: 'cut_timeline',
      description: 'Detects the shots of the footage in a timeline, then creates a new cut timeline '
        + '(lossless, frame-accurate). timelineName omitted = open timeline.',
      risk: 'write',
      inputSchema: {
        type: 'object',
        properties: {
          timelineName: { type: 'string' },
          model: { type: 'string', enum: ['transnetv2', 'omnishotcut', 'autoshot'] },
          threshold: { type: 'number' },
          detectionOptions: { type: 'object' },
          name: { type: 'string' },
        },
      },
      handler: guarded((/** @type {any} */ a) => timeline.cutTimeline(ev, a)),
    },
    {
      name: 'probe_media',
      description: 'Metadata of a video file: duration and dimensions.',
      risk: 'read',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      handler: (/** @type {any} */ a) => ffmpeg.probeMedia(a.path),
    },
    {
      name: 'make_thumbnail',
      description: 'Generates (or reads from cache) a thumbnail of a video at a given time. Returns the JPEG path.',
      risk: 'read',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, time: { type: 'number' } },
        required: ['path'],
      },
      handler: (/** @type {any} */ a) => thumbs.thumbnail(a.path, a.time || 0).catch((/** @type {any} */ e) => ({ error: String(e) })),
    },
    {
      name: 'export_to_after_effects',
      description: 'Exports a Resolve timeline to After Effects (.jsx + media). See the video/audio '
        + 'mode options. timelineName omitted = open timeline.',
      risk: 'write',
      inputSchema: {
        type: 'object',
        properties: {
          timelineName: { type: 'string' },
          videoMode: { type: 'string', enum: ['copy', 'remux', 'reencode'] },
          audio: { type: 'string', enum: ['copy', 'remux', 'aac', 'pcm', 'none'] },
        },
      },
      handler: guarded((/** @type {any} */ a) =>
        aeExporter.aeExport(ev, { videoMode: a.videoMode || 'copy', audio: a.audio || 'copy', timelineName: a.timelineName ?? null })),
    },
    {
      name: 'upscale_media',
      description: 'Upscales a video (or a segment) with Real-ESRGAN. model: anime | general | light. '
        + 'scale 2 or 4. whole=true for the whole file, otherwise segments [{in,out}] (seconds). '
        + 'outDir omitted = temporary folder. importBack=true re-imports the result into the Media Pool.',
      risk: 'write',
      inputSchema: {
        type: 'object',
        properties: {
          input: { type: 'string', description: 'Path of the source video' },
          model: { type: 'string', enum: ['anime', 'general', 'light'] },
          scale: { type: 'number', enum: [2, 4] },
          whole: { type: 'boolean' },
          segments: { type: 'array', items: { type: 'object', properties: { in: { type: 'number' }, out: { type: 'number' } } } },
          outDir: { type: 'string' },
          importBack: { type: 'boolean' },
        },
        required: ['input'],
      },
      handler: (/** @type {any} */ a) => sidecars.runUpscale(ev, {
        input: a.input,
        model: a.model || 'light',
        scale: a.scale || 4,
        whole: a.whole ?? (!Array.isArray(a.segments) || !a.segments.length),
        segments: a.segments,
        outDir: a.outDir || path.join(os.tmpdir(), 'netsurush-upscale'),
        importBack: !!a.importBack,
      }),
    },
  ];

  return tools;
}

module.exports = { createNetsuRushTools };
