// @ts-check
// System health: hardware and runtimes, NetsuRush caches, and the Resolve performance diagnostics of the
// Optimisation tab. The "free_*" actions are not harmless: they kill NetsuRush's own heavy processes.

/** @param {any} r */
function slimCompat(r) {
  if (!r || typeof r !== 'object') return r;
  const enc = r.encoding || {};
  return {
    ok: r.ok,
    hardware: r.hardware,
    configured: r.configured,
    runtime: r.runtime,
    encoding: {
      h264: enc.h264, h265: enc.h265, webp: enc.webp, hardwareEncoders: enc.hardwareEncoders,
      codecs: enc.codecs, ...(enc.error ? { error: enc.error } : {}),
    },
  };
}

/** @param {any} r */
function slimHealth(r) {
  if (!r || typeof r !== 'object') return r;
  const { samples, ...rest } = r;
  const list = Array.isArray(samples) ? samples : [];
  return { ...rest, sampleCount: list.length, recentSamples: list.slice(-6) };
}

/** @param {any} r */
function slimMissing(r) {
  if (!r || !Array.isArray(r.sources) || r.sources.length <= 100) return r;
  return { ...r, total: r.sources.length, sources: r.sources.slice(0, 100), note: 'Showing the 100 heaviest of ' + r.sources.length + '.' };
}

const CACHE_KINDS = ['thumb', 'proxy', 'voice', 'upscaleTest', 'roto', 'scenes', 'embeddings', 'indexThumbs', 'faces', 'transcripts'];

/** @type {import('./domain').DomainDef} */
module.exports = {
  name: 'netsu_system',
  summary: 'Machine and cache health: hardware / runtime / encoder facts, cache sizes and cleanup, and the live resource monitor '
    + '(VRAM, RAM, CPU, Resolve session drift, Resolve render queue). Read actions are safe; cache_clear deletes data and the free_* actions '
    + 'kill NetsuRush processes, so use them only when the user asked to free resources.',
  actions: {
    compat: {
      risk: 'read',
      usage: 'compat(force?) — {hardware, configured backends, runtime (torch / onnx availability), encoding {h264, h265, hardwareEncoders, codecs}}; cached 30 s, force re-probes',
      channel: 'compat:status', args: (a) => [{ force: !!a.force }],
      map: slimCompat,
    },
    cache_overview: {
      risk: 'read',
      usage: 'cache_overview() — size per cache kind {kind, lifecycle: session|reusable|durable, bytes, files}, totals, disk free space, models size',
      channel: 'cache:overview',
    },
    cache_missing: {
      risk: 'read',
      usage: 'cache_missing() — cached media whose source file no longer exists {source, bytes} (report only; nothing is deleted)',
      channel: 'cache:missing',
      map: slimMissing,
    },
    cache_clear: {
      risk: 'destructive',
      usage: 'cache_clear(kinds?, sources?, unattributed?) — DELETE cached data. kinds: thumb, proxy, voice, upscaleTest, roto (regenerate on demand, cheap) and scenes, embeddings, '
        + 'indexThumbs, faces, transcripts (databases: the search index, shot cuts and face data cost GPU time to rebuild). sources[] limits the purge to those rush files; '
        + 'unattributed:true purges entries with no known source; at least one of the three is required. Source media files are never touched. Returns {freed (bytes), files, rows}',
      channel: 'cache:clear', args: (a) => [{ kinds: a.kinds, sources: a.sources, unattributed: !!a.unattributed }],
    },
    diagnose: {
      risk: 'read',
      usage: 'diagnose() — Resolve state and performance settings: {connected, project, timeline, version, settings, render {jobs, inProgress}, cacheRoots, vram}; works with Resolve closed (connected:false)',
      channel: 'optimize:diagnose',
    },
    resources: {
      risk: 'read',
      usage: 'resources(root?) — live {gpu {name, totalMB, usedMB...}, ram {free, total}, cpu (%), resolveRam, disk (when root = a folder path)}',
      channel: 'optimize:resources', args: (a) => [a.root],
    },
    session_health: {
      risk: 'read',
      usage: 'session_health() — Resolve session drift: {running, measured, ram, driftRam, vram, driftVram, verdict: ok|watch|high, recentSamples}. "high" means reloading the project or restarting Resolve is worth it',
      channel: 'optimize:sessionHealth',
      map: slimHealth,
    },
    render_jobs: {
      risk: 'read',
      usage: 'render_jobs() — Resolve render queue {connected, jobs [{id, name, target}], inProgress}',
      channel: 'optimize:renderJobs',
    },
    free_gpu: {
      risk: 'destructive',
      usage: 'free_gpu() — release the VRAM NetsuRush holds: CANCELS every proxy encode and KILLS the AI daemons (search, upscale, detection) — jobs running in them fail — '
        + 'and kills any application that is "not responding". Returns {proxiesKilled, deadKilled, vramFreedMB, vram}. Daemons restart on next use',
      channel: 'optimize:freeGpu',
    },
    free_ram: {
      risk: 'destructive',
      usage: 'free_ram() — same stop of NetsuRush heavy work as free_gpu, kills not-responding apps, and trims the working set of other processes (pages them out; harmless). Returns {deadKilled, ramFreed, ram}',
      channel: 'optimize:freeRam',
    },
    free_cpu: {
      risk: 'destructive',
      usage: 'free_cpu() — same stop of NetsuRush heavy work as free_gpu and kills not-responding apps. Returns {proxiesKilled, deadKilled, cpu}',
      channel: 'optimize:freeCpu',
    },
  },
  params: {
    force: { type: 'boolean', description: 'Re-probe instead of using the cached answer' },
    kinds: { type: 'array', items: { type: 'string', enum: CACHE_KINDS }, description: 'Cache kinds to clear' },
    sources: { type: 'array', items: { type: 'string' }, description: 'Absolute rush file paths whose cache entries are purged' },
    unattributed: { type: 'boolean', description: 'Purge cache entries whose source is unknown' },
    root: { type: 'string', description: 'Absolute folder whose disk free space is reported' },
  },
};
