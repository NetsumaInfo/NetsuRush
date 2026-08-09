// @ts-check
// core/resolve-watch.js
// Synchro renderer↔Resolve. Resolve n'expose AUCUNE API d'événements → on POLL une signature
// LÉGÈRE (projet / timeline ouverte / nb clips Media Pool / nb timelines), puis on DIFF. Sur
// changement, broadcast SSE `resolve:changed` { status?, mediaPool?, timelines? } → le renderer
// refetch ciblé (statut, Media Pool, liste des timelines). Le renderer déclenche aussi un poll
// immédiat au focus fenêtre (canal resolve:refreshNow). Suspendu pendant les ops lourdes
// (cut / build / AE / index) qui occupent déjà le pont Python (pause/resume imbriqués).
//
// Cadence ADAPTATIVE : tant que Resolve est HORS LIGNE (ou statut pas encore mesuré), on POLL VITE
// (FAST_INTERVAL) → l'app se reconnecte SEULE en quelques secondes dès que Resolve s'ouvre, sans
// que l'utilisateur ait à presser « rafraîchir ». Une fois CONNECTÉ, on repasse en cadence LENTE
// (interval) : le diff de signature est juste là pour capter les changements de projet/clips.

const DEFAULT_INTERVAL = 90_000;
const DEFAULT_FAST_INTERVAL = 6_000;

function createResolveWatch({ broadcast, getSignature, onReconnect, interval = DEFAULT_INTERVAL, fastInterval = DEFAULT_FAST_INTERVAL }) {
  let timer = null;
  let running = false;   // boucle active (start/stop) — distinct de `timer` (re-planifié à chaque tick)
  let paused = 0;        // compteur de pauses imbriquées (ops lourdes)
  let polling = false;   // un poll en vol → jamais de chevauchement
  let last = null;       // dernière signature connue (null = pas encore mesurée)

  async function poll(force = false) {
    if (polling) return;
    if (paused > 0 && !force) return;
    polling = true;
    try {
      const sig = await getSignature();
      const prev = last;
      last = sig;
      // Première mesure : le renderer a déjà chargé au démarrage → on mémorise sans diffuser.
      if (!prev) return;
      const connChanged = !!prev.connected !== !!sig.connected;
      // Transition HORS LIGNE → EN LIGNE : Resolve vient de rouvrir → flush de la file d'attente
      // (« cache projet » : les envois différés pendant que Resolve était fermé s'appliquent).
      if (connChanged && sig.connected && typeof onReconnect === "function") {
        try { onReconnect(); } catch { /* le flush gère ses erreurs */ }
      }
      const changes = {};
      if (connChanged || prev.project !== sig.project || prev.timeline !== sig.timeline) changes.status = true;
      // clipCount = -1 ⇒ comptage en échec (transitoire) → on n'invalide pas sur cette mesure.
      if (connChanged || (sig.clipCount >= 0 && prev.clipCount >= 0 && prev.clipCount !== sig.clipCount)) changes.mediaPool = true;
      if (connChanged || prev.tlCount !== sig.tlCount
        || (prev.tlFingerprint != null && sig.tlFingerprint != null && prev.tlFingerprint !== sig.tlFingerprint)) {
        changes.timelines = true;
      }
      if (Object.keys(changes).length) broadcast("resolve:changed", changes);
    } catch {
      /* le pont gère ses erreurs ; un poll raté n'interrompt pas la boucle */
    } finally {
      polling = false;
    }
  }

  // Délai du prochain tick : rapide tant qu'on n'est pas connecté (reconnexion auto), lent une fois
  // en ligne. `last` null (pas encore mesuré) ⇒ rapide pour établir la baseline sans attendre 90 s.
  function nextDelay() {
    return last && last.connected ? interval : fastInterval;
  }

  function schedule() {
    if (!running) return;
    timer = setTimeout(tick, nextDelay());
    if (timer.unref) timer.unref(); // ne maintient pas le process en vie à lui seul
  }

  async function tick() {
    await poll(false);
    schedule(); // re-planifie selon l'état de connexion fraîchement mesuré
  }

  return {
    start() {
      if (running) return;
      running = true;
      schedule();
    },
    stop() { running = false; if (timer) { clearTimeout(timer); timer = null; } },
    pause() { paused++; },
    resume() { if (paused > 0) paused--; },
    // Poll immédiat (focus fenêtre) — ignore la pause pour répondre vite ; le guard `polling` tient.
    refreshNow() { return poll(true); },
  };
}

module.exports = { createResolveWatch };
