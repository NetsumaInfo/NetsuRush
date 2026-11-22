// @ts-check
// Resolve Media Pool operations behind the agent's `resolve_media_pool` tool. Kept apart from the
// tool table so they run against a fake media pool in tests: every Resolve call goes through the
// proxy and is awaited, and nothing here needs a live Resolve.
//
// Bins are addressed by PATH from the root ("Rushes/Episode 1"; "" = root) so the agent can sort a
// whole tree without holding Resolve object handles. Clips are addressed by file path or by the
// unique id list_clips returns (a generated clip — timeline, compound — has no file path).

const { t } = require('../../i18n');

const ok = (/** @type {any} */ data) => ({ ok: true, ...data });

/** @param {any} p */
function binParts(p) {
  return String(p == null ? '' : p).split('/').map((s) => s.trim()).filter(Boolean);
}

/** @param {any} mp MediaPool proxy @param {any} root its root Folder */
function createMediaPoolOps(mp, root) {
  /** @param {any} parent @param {string} name */
  async function child(parent, name) {
    let loose = null;
    for (const sub of (await parent.GetSubFolderList()) || []) {
      const n = String(await sub.GetName());
      if (n === name) return sub;
      if (!loose && n.toLowerCase() === name.toLowerCase()) loose = sub;
    }
    return loose;
  }

  /// Walks a bin path. `create` adds the missing bins; AddSubFolder accepts a duplicate name and
  /// would make a second bin, so each level is looked up first.
  /** @param {any} p @param {boolean} [create] */
  async function bin(p, create = false) {
    let cur = root;
    for (const name of binParts(p)) {
      let next = await child(cur, name);
      if (!next && create) next = await mp.AddSubFolder(cur, name);
      if (!next) throw new Error(t('agentBinMissing', { path: String(p) }));
      cur = next;
    }
    return cur;
  }

  /** @param {any} from @param {string} prefix @param {boolean} recursive */
  async function clipsUnder(from, prefix, recursive) {
    /** @type {{item:any, bin:string}[]} */
    const out = [];
    /** @param {any} folder @param {string} at */
    const walk = async (folder, at) => {
      for (const item of (await folder.GetClipList()) || []) out.push({ item, bin: at });
      if (!recursive) return;
      for (const sub of (await folder.GetSubFolderList()) || []) await walk(sub, (at ? at + '/' : '') + (await sub.GetName()));
    };
    await walk(from, prefix);
    return out;
  }

  /// Clips named by file path (case-insensitive, Windows paths) or unique id. The ones not found are
  /// reported so the agent does not believe a partial move was complete.
  /** @param {any} a */
  async function pick(a) {
    const wantPaths = new Set((a.paths || (a.path ? [a.path] : [])).map((/** @type {any} */ p) => String(p).toLowerCase()));
    const wantIds = new Set((a.ids || (a.id ? [a.id] : [])).map(String));
    if (!wantPaths.size && !wantIds.size) throw new Error(t('agentNoClipsGiven'));
    const items = [];
    const seen = new Set();
    for (const { item } of await clipsUnder(root, '', true)) {
      let fp = '';
      let uid = '';
      try { fp = String((await item.GetClipProperty('File Path')) || '').toLowerCase(); } catch { /* generated clip */ }
      if (wantIds.size) { try { uid = String(await item.GetUniqueId()); } catch { /* older Resolve */ } }
      const byPath = !!fp && wantPaths.has(fp);
      const byId = !!uid && wantIds.has(uid);
      if (!byPath && !byId) continue;
      items.push(item);
      if (byPath) seen.add(fp);
      if (byId) seen.add(uid);
    }
    const missing = [...wantPaths, ...wantIds].filter((k) => !seen.has(k));
    return { items, missing };
  }

  /** @param {any} data @param {string[]} missing */
  const withMissing = (data, missing) => ok(missing.length ? { ...data, notFound: missing } : data);

  /** @param {any} a */
  async function run(a) {
    switch (a.action) {
      case 'list_folders': {
        /** @type {{path:string, clips:number, id?:string}[]} */
        const folders = [];
        /** @param {any} folder @param {string} at */
        const walk = async (folder, at) => {
          /** @type {{path:string, clips:number, id?:string}} */
          const row = { path: at, clips: ((await folder.GetClipList()) || []).length };
          try { row.id = String(await folder.GetUniqueId()); } catch { /* older Resolve */ }
          folders.push(row);
          for (const sub of (await folder.GetSubFolderList()) || []) await walk(sub, (at ? at + '/' : '') + (await sub.GetName()));
        };
        await walk(root, '');
        return ok({ folders });
      }
      case 'create_folder':
      case 'add_subfolder': {
        const target = a.folder !== undefined ? a.folder : a.name;
        if (!binParts(target).length) throw new Error(t('agentBinMissing', { path: String(target || '') }));
        await bin(target, true);
        return ok({ folder: binParts(target).join('/') });
      }
      case 'set_current_folder': {
        const target = a.folder !== undefined ? a.folder : a.name;
        return ok({ set: !!(await mp.SetCurrentFolder(await bin(target))), folder: binParts(target).join('/') });
      }
      case 'move_clips': {
        const { items, missing } = await pick(a);
        if (!items.length) return { ok: false, error: t('agentClipsNotFound'), notFound: missing };
        const dest = await bin(a.folder, true);
        const moved = !!(await mp.MoveClips(items, dest));
        if (!moved) return { ok: false, error: t('agentResolveRefused'), notFound: missing };
        return withMissing({ moved: items.length, folder: binParts(a.folder).join('/') }, missing);
      }
      case 'move_folder': {
        const from = binParts(a.folder);
        const to = binParts(a.to);
        if (!from.length) throw new Error(t('agentBinRootMove'));
        // A bin dropped into itself or one of its descendants would vanish from the tree.
        if (to.length >= from.length && from.every((s, i) => s.toLowerCase() === to[i].toLowerCase())) {
          throw new Error(t('agentBinIntoItself'));
        }
        const src = await bin(a.folder);
        const dest = await bin(a.to, true);
        if (!(await mp.MoveFolders([src], dest))) return { ok: false, error: t('agentResolveRefused') };
        return ok({ folder: [...to, from[from.length - 1]].join('/') });
      }
      case 'import': {
        const previous = a.folder ? await mp.GetCurrentFolder() : null;
        if (a.folder) await mp.SetCurrentFolder(await bin(a.folder, true));
        try {
          const items = await mp.ImportMedia(a.paths || []);
          return ok({ count: items ? items.length : 0, folder: binParts(a.folder).join('/') });
        } finally {
          if (previous) { try { await mp.SetCurrentFolder(previous); } catch { /* bin gone */ } }
        }
      }
      case 'rename_clip': {
        const name = String(a.name || '').trim();
        if (!name) throw new Error(t('agentEmptyName'));
        const { items } = await pick(a);
        if (items.length !== 1) return { ok: false, error: items.length ? t('agentClipAmbiguous') : t('agentClipsNotFound') };
        return ok({ renamed: !!(await items[0].SetName(name)) });
      }
      case 'set_clip_color': {
        const { items, missing } = await pick(a);
        let colored = 0;
        for (const item of items) {
          if (a.color ? await item.SetClipColor(String(a.color)) : await item.ClearClipColor()) colored += 1;
        }
        return withMissing({ colored }, missing);
      }
      case 'append_to_timeline': {
        const { items, missing } = await pick(a);
        const r = await mp.AppendToTimeline(items);
        return withMissing({ appended: Array.isArray(r) ? r.length : !!r }, missing);
      }
      case 'create_empty_timeline': return ok({ created: !!(await mp.CreateEmptyTimeline(String(a.name || 'Timeline'))) });
      case 'create_timeline_from_clips': {
        const { items, missing } = await pick(a);
        return withMissing({ created: !!(await mp.CreateTimelineFromClips(String(a.name || 'Timeline'), items)) }, missing);
      }
      case 'delete_clips': {
        const { items, missing } = await pick(a);
        return withMissing({ deleted: items.length ? !!(await mp.DeleteClips(items)) : false }, missing);
      }
      case 'delete_folders': {
        const list = Array.isArray(a.folders) ? a.folders : (a.folder !== undefined ? [a.folder] : []);
        if (!list.length) throw new Error(t('agentBinMissing', { path: '' }));
        if (list.some((/** @type {any} */ f) => !binParts(f).length)) throw new Error(t('agentBinRootDelete'));
        const bins = [];
        for (const f of list) bins.push(await bin(f));
        return ok({ deleted: !!(await mp.DeleteFolders(bins)) });
      }
      case 'list_clips':
      case undefined: {
        const from = a.folder ? await bin(a.folder) : root;
        const clips = [];
        for (const { item, bin: at } of await clipsUnder(from, binParts(a.folder).join('/'), a.recursive !== false)) {
          try {
            /** @type {any} */
            const c = { name: await item.GetName(), path: await item.GetClipProperty('File Path'), bin: at };
            try { c.id = String(await item.GetUniqueId()); } catch { /* older Resolve */ }
            try { const col = await item.GetClipColor(); if (col) c.color = col; } catch { /* older Resolve */ }
            clips.push(c);
          } catch { /* unreadable clip */ }
        }
        return ok({ clips });
      }
      default: throw new Error(t('agentUnknownAction', { action: String(a.action) }));
    }
  }

  return { run, bin, pick };
}

const ACTIONS = ['list_folders', 'list_clips', 'create_folder', 'add_subfolder', 'move_clips', 'move_folder', 'import',
  'rename_clip', 'set_clip_color', 'set_current_folder', 'append_to_timeline', 'create_empty_timeline',
  'create_timeline_from_clips', 'delete_clips', 'delete_folders'];
const READ_ACTIONS = new Set(['list_clips', 'list_folders']);
const DESTRUCTIVE_ACTIONS = new Set(['delete_clips', 'delete_folders']);

/// An action the table does not know is destructive: the gate never waves through what it cannot classify.
/** @param {any} a @returns {'read'|'write'|'destructive'} */
function mediaPoolRisk(a) {
  const action = a && a.action;
  if (!action || READ_ACTIONS.has(action)) return 'read';
  if (!ACTIONS.includes(action) || DESTRUCTIVE_ACTIONS.has(action)) return 'destructive';
  return 'write';
}

module.exports = { createMediaPoolOps, mediaPoolRisk, binParts, ACTIONS };
