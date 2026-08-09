// @ts-check
// Cache de SESSION : fichiers volumineux utiles uniquement tant que NetsuRush reste ouvert.
//
// Deux barrières complémentaires :
//  - resetSync() au boot supprime les restes d'un crash et les anciens emplacements historiques ;
//  - cleanup() à l'arrêt est appelé après l'extinction des sidecars. La coquille Tauri refait la
//    suppression en dernier recours si Node ne répond pas.

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  NR_HOME, SESSION_CACHE_ROOT, VOICE_DIR, UPSCALE_TEST_DIR, ROTO_DIR, SEQ_DIR,
} = require('./config');

const SESSION_DIRS = [VOICE_DIR, UPSCALE_TEST_DIR, ROTO_DIR, SEQ_DIR];

// Emplacements utilisés avant l'introduction du cache de session unifié. Ils ne contiennent que des
// dérivés régénérables ; les nettoyer une fois rend immédiatement l'espace déjà gaspillé.
const LEGACY_ROOTS = [
  path.join(NR_HOME, 'roto-cache'),
  path.join(os.tmpdir(), 'nr-roto-cache'),
  path.join(os.tmpdir(), 'netsurush-voice'),
  path.join(os.tmpdir(), 'netsurush-upscale-test'),
  path.join(os.tmpdir(), 'netsurush-seq-frames'),
];

// Suffixe des dossiers mis de côté au démarrage, en attente d'effacement en arrière-plan.
const TOMB_SUFFIX = '.discarded-';

function recreateSync() {
  for (const dir of SESSION_DIRS) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  }
}

/** Efface sans bloquer et sans jamais faire tomber le core : ce sont des dérivés régénérables. */
function removeInBackground(dir) {
  setTimeout(() => {
    fs.promises.rm(dir, { recursive: true, force: true })
      .catch((error) => console.warn('cache de session : suppression différée impossible', dir, String(error)));
  }, 0);
}

/** Écarte un dossier du chemin de démarrage. Le renommage est en O(1) quel que soit le nombre de
 * fichiers dedans ; seule la suppression, elle, est coûteuse — elle part en arrière-plan. Si le
 * renommage échoue (fichier verrouillé, volume différent), on retombe sur la suppression synchrone :
 * recréer par-dessus un dossier en cours d'effacement produirait un cache à moitié vivant. */
function discardSync(dir) {
  if (!fs.existsSync(dir)) return;
  const tomb = `${dir}${TOMB_SUFFIX}${process.pid}`;
  try {
    fs.renameSync(dir, tomb);
    removeInBackground(tomb);
  } catch (_) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

/** Supprime les dossiers temporaires uniques laissés par une opération interrompue, ainsi que les
 * dossiers écartés par un démarrage précédent. On ne touche qu'aux préfixes NetsuRush connus et
 * seulement s'ils ont au moins une heure, pour ne pas gêner un second processus de développement
 * éventuellement encore actif. Balayage complet de %TEMP% (readdir + stat par entrée) : jamais dans
 * le chemin de démarrage. */
async function purgeStaleOperationDirs() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  const prefixes = ['nr-pid-', 'netsurush-frames-', 'netsurush-export-', 'nr-pip-'];
  let entries = [];
  try { entries = await fs.promises.readdir(os.tmpdir(), { withFileTypes: true }); } catch (_) { return; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const stale = prefixes.some((prefix) => entry.name.startsWith(prefix));
    // Une tombe d'un run précédent (core tué avant la fin de sa suppression différée) n'a pas d'âge
    // minimum à respecter : plus personne ne la lit, son nom porte le pid mort qui l'a écartée.
    const tomb = entry.name.includes(TOMB_SUFFIX);
    if (!stale && !tomb) continue;
    const full = path.join(os.tmpdir(), entry.name);
    try {
      if (tomb || (await fs.promises.stat(full)).mtimeMs < cutoff) {
        await fs.promises.rm(full, { recursive: true, force: true });
      }
    } catch (_) {}
  }
}

// Appelé AVANT l'ouverture du port : tout ce qui est coûteux doit en sortir. Une session
// interrompue peut laisser des dizaines de milliers d'images (roto, séquences) ; les effacer ici
// retardait `listen()` de plusieurs secondes et le renderer, lui, abandonne — l'utilisateur voyait
// « core indisponible » alors que le service arrivait juste après.
/** Un autre core est-il vivant ? Il publie son pid en même temps que son port (server.js). Depuis
 * que le port se choisit tout seul, deux instances peuvent tourner en même temps — et elles
 * partagent ce dossier temporaire. Purger à l'aveugle arrachait alors ses fichiers de travail à
 * l'instance déjà en route (roto, voix : `EPERM` sur les fichiers ouverts, images disparues en
 * pleine propagation). */
function anotherCoreAlive() {
  try {
    const { pid } = JSON.parse(fs.readFileSync(path.join(NR_HOME, 'core-port.json'), 'utf8'));
    if (!pid || pid === process.pid) return false;
    process.kill(pid, 0); // ne tue rien : teste l'existence du processus
    return true;
  } catch (_) {
    return false; // fichier absent, illisible, ou processus mort
  }
}

function resetSync() {
  // Les dossiers manquants doivent exister quoi qu'il arrive ; seule la PURGE est conditionnelle.
  if (anotherCoreAlive()) {
    recreateSync();
    return;
  }
  discardSync(SESSION_CACHE_ROOT);
  // Les anciens chemins doivent disparaître immédiatement eux aussi : les renommer garde le boot
  // en O(1), puis leur contenu est supprimé en arrière-plan sans laisser l'ancien cache visible.
  for (const dir of LEGACY_ROOTS) discardSync(dir);
  recreateSync();
  void purgeStaleOperationDirs();
}

async function cleanup() {
  try { await fs.promises.rm(SESSION_CACHE_ROOT, { recursive: true, force: true }); } catch (_) {}
}

module.exports = { resetSync, cleanup, SESSION_DIRS, LEGACY_ROOTS };
