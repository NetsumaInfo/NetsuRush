// @ts-check
// Politiques de nettoyage automatique, UNE PAR TYPE de cache.
//
// Chaque type se règle indépendamment : un quota (Go, appliqué en LRU — les entrées les moins
// récemment utilisées partent d'abord) et un âge (jours sans utilisation). Un quota sur les proxies
// n'a rien à voir avec un quota sur les embeddings : les premiers se régénèrent en une seconde, les
// seconds coûtent des heures de GPU. D'où le réglage séparé plutôt qu'un seuil global qui arbitrerait
// à la place de l'utilisateur.
//
// Les caches à régénération rapide ont des bornes prudentes par défaut ; les analyses coûteuses
// (détection, transcription, embeddings) restent manuelles. Les caches de session sont gérés par
// sessionCache.js et ne sont jamais purgés pendant une opération active.
//
// Persisté dans nr.config.json (`CONFIG.cache`), pas en localStorage : ces règles s'appliquent au boot
// du core, qui tourne headless et ne voit pas le navigateur.

const { CONFIG, CACHE_KINDS, saveConfig } = require('./config');
const cacheDb = require('./cacheDb');

const GB = 1024 * 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;
const POLICY_VERSION = 3;
const SESSION_KINDS = new Set(['voice', 'upscaleTest', 'roto']);
const SESSION_TRIGGERS = new Set(['operation', 'page', 'app']);

/** Réglages par défaut : rapide à régénérer = borné ; calcul coûteux = conservé. */
function defaults() {
  /** @type {Record<string, { auto: boolean, maxGb: number|null, maxDays: number|null }>} */
  const kinds = {};
  for (const k of CACHE_KINDS) kinds[k] = { auto: false, maxGb: null, maxDays: null };
  kinds.thumb = { auto: true, maxGb: 4, maxDays: 30 };
  kinds.proxy = { auto: true, maxGb: 8, maxDays: 7 };
  // `auto:true` décrit leur cycle de vie dans l'API ; quota/âge ne s'appliquent pas. Leur déclencheur
  // métier est configuré séparément et la fermeture reste le filet de sécurité final.
  for (const k of SESSION_KINDS) kinds[k] = { auto: true, maxGb: null, maxDays: null };
  return {
    policyVersion: POLICY_VERSION,
    dir: null,
    // Déclencheur adapté à la vraie durée d'utilité de chaque dérivé :
    // - Roto : garder seulement le plan actif ;
    // - tests : garder seulement la dernière comparaison ;
    // - audio : garder pendant le travail dans la page Voix.
    session: { roto: 'operation', upscaleTest: 'operation', voice: 'page' },
    // Avertir ≠ supprimer. Actifs par défaut : ils informent sans rien détruire.
    warn: { enabled: true, gb: 50 },
    disk: { enabled: true, freeGb: 20 },
    kinds,
  };
}

/** Fusionne la config utilisateur avec les défauts et borne les valeurs aberrantes. */
function settings() {
  const d = defaults();
  const c = (CONFIG.cache || {});
  const migrated = Number(c.policyVersion || 0) < POLICY_VERSION;
  /** @type {typeof d.kinds} */
  const kinds = {};
  for (const k of CACHE_KINDS) {
    const u = (c.kinds && c.kinds[k]) || {};
    // v2 introduit les bornes recommandées. Une ancienne config enregistrait `false` pour TOUS les
    // types même si l'utilisateur n'avait touché qu'à une alerte : pendant la migration, on applique
    // donc les nouveaux défauts aux caches rapides. Le premier changement UI persiste policyVersion.
    const useDefaults = migrated && (k === 'thumb' || k === 'proxy' || SESSION_KINDS.has(k));
    kinds[k] = {
      auto: useDefaults ? d.kinds[k].auto : (Object.hasOwn(u, 'auto') ? !!u.auto : d.kinds[k].auto),
      maxGb: useDefaults ? d.kinds[k].maxGb : (Object.hasOwn(u, 'maxGb') ? num(u.maxGb) : d.kinds[k].maxGb),
      maxDays: useDefaults ? d.kinds[k].maxDays : (Object.hasOwn(u, 'maxDays') ? num(u.maxDays) : d.kinds[k].maxDays),
    };
  }
  return {
    policyVersion: POLICY_VERSION,
    dir: c.dir || null,
    session: {
      roto: sessionTrigger(c.session && c.session.roto, d.session.roto),
      upscaleTest: sessionTrigger(c.session && c.session.upscaleTest, d.session.upscaleTest),
      voice: sessionTrigger(c.session && c.session.voice, d.session.voice),
    },
    warn: { enabled: c.warn ? !!c.warn.enabled : d.warn.enabled, gb: num(c.warn && c.warn.gb) ?? d.warn.gb },
    disk: { enabled: c.disk ? !!c.disk.enabled : d.disk.enabled, freeGb: num(c.disk && c.disk.freeGb) ?? d.disk.freeGb },
    kinds,
  };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function sessionTrigger(value, fallback) {
  return SESSION_TRIGGERS.has(value) ? value : fallback;
}

/** Enregistre un patch de réglages. `dir` n'est PAS modifiable ici : changer de dossier implique une
 *  migration de fichiers → cacheMove.setDir. */
function setSettings(patch) {
  const cur = settings();
  const p = patch || {};
  const next = {
    ...cur,
    policyVersion: POLICY_VERSION,
    session: { ...cur.session, ...(p.session || {}) },
    warn: { ...cur.warn, ...(p.warn || {}) },
    disk: { ...cur.disk, ...(p.disk || {}) },
    kinds: { ...cur.kinds },
  };
  for (const [k, v] of Object.entries(p.kinds || {})) {
    if (!CACHE_KINDS.includes(k)) continue;
    next.kinds[k] = { ...next.kinds[k], .../** @type {any} */ (v) };
  }
  next.dir = cur.dir;
  for (const [kind, trigger] of Object.entries(next.session)) {
    next.session[kind] = sessionTrigger(trigger, cur.session[kind]);
  }
  const r = saveConfig({ cache: next });
  // CONFIG est figé au require → on met aussi à jour l'objet en mémoire, sinon les politiques
  // continueraient de s'appliquer avec les anciennes valeurs jusqu'au prochain démarrage.
  CONFIG.cache = next;
  return { ...r, settings: next };
}

function createCachePolicy({ cacheIndex, admin, broadcast }) {
  /** @type {NodeJS.Timeout|null} */
  let periodic = null;
  /**
   * Applique les politiques de TOUS les types dont `auto` est vrai.
   * Ordre : l'âge d'abord (critère franc), puis le quota sur ce qui reste (LRU).
   */
  async function apply() {
    const s = settings();
    let freed = 0;
    let files = 0;
    for (const kind of CACHE_KINDS) {
      const k = s.kinds[kind];
      if (!k || !k.auto) continue;
      if (SESSION_KINDS.has(kind)) continue;
      // Les types en base ne sont pas dans l'index latéral (pas de mtime par entrée) : on ne sait pas
      // les trier par usage. Ils restent en purge manuelle uniquement.
      if (cacheDb.DB_KINDS.includes(kind)) continue;
      try {
        const r = await applyKind(kind, k);
        freed += r.freed;
        files += r.files;
      } catch (_) {}
    }
    if (files && broadcast) broadcast('cache:changed', { freed, files, auto: true });
    return { ok: true, freed, files };
  }

  /** @param {string} kind @param {{ maxGb: number|null, maxDays: number|null }} k */
  async function applyKind(kind, k) {
    /** @type {string[]} */
    const doomed = [];
    let rows = cacheIndex.lru(kind);   // déjà trié : le moins récemment utilisé d'abord

    if (k.maxDays) {
      const cutoff = Date.now() - k.maxDays * DAY;
      for (const r of rows) if (r.used < cutoff) doomed.push(r.file);
      const gone = new Set(doomed);
      rows = rows.filter((r) => !gone.has(r.file));
    }
    if (k.maxGb) {
      const cap = k.maxGb * GB;
      let total = rows.reduce((s, r) => s + r.bytes, 0);
      for (const r of rows) {
        if (total <= cap) break;
        doomed.push(r.file);
        total -= r.bytes;
      }
    }
    if (!doomed.length) return { freed: 0, files: 0 };
    return admin.rmFiles(doomed);
  }

  /**
   * Contrôle des seuils d'alerte. Ne supprime RIEN : émet `cache:warn`, l'UI décide de l'afficher
   * (pastille, bannière, notice au démarrage).
   */
  async function check() {
    const s = settings();
    /** @type {{ kind: string, bytes?: number, gb?: number, freeGb?: number }[]} */
    const alerts = [];
    let total = 0;
    try {
      const ov = await admin.overview();
      // Poids réel sur disque : le seuil doit se déclencher même sur des caches pas encore indexés
      // (sinon il resterait muet tant que « Réindexer » n'a pas tourné).
      total = Math.max(ov.total, ov.totalOnDisk || 0);
      if (s.warn.enabled && total > s.warn.gb * GB) alerts.push({ kind: 'cache', bytes: total, gb: s.warn.gb });
      if (s.disk.enabled && ov.disk && ov.disk.free < s.disk.freeGb * GB) {
        alerts.push({ kind: 'disk', bytes: ov.disk.free, freeGb: s.disk.freeGb });
      }
    } catch (_) {}
    const payload = { alerts, total, at: Date.now() };
    if (broadcast) broadcast('cache:warn', payload);
    return payload;
  }

  async function runMaintenance() {
    try { cacheIndex.pruneMissing(); } catch (_) {}
    try { await apply(); } catch (_) {}
    try { await check(); } catch (_) {}
  }

  /** Appelé une fois au boot puis toutes les 30 minutes. L'entretien périodique évite qu'une longue
   *  session de dérush dépasse indéfiniment les bornes, sans ajouter de travail au chemin chaud. */
  function boot() {
    setTimeout(() => {
      void runMaintenance();
    }, 4000).unref?.();
    periodic = setInterval(() => void runMaintenance(), 30 * 60 * 1000);
    periodic.unref?.();
  }

  function stop() {
    if (periodic) clearInterval(periodic);
    periodic = null;
  }

  function shouldClearSession(kind, trigger) {
    const configured = settings().session[kind];
    const rank = { operation: 0, page: 1, app: 2 };
    // Le choix est une durée MAXIMALE : « au changement » implique aussi de nettoyer si l'utilisateur
    // quitte directement la page avant de changer de source. La fermeture reste le dernier niveau.
    return SESSION_KINDS.has(kind) && rank[trigger] >= rank[configured];
  }

  return { settings, setSettings, apply, check, boot, stop, defaults, shouldClearSession };
}

module.exports = { createCachePolicy, settings, setSettings, defaults };
