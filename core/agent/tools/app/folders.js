// @ts-check
// Folder addressing shared by netsu_library and netsu_collections. Both stores keep a flat list of
// {id, name, parentId}; an agent thinks in paths ("Anime/OP"), so every write that targets a folder
// takes either a path (created when missing) or an id that must exist. An unknown id used to be
// stored as is, and the item vanished from every view of the tree.

/** @typedef {{id:string, name:string, parentId?:string|null}} Folder */

/** @param {any} p */
function pathParts(p) {
  return String(p == null ? '' : p).split('/').map((s) => s.trim()).filter(Boolean);
}

/** @param {Folder[]} folders */
function withPaths(folders) {
  const byId = new Map(folders.map((f) => [f.id, f]));
  /** @param {Folder} f */
  const pathOf = (f) => {
    const names = [];
    const seen = new Set();
    /** @type {Folder|undefined} */
    let cur = f;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      names.unshift(cur.name);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return names.join('/');
  };
  return folders.map((f) => ({ id: f.id, name: f.name, parentId: f.parentId || null, path: pathOf(f) }));
}

/**
 * @param {{ invoke:(channel:string, args?:any[])=>Promise<any> }} ctx
 * @param {{ list:string, save:string }} channels
 */
function folderAddressing(ctx, channels) {
  /** @returns {Promise<Folder[]>} */
  async function list() {
    const r = await ctx.invoke(channels.list, []);
    return Array.isArray(r) ? r : [];
  }

  /// Walks a path from the root, creating each missing level. Names compare case-insensitively:
  /// the library refuses two siblings that differ only by case.
  /** @param {any} p @returns {Promise<string|null>} */
  async function ensure(p) {
    const all = await list();
    /** @type {string|null} */
    let parentId = null;
    for (const name of pathParts(p)) {
      if (name.includes('\\')) throw new Error(`folder names cannot contain "\\": ${name}`);
      const found = all.find((f) => (f.parentId || null) === parentId && String(f.name).toLowerCase() === name.toLowerCase());
      if (found) { parentId = found.id; continue; }
      const r = await ctx.invoke(channels.save, [{ name, parentId }]);
      if (!r || r.ok === false || !r.id) throw new Error((r && r.error) || `could not create folder "${name}"`);
      all.push({ id: r.id, name, parentId });
      parentId = r.id;
    }
    return parentId;
  }

  /** @param {string} p @param {Folder[]} all */
  function byPath(p, all) {
    const want = pathParts(p).join('/').toLowerCase();
    const matches = withPaths(all).filter((f) => f.path.toLowerCase() === want);
    return matches.length === 1 ? matches[0].id : null;
  }

  /// The folder an action targets: `folder` (a path, "" = root) wins over `folderId` (null = root).
  /// A folderId that is not an id is still accepted when it is the exact path of one folder, since
  /// models pass names where ids are expected. `create` makes a missing path; without it a missing
  /// folder is an error. Returns undefined when the input names neither.
  /** @param {any} a @param {{ create?:boolean, pathKey?:string, idKey?:string }} [opts] @returns {Promise<string|null|undefined>} */
  async function target(a, opts = {}) {
    const pathKey = opts.pathKey || 'folder';
    const idKey = opts.idKey || 'folderId';
    if (typeof a[pathKey] === 'string') {
      if (!pathParts(a[pathKey]).length) return null;
      if (opts.create) return ensure(a[pathKey]);
      const id = byPath(a[pathKey], await list());
      if (!id) throw new Error(`no folder at path "${a[pathKey]}" (see the folders action)`);
      return id;
    }
    if (a[idKey] === undefined) return undefined;
    if (a[idKey] === null || a[idKey] === '') return null;
    const id = String(a[idKey]);
    const all = await list();
    if (all.some((f) => f.id === id)) return id;
    const found = byPath(id, all);
    if (found) return found;
    throw new Error(`unknown ${idKey} "${id}": take an id from the folders action, or pass ${pathKey} as a path ("A/B")`);
  }

  /// True when `candidate` is `ancestor` or sits below it: moving a folder there would make a cycle.
  /** @param {string} ancestor @param {string|null} candidate */
  async function isWithin(ancestor, candidate) {
    const byId = new Map((await list()).map((f) => [f.id, f]));
    const seen = new Set();
    let cur = candidate;
    while (cur && !seen.has(cur)) {
      if (cur === ancestor) return true;
      seen.add(cur);
      const f = byId.get(cur);
      cur = f ? f.parentId || null : null;
    }
    return false;
  }

  return { list, ensure, target, isWithin, withPaths: async () => withPaths(await list()) };
}

/// Parameters every domain with folders accepts.
const FOLDER_PARAMS = {
  folderId: { type: ['string', 'null'], description: 'Folder id from the folders action; null = root' },
  folder: { type: 'string', description: 'Folder PATH from the root, "/"-separated, e.g. "Anime/OP" ("" = root). Missing folders are created. Wins over folderId.' },
};

module.exports = { folderAddressing, pathParts, withPaths, FOLDER_PARAMS };
