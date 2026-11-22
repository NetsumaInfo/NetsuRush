// @ts-check
// Media library: the imported rushes that feed the derush (core/library.js), independent of the
// Resolve Media Pool. Removing an entry never touches the file on disk.
//
// Folders are addressed by path or by id (folders.js): sorting a library is many moves into a tree
// the agent builds as it goes, so every move takes many ids and creates its destination.

const { WAIT_PARAM } = require('./domain');
const { folderAddressing, FOLDER_PARAMS } = require('./folders');

const CHANNELS = { list: 'library:listFolders', save: 'library:saveFolder' };

/** @param {any} s */
const lower = (s) => String(s || '').toLowerCase();

/** @param {any} a @returns {string[]} */
const idsOf = (a) => (Array.isArray(a.ids) ? a.ids.map(String) : a.id ? [String(a.id)] : []);

/** @type {import('./domain').DomainDef} */
module.exports = {
  name: 'netsu_library',
  summary: 'NetsuRush media library (imported rushes, independent of Resolve), sorted in a folder tree. Items carry an '
    + 'absolute file path usable by every other netsu_* tool. Folders are named by PATH ("Anime/OP", "" = root; missing '
    + 'ones are created by moves and imports) or by id. Removing an item never deletes the file.',
  actions: {
    list: {
      risk: 'read',
      usage: 'list(query?, folder|folderId?, limit?) — items {id, name, path, folderId, duration, fps, resolution, format}; a folder filter lists that folder only',
      run: async (a, ctx) => {
        const folders = folderAddressing(ctx, CHANNELS);
        const inFolder = await folders.target(a);
        let out = /** @type {any[]} */ (await ctx.invoke('library:list', []));
        out = Array.isArray(out) ? out : [];
        if (inFolder !== undefined) out = out.filter((i) => (i.folderId || null) === inFolder);
        if (a.query) out = out.filter((i) => lower(i.name).includes(lower(a.query)) || lower(i.path).includes(lower(a.query)));
        const total = out.length;
        const limit = Number(a.limit) > 0 ? Number(a.limit) : 200;
        return { total, items: out.slice(0, limit), ...(total > limit ? { note: `Showing ${limit} of ${total}; pass limit or query.` } : {}) };
      },
    },
    folders: {
      risk: 'read',
      usage: 'folders() — folder tree {id, name, parentId, path}',
      run: async (_a, ctx) => ({ folders: await folderAddressing(ctx, CHANNELS).withPaths() }),
    },
    offline: { risk: 'read', usage: 'offline() — items whose file is missing on disk', channel: 'library:offline', map: (r) => (Array.isArray(r) ? { items: r } : r) },
    create_folder: {
      risk: 'write',
      usage: 'create_folder(folder) — create a folder path, parents included; returns {folderId, path}',
      run: async (a, ctx) => {
        if (typeof a.folder !== 'string' || !a.folder.trim()) return { ok: false, error: 'folder (a path) is required' };
        const folderId = await folderAddressing(ctx, CHANNELS).ensure(a.folder);
        return { folderId, path: a.folder };
      },
    },
    move: {
      risk: 'write',
      usage: 'move(ids[]|id, folder|folderId) — move items into a folder (created when given as a path; null/"" = root)',
      run: async (a, ctx) => {
        const ids = idsOf(a);
        if (!ids.length) return { ok: false, error: 'ids is required' };
        const dest = await folderAddressing(ctx, CHANNELS).target(a, { create: true });
        if (dest === undefined) return { ok: false, error: 'folder or folderId is required (null = root)' };
        const failed = [];
        for (const id of ids) {
          const r = await ctx.invoke('library:move', [id, dest]);
          if (!r || r.ok === false) failed.push({ id, error: r && r.error });
        }
        return { ok: failed.length === 0, moved: ids.length - failed.length, folderId: dest, ...(failed.length ? { failed } : {}) };
      },
    },
    rename_folder: {
      risk: 'write',
      usage: 'rename_folder(folder|folderId, name) — rename a folder',
      run: async (a, ctx) => {
        const id = await folderAddressing(ctx, CHANNELS).target(a);
        if (!id) return { ok: false, error: 'folder or folderId of an existing folder is required' };
        if (!String(a.name || '').trim()) return { ok: false, error: 'name is required' };
        return ctx.invoke('library:saveFolder', [{ id, name: String(a.name).trim() }]);
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
        return ctx.invoke('library:saveFolder', [{ id, parentId }]);
      },
    },
    add_paths: {
      risk: 'write', long: true,
      usage: 'add_paths(paths[], folder|folderId?) — import files or folders (folders are scanned recursively)',
      run: async (a, ctx) => {
        const dest = await folderAddressing(ctx, CHANNELS).target(a, { create: true });
        return ctx.invoke('library:addPaths', [a.paths || [], dest || null]);
      },
    },
    add_dir: {
      risk: 'write', long: true,
      usage: 'add_dir(dir, folder|folderId?) — import a disk folder, recreating its sub-folders as library folders',
      run: async (a, ctx) => {
        const dest = await folderAddressing(ctx, CHANNELS).target(a, { create: true });
        return ctx.invoke('library:addDir', [a.dir, dest || null]);
      },
    },
    remove: {
      risk: 'write',
      usage: 'remove(ids[]) — remove items from the library (files untouched); returns an undo token for restore',
      channel: 'library:removeMany', args: (a) => [idsOf(a)],
    },
    restore: { risk: 'write', usage: 'restore(undo) — undo a remove or delete_folder', channel: 'library:restore', args: (a) => [a.undo] },
    delete_folder: {
      risk: 'destructive',
      usage: 'delete_folder(folder|folderId, withItems?) — delete a folder; its items and sub-folders move up to the parent, or with withItems the whole sub-tree and its items are removed (files untouched); returns an undo token for restore',
      run: async (a, ctx) => {
        const id = await folderAddressing(ctx, CHANNELS).target(a);
        if (!id) return { ok: false, error: 'folder or folderId of an existing folder is required' };
        return ctx.invoke('library:deleteFolder', [id, !!a.withItems]);
      },
    },
    relink_path: { risk: 'write', usage: 'relink_path(oldPath, newPath) — repoint a moved file', channel: 'library:relinkPath', args: (a) => [a.oldPath, a.newPath] },
    relink_dir: { risk: 'write', usage: 'relink_dir(dir) — find missing files inside a folder', channel: 'library:relinkDir', args: (a) => [a.dir] },
  },
  params: {
    id: { type: 'string' },
    ids: { type: 'array', items: { type: 'string' } },
    paths: { type: 'array', items: { type: 'string' }, description: 'Absolute file or folder paths' },
    dir: { type: 'string', description: 'Absolute folder path on disk' },
    ...FOLDER_PARAMS,
    to: { type: 'string', description: 'move_folder: destination parent folder path ("" = root)' },
    toId: { type: ['string', 'null'], description: 'move_folder: destination parent folder id (null = root)' },
    name: { type: 'string', description: 'rename_folder: new name (no "/")' },
    withItems: { type: 'boolean' },
    undo: { type: 'object', description: 'Undo token returned by remove / delete_folder' },
    oldPath: { type: 'string' },
    newPath: { type: 'string' },
    query: { type: 'string', description: 'Case-insensitive filter on name and path' },
    limit: { type: 'number' },
    ...WAIT_PARAM,
  },
};
