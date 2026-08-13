// @ts-check
// Persistance du board de référence : scènes (multi) + assets (images collées écrites sur disque).
// SQLite via le module natif `node:sqlite` si l'Electron de Resolve l'expose, sinon repli sur un
// simple fichier JSON — MÊME API publique dans les deux cas (le renderer ne voit pas la différence).
// Feuille du graphe : ne dépend que d'un répertoire de données (injecté), jamais de main.js.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { t } = require('./i18n');
const downloadTarget = require('./netsu/downloadTarget');

// Téléchargement d'octets distants (CDN, ex. Discord) plafonné — 512 Mo.
const MAX_ASSET = 512 * 1024 * 1024;
// Content-Type → extension (priorité au type renvoyé par le serveur, plus fiable que l'URL).
const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/bmp': 'bmp', 'image/avif': 'avif', 'image/svg+xml': 'svg',
  'image/tiff': 'tiff', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'video/x-matroska': 'mkv', 'video/x-msvideo': 'avi', 'video/ogg': 'ogv', 'video/mpeg': 'mpg',
};
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'mkv', 'm4v', 'avi', 'ogv', 'mpg', 'mpeg']);

// GET avec suivi de redirections + User-Agent (certains CDN refusent l'UA par défaut de Node).
function download(url, redirects) {
  return new Promise((resolve, reject) => {
    if ((redirects || 0) > 5) return reject(new Error('trop de redirections'));
    let u;
    try { u = new URL(url); } catch (e) { return reject(e); }
    const mod = u.protocol === 'http:' ? http : https;
    // Headers façon vrai navigateur : beaucoup de sites (giphy, tenor…) et CDN renvoient 403 sur un
    // User-Agent nu. Referer = origine de la page → débloque les hotlinks protégés par referrer.
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,fr;q=0.8',
      'Referer': u.origin + '/',
    };
    const req = mod.get(u, { headers }, (res) => {
      const sc = res.statusCode || 0;
      if (sc >= 300 && sc < 400 && res.headers.location) {
        res.resume();
        return resolve(download(new URL(res.headers.location, u).toString(), (redirects || 0) + 1));
      }
      if (sc !== 200) { res.resume(); return reject(new Error('HTTP ' + sc)); }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_ASSET) { req.destroy(); reject(new Error('fichier trop volumineux')); }
        else chunks.push(c);
      });
      res.on('end', () => resolve({
        buf: Buffer.concat(chunks),
        type: String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase(),
        finalUrl: u.toString(),
      }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('délai dépassé')));
  });
}

// Décode les entités HTML usuelles dans un attribut content de meta (les og:* en regorgent).
function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&#x2[fF];/g, '/').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

// Parse toutes les <meta> d'une page → map { property|name (minuscule) : content }. Robuste à
// l'ordre des attributs (content avant ou après property).
function parseMetaTags(html) {
  const map = {};
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const key = (tag.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1];
    const val = (tag.match(/content\s*=\s*["']([^"']*)["']/i) || [])[1];
    if (key && val != null) map[key.toLowerCase()] = decodeEntities(val);
  }
  return map;
}

function absoluteHttpUrl(value, baseUrl) {
  try {
    const url = new URL(decodeEntities(value), baseUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch (_) { return null; }
}

// Média principal d'une page via OpenGraph / Twitter Card (vidéo prioritaire sur image), avec son
// type explicite pour que le mode lié n'ait pas besoin de télécharger les octets afin de le deviner.
function parseOgMedia(html, baseUrl) {
  const meta = parseMetaTags(html);
  const candidates = [
    ...['og:video:secure_url', 'og:video:url', 'og:video', 'twitter:player:stream']
      .map((key) => ({ key, kind: 'video' })),
    ...['og:image:secure_url', 'og:image:url', 'og:image', 'twitter:image', 'twitter:image:src']
      .map((key) => ({ key, kind: 'image' })),
  ];
  for (const candidate of candidates) {
    if (!meta[candidate.key]) continue;
    const url = absoluteHttpUrl(meta[candidate.key], baseUrl);
    if (url) return { url, kind: candidate.kind };
  }
  return null;
}

// Repli générique pour les pages qui servent un lecteur HTML5 sans métadonnée OpenGraph (AMV et
// hébergeurs vidéo indépendants). On respecte l'ordre des sources : la page choisit sa préférence.
function parseHtmlVideo(html, baseUrl) {
  const videoTags = html.match(/<video\b[^>]*>/gi) || [];
  const sourceTags = html.match(/<source\b[^>]*>/gi) || [];
  for (const tag of [...videoTags, ...sourceTags]) {
    const type = (tag.match(/type\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
    if (type && !type.toLowerCase().startsWith('video/')) continue;
    const src = (tag.match(/src\s*=\s*["']([^"']+)["']/i) || [])[1];
    const url = src && absoluteHttpUrl(src, baseUrl);
    if (url) return { url, kind: 'video' };
  }
  return null;
}

const EXT_OK = new Set([
  // images
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'svg', 'tif', 'tiff',
  // vidéos (blobs collés/déposés sans chemin disque → persistés comme les images)
  'mp4', 'webm', 'mov', 'mkv', 'm4v', 'avi', 'ogv',
]);

function uid() {
  return crypto.randomBytes(6).toString('hex');
}

// Âge en dessous duquel un asset n'est jamais ramassé. Deux semaines couvrent largement la vie
// d'un fichier posé sur un board pas encore enregistré, sans laisser des Go d'upscales oubliés.
const ASSET_GRACE_MS = 14 * 24 * 60 * 60 * 1000;

// --- Backend SQLite (node:sqlite, expérimental mais sans compilation native) -------------------
// IMPORTANT : on prépare un StatementSync NEUF à chaque appel (jamais mémorisé au niveau du store).
// Un statement conservé peut être finalisé par le GC entre deux appels → « statement has been
// finalized » à la sauvegarde suivante. Préparer à la demande est bon marché (cache interne SQLite).
const UPSERT =
  'INSERT INTO scenes (id, name, data, updated_at) VALUES (?, ?, ?, ?) ' +
  'ON CONFLICT(id) DO UPDATE SET name = excluded.name, data = excluded.data, updated_at = excluded.updated_at';

function sqliteBackend(dbPath) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(
    'CREATE TABLE IF NOT EXISTS scenes (id TEXT PRIMARY KEY, name TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL)',
  );
  return {
    list: () =>
      db
        .prepare('SELECT id, name, updated_at FROM scenes ORDER BY updated_at DESC')
        .all()
        .map((r) => ({ id: r.id, name: r.name, updatedAt: r.updated_at })),
    get: (id) => db.prepare('SELECT id, name, data, updated_at FROM scenes WHERE id = ?').get(id) || null,
    put: (id, name, data, ts) => db.prepare(UPSERT).run(id, name, data, ts),
    del: (id) => db.prepare('DELETE FROM scenes WHERE id = ?').run(id),
  };
}

// --- Backend JSON (repli) : un seul fichier { [id]: {id,name,data,updated_at} } ----------------
function jsonBackend(filePath) {
  const read = () => {
    try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) { return {}; }
  };
  const write = (obj) => {
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, filePath); // rename atomique
  };
  return {
    list: () =>
      Object.values(read())
        .map((r) => ({ id: r.id, name: r.name, updatedAt: r.updated_at }))
        .sort((a, b) => b.updatedAt - a.updatedAt),
    get: (id) => read()[id] || null,
    put: (id, name, data, ts) => {
      const o = read();
      o[id] = { id, name, data, updated_at: ts };
      write(o);
    },
    del: (id) => {
      const o = read();
      delete o[id];
      write(o);
    },
  };
}

function createReferenceStore(dataDir) {
  const dir = path.join(dataDir, 'reference');
  const assetsDir = path.join(dir, 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });

  let backend;
  let kind;
  try {
    backend = sqliteBackend(path.join(dir, 'reference.db'));
    kind = 'sqlite';
  } catch (e) {
    backend = jsonBackend(path.join(dir, 'scenes.json'));
    kind = 'json';
  }

  // Sérialise {items, view} dans la colonne data ; les méta (name/updatedAt) restent en colonnes.
  function saveScene(scene) {
    try {
      const id = scene.id || uid();
      const ts = Date.now();
      const data = JSON.stringify({ items: scene.items || [], view: scene.view || null });
      backend.put(id, scene.name || 'Sans titre', data, ts);
      return { ok: true, id, updatedAt: ts };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  function loadScene(id) {
    const row = backend.get(id);
    if (!row) return null;
    let parsed = { items: [], view: null };
    try { parsed = JSON.parse(row.data); } catch (_) {}
    return { id: row.id, name: row.name, items: parsed.items || [], view: parsed.view || null, updatedAt: row.updated_at };
  }

  function listScenes() {
    try { return backend.list(); } catch (_) { return []; }
  }

  function deleteScene(id) {
    try { backend.del(id); return { ok: true }; } catch (e) { return { ok: false, error: String(e) }; }
  }

  // Écrit un blob d'image (collé) sur disque sous un nom = hash du contenu (dédup naturelle).
  // Renvoie le chemin disque → le renderer le sert via HTTP local.
  function saveAsset(bytes, ext) {
    try {
      const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      const e = EXT_OK.has(String(ext || '').toLowerCase()) ? String(ext).toLowerCase() : 'png';
      const hash = crypto.createHash('md5').update(buf).digest('hex');
      const out = path.join(assetsDir, `${hash}.${e}`);
      if (!fs.existsSync(out)) fs.writeFileSync(out, buf);
      return { ok: true, path: out };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  function persistDownloaded(downloaded, sourceUrl, options = {}) {
    const type = String(downloaded.type || '');
    let ext = MIME_EXT[type];
    if (!ext) {
      const candidate = (new URL(sourceUrl).pathname.split('.').pop() || '').toLowerCase();
      if (EXT_OK.has(candidate)) ext = candidate;
    }
    if (!ext) return { ok: false, error: t('unsupportedType') + ': ' + type };
    const kind = type.startsWith('video/') || VIDEO_EXTS.has(ext) ? 'video' : 'image';
    if (options.projectPath) {
      try {
        return {
          ok: true,
          path: downloadTarget.writeBuffer(String(options.projectPath), kind, String(options.title || 'media'), downloaded.buf, ext),
          kind,
        };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    }
    const saved = saveAsset(downloaded.buf, ext);
    if (!saved.ok) return saved;
    return {
      ok: true,
      path: saved.path,
      kind,
    };
  }

  // Télécharge un média distant (URL CDN signée Discord, hotlink protégé, lien expirant…) côté core
  // — pas de CORS/référrer côté WebView — puis le persiste en asset disque (durable, content-hash).
  // Renvoie le chemin + le `kind` détecté (image/vidéo) pour que le renderer pose le bon item.
  async function fetchAsset(url, options = {}) {
    try {
      if (!/^https?:\/\//i.test(String(url || ''))) return { ok: false, error: 'URL invalide' };
      const downloaded = await download(url);
      return persistDownloaded(downloaded, downloaded.finalUrl || url, options);
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // Résout le VRAI média derrière N'IMPORTE QUEL lien et le persiste en asset disque. Catch-all
  // générique : 1) si la réponse est déjà un fichier média → on l'écrit tel quel (couvre les .gif
  // direct, CDN, hotlinks) ; 2) sinon c'est une page HTML → on lit l'OpenGraph/Twitter Card pour
  // trouver l'URL du média (giphy/tenor/imgur/articles…) et on la télécharge. Une seule requête
  // pour un média direct, deux pour une page. Repli renderer : extraction yt-dlp puis carte embed.
  async function resolveMedia(url, options = {}) {
    try {
      if (!/^https?:\/\//i.test(String(url || ''))) return { ok: false, error: 'URL invalide' };
      const first = await download(url);
      const downloadMedia = options.download !== false;
      // 1. Réponse déjà un média direct → persiste sans re-télécharger.
      const directKind = first.type.startsWith('video/') ? 'video'
        : first.type.startsWith('image/') ? 'image' : null;
      if (directKind) {
        if (!downloadMedia) return { ok: true, url: first.finalUrl, kind: directKind };
        return persistDownloaded(first, first.finalUrl || url, options);
      }
      // 2. Page HTML/XML → OpenGraph ou lecteur HTML5 → lien distant ou asset selon le réglage.
      if (!first.type || first.type.includes('html') || first.type.includes('xml')) {
        const html = first.buf.toString('utf8');
        const media = parseOgMedia(html, first.finalUrl || url) || parseHtmlVideo(html, first.finalUrl || url);
        if (media) {
          if (!downloadMedia) return { ok: true, url: media.url, kind: media.kind };
          const r = await fetchAsset(media.url, options);
          if (r.ok) return r;
          return { ok: false, error: t('openGraphFailed') + ': ' + (r.error || '') };
        }
      }
      return { ok: false, error: t('noMediaDetected') };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // Chemin d'un nouvel asset (ex. média upscalé) dans le dossier possédé par l'app.
  function assetPath(name) {
    return path.join(assetsDir, sanitizeFile(name));
  }

  // Un chemin est-il un asset POSSÉDÉ par l'app (sous assets/) ? → seul cas où on s'autorise à le
  // supprimer (jamais un fichier original de l'utilisateur, ajouté par son chemin disque d'origine).
  function isAppAsset(p) {
    try {
      const a = path.resolve(assetsDir).toLowerCase();
      const f = path.resolve(String(p || '')).toLowerCase();
      return f === a || f.startsWith(a + path.sep);
    } catch (_) {
      return false;
    }
  }

  // Supprime un fichier UNIQUEMENT s'il est un asset de l'app. Renvoie removed=false sinon (sans erreur).
  function removeAsset(p) {
    try {
      if (isAppAsset(p) && fs.existsSync(p)) { fs.unlinkSync(p); return { ok: true, removed: true }; }
      return { ok: true, removed: false };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // Tous les localisateurs d'une scène : média affiché, frames d'une séquence, média d'avant un
  // upscale, fichier gardé derrière un embed. Manquer une de ces cases ferait effacer un fichier
  // encore utilisé — la liste est la seule chose qui protège les octets du ménage ci-dessous.
  function sceneRefs(scene, into) {
    for (const item of (scene && scene.items) || []) {
      for (const value of [item.ref, ...(Array.isArray(item.frames) ? item.frames : [])]) {
        if (value) into.add(path.resolve(String(value)).toLowerCase());
      }
      for (const nested of [item.prevMedia, item.localMedia]) {
        if (nested && nested.ref) into.add(path.resolve(String(nested.ref)).toLowerCase());
      }
    }
    return into;
  }

  /**
   * Vide le magasin d'assets de ce que plus aucune scène ne réclame. Ce dossier reçoit tout ce que
   * l'app fabrique pour un board — image collée, média téléchargé, frames extraites, SORTIE
   * D'UPSCALE (des centaines de Mo par plan) — et, jusqu'ici, rien n'en sortait jamais.
   *
   * Deux garde-fous, parce qu'un asset peut être utilisé sans qu'aucune scène ne le dise (board
   * ouvert depuis un fichier .netsu, dont les items pointent en mémoire sur le magasin) :
   *   1. le DÉLAI DE GRÂCE — un fichier récent n'est jamais touché ;
   *   2. l'appel se fait au démarrage du core, avant qu'un board ait pu être ouvert.
   * @param {{ graceMs?: number }} [opts]
   * @returns {{ ok: boolean, removed: number, bytes: number, kept: number, error?: string }}
   */
  function sweepAssets(opts) {
    const graceMs = Number((opts || {}).graceMs);
    const grace = Number.isFinite(graceMs) && graceMs >= 0 ? graceMs : ASSET_GRACE_MS;
    try {
      const used = new Set();
      for (const meta of listScenes()) sceneRefs(loadScene(meta.id), used);
      const now = Date.now();
      let removed = 0;
      let bytes = 0;
      let kept = 0;
      for (const name of fs.readdirSync(assetsDir)) {
        const file = path.join(assetsDir, name);
        let stat;
        try { stat = fs.statSync(file); } catch (_) { continue; }
        if (!stat.isFile()) continue;
        if (used.has(file.toLowerCase()) || now - stat.mtimeMs < grace) { kept += 1; continue; }
        try { fs.rmSync(file, { force: true }); removed += 1; bytes += stat.size; }
        catch (_) { kept += 1; /* fichier verrouillé : il repassera au prochain démarrage */ }
      }
      return { ok: true, removed, bytes, kept };
    } catch (e) {
      return { ok: false, removed: 0, bytes: 0, kept: 0, error: String(e) };
    }
  }

  return {
    kind, listScenes, loadScene, saveScene, deleteScene, saveAsset, fetchAsset, resolveMedia,
    storagePath: () => dir,
    assetsDir, assetPath, isAppAsset, removeAsset, sweepAssets,
  };
}

// Nom de fichier sûr (pas de séparateur ni de caractère interdit) pour les assets générés.
function sanitizeFile(s) {
  return String(s || 'asset').replace(/[\\/:*?"<>|]+/g, '_');
}

module.exports = { createReferenceStore };
