// @ts-check
// Semantic search (SigLIP 2) over indexed shots, plus face search. Both run in the Python sidecar
// (python/nrsearch). Hits are shots: {file_path, start_frame, end_frame, start_sec, end_sec, score}.

const { WAIT_PARAM } = require('./domain');
const { packShots, renderPage } = require('./shotGrid');

const MAX_IMAGES = 6;
const ROW_HITS = 18;

/// The best hits as rows of frames, several shots per image, each with its `label` written on its
/// first frame. Measured on real footage, seeing more shots is what finds more of them: judging 6
/// hits one sheet at a time found 5 shots of an action where 20 existed, and a row costs a third of a
/// sheet. The label is the shot's first frame, not its rank: an agent running two searches read "5" on
/// the second image and took the 5th hit of the first list. A shot keeps its number across searches.
/** @param {any[]} hits @param {any} a @param {import('./domain').ActionCtx} ctx */
async function attachRows(hits, a, ctx) {
  const fixed = [2, 3, 4].includes(Number(a.framesPerShot)) ? Number(a.framesPerShot) : undefined;
  /** @type {number[][]} */
  const plans = new Array(hits.length);
  let analysed = true;
  for (const file of new Set(hits.map((h) => h.file))) {
    const indexes = hits.map((h, i) => (h.file === file ? i : -1)).filter((i) => i >= 0);
    const r = await ctx.invoke('ffmpeg:shotFrames', [{ path: file, shots: indexes.map((i) => hits[i]), framesPerShot: fixed }]);
    if (!r || !r.ok) throw new Error('no frame plan');
    if (!r.analysed) analysed = false;
    indexes.forEach((hit, i) => { plans[hit] = r.plans[i]; });
  }
  const images = [];
  for (const page of packShots(plans)) {
    const image = await renderPage(hits, plans, page, ctx);
    if (image) images.push(image);
  }
  return { images, analysed };
}

/** @param {any} h */
function normalizeHit(h) {
  return {
    file: h.file_path, inFrame: h.start_frame, outFrame: h.end_frame,
    startSec: h.start_sec, endSec: h.end_sec, fps: h.fps,
    score: typeof h.score === 'number' ? Math.round(h.score * 1000) / 1000 : h.score,
    ...(h.aesthetic != null ? { aesthetic: h.aesthetic } : {}),
    ...(h.char ? { char: h.char.name || h.char } : {}),
    sceneIndex: h.scene_index,
  };
}

/**
 * Normalizes a `{hits, error}` sidecar answer: sorted by score, capped, and the best few shots get a
 * thumbnail (core/thumbs cache, reached through the ffmpeg:thumbnail channel) attached as __images.
 * @param {any} res @param {any} a @param {import('./domain').ActionCtx} ctx
 */
async function hitsResult(res, a, ctx) {
  if (!res || typeof res !== 'object') return res;
  if (res.error && !(res.hits && res.hits.length)) return { ok: false, error: String(res.error) };
  const raw = Array.isArray(res.hits) ? res.hits : [];
  const hits = raw.map(normalizeHit).sort((x, y) => (Number(y.score) || 0) - (Number(x.score) || 0));
  const limit = Number(a.limit) > 0 ? Number(a.limit) : 30;
  const offset = Math.max(0, Math.round(Number(a.offset)) || 0);
  const shown = hits.slice(offset, offset + limit);
  // Several files: a letter tells them apart, spelled out in `files`.
  const paths = [...new Set(shown.map((h) => h.file))];
  const letter = (/** @type {string} */ file) => (paths.length > 1 ? String.fromCharCode(65 + (paths.indexOf(file) % 26)) : '');
  shown.forEach((h) => { h.label = `${letter(h.file)}${h.inFrame}`; });
  /** @type {string[]} */
  let images = [];
  const view = a.thumbnails === false ? 'none' : (a.view || 'rows');
  let analysed = true;
  if (view === 'rows') {
    const seen = shown
      .slice(0, Math.max(0, Number(a.imageHits) || ROW_HITS))
      .filter((h) => typeof h.startSec === 'number' && typeof h.endSec === 'number');
    try { ({ images, analysed } = await attachRows(seen, a, ctx)); } catch (_) { /* missing images never fail a search */ }
  } else if (view !== 'none') {
    for (const h of shown.slice(0, Math.max(0, Number(a.imageHits) || MAX_IMAGES))) {
      try {
        if (view === 'sheet' && typeof h.inFrame === 'number' && typeof h.outFrame === 'number') {
          // A sheet rather than a still: what happens in the shot, for the price of one thumbnail.
          const r = await ctx.invoke('ffmpeg:shotSheet', [{ path: h.file, inFrame: h.inFrame, outFrame: h.outFrame, cols: 4, rows: 2 }]);
          if (r && r.ok && r.path) { images.push(r.path); h.sheetFrames = r.frames; }
        } else {
          const mid = typeof h.startSec === 'number' && typeof h.endSec === 'number' ? (h.startSec + h.endSec) / 2 : h.startSec || 0;
          const p = await ctx.invoke('ffmpeg:thumbnail', [{ path: h.file, time: mid }]);
          if (typeof p === 'string' && p) { images.push(p); h.thumb = p; }
        }
      } catch (_) { /* a missing image never fails the search */ }
    }
  }
  // An empty answer usually means an empty index, not "nothing matches": say so, or the model
  // concludes the footage does not contain the subject.
  const emptyNote = hits.length ? undefined : 'No results. The footage is probably not indexed: check action=status / indexed, run action=index on each file, then search again.';
  return {
    total: hits.length, hits: shown,
    ...(paths.length > 1 ? { files: Object.fromEntries(paths.map((f) => [letter(f), f])) } : {}),
    ...(emptyNote ? { note: emptyNote } : {}),
    ...(res.notice ? { notice: res.notice } : {}),
    ...(hits.length > offset + limit ? { note: `Showing ${offset + 1}-${offset + shown.length} of ${hits.length}; offset=${offset + limit} shows the next ones.` } : {}),
    ...(images.length ? {
      images: view === 'rows'
        ? `${images.length} image(s) follow. Each shot starts a new row, left to right, with its "label" (its first frame) written on its first image; a busy shot gets more frames and may carry on to the next row. Identify a shot by that number, never by counting rows.${analysed ? '' : ' This file is being analysed: frames are evenly spaced for now, placed where the picture changes on the next search.'}`
        : `${images.length} image(s) follow, one per hit in the order of hits; each sheet reads left to right, top to bottom`,
      __images: images,
    } : {}),
  };
}

/** @param {any} a */
const searchOpts = (a) => ({
  text: a.text, negText: a.negText, lang: a.lang, refs: a.refs, topK: a.topK, minScore: a.minScore,
  aesthetic: a.aesthetic, charIds: a.charIds, filePaths: a.filePaths,
});

/** Trims a list field of a sidecar answer. @param {string} key */
const trimList = (key) => (/** @type {any} */ res, /** @type {any} */ a) => {
  if (!res || typeof res !== 'object' || !Array.isArray(res[key])) return res;
  const limit = Number(a.limit) > 0 ? Number(a.limit) : 50;
  const total = res[key].length;
  return { ...res, [key]: res[key].slice(0, limit), total, ...(total > limit ? { note: `Showing ${limit} of ${total}; raise limit.` } : {}) };
};

/// Index in flight per file. Every action that reads or rewrites a file's shots waits for it: a
/// second correction read earlier rebuilt the file from the pre-correction shots, and an index
/// finishing after clear_scenes wrote the cleared boundaries back.
/** @type {Map<string, Promise<any>>} */
const reindexing = new Map();

/** @param {any} path */
async function afterIndex(path) {
  const pending = reindexing.get(String(path));
  if (pending) await pending.catch(() => {});
}

/** @param {any} path @param {Promise<any>} run */
function trackIndex(path, run) {
  const key = String(path);
  const tracked = run.finally(() => { if (reindexing.get(key) === tracked) reindexing.delete(key); });
  reindexing.set(key, tracked);
  return run;
}

/// Rewrites the shot boundaries of an indexed file from its current shots, then re-indexes it so
/// search sees the corrected shots. The index answers inline when quick, otherwise as a job.
/** @param {any} a @param {import('./domain').ActionCtx} ctx @param {(scenes:{startFrame:number,endFrame:number}[])=>any[]} edit */
async function editScenes(a, ctx, edit) {
  await afterIndex(a.path);
  const cur = await ctx.invoke('search:shots', [a.path]);
  const rows = (cur && Array.isArray(cur.shots) ? cur.shots : []).slice().sort((x, y) => x.start_frame - y.start_frame);
  if (!rows.length) return { ok: false, error: 'file not indexed: run index first' };
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i].start_frame <= rows[i - 1].end_frame) {
      return { ok: false, error: `the index of this file holds overlapping shots (frame ${rows[i].start_frame}): rebuild it with forget(filePaths:[path], kinds:["search"]), clear_scenes(path), then index(path, force:true)` };
    }
  }
  const fps = Number(rows[0].fps) || undefined;
  let next;
  try { next = edit(rows.map((r) => ({ startFrame: r.start_frame, endFrame: r.end_frame }))); } catch (e) { return { ok: false, error: String(/** @type {any} */ (e).message || e) }; }
  const set = await ctx.invoke('search:setScenes', [{ path: a.path, scenes: next, fps, frames: rows[0].src_frames || undefined }]);
  if (!set || set.ok === false) return set;
  const run = trackIndex(a.path, ctx.invoke('search:index', [a.path, false, undefined, undefined, {}]));
  const index = await ctx.jobs.run('netsu_search.reindex', () => run, { waitMs: 45000 });
  return { ok: true, before: rows.length, after: next.length, index };
}

/** @type {import('./domain').DomainDef} */
module.exports = {
  name: 'netsu_search',
  summary: 'NetsuRush semantic search over INDEXED footage (SigLIP 2) and face search. Files must be indexed first '
    + '(index / face_index, long). A hit is a shot {file, inFrame, outFrame, startSec, endSec, score}; the best few '
    + 'come as rows of frames, one row per shot, so judge the action and not one still. For a precise action or movement: search several phrasings, go further down with offset, keep only the shots that really show it. Search ranks on still images and misses movement: when every occurrence matters, also go through the rush with netsu_media overview. Search by text, by example image (refs), by negative text, or restricted to characters '
    + '(charIds from netsu_characters). Frames are inclusive.',
  actions: {
    run: {
      risk: 'read',
      usage: 'run(text?, negText?, refs?[], topK?, minScore?, aesthetic?, charIds?[], filePaths?[], lang?, limit?, offset?, view?, framesPerShot?, imageHits?) — ranked shots; refs = image paths or {file_path, scene_index} for search-by-example; needs text and/or refs and/or charIds',
      run: async (a, ctx) => {
        const refs = Array.isArray(a.refs) ? a.refs.map((r) => (typeof r === 'string' ? { path: r } : r)) : [];
        const res = await ctx.invoke('search:run', [{ ...searchOpts(a), refs }]);
        return hitsResult(res, a, ctx);
      },
    },
    shots: {
      risk: 'read',
      usage: 'shots(path, limit?) — indexed shots of ONE file {file, inFrame, outFrame, startSec, endSec}',
      channel: 'search:shots', args: (a) => [a.path],
      map: (res, a) => {
        const raw = res && Array.isArray(res.shots) ? res.shots : [];
        const limit = Number(a.limit) > 0 ? Number(a.limit) : 100;
        return {
          total: raw.length, shots: raw.slice(0, limit).map(normalizeHit),
          ...(raw.length > limit ? { note: `Showing ${limit} of ${raw.length}; raise limit.` } : {}),
          ...(res && res.error ? { error: res.error } : {}),
        };
      },
    },
    dedup: {
      risk: 'read',
      usage: 'dedup(filePath?, scenes?[{file_path, scene_index}], threshold?, limit?) — groups of near-identical shots (size>=2); no scope = whole index',
      channel: 'search:dedup', args: (a) => [{ filePath: a.filePath, scenes: a.scenes, threshold: a.threshold }],
      map: trimList('groups'),
    },
    cluster: {
      risk: 'read',
      usage: 'cluster(filePath?, scenes?[], k?, limit?) — k-means visual clusters of shots; no scope = first 5000 shots of the index',
      channel: 'search:cluster', args: (a) => [{ filePath: a.filePath, scenes: a.scenes, k: a.k }],
      map: trimList('clusters'),
    },
    status: { risk: 'read', usage: 'status(filePaths?[]) — indexing coverage (clips and shots indexed)', channel: 'search:status', args: (a) => [{ filePaths: a.filePaths }] },
    indexed: {
      risk: 'read',
      usage: 'indexed(limit?) — files already in the search index',
      channel: 'search:indexed',
      map: (res, a) => {
        const limit = Number(a.limit) > 0 ? Number(a.limit) : 200;
        if (Array.isArray(res)) return { total: res.length, files: res.slice(0, limit) };
        return trimList('files')(res, a);
      },
    },
    model_state: { risk: 'read', usage: 'model_state() — active SigLIP variant and available variants', channel: 'search:modelState' },
    index: {
      risk: 'write', long: true, cancelChannel: 'search:cancelIndex',
      usage: 'index(path, force?, frames?, model?) — index ONE video file for search (scene detection + embeddings); skips already-indexed files unless force; heavy GPU work',
      run: async (a, ctx) => {
        await afterIndex(a.path);
        return trackIndex(a.path, ctx.invoke('search:index', [a.path, !!a.force, a.frames, a.model, a.options || {}]));
      },
    },
    cancel_index: { risk: 'write', usage: 'cancel_index() — stop the running indexing job immediately', channel: 'search:cancelIndex' },
    forget: {
      risk: 'destructive',
      usage: 'forget(filePaths[], kinds?[search|faces|scenes]) — remove files from the shot index / face index / cached shot detection (default search+faces); re-index afterwards to rebuild clean data',
      channel: 'search:forget', args: (a) => [{ filePaths: a.filePaths || (a.path ? [a.path] : []), kinds: a.kinds }],
    },
    set_scenes: {
      risk: 'write',
      usage: 'set_scenes(path, scenes[{startFrame, endFrame}], fps?, frames?) — impose corrected shot boundaries (inclusive frames, no overlap) for search; they beat detection. Then run index on the file to re-embed it',
      run: async (a, ctx) => {
        await afterIndex(a.path);
        return ctx.invoke('search:setScenes', [{ path: a.path, scenes: a.scenes, fps: a.fps, frames: a.srcFrames }]);
      },
    },
    merge_shots: {
      risk: 'write',
      usage: 'merge_shots(path, sceneIndexes[]) — merge consecutive indexed shots into one (a cut detected by mistake), then re-index the file',
      run: async (a, ctx) => editScenes(a, ctx, (scenes) => {
        const idx = [...new Set((a.sceneIndexes || []).map(Number))].sort((x, y) => x - y);
        if (idx.length < 2) throw new Error('sceneIndexes needs at least two consecutive shots');
        for (let i = 1; i < idx.length; i += 1) if (idx[i] !== idx[i - 1] + 1) throw new Error('sceneIndexes must be consecutive');
        const first = scenes[idx[0]];
        const last = scenes[idx[idx.length - 1]];
        if (!first || !last) throw new Error('sceneIndexes out of range');
        return [...scenes.slice(0, idx[0]), { startFrame: first.startFrame, endFrame: last.endFrame }, ...scenes.slice(idx[idx.length - 1] + 1)];
      }),
    },
    split_shot: {
      risk: 'write',
      usage: 'split_shot(path, atFrame) — split the indexed shot containing atFrame into two (a missed cut; atFrame starts the second), then re-index the file',
      run: async (a, ctx) => editScenes(a, ctx, (scenes) => {
        const at = Number(a.atFrame);
        const i = scenes.findIndex((s) => s.startFrame < at && at <= s.endFrame);
        if (i < 0) throw new Error(`no shot strictly contains frame ${at}`);
        const s = scenes[i];
        return [...scenes.slice(0, i), { startFrame: s.startFrame, endFrame: at - 1 }, { startFrame: at, endFrame: s.endFrame }, ...scenes.slice(i + 1)];
      }),
    },
    clear_scenes: {
      risk: 'write',
      usage: 'clear_scenes(path) — drop the hand-set boundaries of a file; the next index falls back to detection',
      run: async (a, ctx) => {
        await afterIndex(a.path);
        return ctx.invoke('search:clearScenes', [a.path]);
      },
    },
    face_label: {
      risk: 'write',
      usage: 'face_label(path, sceneIndex, faceIndex, domain?, charId|null, reset?) — correct who a detected face is (null = nobody); survives auto-labelling; reset drops the correction',
      channel: 'face:label', args: (a) => [{ filePath: a.path, sceneIndex: a.sceneIndex, faceIndex: a.faceIndex, domain: a.domain, charId: a.charId ?? null, reset: !!a.reset }],
    },
    face_index: {
      risk: 'write', long: true, cancelChannel: 'search:cancelIndex',
      usage: 'face_index(path, force?, model?) — detect and embed the faces of ONE video file (needed for face_search and netsu_characters)',
      channel: 'face:index', args: (a) => [a.path, !!a.force, a.model, a.options || {}],
    },
    face_search: {
      risk: 'read',
      usage: 'face_search(path | filePath+sceneIndex | refs[], topK?, minScore?, filePaths?[], limit?, thumbnails?) — shots containing the same face; path = reference image, filePath+sceneIndex = an indexed face',
      run: async (a, ctx) => {
        const res = await ctx.invoke('face:search', [{
          path: a.path, filePath: a.filePath, sceneIndex: a.sceneIndex, refs: a.refs,
          topK: a.topK, minScore: a.minScore, filePaths: a.filePaths,
        }]);
        return hitsResult(res, a, ctx);
      },
    },
    face_detect: {
      risk: 'read',
      usage: 'face_detect(path) — faces found in a reference IMAGE {faces:[{index, domain, bbox}]}; pick one bbox for face_search / netsu_characters add_sample',
      channel: 'face:detect', args: (a) => [a.path],
      map: (res) => {
        if (!res || !Array.isArray(res.faces)) return res;
        return { ...res, faces: res.faces.map((/** @type {any} */ f) => ({ index: f.index, domain: f.domain, bbox: f.bbox })) };
      },
    },
    face_status: { risk: 'read', usage: 'face_status(filePaths?[]) — face-index coverage {faces, clips, domains}', channel: 'face:status', args: (a) => [{ filePaths: a.filePaths }] },
    face_engines: { risk: 'read', usage: 'face_engines() — available face engines (anime / real)', channel: 'face:engines' },
    face_indexed: {
      risk: 'read',
      usage: 'face_indexed(limit?) — files already in the face index',
      channel: 'face:indexed',
      map: (res, a) => {
        const limit = Number(a.limit) > 0 ? Number(a.limit) : 200;
        if (Array.isArray(res)) return { total: res.length, files: res.slice(0, limit) };
        return trimList('files')(res, a);
      },
    },
    face_gallery: {
      risk: 'read',
      usage: 'face_gallery(topK?, minSize?, filePaths?[], limit?) — indexed faces grouped by identity {ref:{file_path, scene_index, face_index}, count, char}; feed a ref to face_search or add_sample',
      channel: 'face:gallery', args: (a) => [{ topK: a.topK, minSize: a.minSize, filePaths: a.filePaths }],
      map: (res, a) => {
        if (!res || !Array.isArray(res.faces)) return res;
        const limit = Number(a.limit) > 0 ? Number(a.limit) : 50;
        const faces = res.faces.slice(0, limit).map((/** @type {any} */ f) => ({ ref: f.ref, count: f.count, char: f.char || null }));
        return { total: res.faces.length, faces, ...(res.faces.length > limit ? { note: `Showing ${limit} of ${res.faces.length}; raise limit.` } : {}) };
      },
    },
  },
  params: {
    kinds: { type: 'array', items: { type: 'string', enum: ['search', 'faces', 'scenes'] }, description: 'forget: which data to drop' },
    srcFrames: { type: 'number', description: 'set_scenes: total frame count of the file (optional)' },
    faceIndex: { type: 'number', description: 'face_label: index of the face within the shot' },
    sceneIndexes: { type: 'array', items: { type: 'number' }, description: 'merge_shots: consecutive scene indexes' },
    atFrame: { type: 'number', description: 'split_shot: first frame of the second part' },
    reset: { type: 'boolean' },
    text: { type: 'string', description: 'Natural-language query (any language), e.g. "a character running in the rain"' },
    negText: { type: 'string', description: 'Concepts to push results away from' },
    refs: {
      type: 'array',
      items: { anyOf: [{ type: 'string' }, { type: 'object' }] },
      description: 'run: image file paths (or {file_path, scene_index} of indexed shots) for search-by-example. face_search: face refs {path, bbox?, domain?} or {file_path, scene_index, face_index?}',
    },
    topK: { type: 'number', description: 'Candidates fetched from the index (default 60)' },
    minScore: { type: 'number', description: 'Minimum score, 0-1' },
    aesthetic: { type: 'boolean', description: 'Bias results toward aesthetically stronger frames' },
    charIds: { type: 'array', items: { type: 'number' }, description: 'Restrict to shots containing ALL these characters (netsu_characters ids)' },
    filePaths: { type: 'array', items: { type: 'string' }, description: 'Restrict to these source files' },
    lang: { type: 'string', description: 'Query language hint (fr, en, es, de, ...) for short queries' },
    limit: { type: 'number', description: 'Max entries returned to you (hits 30, others 50-200)' },
    thumbnails: { type: 'boolean', description: 'false: no images at all' },
    view: { type: 'string', enum: ['rows', 'sheet', 'frame', 'none'], description: 'How the best hits are shown: rows (default, one row of frames per shot, many shots per image, the cheapest way to judge actions), sheet (8 frames per shot, one image each), frame (one still each), none' },
    imageHits: { type: 'number', description: 'How many hits get images (default 18 in rows, 6 otherwise)' },
    offset: { type: 'number', description: 'Skip this many hits: look further down the ranking' },
    framesPerShot: { type: 'number', enum: [2, 3, 4], description: 'rows view: force this many frames per shot. Leave it out: each shot gets what it needs (2 to 6, up to 8 for a very long shot), according to its length and how much happens in it' },
    path: { type: 'string', description: 'Absolute path of a video file (index, shots, face_index) or of a reference image (face_search, face_detect)' },
    filePath: { type: 'string', description: 'Absolute path of an indexed video file' },
    sceneIndex: { type: 'number' },
    scenes: {
      type: 'array',
      items: { type: 'object', properties: { file_path: { type: 'string' }, scene_index: { type: 'number' }, startFrame: { type: 'number' }, endFrame: { type: 'number' } } },
      description: 'dedup/cluster: shots as {file_path, scene_index}; set_scenes: shots as {startFrame, endFrame} (inclusive frames)',
    },
    domain: { type: 'string', enum: ['anime', 'real'], description: 'face_label: face domain (default anime)' },
    charId: { type: ['number', 'null'], description: 'face_label: character id, null = nobody' },
    fps: { type: 'number', description: 'set_scenes: frame rate (default: from the cached detection)' },
    threshold: { type: 'number', description: 'dedup cosine threshold (default 0.93)' },
    k: { type: 'number', description: 'cluster count (default auto)' },
    force: { type: 'boolean', description: 'Re-index even if already indexed' },
    frames: { type: 'number', description: 'Frames sampled per shot (default per settings)' },
    model: { type: 'string', description: 'Model variant id (default: active model)' },
    options: { type: 'object', description: 'Advanced indexing options (leave unset)' },
    minSize: { type: 'number', description: 'face_gallery: minimum occurrences per identity' },
    ...WAIT_PARAM,
  },
};
