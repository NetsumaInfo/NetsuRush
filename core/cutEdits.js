// @ts-check
// Persistance des ÉDITS de découpe du Découpage (CutStudio) : les FUSIONS (union de ≥2 plans
// détectés sélectionnés) et les RETRAITS (plans écartés de la découpe). Enregistrés « pour toujours »
// et rejoués à la réouverture du rush ET après une nouvelle détection (recalage par chevauchement de
// frames côté renderer).
//
// Clé = (chemin fichier source, MODÈLE de détection). Chaque modèle pose ses propres frontières de
// plans, donc ses édits lui sont propres : fusionner sous TransNetV2 ne touche pas la découpe
// OmniShotCut. Même granularité que le cache de plans (`scene_cache_v3`, PK file_path+threshold+
// model) ; le seuil n'entre PAS dans la clé — le recalage par chevauchement absorbe l'écart entre
// deux préréglages d'un même modèle.
//
// Store JSON simple (les édits sont peu nombreux et légers). Feuille du graphe : ne dépend que d'un
// répertoire de données (injecté), jamais de main.js.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { t } = require('./i18n');
const logbus = require('./logbus');

// Modèle de repli : celui sur lequel le studio ouvre par défaut.
const DEFAULT_MODEL = 'transnetv2';
// Fenêtre de coalescence des écritures disque (une rafale de fusions ne produit qu'une écriture).
const FLUSH_MS = 300;

// Une plage éditée = l'étendue couverte, en secondes ET frames source (frames = vérité pour le
// recalage ; secondes = repli si le détecteur ne rend pas de frames).
function cleanSpan(m) {
  return {
    in: Number(m && m.in) || 0,
    out: Number(m && m.out) || 0,
    inFrame: m && m.inFrame != null ? Math.round(Number(m.inFrame)) : undefined,
    outFrame: m && m.outFrame != null ? Math.round(Number(m.outFrame)) : undefined,
  };
}

/** @typedef {ReturnType<typeof cleanSpan>} Span */
/** @typedef {{ merges: Span[], removed: Span[] }} Edits */

/** @returns {Span[]} */
const spanList = (v) => (Array.isArray(v) ? v.flatMap((item) => {
  const span = cleanSpan(item);
  return span.out > span.in ? [span] : [];
}) : []);
/** @returns {Edits} */
const cleanEdits = (e) => ({ merges: spanList(e && e.merges), removed: spanList(e && e.removed) });
/** @param {Edits} e */
const isEmpty = (e) => !e.merges.length && !e.removed.length;
const modelKey = (m, optionsKey) => {
  const model = typeof m === 'string' && m ? m : DEFAULT_MODEL;
  if (typeof optionsKey !== 'string' || !optionsKey) return model;
  return `${model}@${crypto.createHash('sha256').update(optionsKey).digest('hex').slice(0, 16)}`;
};

function createCutEditsStore(dataDir) {
  const file = path.join(dataDir, 'cut-edits.json');
  const legacyFile = path.join(dataDir, 'cut-merges.json');

  // Map complète { filePath: { model: Edits } }. Lue paresseusement, gardée en mémoire, réécrite en
  // entier (petit fichier). Écriture atomique (.tmp + rename) pour ne jamais laisser un JSON tronqué.
  /** @type {Record<string, Record<string, Edits>> | null} */
  let cache = null;
  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  let dirty = false;

  // Reprise du store à plat { filePath: merge[] } : ces fusions ont été enregistrées sans modèle,
  // donc elles appartiennent à celui sur lequel le studio ouvrait — transnetv2.
  /** @returns {Record<string, Record<string, Edits>>} */
  function loadLegacy() {
    /** @type {Record<string, Record<string, Edits>>} */
    const out = {};
    let raw;
    try { raw = JSON.parse(fs.readFileSync(legacyFile, 'utf8')); }
    catch { return out; }
    if (!raw || typeof raw !== 'object') return out;
    for (const [key, merges] of Object.entries(raw)) {
      const edits = cleanEdits({ merges, removed: [] });
      if (!isEmpty(edits)) out[key] = { [DEFAULT_MODEL]: edits };
    }
    return out;
  }

  function loadAll() {
    if (cache) return cache;
    let disk;
    try { disk = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { /* absent ou illisible → reprise du legacy ci-dessous */ }
    if (disk && typeof disk === 'object') { cache = disk; return cache; }
    // `cache` est posé AVANT l'écriture : writeNow() rappelle loadAll(), qui rend alors la map directement.
    cache = loadLegacy();
    if (Object.keys(cache).length) { dirty = true; try { writeNow(); } catch { /* best-effort */ } }
    return cache;
  }

  /** Écrit le magasin sur disque. Atomique (.tmp + rename) : jamais de JSON tronqué. */
  function writeNow() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!dirty) return;
    dirty = false;
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(loadAll()));
    fs.renameSync(tmp, file);
  }

  // Écriture DIFFÉRÉE. Le renderer renvoie l'état COMPLET des édits à chaque fusion, retrait,
  // annulation ou rétablissement — donc à chaque clic dans le Découpage. Réécrire tout le magasin en
  // synchrone à chacun faisait croître le coût d'un clic avec l'historique accumulé (sérialisation +
  // écriture de TOUT le fichier, sur la boucle d'événements). La map en mémoire reste la vérité — les
  // lectures la voient immédiatement — et le disque la rattrape par lots. Même mécanique que
  // `cacheIndex`. Le timer est `unref` : il ne retient pas le process, `flush()` couvre la sortie.
  function scheduleWrite() {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      try {
        writeNow();
      } catch (e) {
        // Les édits vivent toujours en mémoire : la session continue, mais l'utilisateur doit
        // pouvoir voir pourquoi ils ne survivront pas au redémarrage.
        logbus.emit('core', 'error', `cut-edits: écriture impossible — ${(e && e.message) || e}`);
      }
    }, FLUSH_MS);
    if (typeof timer.unref === 'function') timer.unref();
  }

  return {
    /** Force l'écriture en attente (arrêt du core). Lève si le disque refuse. */
    flush: writeNow,
    // Les édits d'un rush pour UN modèle (listes vides si aucun) — lus à l'ouverture du studio.
    getEdits(filePath, model, optionsKey) {
      const byModel = loadAll()[String(filePath || '')];
      return cleanEdits(byModel && byModel[modelKey(model, optionsKey)]);
    },
    // Remplace les édits d'un rush pour UN modèle (le renderer envoie l'état complet à chaque édit).
    saveEdits(filePath, model, edits, optionsKey) {
      const key = String(filePath || '');
    if (!key) return { ok: false, error: t('pathMissing') };
      const all = loadAll();
      const next = cleanEdits(edits);
      const byModel = all[key] || {};
      if (isEmpty(next)) delete byModel[modelKey(model, optionsKey)];
      else byModel[modelKey(model, optionsKey)] = next;
      if (Object.keys(byModel).length) all[key] = byModel;
      else delete all[key];
      scheduleWrite();
      return { ok: true };
    },
    // Oublie les édits d'un rush pour UN modèle (échappatoire « Annuler les fusions » → re-détecter
    // propre). L'autre modèle garde les siens.
    clearEdits(filePath, model, optionsKey) {
      const all = loadAll();
      const key = String(filePath || '');
      const byModel = all[key];
      if (byModel) {
        delete byModel[modelKey(model, optionsKey)];
        if (!Object.keys(byModel).length) delete all[key];
      }
      scheduleWrite();
      return { ok: true };
    },
  };
}

module.exports = { createCutEditsStore };
