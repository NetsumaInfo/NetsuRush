// @ts-check
// Collections: persistent folders of SHOTS (core/collections.js). A shot is a segment of a source
// file (path + in/out), not a whole rush.

const { WAIT_PARAM } = require('./domain');
const { folderAddressing, FOLDER_PARAMS } = require('./folders');

const CHANNELS = { list: 'collections:listFolders', save: 'collections:saveFolder' };

/** @param {any} a @returns {string[]} */
const idsOf = (a) => (Array.isArray(a.ids) ? a.ids.map(String) : a.id ? [String(a.id)] : []);

const SHOT_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Absolute path of the source video (required)' },
    name: { type: 'string', description: 'rename_folder: new name; queue_enqueue: label; default_archive_dir: collection name' },
    in: { type: 'number', description: 'In point, seconds' },
    out: { type: 'number', description: 'Out point, seconds' },
    inFrame: { type: 'number', description: 'In frame (inclusive); also the de-duplication key with path' },
    outFrame: { type: 'number', description: 'Out frame (inclusive)' },
    srcFrames: { type: 'number', description: 'Total frames of the source file' },
    fps: { type: 'number' },
    tags: { type: 'array', items: { type: 'string' } },
    label: { type: 'string' },
    rating: { type: 'number', description: '0-5' },
    note: { type: 'string' },
  },
  required: ['path'],
};

/** @type {import('./domain').DomainDef} */
module.exports = {
  name: 'netsu_collections',
  summary: 'NetsuRush Collections: named libraries of SHOTS (segments of source files, each with in/out points, '
    + 'tags, label, rating, note), organised in a folder tree. Folders are named by PATH ("Anime/OP", "" = root; missing '
    + 'ones are created by moves) or by id. Unlike netsu_library (whole imported rushes), a collection '
    + 'item is a segment. Shots reference files by absolute path, so a moved file becomes "offline" until relinked. '
    + 'A collection can be archived: each shot is exported as an independent file in a storage folder.',
  actions: {
    list: {
      risk: 'read',
      usage: 'list(query?, folder|folderId?, limit?) — collections {id, name, count, tags, collTags, description, folderId, archived}',
      run: async (a, ctx) => {
        const inFolder = await folderAddressing(ctx, CHANNELS).target(a);
        const items = await ctx.invoke('collections:list', []);
        let out = /** @type {any[]} */ (Array.isArray(items) ? items : []);
        if (inFolder !== undefined) out = out.filter((c) => (c.folderId || null) === inFolder);
        if (a.query) {
          const q = String(a.query).toLowerCase();
          out = out.filter((c) => String(c.name || '').toLowerCase().includes(q) || String(c.description || '').toLowerCase().includes(q));
        }
        const total = out.length;
        const limit = Number(a.limit) > 0 ? Number(a.limit) : 100;
        return {
          total,
          collections: out.slice(0, limit).map((c) => ({
            id: c.id, name: c.name, count: c.count, folderId: c.folderId, description: c.description,
            collTags: c.collTags, tags: c.tags, archived: c.archived, autoSync: c.autoSync, updatedAt: c.updatedAt,
          })),
          ...(total > limit ? { note: `Showing ${limit} of ${total}; pass limit or query.` } : {}),
        };
      },
    },
    load: {
      risk: 'read',
      usage: 'load(id, limit?, offset?) — full collection incl. shots [{id, path, name, in, out, inFrame, outFrame, fps, tags, label, rating, note}]',
      channel: 'collections:load', args: (a) => [a.id],
      map: (c, a) => {
        if (!c) return { ok: false, error: 'collection not found' };
        const shots = Array.isArray(c.shots) ? c.shots : [];
        const offset = Number(a.offset) > 0 ? Number(a.offset) : 0;
        const limit = Number(a.limit) > 0 ? Number(a.limit) : 200;
        return {
          ...c, shots: shots.slice(offset, offset + limit), totalShots: shots.length,
          ...(shots.length > offset + limit ? { note: `Showing shots ${offset}-${offset + limit} of ${shots.length}; pass offset/limit.` } : {}),
        };
      },
    },
    folders: {
      risk: 'read',
      usage: 'folders() — collection folder tree {id, name, parentId, path}',
      run: async (_a, ctx) => ({ folders: await folderAddressing(ctx, CHANNELS).withPaths() }),
    },
    tags: { risk: 'read', usage: 'tags() — every tag used by collections and shots', channel: 'collections:allTags', map: (t) => ({ tags: t }) },
    offline: {
      risk: 'write',
      usage: 'offline(id) — sources of a collection whose file is missing {path, name, count}; also silently relinks exact content twins found elsewhere',
      channel: 'collections:offline', args: (a) => [a.id],
    },
    default_archive_dir: { risk: 'read', usage: 'default_archive_dir(name) — default storage folder for archiving a collection of that name', channel: 'collections:defaultArchiveDir', args: (a) => [a.name] },
    save: {
      risk: 'write',
      usage: 'save(collection {id?, name?, color?, description?, tags?, folderId?}, folder?) — create (no id) or update metadata; shots are never touched; omitted fields keep their value; folder (a path) files it, creating the folder; returns {id}',
      run: async (a, ctx) => {
        const c = { ...(a.collection || {}) };
        const dest = await folderAddressing(ctx, CHANNELS).target({ folder: a.folder, folderId: c.folderId }, { create: true });
        if (dest !== undefined) c.folderId = dest;
        return ctx.invoke('collections:save', [c]);
      },
    },
    add_shots: {
      risk: 'write',
      usage: 'add_shots(id, shots[]) — add shots (deduplicated by path + inFrame); each shot needs path plus in/out seconds and ideally inFrame/outFrame/fps',
      channel: 'collections:addShots', args: (a) => [a.id, a.shots || []],
    },
    update_shot: {
      risk: 'write',
      usage: 'update_shot(id, shotId, patch) — patch any of tags, label, rating(0-5), note, in, out, inFrame, outFrame, fps, name, path; null clears a field',
      channel: 'collections:updateShot', args: (a) => [a.id, a.shotId, a.patch || {}],
    },
    remove_shot: { risk: 'write', usage: 'remove_shot(id, shotId) — remove a shot (source file untouched)', channel: 'collections:removeShot', args: (a) => [a.id, a.shotId] },
    reorder: {
      risk: 'write',
      usage: 'reorder(id, shotIds[]) — manual shot order, first shown first (under the default "recently added" sort; rewrites addedAt). Unlisted shots follow',
      channel: 'collections:reorderShots', args: (a) => [a.id, a.shotIds || []],
    },
    update_shots: {
      risk: 'write',
      usage: 'update_shots(id, updates[{shotId, patch}]) — patch many shots in one call (tags, label, rating, note, bounds…)',
      run: async (a, ctx) => {
        const updates = Array.isArray(a.updates) ? a.updates : [];
        const failed = [];
        for (const u of updates) {
          const r = await ctx.invoke('collections:updateShot', [a.id, u && u.shotId, (u && u.patch) || {}]);
          if (!r || r.ok === false) failed.push({ shotId: u && u.shotId, error: r && r.error });
        }
        return { ok: failed.length === 0, updated: updates.length - failed.length, ...(failed.length ? { failed } : {}) };
      },
    },
    move: {
      risk: 'write',
      usage: 'move(ids[]|id, folder|folderId) — move collections into a folder (created when given as a path; null/"" = root)',
      run: async (a, ctx) => {
        const ids = idsOf(a);
        if (!ids.length) return { ok: false, error: 'ids is required' };
        const dest = await folderAddressing(ctx, CHANNELS).target(a, { create: true });
        if (dest === undefined) return { ok: false, error: 'folder or folderId is required (null = root)' };
        const failed = [];
        for (const id of ids) {
          const r = await ctx.invoke('collections:move', [id, dest]);
          if (!r || r.ok === false) failed.push({ id, error: r && r.error });
        }
        return { ok: failed.length === 0, moved: ids.length - failed.length, folderId: dest, ...(failed.length ? { failed } : {}) };
      },
    },
    create_folder: {
      risk: 'write',
      usage: 'create_folder(folder) — create a folder path, parents included; returns {folderId, path}',
      run: async (a, ctx) => {
        if (typeof a.folder !== 'string' || !a.folder.trim()) return { ok: false, error: 'folder (a path) is required' };
        return { folderId: await folderAddressing(ctx, CHANNELS).ensure(a.folder), path: a.folder };
      },
    },
    rename_folder: {
      risk: 'write',
      usage: 'rename_folder(folder|folderId, name) — rename a folder',
      run: async (a, ctx) => {
        const id = await folderAddressing(ctx, CHANNELS).target(a);
        if (!id) return { ok: false, error: 'folder or folderId of an existing folder is required' };
        if (!String(a.name || '').trim()) return { ok: false, error: 'name is required' };
        // Paths address folders: a "/" in a name would forge a level nothing can reach.
        if (/[\\/]/.test(String(a.name))) return { ok: false, error: 'a folder name cannot contain "/" or "\\"' };
        return ctx.invoke('collections:saveFolder', [{ id, name: String(a.name).trim() }]);
      },
    },
    move_folder: {
      risk: 'write',
      usage: 'move_folder(folder|folderId, to|toId) — move a folder (and everything in it) under another folder; to "" = root',
      run: async (a, ctx) => {
        const folders = folderAddressing(ctx, CHANNELS);
        const id = await folders.target(a);
        if (!id) return { ok: false, error: 'folder or folderId of an existing folder is required' };
        const parentId = await folders.target(a, { create: true, pathKey: 'to', idKey: 'toId' });
        if (parentId === undefined) return { ok: false, error: 'to (a path, "" = root) or toId is required' };
        if (parentId && await folders.isWithin(id, parentId)) return { ok: false, error: 'a folder cannot move into itself or one of its sub-folders' };
        return ctx.invoke('collections:saveFolder', [{ id, parentId }]);
      },
    },
    move_shots: {
      risk: 'write',
      usage: 'move_shots(id, toId, shotIds[], copy?) — move shots to another collection with their tags, label, rating and note (copy keeps them in the source too); a shot already in the target is not duplicated',
      run: async (a, ctx) => {
        if (!a.toId || a.toId === a.id) return { ok: false, error: 'toId must be another collection' };
        const src = await ctx.invoke('collections:load', [a.id]);
        if (!src) return { ok: false, error: 'source collection not found' };
        const dst = await ctx.invoke('collections:load', [a.toId]);
        if (!dst) return { ok: false, error: 'target collection not found' };
        const want = new Set((Array.isArray(a.shotIds) ? a.shotIds : []).map(String));
        const shots = (Array.isArray(src.shots) ? src.shots : []).filter((/** @type {any} */ s) => want.has(String(s.id)));
        const notFound = [...want].filter((id) => !shots.some((/** @type {any} */ s) => String(s.id) === id));
        if (!shots.length) return { ok: false, error: 'none of these shots is in the source collection', notFound };
        const copies = shots.map((/** @type {any} */ s) => { const { id: _drop, ...rest } = s; return rest; });
        const added = await ctx.invoke('collections:addShots', [a.toId, copies]);
        if (!added || added.ok === false) return { ok: false, error: (added && added.error) || 'could not add the shots' };
        let removed = 0;
        if (!a.copy) {
          for (const s of shots) {
            const r = await ctx.invoke('collections:removeShot', [a.id, s.id]);
            if (r && r.ok !== false) removed += 1;
          }
        }
        return { ok: true, added: added.added || 0, alreadyThere: shots.length - (added.added || 0), removed, ...(notFound.length ? { notFound } : {}) };
      },
    },
    relink_path: { risk: 'write', usage: 'relink_path(id, oldPath, newPath) — repoint every shot of a moved source file', channel: 'collections:relinkPath', args: (a) => [a.id, a.oldPath, a.newPath] },
    relink_dir: { risk: 'write', usage: 'relink_dir(id, dir) — scan a folder (recursive) and repoint every offline source found there', channel: 'collections:relinkDir', args: (a) => [a.id, a.dir] },
    delete: { risk: 'destructive', usage: 'delete(id) — delete a collection and all its shot references (source files untouched, no undo)', channel: 'collections:delete', args: (a) => [a.id] },
    delete_folder: {
      risk: 'destructive',
      usage: 'delete_folder(folder|folderId) — delete a folder; its sub-folders and collections move up to the parent',
      run: async (a, ctx) => {
        const id = await folderAddressing(ctx, CHANNELS).target(a);
        if (!id) return { ok: false, error: 'folder or folderId of an existing folder is required' };
        return ctx.invoke('collections:deleteFolder', [id]);
      },
    },
    archive: {
      risk: 'destructive', long: true,
      usage: 'archive(id, profile, dir?, autoSync?, process?) — export every shot as an independent file in dir (remux or re-encode per profile); writes many files and may overwrite/prune earlier archive files; dir defaults to the previous archive folder',
      channel: 'collections:archive', args: (a) => [a.id, { profile: a.profile, dir: a.dir, autoSync: a.autoSync, process: a.process }],
    },
    queue_state: { risk: 'read', usage: 'queue_state() — deferred archive queue entries {id, collId, mode, status}', channel: 'collections:queueState' },
    queue_enqueue: {
      risk: 'write',
      usage: 'queue_enqueue(id, mode?, name?, opts?) — queue an archive to run now or when the machine is idle; opts = archive options {profile, dir, autoSync, process}',
      channel: 'collections:queueEnqueue', args: (a) => [a.id, { mode: a.mode, name: a.name, opts: a.opts }],
    },
    queue_cancel: { risk: 'write', usage: 'queue_cancel(entryId) — drop a pending queue entry', channel: 'collections:queueCancel', args: (a) => [a.entryId] },
  },
  params: {
    shotIds: { type: 'array', items: { type: 'string' }, description: 'reorder: shot ids in the wanted order' },
    updates: { type: 'array', items: { type: 'object', properties: { shotId: { type: 'string' }, patch: { type: 'object' } } }, description: 'update_shots: one patch per shot' },
    id: { type: 'string', description: 'Collection id' },
    ids: { type: 'array', items: { type: 'string' }, description: 'move: collection ids' },
    toId: { type: ['string', 'null'], description: 'move_shots: target collection id; move_folder: destination parent folder id (null = root)' },
    to: { type: 'string', description: 'move_folder: destination parent folder path ("" = root)' },
    copy: { type: 'boolean', description: 'move_shots: keep the shots in the source collection too' },
    collection: {
      type: 'object',
      description: 'Collection metadata for save',
      properties: {
        id: { type: 'string' }, name: { type: 'string' }, color: { type: ['string', 'null'] }, description: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } }, folderId: { type: ['string', 'null'] },
      },
    },
    shots: { type: 'array', items: SHOT_SCHEMA, description: 'Shots to add' },
    shotId: { type: 'string' },
    patch: { type: 'object', description: 'Fields of a shot to change (see update_shot)' },
    ...FOLDER_PARAMS,
    oldPath: { type: 'string' },
    newPath: { type: 'string' },
    dir: { type: 'string', description: 'Absolute folder path' },
    name: { type: 'string' },
    profile: {
      type: 'object',
      description: 'Export profile for archive: {id, name, workflow:"video_remux"|"video_encode", container:"mp4"|"mkv"|"mov", codec, audioMode, mergeEnabled:false, encoderMode?, speed?}. workflow "video_remux" = lossless copy (keyframe-snapped).',
    },
    autoSync: { type: 'boolean', description: 'Keep the archive in sync when the collection changes' },
    process: { type: 'object', description: 'Optional processing pass (upscale etc.) applied to each archived shot; same settings as the Processing panel' },
    mode: { type: 'string', enum: ['now', 'idle'] },
    opts: { type: 'object', description: 'Archive options for queue_enqueue' },
    entryId: { type: 'string' },
    query: { type: 'string', description: 'Case-insensitive filter on name/description' },
    limit: { type: 'number' },
    offset: { type: 'number' },
    ...WAIT_PARAM,
  },
};
