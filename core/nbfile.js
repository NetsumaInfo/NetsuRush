// @ts-check
// core/nbfile.js
// Format de partage commun « .netsu », type-routé pour le Carnet. Les anciennes archives
// « .nrnote » restent importables pour compatibilité.
//   manifest.json   → index : format/version/type, méta du carnet, compteurs.
//   pages.json      → pages (méta + BLOCS JSON NATIFS BlockNote → réimport à l'IDENTIQUE, pas lossy).
//   databases.json  → databases des pages exportées (schéma + lignes + vues, brut).
//   assets/<sha>.<ext> → médias du carnet référencés par les blocs (dédup par hash de contenu).
// À l'export, les URLs /media pointant dans les assets du carnet sont réécrites en tokens portables
// `netsu-asset://<sha>.<ext>` ; à l'import, chaque asset est ré-écrit sur disque (dédup) et le token
// redevient une URL /media locale (préfixe/suffixe fournis par le renderer — il connaît base + token).
// Les ids de pages/databases sont RÉGÉNÉRÉS à l'import (remap textuel dans le JSON, comme
// duplicatePage) → mentions, sous-pages et blocs /database internes suivent les copies.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { zipStore, unzip } = require('./netsu');
const { t } = require('./i18n');

const FORMAT = 'netsu';
const LEGACY_FORMAT = 'nrnote';
const VERSION = 1;
const TOKEN_RE = /(?:netsu|nrnote)-asset:\/\/([0-9a-f]{64})\.(\w+)/g;
// URL /media telle que persistée dans les blocs (échappée JSON : pas de " ni \ dedans).
const MEDIA_URL_RE = /https?:\/\/[^"\\\s]*\/media\?p=([^&"\\\s]+)[^"\\\s]*/g;

function uid() {
  return crypto.randomBytes(6).toString('hex');
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function createNbFile({ notebookStore, dataDir }) {
  const assetsDir = path.resolve(path.join(dataDir, 'notebook', 'assets'));

  // Sous-arbre d'une page (métas non supprimées du carnet), racine incluse — ordre = parcours en
  // profondeur pour préserver parentId avant enfants à l'import.
  function subtree(pages, rootId) {
    const childrenOf = (pid) => pages.filter((p) => (p.parentId || null) === pid);
    const out = [];
    const walk = (p) => { out.push(p); for (const c of childrenOf(p.id)) walk(c); };
    const root = pages.find((p) => p.id === rootId);
    if (root) walk(root);
    return out;
  }

  // --- Export ---------------------------------------------------------------------------------
  // opts = { notebookId, rootId?: string|null (null = carnet entier), dest, embedAssets?: boolean }.
  function exportFile(opts) {
    try {
      const { notebookId, rootId, dest } = opts || {};
      const embedAssets = opts && opts.embedAssets !== false;
    if (!dest) return { ok: false, error: t('destinationMissing') };
      const loaded = notebookStore.loadNotebook(notebookId);
    if (!loaded) return { ok: false, error: t('notebookMissing') };
      const metas = rootId ? subtree(loaded.pages, rootId) : loaded.pages;
    if (!metas.length) return { ok: false, error: t('noPagesExport') };
      const inSet = new Set(metas.map((m) => m.id));

      const pages = [];
      const databases = [];
      for (const m of metas) {
        const full = notebookStore.loadPage(m.id);
        if (!full) continue;
        // Racines du sous-arbre : parent hors export → détaché (re-parenté à l'import).
        const page = full.page;
        const parentId = page.parentId && inSet.has(page.parentId) ? page.parentId : null;
        pages.push({
          id: page.id, parentId, title: page.title, icon: page.icon,
          cover: page.cover, orderIdx: page.orderIdx, blocks: page.blocks,
        });
        for (const [dbId, data] of Object.entries(full.databases || {})) {
          databases.push({ id: dbId, pageId: full.page.id, data });
        }
      }

      // Réécrit les URLs /media (assets du carnet) en tokens portables + collecte les octets.
      const assetEntries = [];
      const seen = new Map(); // chemin abs → token
      let pagesJson = JSON.stringify(pages);
      if (embedAssets) {
        pagesJson = pagesJson.replace(MEDIA_URL_RE, (url, encPath) => {
          try {
            const abs = path.resolve(decodeURIComponent(encPath));
            if (abs !== assetsDir && !abs.startsWith(assetsDir + path.sep)) return url; // média hors carnet
            const cached = seen.get(abs);
            if (cached) return cached;
            if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return url;
            const buf = fs.readFileSync(abs);
            const sha = sha256(buf);
            const ext = (path.extname(abs).slice(1) || 'bin').toLowerCase();
            const name = `assets/${sha}.${ext}`;
            if (!assetEntries.some((e) => e.name === name)) assetEntries.push({ name, data: buf });
            const token = `netsu-asset://${sha}.${ext}`;
            seen.set(abs, token);
            return token;
          } catch (_) {
            return url;
          }
        });
      }

      const manifest = {
        format: FORMAT, version: VERSION,
        type: rootId ? 'notebook-pages' : 'notebook',
        notebook: {
          title: loaded.notebook.title,
          icon: loaded.notebook.icon,
          kind: loaded.notebook.kind || 'notes',
          language: loaded.notebook.language || 'fr',
          tags: [],
        },
        settings: { kind: loaded.notebook.kind || 'notes', language: loaded.notebook.language || 'fr' },
        counts: { pages: pages.length, databases: databases.length, assets: assetEntries.length },
      };
      const entries = [
        { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) },
        { name: 'pages.json', data: Buffer.from(pagesJson) },
        { name: 'databases.json', data: Buffer.from(JSON.stringify(databases)) },
        ...assetEntries,
      ];
      const zip = zipStore(entries);
      fs.writeFileSync(dest, zip);
      return { ok: true, path: dest, bytes: zip.length, counts: manifest.counts };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // --- Import ---------------------------------------------------------------------------------
  // opts = { b64 (octets de l'archive), notebookId?: cible (absent → nouveau carnet), parentId?: page
  // d'accueil des racines importées, mediaPrefix/mediaSuffix: gabarit d'URL /media du renderer }.
  function importFile(opts) {
    try {
      const { b64, parentId, mediaPrefix, mediaSuffix } = opts || {};
    if (!b64) return { ok: false, error: t('archiveMissing') };
      const buf = Buffer.from(String(b64), 'base64');
      if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) {
      return { ok: false, error: t('invalidArchive') };
      }
      const files = unzip(buf);
      const manRaw = files.get('manifest.json');
      const pagesRaw = files.get('pages.json');
    if (!manRaw || !pagesRaw) return { ok: false, error: t('archiveIncomplete') };
      let manifest;
    try { manifest = JSON.parse(manRaw.toString('utf8')); } catch { return { ok: false, error: t('unreadableFile') }; }
    if (manifest.format !== FORMAT && manifest.format !== LEGACY_FORMAT) return { ok: false, error: t('unknownFormat') };
    if (!['notebook', 'notebook-pages', 'pages'].includes(manifest.type)) return { ok: false, error: `${t('unsupportedType')}: ${manifest.type}` };

      // 1. Assets → disque (saveAsset dédup par contenu), token → URL /media locale.
      const tokenToUrl = new Map();
      for (const [name, data] of files) {
        const m = name.match(/^assets\/([0-9a-f]{64})\.(\w+)$/i);
        if (!m) continue;
        const r = notebookStore.saveAsset(data, m[2]);
        if (r.ok && r.path) {
          tokenToUrl.set(`${m[1]}.${m[2]}`, `${mediaPrefix || ''}${encodeURIComponent(r.path)}${mediaSuffix || ''}`);
        }
      }

      // 2. Remap textuel : tokens d'assets → URLs, puis ids pages/databases → ids neufs.
      let pagesJson = pagesRaw.toString('utf8');
      let dbsJson = (files.get('databases.json') || Buffer.from('[]')).toString('utf8');
      const swapTokens = (s) => s.replace(TOKEN_RE, (tok, sha, ext) => tokenToUrl.get(`${sha}.${ext}`) || tok);
      pagesJson = swapTokens(pagesJson);
      dbsJson = swapTokens(dbsJson);

      let pages;
      let dbs;
      try {
        pages = JSON.parse(pagesJson) || [];
        dbs = JSON.parse(dbsJson) || [];
      } catch {
      return { ok: false, error: t('unreadableFile') };
      }
      const idMap = new Map();
      for (const p of pages) idMap.set(p.id, uid());
      for (const d of dbs) idMap.set(d.id, uid());
      let remappedPages = pagesJson;
      let remappedDbs = dbsJson;
      for (const [oldId, newId] of idMap) {
        remappedPages = remappedPages.split(oldId).join(newId);
        remappedDbs = remappedDbs.split(oldId).join(newId);
      }
      pages = JSON.parse(remappedPages);
      dbs = JSON.parse(remappedDbs);

      // 3. Carnet cible : fourni, sinon nouveau carnet au titre de l'archive.
      let notebookId = opts && opts.notebookId;
      if (!notebookId) {
        const created = notebookStore.saveNotebook({
        title: (manifest.notebook && manifest.notebook.title) || t('importedNotebook'),
          icon: (manifest.notebook && manifest.notebook.icon) || null,
          kind: (manifest.notebook && manifest.notebook.kind) || (manifest.settings && manifest.settings.kind) || 'notes',
          language: (manifest.notebook && manifest.notebook.language) || (manifest.settings && manifest.settings.language) || 'fr',
        });
        if (!created.ok) return { ok: false, error: created.error || 'création du carnet impossible' };
        notebookId = created.id;
      }

      // 4. Écrit pages (parents d'abord : pages.json est en ordre profondeur) puis databases.
      const rootIds = [];
      const base = Date.now();
      let i = 0;
      for (const p of pages) {
        const isRoot = !p.parentId;
        if (isRoot) rootIds.push(p.id);
        const r = notebookStore.savePage({
          id: p.id,
          notebookId,
          parentId: isRoot ? (parentId || null) : p.parentId,
          title: p.title,
          icon: p.icon ?? null,
          cover: p.cover ?? null,
          // Racines : ré-ordonnées en fin de liste cible (base + i) ; enfants : ordre d'origine.
          orderIdx: isRoot ? base + i : p.orderIdx,
          blocks: p.blocks || [],
        });
        if (!r.ok) return { ok: false, error: r.error || `échec d'écriture de « ${p.title} »` };
        i++;
      }
      for (const d of dbs) {
        const r = notebookStore.saveDatabase({ ...(d.data || {}), id: d.id, pageId: d.pageId });
        if (!r.ok) return { ok: false, error: r.error || 'échec d\'écriture d\'une database' };
      }

      return { ok: true, notebookId, pages: pages.length, databases: dbs.length, rootIds };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  return { exportFile, importFile };
}

module.exports = { createNbFile, FORMAT, LEGACY_FORMAT, VERSION };
