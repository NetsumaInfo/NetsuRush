// @ts-check
// Variante SigLIP 2 ACTIVE pour NetsuSearch : choisie à l'installation, changeable ensuite.
//
// Les embeddings sont indexés PAR TAG de modèle (python/nrsearch : colonne `model` de
// frame_embeddings_v1, tag = nom du dossier du modèle). Changer de variante n'écrase donc RIEN :
// l'index de l'ancienne reste sur disque et la nouvelle repart de zéro. C'est aussi pourquoi la
// bascule impose une ré-indexation complète — deux variantes n'ont ni la même dimension d'embedding
// ni le même espace vectoriel, leurs scores ne sont pas comparables.
//
// La bascule met à jour nr.config.json ET DETECT_ENV (les daemons lisent l'env au spawn), puis tue
// les daemons de recherche : le prochain job charge la nouvelle variante sans redémarrer le core.

const { CONFIG, DETECT_ENV, saveConfig } = require('./config');
const { MANIFEST, modelDir, statusOf } = require('./models');
const { hasFiles } = require('./utils');
const { t } = require('./i18n');

const DEFAULT_SEARCH_MODEL = 'siglip2-so400m';

/** Variantes de recherche du manifeste (source unique : `task: 'search'`). */
function searchModelIds() {
  return Object.keys(MANIFEST).filter((id) => MANIFEST[id].task === 'search');
}

/** Id de la variante active (config du setup, sinon défaut du catalogue). */
function activeSearchModelId() {
  const configured = String(CONFIG.siglipModelId || CONFIG.siglipModel || '');
  return searchModelIds().includes(configured) ? configured : DEFAULT_SEARCH_MODEL;
}

// Dossier réellement chargeable pour une variante : celui du gestionnaire de modèles, ou le chemin
// provisionné à l'installation pour la variante active. Un dossier vide ne compte pas : transformers
// échouerait au chargement là où l'absence de dossier laisse au moins un message clair.
function modelDirOf(id) {
  const managed = modelDir(id);
  if (hasFiles(managed)) return managed;
  if (id === activeSearchModelId() && hasFiles(CONFIG.siglipDir)) return String(CONFIG.siglipDir);
  return null;
}

/**
 * État du sélecteur : variante active + ce que chaque variante a déjà indexé.
 * @param {{ indexedByModel?: () => Record<string, { clips: number, frames: number }> }} [catalog]
 */
function searchModelState(catalog) {
  const indexed = catalog && catalog.indexedByModel ? catalog.indexedByModel() : {};
  const active = activeSearchModelId();
  return {
    ok: true,
    active,
    models: searchModelIds().map((id) => {
      const counts = indexed[id] || { clips: 0, frames: 0 };
      return {
        id,
        active: id === active,
        installed: statusOf(id).installed === true,
        ready: !!modelDirOf(id),
        indexedClips: counts.clips,
        indexedFrames: counts.frames,
      };
    }),
  };
}

/**
 * Bascule la variante active. `restart` = arrêt des daemons de recherche (injecté par rpc.js pour
 * garder ce module sans dépendance aux sidecars).
 * @param {string} id
 * @param {{ restart?: () => void, catalog?: { indexedByModel?: () => Record<string, { clips: number, frames: number }> } }} [deps]
 */
function setSearchModel(id, deps = {}) {
  const wanted = String(id || '');
  if (!searchModelIds().includes(wanted)) return { ok: false, error: `${t('unknownModel')}: ${wanted}` };
  const dir = modelDirOf(wanted);
  if (!dir) return { ok: false, error: `${t('modelNotDownloaded')}: ${wanted}`, needsDownload: true };
  const saved = saveConfig({ siglipDir: dir, siglipModel: wanted, siglipModelId: wanted });
  if (!saved.ok) return { ok: false, error: saved.error };
  DETECT_ENV.NETSURUSH_SIGLIP_DIR = dir;
  DETECT_ENV.NETSURUSH_SIGLIP_MODEL = wanted;
  if (deps.restart) deps.restart();
  return searchModelState(deps.catalog);
}

module.exports = { DEFAULT_SEARCH_MODEL, searchModelIds, activeSearchModelId, searchModelState, setSearchModel };
