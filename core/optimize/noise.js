// @ts-check
// Registre du BRUIT D'ARRIÈRE-PLAN : les processus qui tournent en permanence sur un poste Windows
// sans rien apporter pendant un montage ou un rendu.
//
// Pourquoi ce module existe : le nettoyage de processus ne captait que le statut Windows
// « Ne répond pas ». Or un updater Adobe, OneDrive, la superposition GeForce ou un helper Discord
// répondent parfaitement — ils ne sont jamais « figés ». Le bouton ne trouvait donc quasiment rien,
// alors que ces familles-là sont exactement la RAM et les sessions d'encodeur qui manquent au rendu.
//
// Le cas le plus coûteux pour NetsuRush est la superposition GeForce : elle RÉSERVE une session NVENC,
// donc elle concurrence directement l'encodage des proxies, en plus de sa RAM.
//
// Module PUR (aucune I/O, aucun require) : classer un nom de processus est une décision, pas un effet
// de bord — elle se teste sans Windows.

/**
 * @typedef {'updater'|'overlay'|'sync'|'social'|'browser'} NoiseCategory
 * @typedef {'low'|'medium'} NoiseRisk
 *   low    = aucun travail utilisateur en jeu, le service revient de lui-même
 *   medium = application visible : rien n'est perdu, mais l'utilisateur voit sa fenêtre disparaître
 * @typedef {'auto'|'manual'} NoiseRestart  comment le processus revient après un arrêt
 */

/**
 * @typedef {Object} NoiseFamily
 * @property {string} id           identifiant stable (clé i18n côté renderer)
 * @property {NoiseCategory} category
 * @property {NoiseRisk} risk
 * @property {NoiseRestart} restart
 * @property {RegExp} match        testé sur le nom d'image SANS extension, en minuscules
 */

/**
 * Familles reconnues. La liste est volontairement CONSERVATRICE : un processus non listé sort en
 * « inconnu » et n'est jamais proposé à l'arrêt. Mieux vaut rater du bruit que proposer de tuer
 * l'outil dont l'utilisateur se sert.
 * @type {NoiseFamily[]}
 */
const NOISE_FAMILIES = [
  {
    id: "updaters",
    category: "updater",
    risk: "low",
    restart: "auto",
    match:
      /^(googleupdate|microsoftedgeupdate|adobeupdateservice|adobegcclient|agsservice|agmservice|adobe desktop service|ccxprocess|cclibrary|creative cloud( helper)?|jusched|gameoverlayui)$/,
  },
  {
    id: "overlays",
    category: "overlay",
    risk: "low",
    restart: "auto",
    // La superposition NVIDIA tient une session NVENC → elle bride l'encodage des proxies.
    match: /^(nvidia share|nvidia overlay|gamebar|gamebarftserver|xboxgamebarwidgets|gamebarpresencewriter)$/,
  },
  {
    id: "sync",
    category: "sync",
    risk: "low",
    restart: "auto",
    match: /^(onedrive|dropbox|googledrivefs|googledrivesync|megasync|nextcloud)$/,
  },
  {
    id: "social",
    category: "social",
    risk: "medium",
    restart: "manual",
    match: /^(discord|slack|teams|ms-teams|spotify|steamwebhelper|epicgameslauncher|whatsapp)$/,
  },
  {
    id: "browsers",
    category: "browser",
    risk: "medium",
    restart: "manual",
    match: /^(chrome|msedge|firefox|brave|opera|vivaldi)$/,
  },
];

/**
 * Noyau Windows, session et shell : arrêt interdit, sans discussion. Les hôtes de montage et le
 * pilote graphique vivent dans `core/hostImages.js` (source unique partagée avec l'alimentation
 * d'hôte et le pont Adobe) — ils sont fusionnés ici par `createClassifier`.
 */
const SYSTEM_BASES = [
  "system", "registry", "idle", "memcompression", "smss", "csrss", "wininit", "winlogon",
  "services", "lsass", "lsaiso", "svchost", "dwm", "explorer", "fontdrvhost", "sihost", "ctfmon",
  "taskhostw", "conhost", "runtimebroker", "searchhost", "searchindexer", "shellexperiencehost",
  "startmenuexperiencehost", "textinputhost", "audiodg", "wudfhost", "msmpeng", "securityhealthservice",
];

/** Nos propres processus : le core Node et les sidecars python. */
const OWN_BASES = ["node", "python", "pythonw", "ffmpeg", "ffprobe"];

/** @typedef {'system'|'host'|'own'|'noise'|'unknown'} ProcClass */

/**
 * @typedef {Object} ProcVerdict
 * @property {ProcClass} kind
 * @property {string|null} family    id de famille quand `kind === 'noise'`
 * @property {NoiseCategory|null} category
 * @property {NoiseRisk|null} risk
 * @property {NoiseRestart|null} restart
 * @property {boolean} critical      arrêt interdit (système, hôte de montage, nos propres process)
 */

/** @type {ProcVerdict} */
const UNKNOWN = { kind: "unknown", family: null, category: null, risk: null, restart: null, critical: false };

/**
 * Fabrique un classifieur. Les bases protégées des hôtes sont INJECTÉES pour garder ce module pur et
 * testable, et pour que l'unique liste de `hostImages.js` reste la seule vérité.
 * @param {{ hostBases: Set<string> }} deps
 */
function createClassifier({ hostBases }) {
  const system = new Set(SYSTEM_BASES);
  const own = new Set(OWN_BASES);

  /**
   * @param {string} name nom de processus, avec ou sans `.exe`
   * @returns {ProcVerdict}
   */
  function classify(name) {
    const base = String(name || "").toLowerCase().replace(/\.exe$/i, "");
    if (!base) return UNKNOWN;
    if (system.has(base)) return { ...UNKNOWN, kind: "system", critical: true };
    if (hostBases.has(base)) return { ...UNKNOWN, kind: "host", critical: true };
    if (own.has(base)) return { ...UNKNOWN, kind: "own", critical: true };
    for (const f of NOISE_FAMILIES) {
      if (f.match.test(base)) {
        return {
          kind: "noise",
          family: f.id,
          category: f.category,
          risk: f.risk,
          restart: f.restart,
          critical: false,
        };
      }
    }
    return UNKNOWN;
  }

  return { classify };
}

module.exports = { NOISE_FAMILIES, SYSTEM_BASES, OWN_BASES, createClassifier };
