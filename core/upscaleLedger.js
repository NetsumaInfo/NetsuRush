// @ts-check
// core/upscaleLedger.js
// Registre des sorties d'upscale déjà produites, adressé par CONTENU.
//
// Un upscale coûte des minutes de GPU par plan : le refaire pour rien est la pire dépense de l'app.
// Trois situations le provoquaient, toutes invisibles depuis un seul dossier d'archive :
//   1. ré-archiver une collection dont rien n'a bougé ;
//   2. archiver dans une AUTRE collection un plan déjà upscalé ailleurs (même source, mêmes bornes,
//      mêmes réglages) ;
//   3. archiver un plan dont la source EST elle-même une sortie d'upscale de NetsuRush.
//
// D'où deux index : `entries` (empreinte → fichier produit) répond aux cas 1 et 2, et l'index inverse
// (fichier produit → empreinte) répond au cas 3. L'empreinte couvre TOUT ce qui détermine le contenu
// du fichier : la source (chemin, date, taille — une source retouchée doit invalider), les bornes du
// plan, les réglages d'encodage et les réglages d'upscale. Changer l'un d'eux donne une autre clé,
// donc un autre fichier : aucune collision silencieuse possible.
//
// Le registre n'est qu'un CACHE : une entrée dont le fichier a disparu est purgée à la lecture, et
// perdre le fichier entier ne fait que retomber sur le comportement d'avant (on ré-upscale).

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { NR_HOME } = require('./config');

// Plafond du registre. Au-delà, les entrées les plus anciennes partent : c'est un cache, pas un
// journal — une entrée oubliée coûte un ré-upscale, pas une erreur.
const MAX_ENTRIES = 4000;
const DEFAULT_FILE = path.join(NR_HOME, 'upscale-ledger.json');

/** Comparaison de chemins tolérante à la casse et aux séparateurs (Windows). */
const normPath = (p) => path.resolve(String(p || '')).toLowerCase();

/** Bornes en secondes arrondies à la milliseconde : le bruit flottant ne doit pas casser une clé. */
const ms = (v) => (v == null ? null : Math.round(Number(v) * 1000));

/**
 * Sérialise la sélection de piste audio en tuple ORDONNÉ : `JSON.stringify` d'un objet dépend de
 * l'ordre d'insertion des clés, qui varie selon l'appelant.
 * @param {any} sel
 */
const audioTuple = (sel) => [
  String((sel && sel.mode) || 'auto'),
  (sel && sel.code) || null,
  sel && sel.index != null ? Number(sel.index) : null,
];

/**
 * Sérialisation à clés TRIÉES. Les réglages d'upscale sont nombreux (tuilage, nettoyage, filtres
 * temps réel…) et chacun change l'image : ils entrent tous dans l'empreinte. L'ordre des clés d'un
 * objet dépend de qui l'a construit — sans tri, le même réglage donnerait deux empreintes.
 */
function stable(value) {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().flatMap((k) => (value[k] === undefined ? [] : [[k, stable(value[k])]]));
  }
  return value;
}

/**
 * Empreinte d'un plan produit : tout ce qui détermine le contenu du fichier, et rien d'autre.
 * Fonction PURE (aucun accès disque) → testable sans registre.
 * @param {{ src: string, mtimeMs?: number, size?: number, in?: number, out?: number,
 *           encode?: any, upscale?: any }} input
 * @returns {string} sha1 hexadécimal
 */
function fingerprint(input) {
  const i = input || /** @type {any} */ ({});
  const e = i.encode || {};
  const u = i.upscale || {};
  const payload = JSON.stringify([
    'v1',
    normPath(i.src),
    i.mtimeMs != null ? Math.round(Number(i.mtimeMs)) : null,
    i.size != null ? Number(i.size) : null,
    ms(i.in), ms(i.out),
    String(e.workflow || 'video_remux'),
    String(e.codec || ''),
    String(e.encoderMode || ''),
    String(e.speed || ''),
    String(e.container || 'mp4'),
    String(e.audioMode || 'copy'),
    audioTuple(e.audioSelect),
    u.enabled ? stable(u) : null,
  ]);
  return crypto.createHash('sha1').update(payload).digest('hex');
}

/**
 * Métadonnées de la source d'un plan (date + taille) : une source ré-encodée sur place doit
 * invalider les fichiers qui en descendent. Source absente → null/null, l'empreinte reste stable
 * (un média hors-ligne ne doit pas déclencher un ré-upscale à chaque passage).
 * @param {string} src
 */
function statSource(src) {
  try {
    const st = fs.statSync(src);
    return { mtimeMs: Math.round(st.mtimeMs), size: st.size };
  } catch (_) {
    return { mtimeMs: null, size: null };
  }
}

/**
 * @param {{ file?: string }} [opts]
 */
function createUpscaleLedger(opts) {
  const file = (opts && opts.file) || DEFAULT_FILE;

  /** @type {Record<string, { file: string, at: number, engine?: string, model?: string, scale?: number }>} */
  let entries = {};
  /** @type {Map<string, string>} chemin produit (normalisé) → empreinte */
  let byFile = new Map();

  function reindex() {
    byFile = new Map();
    for (const [key, entry] of Object.entries(entries)) byFile.set(normPath(entry.file), key);
  }

  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    entries = raw && typeof raw.entries === 'object' && raw.entries ? raw.entries : {};
  } catch (_) { /* premier lancement, ou registre illisible → cache vide */ }
  reindex();

  /** Écriture atomique : un core tué en plein vol ne doit pas laisser un JSON tronqué. */
  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, entries }));
      fs.renameSync(tmp, file);
    } catch (_) { /* best-effort : le registre n'est qu'un cache */ }
  }

  /** Retire les entrées les plus anciennes au-delà du plafond. */
  function prune() {
    const keys = Object.keys(entries);
    if (keys.length <= MAX_ENTRIES) return;
    keys.sort((a, b) => (entries[a].at || 0) - (entries[b].at || 0))
      .slice(0, keys.length - MAX_ENTRIES)
      .forEach((k) => { delete entries[k]; });
    reindex();
  }

  /**
   * Fichier déjà produit pour cette empreinte, s'il existe ENCORE sur disque. L'entrée périmée est
   * purgée au passage : un registre qui promet un fichier absent est pire que pas de registre.
   * @param {string} key
   */
  function lookup(key) {
    const entry = key && entries[key];
    if (!entry) return null;
    let exists = false;
    try { exists = fs.existsSync(entry.file); } catch (_) { /* disque absent = fichier absent */ }
    if (exists) return entry;
    delete entries[key];
    byFile.delete(normPath(entry.file));
    save();
    return null;
  }

  /**
   * Enregistre un fichier produit. Ré-enregistrer la même empreinte remplace l'entrée (le fichier a
   * déménagé) plutôt que d'en accumuler deux.
   * @param {string} key @param {string} outFile
   * @param {{ engine?: string, model?: string, scale?: number }} [meta]
   */
  function record(key, outFile, meta) {
    if (!key || !outFile) return null;
    const prev = entries[key];
    if (prev) byFile.delete(normPath(prev.file));
    const entry = {
      file: String(outFile), at: Date.now(),
      engine: meta && meta.engine ? String(meta.engine) : undefined,
      model: meta && meta.model ? String(meta.model) : undefined,
      scale: meta && meta.scale != null ? Number(meta.scale) : undefined,
    };
    entries[key] = entry;
    byFile.set(normPath(outFile), key);
    prune();
    save();
    return entry;
  }

  /**
   * Ce fichier a-t-il été produit PAR NOUS, et avec quels réglages ? Sert à ne pas ré-upscaler une
   * source qui est déjà une sortie d'upscale.
   * @param {string} outFile
   */
  function describe(outFile) {
    const key = byFile.get(normPath(outFile));
    const entry = key ? entries[key] : null;
    return entry ? { key, ...entry } : null;
  }

  return { fingerprint, statSource, lookup, record, describe, file, size: () => Object.keys(entries).length };
}

module.exports = { createUpscaleLedger, fingerprint, statSource, MAX_ENTRIES };
