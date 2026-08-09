// Barre de progression LISSE et MONOTONE, partagée par la découpe (détection de plans) et
// l'indexation de recherche. Deux défauts, tous deux vus en vrai, que ce module corrige :
//
// 1. La valeur RECULAIT — repli one-shot après la mort d'un daemon, événement tardif d'un autre
//    job, ou pct par-clip remis à zéro à chaque fichier d'un lot. Une barre qui revient en arrière
//    se lit comme un travail refait, jamais comme une correction d'échelle.
// 2. La valeur RESTAIT FIGÉE pendant de longues phases muettes — chargement d'un modèle torch,
//    lecture full-vidéo d'OmniShotCut (~130 s sans une seule ligne sur un film de 45 min). Une
//    barre immobile se lit comme une application plantée.
//
// D'où une valeur affichée qui n'est jamais celle qu'on vient de mesurer : elle rattrape la mesure
// en douceur, puis GLISSE au-dessus tant que rien n'arrive. Le glissement est borné par `head` —
// mentir de quelques points est le prix d'une barre vivante, dépasser la mesure suivante ne l'est
// pas. 100 n'appartient qu'à `finish()` : une barre pleine dit « terminé », pas « presque ».

const TICK_MS = 120;
const CATCH_UP = 0.28;   // fraction de l'écart rattrapée par tic quand la mesure est DEVANT
const CREEP = 0.045;     // idem quand on glisse vers le plafond, sans mesure neuve
const HEAD = 8;          // avance maximale au-dessus de la dernière mesure
const CAP = 99;

export interface SmoothProgress {
  /** Nouvelle mesure (ignorée si elle recule). `ceiling` borne le glissement au terme du travail en cours. */
  to(pct: number, ceiling?: number): void;
  /** Valeur affichée à l'instant t (pour amorcer un autre état sans le faire reculer). */
  value(): number;
  /** Pousse 100 et arrête le tic. */
  finish(): void;
  /** Arrête le tic sans rien émettre de plus. */
  stop(): void;
}

export function createSmoothProgress(
  emit: (pct: number) => void,
  opts: { head?: number; cap?: number } = {},
): SmoothProgress {
  const head = opts.head ?? HEAD;
  const cap = opts.cap ?? CAP;
  let target = 0;      // dernière mesure réelle, monotone
  let ceiling = cap;   // plafond imposé par l'appelant
  let shown = 0;
  let sent = -1;
  let timer: ReturnType<typeof setInterval> | null = null;

  const push = () => {
    const rounded = Math.round(shown);
    if (rounded === sent) return;
    sent = rounded;
    emit(rounded);
  };
  const tick = () => {
    const goal = Math.min(cap, ceiling, target + head);
    const rate = shown < target ? CATCH_UP : CREEP;
    shown = Math.max(shown, Math.min(goal, shown + (goal - shown) * rate));
    push();
  };
  timer = setInterval(tick, TICK_MS);

  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  return {
    to(pct, ceil) {
      if (ceil != null && Number.isFinite(ceil)) ceiling = ceil;
      if (Number.isFinite(pct) && pct > target) target = pct;
    },
    value: () => Math.round(shown),
    finish() {
      stop();
      shown = 100;
      push();
    },
    stop,
  };
}

// Le core plafonne la progression d'UN job d'indexation à 95 (cf. makeIndexRouter) : le reste de
// l'échelle appartient à l'écriture SQLite, muette.
const CORE_JOB_CEIL = 95;

/** Progression GLOBALE d'un lot : clips terminés + fraction du clip courant, sur 0..100. */
export function batchProgress(done: number, total: number, jobPct: number | null): number {
  if (total <= 0) return 0;
  const within = jobPct == null ? 0 : Math.max(0, Math.min(1, jobPct / CORE_JOB_CEIL));
  return Math.round(((done + within) / total) * 100);
}

/** Plafond de glissement d'un lot : le travail en cours ne peut pas dépasser sa propre fin. */
export function batchCeiling(done: number, total: number, running = 1): number {
  if (total <= 0) return 100;
  return Math.round((Math.min(total, done + Math.max(1, running)) / total) * 100);
}
