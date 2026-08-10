// Anneau du journal applicatif (Console — Paramètres › Système › Console). Module FEUILLE : zéro
// import, pour que n'importe quelle couche puisse y écrire — y compris `coreClient`, dont dépend
// `bridge`, dont dépend `appConsole`. Le branchement (patch de console.*, flux SSE du core) vit dans
// `appConsole.ts`, qui a besoin du pont ; ici il n'y a que la mémoire et la diffusion.
//
// POURQUOI une porte explicite : une erreur ATTRAPÉE puis affichée dans un coin de l'interface
// (`setErr`, `setNotice`) ne passe ni par `console.error`, ni par `window.onerror`, ni par
// `unhandledrejection` — la console n'en voyait donc rien, et l'utilisateur lisait un nom d'exception
// brut dans une pastille sans trace nulle part. Tout `catch` qui informe l'utilisateur doit aussi
// appeler `logError`/`logWarn`.

export type LogLevel = "log" | "warn" | "error";

export type ConsoleEntry = {
  id: string;
  t: number; // epoch ms
  source: string; // frontend | core | python:<name> | system | <domaine>
  level: LogLevel;
  message: string;
  /** Occurrences consécutives de la MÊME ligne, repliées en une entrée (absent = 1). */
  repeat?: number;
};

const MAX = 600;
// Au-delà, une ligne identique redevient un évènement distinct : une erreur qui revient une minute
// plus tard n'est pas la même occurrence, la replier masquerait une boucle qui redémarre.
const DEDUPE_WINDOW_MS = 15_000;
let logs: ConsoleEntry[] = [];
const listeners = new Set<(l: ConsoleEntry[]) => void>();
let localSeq = 0;

// Compteur d'erreurs NON LUES (badge global) : incrémenté à chaque entrée `error` poussée EN DIRECT
// (pas l'historique core rechargé), remis à zéro quand l'utilisateur ouvre la console.
let unseenErrors = 0;
const errorListeners = new Set<(n: number) => void>();

function notifyErrors() {
  for (const l of errorListeners) l(unseenErrors);
}
function notify() {
  for (const l of listeners) l(logs);
}

/**
 * Ajoute une entrée. Une ligne IDENTIQUE à la précédente (même source, même niveau, même texte, dans
 * la fenêtre de repli) n'empile pas : elle incrémente un compteur. Sans ça, une boucle en échec —
 * un aperçu qui retente, un sidecar qui redémarre — écrivait 400 fois la même chose et expulsait de
 * l'anneau tout le contexte qui précédait le problème, donc précisément ce qu'un rapport doit porter.
 */
export function pushLog(e: ConsoleEntry): void {
  const last = logs[logs.length - 1];
  if (last && last.source === e.source && last.level === e.level && last.message === e.message
      && e.t - last.t < DEDUPE_WINDOW_MS) {
    logs = [...logs.slice(0, -1), { ...last, t: e.t, repeat: (last.repeat ?? 1) + 1 }];
    notify();
    return;
  }
  logs = [...logs.slice(-(MAX - 1)), e];
  if (e.level === "error") { unseenErrors++; notifyErrors(); }
  notify();
}

/**
 * Met à jour une entrée déjà reçue (le core rediffuse la MÊME entrée quand son propre compteur de
 * répétitions bouge). Sans ça, le journal du renderer afficherait « 1 » là où le service en a vu 40.
 */
export function updateLog(id: string, patch: Partial<ConsoleEntry>): boolean {
  const i = logs.findIndex((e) => e.id === id);
  if (i < 0) return false;
  logs = [...logs.slice(0, i), { ...logs[i], ...patch }, ...logs.slice(i + 1)];
  notify();
  return true;
}

/** Identifiant local unique (les entrées venues du core portent le leur, préfixé `c`). */
export function nextLocalId(prefix: string): string {
  return `${prefix}${++localSeq}`;
}

/**
 * Journalise un événement applicatif. `source` nomme le domaine (« dictée », « core:rpc »… ) pour
 * que la console dise d'où ça vient sans lire le message.
 * Niveaux : `error` = rouge, l'action a échoué · `warn` = orange, ça continue en dégradé ·
 * `log` = neutre, information.
 */
export function logAt(level: LogLevel, source: string, message: string): void {
  pushLog({ id: nextLocalId("a"), t: Date.now(), source, level, message });
}
export const logError = (source: string, message: string) => logAt("error", source, message);
export const logWarn = (source: string, message: string) => logAt("warn", source, message);

/** Met en forme une valeur attrapée : garde le nom et la pile quand c'en est une. */
export function describeError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}${e.stack ? `\n${e.stack}` : ""}`;
  const named = e as { name?: string; message?: string } | null;
  if (named && named.name) return `${named.name}${named.message ? `: ${named.message}` : ""}`;
  try { return JSON.stringify(e); } catch { return String(e); }
}

/** Journalise une exception attrapée, en conservant le contexte de l'appelant. */
export function logCaught(source: string, context: string, e: unknown): void {
  logError(source, `${context} — ${describeError(e)}`);
}

export function getConsoleSnapshot(): ConsoleEntry[] {
  return logs;
}
export function subscribeConsole(cb: (l: ConsoleEntry[]) => void): () => void {
  listeners.add(cb);
  cb(logs);
  return () => { listeners.delete(cb); };
}
/** Remplace l'anneau (fusion de l'historique du core, vidage). */
export function setLogs(next: ConsoleEntry[]): void {
  logs = next.slice(-MAX);
  notify();
}
export function resetErrorCount(): void {
  unseenErrors = 0;
  notifyErrors();
}

export function subscribeErrorCount(cb: (n: number) => void): () => void {
  errorListeners.add(cb);
  cb(unseenErrors);
  return () => { errorListeners.delete(cb); };
}
export function markConsoleSeen(): void {
  if (unseenErrors === 0) return;
  resetErrorCount();
}

export function serializeConsole(entries: ConsoleEntry[]): string {
  return entries
    .map((e) => {
      const repeat = (e.repeat ?? 1) > 1 ? ` (×${e.repeat})` : "";
      return `[${new Date(e.t).toLocaleTimeString()}] [${e.source}] [${e.level}] ${e.message}${repeat}`;
    })
    .join("\n");
}

/** Décompte par niveau — un rapport dit d'emblée si le journal joint vaut la lecture. */
export function countLevels(entries: ConsoleEntry[]): { errors: number; warns: number } {
  let errors = 0;
  let warns = 0;
  for (const e of entries) {
    if (e.level === "error") errors += e.repeat ?? 1;
    else if (e.level === "warn") warns += e.repeat ?? 1;
  }
  return { errors, warns };
}
