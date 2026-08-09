// @ts-check
// core/resolve.js
// Opérations Media Pool / statut : l'objet Resolve vient du pont Python externe (resolve-proxy)
// au lieu d'un binding natif.
// Chaque appel Resolve est déjà `await`é → marche que le binding renvoie une valeur directe (FFI) ou
// une promesse (pont). NOTE perf : le parcours du Media Pool fait ~6 appels/clip = round-trips stdio ;
// optimisable via un agrégat Python (list_media_pool) si les gros pools rament.

const path = require("path");
const fs = require("fs");
const { yieldLoop } = require("./config");
const { RUSH_EXTS, MEDIA_EXTS, isMediaPath } = require("./utils");
const { getResolve, bridge } = require("./resolve-proxy");
const { t } = require("./i18n");

// Signature LÉGÈRE de l'état Resolve (projet/timeline/nb clips/nb timelines), pour le polling de
// synchro renderer↔Resolve. N'embarque pas connect() : si le pont est KO, renvoie {connected:false}.
// `force` : le poller est le SEUL à sonder réellement le pont quand Resolve est fermé (les lectures,
// elles, sont court-circuitées par le coupe-circuit du bridge) → c'est lui qui détecte la réouverture.
async function resolveSignature() {
  try {
    const r = await bridge.connect({ force: true });
    if (!r || !r.connected) return { connected: false };
    return await bridge.sig();
  } catch (e) {
    return { connected: false, error: String(e) };
  }
}

async function resolveStatus() {
  try {
    const resolve = await getResolve();
    if (!resolve) return { connected: false, error: t("resolveInterfaceFailed") };
    const pm = await resolve.GetProjectManager();
    const proj = pm ? await pm.GetCurrentProject() : null;
    const tl = proj ? await proj.GetCurrentTimeline() : null;
    return {
      connected: true,
      version: await resolve.GetVersionString(),
      project: proj ? await proj.GetName() : null,
      timeline: tl ? await tl.GetName() : null,
    };
  } catch (e) {
    return { connected: false, error: String(e) };
  }
}

const VIDEO_EXTS = RUSH_EXTS;

// Parcours via l'agrégat Python `list_media_pool` : TOUT le Media Pool (props incluses) revient en
// UN round-trip stdio, au lieu de ~6 appels/clip via le proxy. Repli sur la marche proxy historique
// si l'agrégat échoue (helper ancien, projet fermé mid-call…) — sémantique d'erreurs inchangée.
async function listMediaPool(opts = {}) {
  const acceptedExts = opts.includeAudio ? MEDIA_EXTS : VIDEO_EXTS;
  try {
    const c = await bridge.connect();
    if (!c || !c.connected) return { connected: false, clips: [], error: (c && c.error) || t("resolveInterfaceFailed") };
    const r = await bridge.listMediaPool();
    const clips = [];
    for (const row of (r && r.clips) || []) {
      const p = row.props || {};
      const filePath = p["File Path"];
      if (!filePath) continue;
      const ext = path.extname(filePath).toLowerCase().replace(".", "");
      if (!acceptedExts.has(ext)) continue;
      clips.push({
        name: row.name,
        path: filePath,
        duration: p["Duration"],
        fps: p["FPS"],
        resolution: p["Resolution"],
        format: p["Format"],
        bin: row.bin || "",
      });
    }
    return { connected: true, project: (r && r.project) || null, clips, error: null };
  } catch (_) {
    return listMediaPoolViaProxy(opts);
  }
}

async function listMediaPoolViaProxy(opts = {}) {
  const acceptedExts = opts.includeAudio ? MEDIA_EXTS : VIDEO_EXTS;
  try {
    const resolve = await getResolve();
    if (!resolve) return { connected: false, clips: [], error: t("resolveInterfaceFailed") };
    const pm = await resolve.GetProjectManager();
    const proj = pm ? await pm.GetCurrentProject() : null;
    if (!proj) return { connected: true, clips: [], error: t("noProject") };
    const mp = await proj.GetMediaPool();
    const root = await mp.GetRootFolder();

    const clips = [];
    let processed = 0;
    async function walk(folder, prefix) {
      const list = (await folder.GetClipList()) || [];
      for (const item of list) {
        try {
          const filePath = await item.GetClipProperty("File Path");
          if (!filePath) continue;
          const ext = path.extname(filePath).toLowerCase().replace(".", "");
          if (!acceptedExts.has(ext)) continue;
          clips.push({
            name: await item.GetName(),
            path: filePath,
            duration: await item.GetClipProperty("Duration"),
            fps: await item.GetClipProperty("FPS"),
            resolution: await item.GetClipProperty("Resolution"),
            format: await item.GetClipProperty("Format"),
            bin: prefix,
          });
        } catch (_) {}
        if (++processed % 25 === 0) await yieldLoop();
      }
      const subs = (await folder.GetSubFolderList()) || [];
      for (const sub of subs) {
        await walk(sub, (prefix ? prefix + "/" : "") + (await sub.GetName()));
      }
    }
    await walk(root, "");
    return { connected: true, project: await proj.GetName(), clips, error: null };
  } catch (e) {
    return { connected: false, clips: [], error: String(e) };
  }
}

async function importToMediaPool(filePaths) {
  try {
    const resolve = await getResolve();
    if (!resolve) return { ok: false, error: t("resolveInterfaceFailed") };
    const ms = await resolve.GetMediaStorage();
    const items = await ms.AddItemListToMediaPool(filePaths);
    return { ok: !!items, count: items ? items.length : 0 };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Import NetsuDraft : accepte fichiers ET dossiers. Un dossier devient un bin du Media Pool et ses
// sous-dossiers sont reproduits, afin que la hiérarchie visible sur disque survive à l'import.
async function importMediaTree(inputPaths) {
  try {
    const resolve = await getResolve();
    if (!resolve) return { ok: false, error: t("resolveInterfaceFailed") };
    const pm = await resolve.GetProjectManager();
    const proj = pm ? await pm.GetCurrentProject() : null;
    if (!proj) return { ok: false, error: t("noProject") };
    const mp = await proj.GetMediaPool();
    const root = await mp.GetRootFolder();
    const ms = await resolve.GetMediaStorage();
    const previous = await mp.GetCurrentFolder();
    const groups = new Map();

    const add = (binPath, filePath) => {
      if (!isMediaPath(filePath)) return;
      const key = binPath.split(path.sep).filter(Boolean).join('/');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(filePath);
    };
    const scan = (rootPath) => {
      const stack = [rootPath];
      while (stack.length) {
        const current = stack.pop();
        let entries = [];
        try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (_) { continue; }
        for (const entry of entries) {
          const full = path.join(current, entry.name);
          if (entry.isDirectory()) stack.push(full);
          else if (entry.isFile()) add(path.join(path.basename(rootPath), path.relative(rootPath, path.dirname(full))), full);
        }
      }
    };
    for (const raw of Array.isArray(inputPaths) ? inputPaths : []) {
      const p = String(raw || '');
      if (!p) continue;
      let st;
      try { st = fs.statSync(p); } catch (_) { continue; }
      if (st.isDirectory()) scan(p);
      else if (st.isFile()) add('', p);
    }

    const existing = new Set();
    async function collect(folder) {
      for (const item of (await folder.GetClipList()) || []) {
        try {
          const p = await item.GetClipProperty("File Path");
          if (p) existing.add(String(p).toLowerCase());
        } catch (_) {}
      }
      for (const sub of (await folder.GetSubFolderList()) || []) await collect(sub);
    }
    await collect(root);

    const folderCache = new Map([['', root]]);
    async function targetFolder(binPath) {
      if (!binPath) return root;
      let parent = root;
      let acc = '';
      for (const name of binPath.split('/').filter(Boolean)) {
        acc = acc ? `${acc}/${name}` : name;
        if (folderCache.has(acc)) { parent = folderCache.get(acc); continue; }
        let next = null;
        for (const sub of (await parent.GetSubFolderList()) || []) {
          if ((await sub.GetName()) === name) { next = sub; break; }
        }
        if (!next) next = await mp.AddSubFolder(parent, name);
        if (!next) throw new Error(`${t("folderMissing")}: ${name}`);
        folderCache.set(acc, next);
        parent = next;
      }
      return parent;
    }

    let count = 0;
    let skipped = 0;
    try {
      for (const [binPath, files] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const fresh = files.filter((p) => {
          const key = p.toLowerCase();
          if (existing.has(key)) { skipped++; return false; }
          existing.add(key);
          return true;
        });
        if (!fresh.length) continue;
        await mp.SetCurrentFolder(await targetFolder(binPath));
        const items = await ms.AddItemListToMediaPool(fresh);
        count += items ? items.length : 0;
      }
    } finally {
      if (previous) { try { await mp.SetCurrentFolder(previous); } catch (_) {} }
    }
    return { ok: true, count, skipped };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Import dans un BIN dédié du Media Pool (créé sous la racine s'il n'existe pas), ex. « Audios »
// pour les enregistrements voix off du module Script. Déduplique par chemin (les fichiers déjà
// présents dans le projet ne sont pas ré-importés). Le bin courant est restauré ensuite.
async function importToBin(filePaths, binName) {
  try {
    const resolve = await getResolve();
    if (!resolve) return { ok: false, error: t("resolveInterfaceFailed") };
    const pm = await resolve.GetProjectManager();
    const proj = pm ? await pm.GetCurrentProject() : null;
    if (!proj) return { ok: false, error: t("noProject") };
    const mp = await proj.GetMediaPool();
    const root = await mp.GetRootFolder();

    let bin = null;
    for (const sub of (await root.GetSubFolderList()) || []) {
      if ((await sub.GetName()) === binName) { bin = sub; break; }
    }
    if (!bin) bin = await mp.AddSubFolder(root, binName);
    if (!bin) return { ok: false, error: `${t("folderMissing")}: ${binName}` };

    // Déjà importés → sautés (l'import Resolve dupliquerait l'item dans le bin).
    const fresh = [];
    for (const p of filePaths) {
      if (!(await findItemByPath(root, p))) fresh.push(p);
    }
    if (!fresh.length) return { ok: true, count: 0, skipped: filePaths.length };

    const before = await mp.GetCurrentFolder();
    await mp.SetCurrentFolder(bin);
    const ms = await resolve.GetMediaStorage();
    const items = await ms.AddItemListToMediaPool(fresh);
    if (before) { try { await mp.SetCurrentFolder(before); } catch (_) {} }
    return { ok: !!items, count: items ? items.length : 0, skipped: filePaths.length - fresh.length };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Retrouve le MediaPoolItem d'un rush par son chemin fichier.
async function findItemByPath(folder, target) {
  const list = (await folder.GetClipList()) || [];
  for (const item of list) {
    try {
      if ((await item.GetClipProperty("File Path")) === target) return item;
    } catch (_) {}
  }
  const subs = (await folder.GetSubFolderList()) || [];
  for (const sub of subs) {
    const found = await findItemByPath(sub, target);
    if (found) return found;
  }
  return null;
}

module.exports = { getResolve, resolveStatus, listMediaPool, importToMediaPool, importMediaTree, importToBin, findItemByPath, resolveSignature };
