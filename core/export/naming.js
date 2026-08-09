// @ts-check
// Nommage des fichiers d'export : un GABARIT à jetons (« {base}_{index} ») résolu par plan.
// Module PUR (aucun I/O) : le test d'existence est INJECTÉ, ce qui rend la planification vérifiable
// sans disque et sans ffmpeg. Consommé par core/export.js (noms réels) et par le canal d'aperçu
// `export:previewName` (l'éditeur de profil montre le nom AVANT de lancer l'export) — une seule
// implémentation, sinon l'aperçu et le fichier produit finissent par diverger.

const path = require('node:path');
const { sanitizeName } = require('../utils');

// Gabarit par défaut = comportement historique à l'identique (`export_001.mp4`). Le changer
// renommerait les sorties de tous les profils existants sans que personne ne l'ait demandé.
const DEFAULT_TEMPLATE = '{base}_{index}';

// Jetons EXPOSÉS. La liste est la source unique : l'éditeur de profil peuple son menu « Insérer »
// depuis le même tableau (via le canal d'aperçu), donc un jeton ajouté ici apparaît dans l'UI.
const NAMING_TOKENS = [
  'base', 'source', 'index', 'total', 'start', 'end', 'duration', 'label',
  'profile', 'codec', 'container', 'date', 'time',
];

const INDEX_PAD = 3;

/** @param {number} n @param {number} w */
const pad = (n, w) => String(Math.max(0, Math.trunc(n))).padStart(w, '0');

/**
 * Timecode de fichier `HH-MM-SS.mmm` : largeur FIXE (donc l'ordre alphabétique des fichiers suit
 * l'ordre chronologique) et sans deux-points, que Windows refuse dans un nom.
 * @param {number} sec @returns {string}
 */
function timecode(sec) {
  const ms = Math.max(0, Math.round((Number(sec) || 0) * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${pad(h, 2)}-${pad(m, 2)}-${pad(s, 2)}.${pad(ms % 1000, 3)}`;
}

/** Durée en secondes, lisible : `4.20s`. @param {number} sec @returns {string} */
const durationLabel = (sec) => `${(Math.max(0, Number(sec) || 0)).toFixed(2)}s`;

/** @param {Date} d @returns {string} */
const dateLabel = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`;

/** @param {Date} d @returns {string} */
const timeLabel = (d) => `${pad(d.getHours(), 2)}-${pad(d.getMinutes(), 2)}-${pad(d.getSeconds(), 2)}`;

/**
 * @typedef {object} NameContext
 * @property {string} base        nom de base fourni par l'appelant (collection, rush, « export »)
 * @property {string} [source]    chemin du fichier source du plan
 * @property {number|null} [index] numéro de plan 1-based ; null en FUSION (un seul fichier pour tous)
 * @property {number} [total]     nombre de plans du lot
 * @property {number} [start]     début du plan (secondes)
 * @property {number} [end]       fin du plan (secondes)
 * @property {number} [duration]  durée réelle de la SORTIE si elle ne vaut pas `end - start`
 *                                (fusion : le fichier dure la SOMME des plans, pas leur écart)
 * @property {string} [label]     libellé du plan (souvent absent)
 * @property {string} [profile]   nom du profil d'export
 * @property {string} [codec]     codec du profil, ou « copy » en remux
 * @property {string} [container] extension du conteneur
 * @property {Date} [now]         horloge de l'export (jetons {date}/{time})
 */

/**
 * Valeur BRUTE de chaque jeton (avant assainissement). Une valeur vide fait DISPARAÎTRE le jeton.
 * @param {NameContext} ctx @returns {Record<string, string>}
 */
function tokenValues(ctx) {
  const now = ctx.now instanceof Date ? ctx.now : new Date();
  const source = ctx.source ? path.parse(ctx.source).name : '';
  const start = Number(ctx.start);
  const end = Number(ctx.end);
  const dur = ctx.duration != null ? Number(ctx.duration) : end - start;
  return {
    base: ctx.base || '',
    source,
    // En fusion il n'y a PAS d'index : le jeton s'efface (le gabarit par défaut retombe alors sur
    // `{base}` seul, c'est-à-dire le nom historique du fichier fusionné).
    index: ctx.index == null ? '' : pad(ctx.index, INDEX_PAD),
    total: ctx.total ? String(ctx.total) : '',
    start: Number.isFinite(start) ? timecode(start) : '',
    end: Number.isFinite(end) ? timecode(end) : '',
    duration: Number.isFinite(dur) ? durationLabel(dur) : '',
    label: ctx.label || '',
    profile: ctx.profile || '',
    codec: ctx.codec || '',
    container: ctx.container || '',
    date: dateLabel(now),
    time: timeLabel(now),
  };
}

/** Assainit sans le repli « clip » de `sanitizeName`, qui masquerait une résolution VIDE. */
const safeName = (s) => (s ? sanitizeName(s) : '');

/**
 * Résout un gabarit en nom de fichier SANS extension.
 * Un jeton INCONNU est laissé tel quel : une faute de frappe se voit dans le nom produit, alors
 * qu'un effacement silencieux se lit comme « le gabarit ne marche pas ».
 * @param {string} template @param {NameContext} ctx @returns {string}
 */
function resolveName(template, ctx) {
  const values = tokenValues(ctx);
  // Un jeton VIDE (plan sans libellé, fusion sans index) emporte les séparateurs qui le précèdent,
  // sinon « {base}_{label}_{index} » sort « export__002 ». Le nettoyage se fait ICI, jeton par
  // jeton, et non par un repli global des séparateurs du résultat : un tel repli abîmait le texte
  // littéral et les noms de fichiers qui en contiennent (« ep01 - scene » devenait « ep01-scene »).
  const raw = String(template || DEFAULT_TEMPLATE).replace(
    /([ _.-]*)\{([a-z-]+)\}/gi,
    (whole, lead, key) => {
      if (!Object.prototype.hasOwnProperty.call(values, key)) return whole;
      return values[key] ? `${lead}${values[key]}` : '';
    },
  );
  const cleaned = safeName(raw).replace(/^[ _.-]+|[ _.-]+$/g, '');
  return cleaned || safeName(ctx.base) || 'export';
}

/**
 * Nom LIBRE dans un dossier : `stem.ext`, puis `stem (2).ext`… Deux réservoirs à consulter — le
 * disque (`exists`) ET les noms déjà planifiés du même lot (`taken`), car les plans sont encodés en
 * PARALLÈLE : sans réservation, deux plans qui résolvent le même nom écriraient dans le même fichier.
 * @param {string} dir @param {string} stem @param {string} ext
 * @param {{ taken: Set<string>, exists: (p: string) => boolean, sep?: string }} opts
 * @returns {string}
 */
function uniqueOutput(dir, stem, ext, opts) {
  const sep = opts.sep || (dir.includes('\\') ? '\\' : '/');
  const join = (name) => (dir ? `${dir}${sep}${name}` : name);
  let name = `${stem}.${ext}`;
  let i = 2;
  // Même suffixe « (n) » que la préparation média AE (core/ae/codecs.js#uniquePath) : deux
  // conventions de dédoublonnage dans la même application se lisent comme un bug.
  while (opts.taken.has(join(name).toLowerCase()) || opts.exists(join(name))) name = `${stem} (${i++}).${ext}`;
  const full = join(name);
  opts.taken.add(full.toLowerCase());
  return full;
}

/**
 * Planifie les chemins de sortie de TOUT le lot, en ordre d'index. Calculé AVANT le pool d'encodage :
 * la file rend les fins d'encodage dans un ordre libre, donc réserver au fil de l'eau donnerait des
 * numéros dépendants de la vitesse des plans.
 * @param {{ input: string, start: number, end: number, label?: string }[]} clips
 * @param {{ dir: string, ext: string, template?: string, base: string, profile?: string,
 *           codec?: string, now?: Date, exists?: (p: string) => boolean }} opts
 * @returns {string[]}
 */
function planOutputs(clips, opts) {
  const exists = opts.exists || (() => false);
  const taken = new Set();
  const total = clips.length;
  return clips.map((clip, i) => {
    const stem = resolveName(opts.template, {
      base: opts.base,
      source: clip.input,
      index: i + 1,
      total,
      start: clip.start,
      end: clip.end,
      label: clip.label,
      profile: opts.profile,
      codec: opts.codec,
      container: opts.ext,
      now: opts.now,
    });
    return uniqueOutput(opts.dir, stem, opts.ext, { taken, exists });
  });
}

module.exports = { DEFAULT_TEMPLATE, NAMING_TOKENS, resolveName, planOutputs, uniqueOutput, timecode };
