// @ts-check
// Rechargement à chaud d'un sous-arbre de modules, EN DÉVELOPPEMENT SEULEMENT.
//
// La coquille Tauri spawn le core au démarrage et ne le respawn jamais : toute modification de
// `core/**` imposait donc de fermer la fenêtre et de relancer `npm run tauri dev`, soit une minute
// à chaque essai. Ici on purge le cache `require` du sous-arbre surveillé et on redemande à
// l'appelant de reconstruire son objet — le process, lui, ne bouge pas.
//
// Portée VOLONTAIREMENT étroite : seuls les modules PURS ou sans état persistant peuvent être
// rechargés ainsi. Un module qui tient un socket, un daemon Python ou un abonnement SSE garderait
// l'ancien exemplaire vivant en plus du neuf — deux vérités concurrentes, pire que le redémarrage
// qu'on cherche à éviter.

const fs = require("fs");
const path = require("path");

/** Temporisation d'inactivité : un éditeur écrit un fichier en plusieurs fois. */
const SETTLE_MS = 250;

function isDevelopment() {
  return process.env.NODE_ENV !== "production";
}

/** Modules du cache `require` situés SOUS ce dossier. */
function cachedUnder(dir) {
  const prefix = path.resolve(dir) + path.sep;
  return Object.keys(require.cache).filter((file) => file.startsWith(prefix));
}

function purge(dir) {
  const files = cachedUnder(dir);
  for (const file of files) delete require.cache[file];
  return files.length;
}

/**
 * Surveille un dossier de `core/` et rappelle `rebuild` après chaque modification.
 * @param {string} dir dossier absolu à surveiller
 * @param {() => void} rebuild reconstruit ce qui dépend des modules purgés
 * @param {{ label?: string, also?: string[] }} [opts] `also` : autres dossiers à purger au passage.
 *   Purger le seul dossier surveillé ne suffit pas quand ses modules ONT DÉJÀ capturé les fonctions
 *   d'un voisin (`const { f } = require("../autre")`) : le voisin rechargé, l'ancien exemplaire
 *   reste tenu par la référence capturée, et la modification n'a aucun effet visible.
 * @returns {() => void} arrête la surveillance
 */
function watchModules(dir, rebuild, opts = {}) {
  if (!isDevelopment() || !fs.existsSync(dir)) return () => {};
  const label = opts.label || path.basename(dir);
  let timer = null;
  let watcher = null;
  try {
    watcher = fs.watch(dir, { recursive: true }, (_event, file) => {
      if (file && !/\.(js|cjs|json)$/.test(String(file))) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        let count = purge(dir);
        for (const other of opts.also || []) count += purge(other);
        try {
          rebuild();
          console.log(`[dev] ${label} rechargé (${count} module(s)) — pas besoin de redémarrer.`);
        } catch (error) {
          // Un module à moitié écrit casse le require : on le dit et on garde l'ancien objet,
          // qui vient d'être remplacé par… rien. La prochaine sauvegarde réparera.
          console.warn(`[dev] ${label} : rechargement refusé (${(error && error.message) || error})`);
        }
      }, SETTLE_MS);
    });
  } catch (error) {
    console.warn(`[dev] surveillance de ${label} indisponible :`, (error && error.message) || error);
    return () => {};
  }
  return () => {
    if (timer) clearTimeout(timer);
    if (watcher) watcher.close();
  };
}

module.exports = { watchModules, isDevelopment };
