// @ts-check
// Surveillance mémoire pendant les TÂCHES LOURDES.
//
// Le besoin : sur une longue session, la RAM et la VRAM se remplissent de bruit d'arrière-plan et
// c'est au pire moment — pendant un rendu — que la machine manque d'air. Personne ne va ouvrir le
// gestionnaire de tâches au milieu d'un export.
//
// Trois décisions structurent ce module, et chacune évite un dégât :
//
//  1. ARMÉ UNIQUEMENT PENDANT UNE TÂCHE LOURDE. Une surveillance permanente coûte en continu pour un
//     bénéfice nul quand la machine ne fait rien. Hors tâche lourde, la boucle ne lit même pas les
//     ressources.
//  2. LA BOUCLE NE TUE JAMAIS RIEN. Elle ne fait que libérer la mémoire physique inutilisée du bruit
//     (`EmptyWorkingSet`, réversible à la demande). Quand ça ne suffit pas, elle PROPOSE une liste
//     d'arrêts et attend un clic. Une application qui se ferme toute seule pendant un rendu est un
//     bug, pas une optimisation.
//  3. HYSTÉRÉSIS + REPOS. Il faut `ARM_TICKS` mesures consécutives sous le seuil pour agir, puis
//     `COOLDOWN_MS` de repos. Sans ça, un seuil frôlé déclenche une purge par tick : le disque
//     thrash et la machine ralentit — l'inverse du but.

const RAM_LOW_PCT = 12; // RAM disponible sous ce % = pression mémoire
const VRAM_HIGH_PCT = 92; // au-delà, Resolve est au bord du « GPU memory full »
const TICK_MS = 10_000; // 1 s ferait de la surveillance elle-même la charge
const ARM_TICKS = 2;
const COOLDOWN_MS = 60_000;
const JOURNAL_MAX = 20;
const SETTLE_MS = 700; // laisse Windows reprendre les pages avant de relire la RAM

/**
 * @typedef {Object} WatchPrefs
 * @property {boolean} enabled
 * @property {number} ramLowPct
 * @property {number} vramHighPct
 */

/**
 * @typedef {Object} WatchState
 * @property {number} over            mesures consécutives sous le seuil
 * @property {number} cooldownUntil   horodatage avant lequel aucune purge n'est permise
 */

/**
 * @typedef {Object} Pressure
 * @property {boolean} under
 * @property {number|null} ramPct     RAM disponible (%)
 * @property {number|null} vramPct    VRAM occupée (%)
 * @property {string[]} reasons
 */

/** @type {WatchPrefs} */
const DEFAULT_PREFS = { enabled: true, ramLowPct: RAM_LOW_PCT, vramHighPct: VRAM_HIGH_PCT };

/**
 * Normalise des préférences venues du disque ou du renderer. Les bornes évitent qu'un réglage aberrant
 * (0 %, 100 %) rende la surveillance soit inerte, soit permanente.
 * @param {Partial<WatchPrefs>|null|undefined} raw
 * @returns {WatchPrefs}
 */
function sanitizePrefs(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const clamp = (v, lo, hi, def) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : def;
  };
  return {
    enabled: src.enabled == null ? DEFAULT_PREFS.enabled : !!src.enabled,
    ramLowPct: clamp(src.ramLowPct, 5, 40, DEFAULT_PREFS.ramLowPct),
    vramHighPct: clamp(src.vramHighPct, 70, 99, DEFAULT_PREFS.vramHighPct),
  };
}

/**
 * Traduit un instantané de ressources en verdict de pression. PUR.
 * @param {{ ram?: {free:number,total:number}|null, gpu?: {usedMB:number,totalMB:number}|null }} res
 * @param {WatchPrefs} prefs
 * @returns {Pressure}
 */
function evaluatePressure(res, prefs) {
  const reasons = [];
  const ram = res && res.ram;
  const gpu = res && res.gpu;
  const ramPct = ram && ram.total > 0 ? (ram.free / ram.total) * 100 : null;
  const vramPct = gpu && gpu.totalMB > 0 ? (gpu.usedMB / gpu.totalMB) * 100 : null;
  if (ramPct != null && ramPct <= prefs.ramLowPct) reasons.push("ram");
  if (vramPct != null && vramPct >= prefs.vramHighPct) reasons.push("vram");
  return {
    under: reasons.length > 0,
    ramPct: ramPct == null ? null : Math.round(ramPct),
    vramPct: vramPct == null ? null : Math.round(vramPct),
    reasons,
  };
}

/**
 * Machine à états de la boucle. PURE : c'est ici que vivent l'hystérésis et le repos, donc c'est ici
 * qu'on peut prouver qu'une purge ne peut pas se rejouer à chaque tick.
 * @param {WatchState} state
 * @param {{ now:number, heavy:boolean, pressure:Pressure }} input
 * @returns {{ state: WatchState, purge: boolean }}
 */
function nextState(state, input) {
  if (!input.heavy || !input.pressure.under) {
    return { state: { ...state, over: 0 }, purge: false };
  }
  const over = state.over + 1;
  if (over < ARM_TICKS) return { state: { ...state, over }, purge: false };
  // Armé mais encore au repos : on garde le compteur haut pour agir dès la sortie du repos.
  if (input.now < state.cooldownUntil) return { state: { ...state, over }, purge: false };
  return { state: { over: 0, cooldownUntil: input.now + COOLDOWN_MS }, purge: true };
}

/**
 * @typedef {Object} WatchdogDeps
 * @property {() => Promise<any>} resources             instantané RAM/VRAM (optimize.resources)
 * @property {() => Promise<{heavy:boolean, source:string|null}>} heavySignal
 * @property {() => Promise<import('./procScan').ScannedProc[]>} scan
 * @property {(pids:number[]) => Promise<{ok:boolean,trimmed:number}>} trim
 * @property {(procs:import('./procScan').ScannedProc[]) => import('./procScan').ScannedProc[]} killable
 * @property {(channel:string, payload:any) => void} broadcast
 * @property {() => WatchPrefs} readPrefs
 * @property {(prefs:WatchPrefs) => void} writePrefs
 * @property {() => number} [now]
 */

/** @param {WatchdogDeps} deps */
function createWatchdog(deps) {
  const now = deps.now || (() => Date.now());
  let prefs = sanitizePrefs(deps.readPrefs());
  /** @type {WatchState} */
  let state = { over: 0, cooldownUntil: 0 };
  /** @type {{at:number,reasons:string[],trimmed:number,freed:number,names:string[]}[]} */
  let journal = [];
  /** @type {{at:number,procs:{pid:number,name:string,ram:number,family:string|null,risk:string|null}[]}|null} */
  let suggestion = null;
  let heavySource = null;
  let lastPressure = /** @type {Pressure|null} */ (null);
  let running = false;
  /** @type {NodeJS.Timeout|null} */
  let timer = null;

  function emit() {
    deps.broadcast("optimize:watchdog", snapshot());
  }

  function snapshot() {
    return {
      prefs,
      armed: !!heavySource,
      source: heavySource,
      pressure: lastPressure,
      over: state.over,
      cooldownUntil: state.cooldownUntil,
      journal,
      suggestion,
    };
  }

  /** Libère la mémoire du bruit, puis relit : si la pression tient, on PROPOSE des arrêts. */
  async function purge(pressure) {
    const before = await deps.resources();
    const procs = await deps.scan();
    const noise = procs.filter((p) => p.kind === "noise" && p.pid !== process.pid);
    if (!noise.length) return;
    const r = await deps.trim(noise.map((p) => p.pid));
    await new Promise((res) => setTimeout(res, SETTLE_MS));
    const after = await deps.resources();
    const freed = Math.max(0, (after?.ram?.free || 0) - (before?.ram?.free || 0));
    journal = [
      {
        at: now(),
        reasons: pressure.reasons,
        trimmed: r.trimmed,
        freed,
        names: [...new Set(noise.map((p) => p.name))].slice(0, 12),
      },
      ...journal,
    ].slice(0, JOURNAL_MAX);

    // Toujours sous le seuil après libération : la mémoire est réellement occupée, pas juste
    // paginable. Seul un arrêt la rendra — c'est à l'utilisateur de trancher.
    const still = evaluatePressure(after, prefs);
    lastPressure = still;
    suggestion = still.under
      ? {
          at: now(),
          procs: deps
            .killable(procs)
            .slice(0, 8)
            .map((p) => ({ pid: p.pid, name: p.name, ram: p.ram, family: p.family, risk: p.risk })),
        }
      : null;
  }

  async function tick() {
    if (running || !prefs.enabled) return;
    running = true;
    try {
      const heavy = await deps.heavySignal();
      const wasArmed = !!heavySource;
      heavySource = heavy.heavy ? heavy.source : null;
      if (!heavy.heavy) {
        state = nextState(state, { now: now(), heavy: false, pressure: { under: false, ramPct: null, vramPct: null, reasons: [] } }).state;
        lastPressure = null;
        if (wasArmed) emit(); // la tâche vient de finir : l'interface repasse en veille
        return;
      }
      const res = await deps.resources();
      const pressure = evaluatePressure(res, prefs);
      lastPressure = pressure;
      const step = nextState(state, { now: now(), heavy: true, pressure });
      state = step.state;
      if (step.purge) await purge(pressure);
      emit();
    } catch (e) {
      // Un tick raté ne doit jamais arrêter la surveillance : on trace et on retentera au suivant.
      console.warn("[watchdog] tick échoué :", String(e));
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => void tick(), TICK_MS);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  /** @param {Partial<WatchPrefs>} patch */
  function setPrefs(patch) {
    prefs = sanitizePrefs({ ...prefs, ...patch });
    deps.writePrefs(prefs);
    if (!prefs.enabled) {
      state = { over: 0, cooldownUntil: 0 };
      heavySource = null;
      lastPressure = null;
      suggestion = null;
    }
    emit();
    return snapshot();
  }

  /** L'utilisateur a traité (ou ignoré) la proposition d'arrêts. */
  function dismissSuggestion() {
    suggestion = null;
    emit();
    return snapshot();
  }

  start();
  return { state: snapshot, setPrefs, dismissSuggestion, stop, tick };
}

module.exports = {
  createWatchdog,
  evaluatePressure,
  nextState,
  sanitizePrefs,
  DEFAULT_PREFS,
  TICK_MS,
  ARM_TICKS,
  COOLDOWN_MS,
};
