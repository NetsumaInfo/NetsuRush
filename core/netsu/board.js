// @ts-check
// core/netsu/board.js
// Traduction board ⇄ conteneur .netsu v2.
//
// Deux invariants portent ce fichier :
//
//   1. UNE LIGNE PAR ITEM dans `board_items`. C'est ce qui rend le fichier modifiable en continu :
//      déplacer une note touche une ligne, pas tout le document (l'ancien stockage gardait la scène
//      entière dans une colonne TEXT, cf. core/reference.js).
//   2. Le vocabulaire de tokens est celui du .netsu v1 — `asset:<sha>` pour des octets embarqués,
//      `ref:<id>` pour un média seulement référencé. Le réutiliser évite une collision vicieuse :
//      un token « blob: » se confondrait avec les URL `blob:` du navigateur, qu'un item peut porter.
//
// La forme rendue par `readBoardDoc` est IDENTIQUE à celle de l'import v1 (items + placeholders
// `missing`) : le renderer n'a rien à savoir du changement de format.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const blobs = require('./blobs');
const levels = require('./levels');
const sidecar = require('./sidecar');
const relocate = require('./relocate');
const { embedItem, describeSource } = require('./embed');

const DOC_TYPE = 'board';
// Kinds dont le `ref` désigne un média local embarquable. Les autres (youtube, embed, text, frame,
// draw) portent soit un lien tiers, soit aucun média.
const MEDIA_KINDS = new Set(['image', 'video', 'sequence']);
// Champs transitoires : recalculés à l'ouverture, ils n'ont rien à faire dans le fichier.
const TRANSIENT_FIELDS = ['src', 'loading', 'localMedia'];

/** @param {string} ref @returns {boolean} */
function isRemoteRef(ref) {
  return /^(https?:|data:|blob:)/i.test(ref);
}

/** @param {any} item @returns {any} */
function stripTransient(item) {
  const out = { ...item };
  for (const field of TRANSIENT_FIELDS) delete out[field];
  return out;
}

/** Réglages d'embarquement d'un item : sa surcharge, sinon le défaut du board. */
function embedOptionsFor(item, defaults) {
  const own = item && item.embed ? item.embed : {};
  return {
    level: own.level != null ? own.level : defaults.level,
    quality: own.quality != null ? own.quality : defaults.quality,
    marginSec: own.marginSec != null ? own.marginSec : defaults.marginSec,
  };
}

/**
 * Une référence média → un token portable. Renvoie aussi de quoi tenir les compteurs et, en cas
 * d'échec, le placeholder « manquant » que l'UI sait relocaliser.
 * @returns {Promise<{ token: string, bytes: number, bundled: boolean, referenced: boolean,
 *                     missing?: { name: string, size: number, kind: string } }>}
 */
async function tokenizeRef(ctx, item, itemId, rawRef, kindHint) {
  const ref = String(rawRef || '');
  const inert = { token: ref, bytes: 0, bundled: false, referenced: false };
  if (!ref) return { ...inert, token: '' };

  // Lien distant : figé (téléchargé) sur demande, sinon gardé tel quel — il ne coûte rien.
  if (isRemoteRef(ref)) {
    if (!ctx.freezeLinks || !/^https?:/i.test(ref)) return inert;
    const fetched = await ctx.refStore.fetchAsset(ref).catch(() => null);
    if (!fetched || !fetched.ok || !fetched.path || !fs.existsSync(fetched.path)) return inert;
    return tokenizeLocal(ctx, item, itemId, fetched.path, kindHint);
  }
  return tokenizeLocal(ctx, item, itemId, ref, kindHint);
}

/** @returns {Promise<{ token: string, bytes: number, bundled: boolean, referenced: boolean, missing?: any }>} */
async function tokenizeLocal(ctx, item, itemId, filePath, kindHint) {
  const options = embedOptionsFor(item, ctx.defaults);
  const result = await embedItem({
    handle: ctx.handle,
    docId: ctx.docId,
    itemId,
    item: { ...item, kind: kindHint || item.kind },
    filePath,
    // Un fichier écrit pour être ENVOYÉ ne transporte pas les chemins de la machine d'origine.
    keepPath: false,
    ...options,
  });

  // Source introuvable : on garde de quoi la relocaliser, on ne perd pas l'item.
  if (result.error || (!result.clipSha && !result.mediaId)) {
    const source = await describeSource(filePath);
    return {
      token: '',
      bytes: 0,
      bundled: false,
      referenced: false,
      missing: { name: source.name || path.basename(filePath), size: source.size, kind: kindHint || item.kind },
    };
  }
  if (result.clipSha) {
    return { token: `asset:${result.clipSha}`, bytes: result.bytes, bundled: true, referenced: false };
  }
  return { token: `ref:${result.mediaId}`, bytes: result.bytes, bundled: false, referenced: true };
}

/**
 * Ce qu'un PARTAGE garde du média d'avant (upscale annulable, séquence dépliée). Ses octets sont
 * ceux d'un fichier qui vit chez l'expéditeur : les embarquer doublerait le poids du fichier pour
 * une version que personne ne regarde, et recopier son chemin absolu ne ferait que publier
 * l'arborescence de l'expéditeur au profit d'un bouton « revenir en arrière » qui ne marcherait
 * pas. Reste le LIEN d'origine quand il y en a un — lui, le destinataire peut le suivre.
 */
function shareablePrevMedia(prev) {
  const source = prev && typeof prev === 'object' ? String(prev.sourceUrl || '') : '';
  return /^https?:/i.test(source) ? { sourceUrl: source } : undefined;
}

/** Un item, prêt à être écrit : tokens posés, champs transitoires retirés. */
async function tokenizeItem(ctx, raw) {
  const item = stripTransient(raw);
  const shareablePrev = shareablePrevMedia(item.prevMedia);
  if (shareablePrev) item.prevMedia = shareablePrev;
  else delete item.prevMedia;
  const kind = String(item.kind || '');
  if (!MEDIA_KINDS.has(kind)) return { item, bytes: 0, bundled: 0, referenced: 0 };

  if (kind === 'sequence') {
    const frames = Array.isArray(item.frames) ? item.frames : [];
    const tokens = [];
    let bytes = 0;
    let bundled = 0;
    let referenced = 0;
    for (const frame of frames) {
      // Frames = médias SECONDAIRES : pas de ligne item_media (une seule par item), juste les octets.
      const out = await tokenizeRef(ctx, item, null, frame, 'image');
      tokens.push(out.token);
      bytes += out.bytes;
      if (out.bundled) bundled += 1;
      if (out.referenced) referenced += 1;
    }
    item.frames = tokens;
    item.ref = tokens.find(Boolean) || '';
    delete item.missing;
    return { item, bytes, bundled, referenced };
  }

  const out = await tokenizeRef(ctx, item, item.id, item.ref, kind);
  item.ref = out.token;
  if (out.missing) item.missing = out.missing;
  else delete item.missing;
  return { item, bytes: out.bytes, bundled: out.bundled ? 1 : 0, referenced: out.referenced ? 1 : 0 };
}

/**
 * Écrit une scène de board dans le conteneur.
 * @param {{ handle: any, refStore: any, scene: any, docId?: string,
 *           defaults?: { level?: unknown, quality?: unknown, marginSec?: unknown },
 *           freezeLinks?: boolean,
 *           onProgress?: (p: { done: number, total: number, title: string }) => void }} args
 */
async function writeBoardDoc({ handle, refStore, scene, docId, defaults, freezeLinks, onProgress }) {
  const ctx = {
    handle,
    refStore,
    freezeLinks: !!freezeLinks,
    docId: docId || crypto.randomUUID(),
    defaults: {
      level: levels.normalizeLevel((defaults || {}).level),
      quality: levels.normalizeQuality((defaults || {}).quality),
      marginSec: levels.normalizeMargin((defaults || {}).marginSec),
    },
  };

  const now = Date.now();
  handle.tx((db) => {
    db.prepare(
      `INSERT INTO docs (id, type, title, is_primary, data, updated_at) VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, data = excluded.data, updated_at = excluded.updated_at`,
    ).run(ctx.docId, DOC_TYPE, String(scene.name || ''), JSON.stringify({ view: scene.view || null }), now);
    // Réécriture complète du document : les items retirés de la scène doivent disparaître du
    // fichier, sinon un board « nettoyé » garderait ses médias supprimés (et leur poids).
    db.prepare('DELETE FROM board_items WHERE doc_id = ?').run(ctx.docId);
  });

  const counts = { items: 0, bundled: 0, referenced: 0, bytes: 0 };
  const all = scene.items || [];
  // Un partage encode ses clips un par un : sans compte-rendu, l'utilisateur regarde un bouton
  // « export en cours » pendant plusieurs minutes sans savoir s'il reste dix items ou deux cents.
  const report = typeof onProgress === 'function' ? onProgress : null;
  for (const raw of all) {
    if (report) report({ done: counts.items, total: all.length, title: String(raw && raw.title || '') });
    const { item, bytes, bundled, referenced } = await tokenizeItem(ctx, raw);
    handle.tx((db) => {
      db.prepare('INSERT INTO board_items (doc_id, id, data, z, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(ctx.docId, String(item.id || crypto.randomUUID()), JSON.stringify(item), Number(item.z) || 0, now);
    });
    counts.items += 1;
    counts.bundled += bundled;
    counts.referenced += referenced;
    counts.bytes += bytes;
  }
  if (report) report({ done: counts.items, total: all.length, title: '' });
  return { docId: ctx.docId, counts };
}

/**
 * Un token → un chemin local exploitable, ou un placeholder relocalisable.
 * @returns {{ path: string, missing?: { name: string, size: number, kind: string,
 *             locator?: string, frameLocators?: (string|null)[] }|null }}
 */
function resolveToken(ctx, token, kindHint) {
  const value = String(token || '');
  // Média du dossier compagnon : chemin RELATIF au fichier, donc résolu depuis lui et non depuis un
  // magasin global — c'est ce qui permet de déplacer un projet avec ses médias.
  if (sidecar.isSidecarToken(value)) {
    const resolved = relocate.findCompanionFile(ctx.handle.path, value);
    if (resolved && fs.existsSync(resolved)) return { path: resolved, missing: null };
    return {
      path: '',
      missing: { name: path.basename(value.slice(sidecar.TOKEN.length)), size: 0, kind: kindHint, locator: value },
    };
  }

  if (value.startsWith('asset:')) {
    const sha = value.slice(6);
    const info = blobs.blobInfo(ctx.handle.db, sha);
    if (!info) return { path: '', missing: { name: 'média', size: 0, kind: kindHint } };
    // Nom déterministe = déduplication naturelle du cache d'assets : réimporter deux fois le même
    // board ne recopie pas les octets. L'extraction est EN FLUX (un « Original » peut peser des Go).
    const dest = path.join(ctx.refStore.assetsDir, `${sha}.${info.ext}`);
    if (!fs.existsSync(dest) && !blobs.extractTo(ctx.handle.db, sha, dest)) {
      return { path: '', missing: { name: 'média', size: info.size, kind: kindHint } };
    }
    return { path: dest, missing: null };
  }

  if (value.startsWith('ref:')) {
    const row = ctx.handle.db.prepare('SELECT path, name, size FROM media WHERE id = ?').get(value.slice(4));
    if (!row) return { path: '', missing: { name: 'média', size: 0, kind: kindHint, locator: value } };
    // Même machine, ou fichier retrouvé au même endroit : on réutilise l'original tel quel.
    try {
      const stat = fs.statSync(String(row.path));
      if (stat.isFile() && (!row.size || stat.size === Number(row.size))) return { path: String(row.path), missing: null };
    } catch (_) { /* déplacé ou disque absent → placeholder */ }
    const moved = relocate.findReferencedFile(ctx.handle.path, row);
    if (moved) return { path: moved, missing: null };
    return {
      path: '',
      missing: {
        name: String(row.name || 'média'), size: Number(row.size) || 0, kind: kindHint, locator: value,
      },
    };
  }

  return { path: value, missing: null }; // lien distant, id YouTube, data: — rien à résoudre
}

/**
 * Rend au média d'avant (upscale annulable) un chemin lisible. Il est rangé comme les autres dans
 * un projet, donc écrit en token : sans cette étape le bouton « revenir en arrière » pointerait sur
 * la chaîne `sidecar:…` au lieu d'un fichier. Introuvable et sans lien d'origine, il disparaît —
 * mieux vaut pas de bouton qu'un bouton qui casse l'item.
 * @param {any} ctx @param {any} item
 */
function restorePrevMedia(ctx, item) {
  const prev = item && item.prevMedia;
  if (!prev || typeof prev !== 'object') return item;
  const ref = String(prev.ref || '');
  if (!ref) return item; // partage : il ne reste que le lien d'origine, rien à résoudre
  const resolved = resolveToken(ctx, ref, String(prev.kind || item.kind || ''));
  if (resolved.path) return { ...item, prevMedia: { ...prev, ref: resolved.path, src: '' } };
  if (prev.sourceUrl) return { ...item, prevMedia: { sourceUrl: prev.sourceUrl } };
  const { prevMedia: _gone, ...rest } = item;
  return rest;
}

/** @param {any} ctx @param {any} raw */
function detokenizeItem(ctx, raw) {
  const item = restorePrevMedia(ctx, raw);
  const kind = String(item.kind || '');
  if (kind === 'sequence') {
    const tokens = Array.isArray(item.frames) ? item.frames : [];
    const frames = [];
    const frameLocators = [];
    let missingSize = 0;
    let missingCount = 0;
    for (const token of tokens) {
      const resolved = resolveToken(ctx, token, 'image');
      frames.push(resolved.path || '');
      if (!resolved.path && resolved.missing) {
        missingSize += resolved.missing.size || 0;
        missingCount += 1;
        frameLocators.push(resolved.missing.locator || String(token || '') || null);
      } else {
        frameLocators.push(null);
      }
    }
    return {
      ...item,
      frames,
      ref: frames.find(Boolean) || '',
      missing: missingCount > 0
        ? { name: `Séquence — ${missingCount}/${tokens.length} image(s) manquante(s)`, size: missingSize, kind: 'sequence', frameLocators }
        : undefined,
    };
  }

  const ref = String(item.ref || '');
  // Tout ce qui n'est PAS un token (lien distant, id YouTube, data:) traverse tel quel. Ajouter un
  // vocabulaire de token sans l'ajouter ici le laisserait arriver brut jusqu'au renderer.
  if (!ref.startsWith('asset:') && !ref.startsWith('ref:') && !sidecar.isSidecarToken(ref)) return item;
  const resolved = resolveToken(ctx, ref, kind);
  if (resolved.path) return { ...item, ref: resolved.path, missing: undefined };
  return {
    ...item,
    ref: '',
    missing: resolved.missing || item.missing || { name: 'média', size: 0, kind, locator: ref },
  };
}

/**
 * Lit le document board d'un conteneur. Rend la MÊME forme que l'import v1.
 * @param {{ handle: any, refStore: any, docId?: string }} args
 * @returns {{ ok: boolean, scene?: any, counts?: any, error?: string }}
 */
function readBoardDoc({ handle, refStore, docId }) {
  const doc = docId
    ? handle.db.prepare('SELECT id, title, data FROM docs WHERE id = ?').get(docId)
    : handle.db.prepare("SELECT id, title, data FROM docs WHERE type = ? ORDER BY is_primary DESC LIMIT 1").get(DOC_TYPE);
  if (!doc) return { ok: false, error: 'aucun board dans ce fichier' };

  let view = null;
  try { view = JSON.parse(String(doc.data || '{}')).view || null; } catch (_) { /* données de doc illisibles : vue par défaut */ }

  const ctx = { handle, refStore };
  const rows = handle.db
    .prepare('SELECT data FROM board_items WHERE doc_id = ? ORDER BY z, rowid')
    .all(doc.id);
  const items = [];
  for (const row of rows) {
    let parsed;
    try { parsed = JSON.parse(String(row.data)); } catch (_) { continue; } // item corrompu : ignoré, pas fatal
    items.push(detokenizeItem(ctx, parsed));
  }

  const bundled = handle.db.prepare('SELECT count(*) AS n FROM blobs').get().n;
  const referenced = handle.db.prepare('SELECT count(*) AS n FROM media').get().n;
  return {
    ok: true,
    scene: { name: String(doc.title || ''), items, view },
    counts: { items: items.length, bundled: Number(bundled) || 0, referenced: Number(referenced) || 0 },
  };
}

module.exports = { writeBoardDoc, readBoardDoc, stripTransient, isRemoteRef, DOC_TYPE, MEDIA_KINDS };
