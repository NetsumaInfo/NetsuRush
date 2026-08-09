// @ts-check
// core/projectSnapshot.js
// « Snapshot projet » : photo des données de LECTURE Resolve (Media Pool + timelines + arbre +
// vignettes) qui rend l'app agréable HORS LIGNE quand le logiciel de montage est fermé
// (core/hostPower.js). Motivation : fermer Resolve libère RAM/GPU pour une tâche lourde, mais les
// canaux resolve:list* renvoient alors vide → rushes et timelines DISPARAISSENT de l'UI. On sert
// donc ces lectures depuis ce cache pendant que l'hôte est fermé (UI reste peuplée = agréable),
// puis on efface le snapshot à la réouverture. Complémentaire de core/outbox.js (ÉCRITURES timeline
// différées) — lui gère les LECTURES cachées.
//
// Le cache se réchauffe PASSIVEMENT : chaque lecture en ligne réussie (`warm`) met à jour sa tranche.
// Il est donc toujours frais pendant l'usage normal, SANS dépendre du chemin de fermeture (une
// fermeture ratée, un crash de Resolve, ou un onglet jamais ouvert ne vident plus le cache). La
// capture explicite (`capture`, sweep complet) reste faite à la fermeture par ceinture+bretelles.
//
// Persisté dans NR_HOME → survit à un respawn du core (fréquent en dev : toute modif core/ le respawn).

const path = require('node:path');
const fs = require('node:fs');
const { t } = require('./i18n');
const { isRushPath } = require('./utils');

// Empreinte complète d'une timeline. Les anciens ids (`track:index:inFrame`) ne changent pas quand
// seule la fin, la position timeline, la source ou le FPS changeait : le snapshot restait alors
// silencieusement périmé. JSON suffit ici (données déjà petites et ordonnées par tlStart).
function cutsFingerprint(cuts) {
  if (!Array.isArray(cuts)) return '';
  return JSON.stringify(cuts.map((cut) => [
    String(cut && cut.path || ''), Number(cut && cut.track || 0), Number(cut && cut.tlStart || 0),
    Number(cut && cut.inFrame || 0), Number(cut && cut.outFrame || 0),
    Number(cut && cut.fps || 0), Number(cut && cut.srcFrames || 0),
  ]));
}

/**
 * @typedef {object} SnapshotData
 * @property {string|null} project
 * @property {number} at
 * @property {any} mediaPool   dernier listMediaPool en ligne (clips + project)
 * @property {any} mediaPoolAll dernier Media Pool complet en ligne (videos + audios, NetsuDraft)
 * @property {any} timelines   dernier listTimelines en ligne
 * @property {any} tree        dernier timelineTree en ligne
 * @property {{name:string,path:string,in:number}[]} thumbs  dernières vignettes en ligne
 * @property {Object<string, any[]>} cuts  plans (readTimelineCuts) par nom de timeline
 */

/**
 * @param {object} deps
 * @param {string} deps.dataDir
 * @param {(channel:string, payload:any)=>void} [deps.broadcast]
 */
function createProjectSnapshot({ dataDir, broadcast }) {
  const file = path.join(dataDir, 'project-snapshot.json');
  /** @type {SnapshotData|null} */
  let snap = null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && (raw.mediaPool || raw.timelines || raw.tree)) snap = raw;
  } catch (_) { /* premier lancement / pas de snapshot */ }

  function persist() {
    try {
      if (!snap) { try { fs.unlinkSync(file); } catch (_) {} return true; }
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(snap));
      fs.renameSync(tmp, file); // rename atomique
      return true;
    } catch (_) { return false; }
  }
  function emit() { try { broadcast && broadcast('snapshot:changed', state()); } catch (_) {} }

  // Écritures groupées : pendant un sweep (build) on ne persiste PAS à chaque timeline (60 écritures
  // synchrones d'un JSON qui grossit = lent + concurrence l'I/O). On marque `dirty` et on flush 1× à la fin.
  let batching = false, dirty = false, capturing = false;
  function flush() { const ok = persist(); emit(); dirty = false; return ok; }
  function touched() { if (batching) dirty = true; else flush(); }

  function has() { return !!snap; }

  function state() {
    if (!snap) return null;
    return {
      project: snap.project,
      at: snap.at,
      clips: (snap.mediaPool && snap.mediaPool.clips ? snap.mediaPool.clips.length : 0),
      timelines: (snap.timelines && snap.timelines.timelines ? snap.timelines.timelines.length : 0),
      cuts: (snap.cuts ? Object.keys(snap.cuts).length : 0),
    };
  }

  /** Snapshot courant si aucun projet demandé ou s'il correspond au projet stocké. */
  function get(project) {
    if (!snap) return null;
    if (project && snap.project && project !== snap.project) return null;
    return snap;
  }

  // Assure un objet snapshot pour `project` (réinitialise si le projet a changé → pas de mélange de
  // tranches de deux projets différents).
  function ensure(project) {
    const p = project || (snap && snap.project) || null;
    if (!snap || (p && snap.project && p !== snap.project)) {
      snap = { project: p, at: Date.now(), mediaPool: null, mediaPoolAll: null, timelines: null, tree: null, thumbs: [], cuts: {} };
    }
    if (!snap.cuts) snap.cuts = {}; // snapshot legacy chargé sans la tranche `cuts`
    if (!Array.isArray(snap.thumbs)) snap.thumbs = []; // snapshot legacy chargé avant les vignettes
    return snap;
  }

  // Réchauffe UNE tranche depuis une lecture en ligne réussie. Ignore les réponses hors-ligne/vides.
  // Pour 'cuts', `result` = { timelineName, cuts } : on indexe les plans par nom de timeline.
  /** @param {"mediaPool"|"mediaPoolAll"|"timelines"|"tree"|"thumbs"|"cuts"} kind @param {any} result */
  function warm(kind, result) {
    if (!result) return;
    try {
      if (kind === 'mediaPool') {
        if (!result.connected || !Array.isArray(result.clips)) return;
        const s = ensure(result.project || null);
        s.project = result.project || s.project;
        s.mediaPool = result;
      } else if (kind === 'mediaPoolAll') {
        if (!result.connected || !Array.isArray(result.clips)) return;
        const s = ensure(result.project || null);
        s.project = result.project || s.project;
        s.mediaPoolAll = result;
      } else if (kind === 'timelines') {
        if (!result.ok) return;
        ensure(null).timelines = result;
      } else if (kind === 'tree') {
        if (!result.ok) return;
        ensure(null).tree = result;
      } else if (kind === 'thumbs') {
        if (!result.ok || !Array.isArray(result.thumbs)) return;
        ensure(null).thumbs = result.thumbs;
      } else if (kind === 'cuts') {
        if (!result.timelineName || !Array.isArray(result.cuts)) return;
        const s = ensure(null);
        s.cuts[result.timelineName] = result.cuts;
        // La carte de timeline doit suivre le premier plan ACTUEL. On remplace aussi l'entrée
        // existante : une timeline éditée pouvait sinon conserver à vie la vignette de l'ancien plan.
        s.thumbs = s.thumbs.filter((thumb) => thumb && thumb.name !== result.timelineName);
        const first = result.cuts.find((cut) => cut && cut.path);
        if (first) s.thumbs.push({
          name: result.timelineName,
          path: first.path,
          in: Number.isFinite(Number(first.in)) ? Number(first.in) : 0,
        });
      } else return;
      snap.at = Date.now();
      touched();
    } catch (_) { /* best-effort */ }
  }

  // Sweep complet à la fermeture (host encore en ligne) : force les 4 lectures et les stocke. Belt
  // & suspenders au-dessus du réchauffage passif — garantit un cache même si un onglet n'a jamais
  // été ouvert. Renvoie { ok, project, clips }.
  /**
   * @param {object} readers
   * @param {() => Promise<any>} readers.listMediaPool
   * @param {() => Promise<any>} readers.listTimelines
   * @param {() => Promise<any>} readers.timelineTree
   * @param {() => Promise<any>} readers.timelineThumbs
   * @param {(name:string) => Promise<any>} [readers.readTimelineCutsByName]  plans d'UNE timeline
   * @param {(msg:string, pct:number|null)=>void} [onProgress]
   * @param {{skipExistingCuts?:boolean, project?:string, refreshTimeline?:string, scanTimelineThumbs?:boolean, beforeEach?:()=>Promise<void>, waitIfBusy?:boolean, requireComplete?:boolean}} [opts]
   *   incrémental + hook « céder au live » + fermeture sûre
   */
  async function capture(readers, onProgress, opts = {}) {
    const note = (msg, pct) => { try { onProgress && onProgress(msg, pct); } catch (_) {} };
    // Un seul sweep à la fois : les auto-déclencheurs (connexion + timelinesEpoch) peuvent en lancer
    // plusieurs → sans ce garde ils s'empileraient sur le pont séquentiel = extrêmement lent.
    if (capturing && opts.waitIfBusy) {
      note('Attente de la mise en cache en cours…', null);
      const deadline = Date.now() + 180_000;
      while (capturing && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (capturing) return { ok: false, busy: true, error: t('captureRunning') };
    capturing = true;
    batching = true;
    try {
      // Un build incrémental du même projet réutilise le Media Pool déjà persistant. Les lectures UI
      // réussies le réchauffent passivement ; le reparcourir à chaque montage était le plus gros scan.
      const sameProject = !!opts.project && !!snap && snap.project === opts.project;
      let mediaPoolAll = opts.skipExistingCuts && sameProject && snap && snap.mediaPoolAll
        ? snap.mediaPoolAll : null;
      if (!mediaPoolAll) {
        if (opts.beforeEach) await opts.beforeEach();
        mediaPoolAll = await readers.listMediaPool();
      }
      if (!mediaPoolAll || !mediaPoolAll.connected) return { ok: false, error: t('mediaPoolUnavailable') };
      const mediaPool = { ...mediaPoolAll, clips: (mediaPoolAll.clips || []).filter((clip) => isRushPath(clip && clip.path)) };
      if (!(opts.skipExistingCuts && sameProject && snap && snap.mediaPoolAll === mediaPoolAll)) {
        warm('mediaPoolAll', mediaPoolAll);
        warm('mediaPool', mediaPool);
      }
      // En fond, chaque lecture cède séparément au live. Le scan global des vignettes de timelines est
      // réservé au sweep forcé/fermeture : il relit toutes les timelines et bloquait l'interface.
      if (opts.beforeEach) await opts.beforeEach();
      const timelines = await readers.listTimelines().catch(() => null);
      const oldNames = sameProject && snap && snap.timelines && Array.isArray(snap.timelines.timelines)
        ? snap.timelines.timelines.map((timeline) => timeline.name) : [];
      const newNames = timelines && timelines.ok && Array.isArray(timelines.timelines)
        ? timelines.timelines.map((timeline) => timeline.name) : [];
      const sameTimelineList = oldNames.length === newNames.length && oldNames.every((name, index) => name === newNames[index]);
      let tree = opts.skipExistingCuts && sameProject && sameTimelineList && snap && snap.tree ? snap.tree : null;
      if (!tree) {
        if (opts.beforeEach) await opts.beforeEach();
        tree = await readers.timelineTree().catch(() => null);
      }
      const scanTimelineThumbs = opts.scanTimelineThumbs !== false;
      let thumbsRes = null;
      if (scanTimelineThumbs) {
        if (opts.beforeEach) await opts.beforeEach();
        thumbsRes = await readers.timelineThumbs().catch(() => null);
      }
      const sameTimelines = sameProject && snap && JSON.stringify(snap.timelines || null) === JSON.stringify(timelines || null);
      if (!sameTimelines) warm('timelines', timelines);
      if (!(opts.skipExistingCuts && sameProject && sameTimelineList && snap && snap.tree === tree)) warm('tree', tree);
      if (thumbsRes) warm('thumbs', thumbsRes);
      // Plans de TOUTES les timelines (l'utilisateur veut pouvoir les ouvrir toutes hors ligne). Lecture
      // SÉQUENTIELLE via le pont Python (chaque timeline = plusieurs allers-retours) → progression émise.
      // Best-effort par timeline : une lecture ratée n'interrompt pas le sweep. En mode incrémental,
      // on lit la géométrie puis on ne réécrit que les timelines réellement modifiées.
      const names = (timelines && timelines.ok && Array.isArray(timelines.timelines))
        ? timelines.timelines.map((t) => t.name) : [];
      const total = names.length;
      let done = 0, fresh = 0;
      let persisted = true;
      const failedCuts = [];
      batching = true; // sweep = 1 seule persistance à la fin (pas 60 écritures)
      try {
        // Une timeline supprimée dans Resolve ne doit pas survivre dans le cache hors ligne.
        const liveNames = new Set(names);
        const s = ensure(null);
        for (const cachedName of Object.keys(s.cuts)) {
          if (!liveNames.has(cachedName)) { delete s.cuts[cachedName]; dirty = true; }
        }
        const keptThumbs = s.thumbs.filter((thumb) => thumb && liveNames.has(thumb.name));
        if (keptThumbs.length !== s.thumbs.length) { s.thumbs = keptThumbs; dirty = true; }
        for (const name of names) {
          done++;
          const pct = Math.round((100 * done) / Math.max(1, total));
          const previous = snap && snap.cuts ? snap.cuts[name] : null;
          const needsRefresh = !!opts.refreshTimeline && opts.refreshTimeline === name;
          // Le build incrémental ne relit pas les timelines déjà cachées. Seule la timeline courante,
          // signalée modifiée par Resolve, est vérifiée ; les nouvelles timelines restent lues.
          if (opts.skipExistingCuts && !opts.requireComplete && previous && !needsRefresh) {
            note(`Déjà en cache… ${done}/${total}`, pct);
            continue;
          }
          // Basse priorité : cède au live (Media Pool/vignettes/ouverture de timeline) AVANT de reprendre
          // → les médias se chargent d'abord, le cache se remplit dans les creux.
          if (opts.beforeEach) await opts.beforeEach();
          note(`Mise en cache des plans… ${done}/${total}`, pct);
          if (!readers.readTimelineCutsByName) continue;
          const r = await readers.readTimelineCutsByName(name).catch(() => null);
          if (r && r.ok) {
            const timelineName = r.timeline || name;
            const previousCuts = snap && snap.cuts ? (snap.cuts[timelineName] || snap.cuts[name]) : null;
            const unchanged = opts.skipExistingCuts && previousCuts
              && cutsFingerprint(previousCuts) === cutsFingerprint(r.cuts);
            if (unchanged) {
              note(`Vérification… ${done}/${total}`, pct);
              continue;
            }
            if (snap && snap.cuts && timelineName !== name) delete snap.cuts[name];
            warm('cuts', { timelineName, cuts: r.cuts }); fresh++;
            // CHECKPOINT périodique : on persiste tous les 3 timelines lus. Sinon (persist uniquement à
            // la fin) une interruption AVANT la fin — navigation, restart, fermeture — perdait TOUT le
            // sweep → le build repartait de zéro à chaque fois (le bug « c'est toujours 3/64 »). Avec le
            // checkpoint, les timelines déjà lues survivent → la reprise les SAUTE (vérification).
            if (fresh % 3 === 0) persist();
          } else failedCuts.push(name);
        }
      } finally {
        batching = false;
        if (dirty || fresh) persisted = flush(); // persiste le reste une dernière fois
      }
      // Aucun changement = aucune réécriture atomique du gros JSON. Un build incrémental déjà chaud
      // devient ainsi réellement gratuit côté disque et ne réveille pas inutilement le renderer.
      if (!fs.existsSync(file)) persisted = persist() && persisted;
      if (opts.requireComplete) {
        if (!timelines || !timelines.ok || !tree || !tree.ok || (scanTimelineThumbs && (!thumbsRes || !thumbsRes.ok))) {
          return { ok: false, error: t('projectCacheIncomplete') };
        }
        if (failedCuts.length) {
          return { ok: false, error: `${t('projectCacheIncomplete')} (${failedCuts.join(', ')})` };
        }
        if (!persisted) return { ok: false, error: t('projectCacheWriteFailed') };
      }
      return { ok: true, project: snap ? snap.project : null, clips: (mediaPool.clips || []).length, timelines: total, fresh };
    } catch (e) {
      batching = false;
      return { ok: false, error: String(e) };
    } finally {
      if (batching) {
        batching = false;
        if (dirty) flush();
      }
      capturing = false; // TOUJOURS libéré (y compris early-return Media Pool) → pas de blocage « busy » perpétuel
    }
  }

  function clear() {
    snap = null;
    persist(); emit();
    return { ok: true };
  }

  return { capture, warm, get, has, clear, state };
}

module.exports = { createProjectSnapshot, cutsFingerprint };
