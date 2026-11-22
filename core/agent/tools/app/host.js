// @ts-check
// Editing hosts and projects: the project registry, the offline snapshot, the deferred-send outbox,
// opening and closing the editing apps, the Resolve timeline builders, and the Premiere / After Effects
// bridge (CEP panel). For the Resolve Media Pool and the full scripting API use the netsu_resolve tools.

const { WAIT_PARAM } = require('./domain');

const LIST_CAP = 200;

/**
 * Caps the long arrays of a host snapshot so it does not flood the model.
 * @param {any} r
 * @param {string[]} keys
 */
function capArrays(r, keys) {
  if (!r || typeof r !== 'object') return r;
  const out = { ...r };
  /** @type {string[]} */
  const notes = [];
  for (const k of keys) {
    if (Array.isArray(out[k]) && out[k].length > LIST_CAP) {
      notes.push(`${k}: showing ${LIST_CAP} of ${out[k].length}`);
      out[k] = out[k].slice(0, LIST_CAP);
    }
  }
  return notes.length ? { ...out, note: notes.join('; ') } : out;
}

/** @param {any} snap */
function slimAdobeSnapshot(snap) {
  if (!snap || typeof snap !== 'object') return { snapshot: snap || null };
  if (snap.app) return capArrays(snap, ['rushes']);
  return { ppro: capArrays(snap.ppro, ['rushes']), aeft: capArrays(snap.aeft, ['rushes']) };
}

/** @param {any} r @param {any} a */
function slimCutAnalysis(r, a) {
  if (!r || !a.summaryOnly || !Array.isArray(r.clips)) return r;
  return {
    ...r,
    clips: r.clips.map((c) => ({ path: c.path, name: c.name, fps: c.fps, totalFrames: c.totalFrames, shots: Array.isArray(c.shots) ? c.shots.length : 0 })),
    note: 'summaryOnly: clips carry shot counts, not the shots build_cut_timeline needs. Call again without summaryOnly to build.',
  };
}

const HOST_ENUM = ['resolve', 'ppro', 'aeft'];

/** @type {import('./domain').DomainDef} */
module.exports = {
  name: 'netsu_host',
  summary: 'Editing hosts and projects: DaVinci Resolve ("resolve"), Premiere Pro ("ppro") and After Effects ("aeft"). '
    + 'Project registry and offline snapshot (what NetsuRush remembers while the host is closed), the outbox of sends queued while a host is closed, '
    + 'closing/reopening hosts to free RAM and GPU, building timelines in Resolve, and the Adobe CEP bridge. '
    + 'Resolve actions need Resolve Studio open with a project (External scripting = Local); Adobe actions need the NetsuRush panel connected (adobe_status).',
  actions: {
    projects: {
      risk: 'read',
      usage: 'projects() — Resolve projects NetsuRush has seen {name, at, count (rushes), current}',
      channel: 'projects:list',
    },
    project_paths: {
      risk: 'read',
      usage: 'project_paths(names[]) — the union of rush file paths of those projects',
      channel: 'projects:paths', args: (a) => [a.names || []],
      map: (r) => (r && Array.isArray(r.paths) && r.paths.length > 500 ? { ...r, total: r.paths.length, paths: r.paths.slice(0, 500), note: 'Showing 500 paths.' } : r),
    },
    forget_project: {
      risk: 'write',
      usage: 'forget_project(name) — drop a project from the registry (narrows project-scoped search; projects_scan rebuilds it); Resolve itself is untouched',
      channel: 'projects:forget', args: (a) => [a.name],
    },
    projects_scan: {
      risk: 'write', long: true,
      usage: 'projects_scan() — open EVERY Resolve project in turn to record its rushes. Switches the project open in Resolve for the duration: only call when the user is not editing',
      channel: 'projects:scan',
    },
    snapshot_state: {
      risk: 'read',
      usage: 'snapshot_state() — what the offline snapshot holds (project, age, timelines cached)',
      channel: 'snapshot:state',
    },
    snapshot_peek: {
      risk: 'read',
      usage: 'snapshot_peek(kind, name?) — instant read of the cached Resolve data without touching Resolve; null when nothing cached. '
        + 'kind: "mediaPool" | "timelines" | "tree" | "thumbs" | "cuts" (needs name = timeline name) | "state"',
      channel: 'snapshot:peek', args: (a) => [a.kind || 'state', a.name],
      map: (r) => (r == null ? { snapshot: null, note: 'Nothing cached for this kind.' } : capArrays(r, ['clips', 'cuts', 'thumbs', 'timelines'])),
    },
    outbox_list: {
      risk: 'read',
      usage: 'outbox_list() — sends queued while a host was closed {entries [{id, host, kind, label, status: pending|done|error, result?, error?}], settings}',
      channel: 'outbox:list',
    },
    outbox_enqueue: {
      risk: 'write',
      usage: 'outbox_enqueue(host, label, opts) — queue a buildTimeline send for a closed host; applied automatically (after a short delay) when the host comes back. '
        + 'opts has the shape of a timeline build: {name, input, segments [{in, out, inFrame?, outFrame?}], mode?, whole?, videoOnly?}',
      channel: 'outbox:enqueue', args: (a) => [{ host: a.host || 'resolve', kind: 'buildTimeline', label: a.label, opts: a.opts || {} }],
    },
    outbox_remove: {
      risk: 'write',
      usage: 'outbox_remove(id) — remove one queued entry (a pending send is lost)',
      channel: 'outbox:remove', args: (a) => [a.id],
    },
    outbox_clear: {
      risk: 'destructive',
      usage: 'outbox_clear(which?) — "done" (history only) | "pending" (queued sends are lost) | "all" (default)',
      channel: 'outbox:clear', args: (a) => [a.which || 'all'],
    },
    outbox_flush: {
      risk: 'write', long: true,
      usage: 'outbox_flush(host?) — apply the pending entries of a host now (default "resolve"); the host must be open',
      channel: 'outbox:flush', args: (a) => [a.host || 'resolve'],
    },
    outbox_settings: {
      risk: 'read',
      usage: 'outbox_settings() — {enabled, delaySec, target: "new"|"single", targetName, keepDone}',
      channel: 'outbox:settings',
    },
    power_state: {
      risk: 'read',
      usage: 'power_state() — which host NetsuRush closed (host, project, page), whether it is busy',
      channel: 'power:state',
    },
    power_close: {
      risk: 'destructive',
      usage: 'power_close(host?) — CLOSE an editing app to free RAM/GPU. Resolve: saves the project then force-kills the process. Adobe: asks the app to close (it may show its own save dialog). '
        + 'Any unsaved work of the user in that app is at risk: only on explicit user request. Default host "resolve".',
      channel: 'power:close', args: (a) => [a.host || 'resolve'],
    },
    power_reopen: {
      risk: 'write', long: true,
      usage: 'power_reopen() — reopen the host closed by power_close on the same project and page (up to ~2.5 min); then flushes its outbox',
      channel: 'power:reopen',
    },
    power_restart: {
      risk: 'destructive', long: true,
      usage: 'power_restart(host?) — close then reopen a host on the same project (clears session drift). Closes the app: only on explicit user request. Default host "resolve".',
      channel: 'power:restart', args: (a) => [a.host || 'resolve'],
    },
    refresh_now: {
      risk: 'read',
      usage: 'refresh_now() — poll Resolve status immediately instead of waiting for the next poll',
      channel: 'resolve:refreshNow',
    },
    timeline_tree: {
      risk: 'read',
      usage: 'timeline_tree() — Resolve timelines with their Media Pool bin path {timelines [{name, bin, current}], current}',
      channel: 'resolve:timelineTree',
    },
    analyze_timeline_cut: {
      risk: 'write', long: true,
      usage: 'analyze_timeline_cut(timelineName?, model?, threshold?, detectionOptions?, summaryOnly?) — run shot detection on every rush of a Resolve timeline and compute where it would be cut, WITHOUT building. '
        + 'Returns {source, base, clips [{src, path, name, fps, fpsNum, totalFrames, w, h, shots [{startFrame, frames}]}], shots}. '
        + 'model default "transnetv2", threshold 0.5. Feed clips (optionally with shots removed or merged) to build_cut_timeline. summaryOnly returns counts only.',
      channel: 'resolve:analyzeTimelineCut',
      args: (a) => [{ timelineName: a.timelineName, model: a.model, threshold: a.threshold, detectionOptions: a.detectionOptions }],
      map: slimCutAnalysis,
    },
    build_cut_timeline: {
      risk: 'write', long: true,
      usage: 'build_cut_timeline(clips[], name?, source?) — create a NEW Resolve timeline cut at the given shots (through-edits; the original timeline is never modified or deleted). '
        + 'clips: the clips of analyze_timeline_cut ({src, name, fps, totalFrames, w, h, shots [{startFrame, frames}]}); drop a shot from shots to remove it.',
      channel: 'resolve:buildCutTimeline',
      args: (a) => [{ clips: a.clips || [], name: a.name, source: a.source, mode: 'new' }],
    },
    build_timeline_from_blocks: {
      risk: 'write', long: true,
      usage: 'build_timeline_from_blocks(blocks[], name?, mode?, timelineName?, insertion?, dest?, binName?, videoOnly?, markers?) — build a Resolve timeline from ordered shots of SEVERAL source files. '
        + 'blocks: [{filePath, inFrame, outFrame (INCLUSIVE source frames; null/omitted = whole clip), fps}]. mode "new" (default) | "append" (to timelineName, else the open timeline). '
        + 'dest "timeline" (default) | "bin" (file the timeline in Media Pool bin binName). markers: [{index (block index), name, note, color}].',
      channel: 'resolve:buildTimelineFromBlocks',
      args: (a) => [{
        blocks: a.blocks || [], name: a.name, mode: a.mode, timelineName: a.timelineName, insertion: a.insertion,
        dest: a.dest, binName: a.binName, videoOnly: a.videoOnly, markers: a.markers,
      }],
    },
    import_to_bin: {
      risk: 'write',
      usage: 'import_to_bin(paths[], bin) — import files into the Resolve Media Pool bin named `bin` (created under the root if missing; files already in the project are skipped)',
      channel: 'resolve:importToBin', args: (a) => [a.paths || [], a.bin],
    },
    adobe_status: {
      risk: 'read',
      usage: 'adobe_status() — per app (ppro, aeft): installed, running, panelConnected, lastSnapshotAt; plus panel install state',
      channel: 'adobe:status',
    },
    adobe_snapshot: {
      risk: 'read',
      usage: 'adobe_snapshot(app?) — the last project scan pushed by the CEP panel {project, projectPath, activeSequence, rushes, sequences}; both apps when app is omitted',
      channel: 'adobe:snapshot', args: (a) => [a.app],
      map: slimAdobeSnapshot,
    },
    adobe_launch: {
      risk: 'write',
      usage: 'adobe_launch(app) — start Premiere Pro ("ppro") or After Effects ("aeft") if it is not running',
      channel: 'adobe:launch', args: (a) => [a.app],
    },
    adobe_import: {
      risk: 'write', long: true,
      usage: 'adobe_import(app, paths[]) — import files into the open Premiere / After Effects project through the panel',
      channel: 'adobe:import', args: (a) => [{ app: a.app, paths: a.paths || [] }],
    },
    adobe_build_timeline: {
      risk: 'write', long: true,
      usage: 'adobe_build_timeline(app, name, input, segments[], mode?, timelineName?, whole?, videoOnly?, insertion?, fps?) — build or extend a Premiere sequence / AE comp from shots. '
        + 'segments: [{in, out (seconds), inFrame?, outFrame?, path? (source of this shot when it differs from input)}]. mode "new" (default) | "append" (to timelineName, else the open one). '
        + 'insertion: insert|overwrite|replace|fit|above|end|ripple_overwrite.',
      channel: 'adobe:buildTimeline',
      args: (a) => [{
        app: a.app, name: a.name, input: a.input, segments: a.segments || [], mode: a.mode, timelineName: a.timelineName,
        whole: a.whole, videoOnly: a.videoOnly, insertion: a.insertion, fps: a.fps,
      }],
    },
    adobe_diagnose: {
      risk: 'read',
      usage: 'adobe_diagnose() — why the CEP panel does or does not load (install folder, manifest, PlayerDebugMode, CEP log lines)',
      channel: 'adobe:diagnose',
    },
  },
  params: {
    names: { type: 'array', items: { type: 'string' }, description: 'Resolve project names' },
    name: { type: 'string', description: 'Project name (forget_project) or name of the timeline to create' },
    kind: { type: 'string', enum: ['mediaPool', 'timelines', 'tree', 'thumbs', 'cuts', 'state'] },
    host: { type: 'string', enum: HOST_ENUM },
    app: { type: 'string', enum: ['ppro', 'aeft'], description: 'ppro = Premiere Pro, aeft = After Effects' },
    id: { type: 'string', description: 'Outbox entry id' },
    label: { type: 'string', description: 'Human label of a queued send' },
    opts: { type: 'object', description: 'Timeline build options of a queued send' },
    which: { type: 'string', enum: ['all', 'done', 'pending'] },
    timelineName: { type: 'string', description: 'Timeline / sequence name; omitted = the open one' },
    model: { type: 'string', description: 'Shot detection model: transnetv2 | omnishotcut | autoshot | keyframes' },
    threshold: { type: 'number' },
    detectionOptions: { type: 'object' },
    summaryOnly: { type: 'boolean' },
    source: { type: 'string', description: 'Name of the source timeline' },
    clips: {
      type: 'array',
      items: { type: 'object' },
      description: 'Clips as returned by analyze_timeline_cut',
    },
    blocks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          filePath: { type: 'string' }, inFrame: { type: 'number' }, outFrame: { type: ['number', 'null'] }, fps: { type: 'number' },
        },
        required: ['filePath'],
      },
    },
    markers: { type: 'array', items: { type: 'object' } },
    mode: { type: 'string', enum: ['new', 'append'] },
    insertion: { type: 'string', enum: ['insert', 'overwrite', 'replace', 'fit', 'above', 'end', 'ripple_overwrite'] },
    dest: { type: 'string', enum: ['timeline', 'bin'] },
    binName: { type: 'string' },
    bin: { type: 'string', description: 'Media Pool bin name' },
    videoOnly: { type: 'boolean' },
    whole: { type: 'boolean' },
    fps: { type: 'number' },
    input: { type: 'string', description: 'Absolute path of the source clip' },
    paths: { type: 'array', items: { type: 'string' }, description: 'Absolute file paths' },
    segments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          in: { type: 'number' }, out: { type: 'number' }, inFrame: { type: 'number' }, outFrame: { type: 'number' }, path: { type: 'string' },
        },
        required: ['in', 'out'],
      },
    },
    ...WAIT_PARAM,
  },
};
