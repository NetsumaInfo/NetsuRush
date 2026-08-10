// Branchement du journal applicatif (Console — Paramètres › Système › Console) : patche les console.*
// du renderer, capte les erreurs non gérées, et reçoit les logs du core + sidecars python (SSE
// `console:log` via nr.onConsoleLog). L'anneau lui-même vit dans `appLog` (module feuille) pour que
// les couches basses — dont `coreClient` — puissent y écrire sans créer de cycle d'import.
import { nr } from "./bridge";
import {
  getConsoleSnapshot, logAt, nextLocalId, pushLog, resetErrorCount, setLogs, updateLog,
  type ConsoleEntry, type LogLevel,
} from "./appLog";

export type { ConsoleEntry };
export {
  getConsoleSnapshot, subscribeConsole, subscribeErrorCount, markConsoleSeen, serializeConsole,
  countLevels, logCaught,
} from "./appLog";

let initialized = false;

// Messages connus-bénins côté renderer (contiennent « error » mais ne sont PAS des erreurs) → warn.
function isBenignFrontend(msg: string): boolean {
  return /ResizeObserver loop (completed|limit exceeded)/i.test(msg);
}
// `JSON.stringify(new Error(...))` rend `{}` : une exception passée à console.error arrivait donc
// VIDE dans le journal — le cas exact où le message compte le plus.
function fmt(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? `\n${a.stack}` : ""}`;
      try { return JSON.stringify(a); } catch { return String(a); }
    })
    .join(" ");
}

// Codes MediaError : `<video>` n'émet qu'un évènement `error` nu, le code est la SEULE information
// qui distingue « le fichier n'est pas arrivé » de « le codec n'est pas décodable ». Les deux se
// voient pareil à l'écran (cadre noir) et se corrigent à des endroits opposés.
const MEDIA_ERROR: Record<number, string> = {
  1: "chargement interrompu (MEDIA_ERR_ABORTED)",
  2: "réseau interrompu pendant le chargement (MEDIA_ERR_NETWORK)",
  3: "décodage impossible — codec ou fichier corrompu (MEDIA_ERR_DECODE)",
  4: "source non lisible ou introuvable (MEDIA_ERR_SRC_NOT_SUPPORTED)",
};

// Ressources qui, en échouant, cassent VISIBLEMENT l'interface (vignette absente, aperçu noir,
// module non chargé). Une image manquante dégrade, le reste bloque → niveau distinct.
const BLOCKING_TAGS = new Set(["VIDEO", "AUDIO", "SCRIPT", "LINK", "IFRAME"]);

function resourceUrl(el: Element): string {
  const direct = (el as HTMLImageElement | HTMLScriptElement).src || (el as HTMLLinkElement).href || "";
  if (direct) return direct;
  // Un <video> avec des <source> enfants n'a pas de `src` : c'est `currentSrc` qui porte l'URL.
  return (el as HTMLMediaElement).currentSrc || "(source inconnue)";
}

// Un échec de chargement (chunk JS, vignette, proxy HEVC, police) NE passe par aucun `console.error`
// et ne remonte pas dans `window.onerror` : l'évènement `error` d'un élément ne bouillonne pas, il
// faut l'écouter en phase de CAPTURE. Sans ça, « l'aperçu reste noir » ou « l'écran est blanc »
// arrivaient dans un rapport sans une seule ligne de journal — le symptôme, jamais la cause.
function captureResourceErrors(): void {
  window.addEventListener(
    "error",
    (ev) => {
      const el = ev.target as Element | null;
      if (!el || el === (window as unknown as Element) || !el.tagName) return; // erreur JS, déjà traitée
      const tag = el.tagName.toUpperCase();
      const media = (el as HTMLMediaElement).error;
      const detail = media ? MEDIA_ERROR[media.code] ?? `code ${media.code}` : "chargement échoué";
      pushLog({
        id: nextLocalId("r"),
        t: Date.now(),
        source: "ressource",
        level: BLOCKING_TAGS.has(tag) ? "error" : "warn",
        message: `<${tag.toLowerCase()}> ${detail} — ${resourceUrl(el)}`,
      });
    },
    true, // capture : les évènements de chargement ne bouillonnent pas
  );
}

export function clearConsole(): void {
  setLogs([]);
  resetErrorCount();
  void nr.consoleClear?.().catch(() => {});
}

// À appeler une fois au démarrage (main.tsx) : patche la console du renderer + branche le flux core.
export function initConsoleCapture(): void {
  if (initialized) return;
  initialized = true;

  // console.info/debug mappés sur "log" (sinon les logs de diagnostic — ex. GPU au boot — passeraient
  // sous le radar). Chaque niveau natif est préservé (appel d'origine) puis journalisé dans l'anneau.
  const orig = { log: console.log, info: console.info, debug: console.debug, warn: console.warn, error: console.error } as const;
  const LEVEL_MAP = { log: "log", info: "log", debug: "log", warn: "warn", error: "error" } as const;
  (["log", "info", "debug", "warn", "error"] as const).forEach((native) => {
    console[native] = (...args: unknown[]) => {
      orig[native](...args);
      pushLog({ id: nextLocalId("f"), t: Date.now(), source: "frontend", level: LEVEL_MAP[native], message: fmt(args) });
    };
  });

  // Erreurs JS non catchées + rejets de promesse non gérés : sans ça, une exception dans un handler
  // (souvent avalée par un try/catch → setNotice) n'apparaîtrait JAMAIS dans la console. On les capte
  // globalement → l'erreur exacte est toujours journalisée (et alimente le badge rouge). Les erreurs
  // ATTRAPÉES, elles, n'arrivent pas ici : elles doivent appeler `logError`/`logWarn` (cf. appLog).
  if (typeof window !== "undefined") {
    window.addEventListener("error", (ev) => {
      const err = ev.error;
      const where = ev.filename ? ` (${ev.filename.split("/").pop()}:${ev.lineno})` : "";
      const msg = err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ""}` : String(ev.message || err);
      // Bruit connu-bénin (pas une vraie erreur) → warn, jamais rouge. « ResizeObserver loop… » est
      // une notification Chromium inoffensive émise en event `error` global (sans objet Error).
      const level: LogLevel = isBenignFrontend(msg) ? "warn" : "error";
      pushLog({ id: nextLocalId("e"), t: Date.now(), source: "frontend", level, message: `Erreur non gérée${where} — ${msg}` });
    });
    window.addEventListener("unhandledrejection", (ev) => {
      const r = ev.reason;
      const msg = r instanceof Error ? `${r.name}: ${r.message}\n${r.stack ?? ""}` : (() => { try { return JSON.stringify(r); } catch { return String(r); } })();
      pushLog({ id: nextLocalId("p"), t: Date.now(), source: "frontend", level: "error", message: `Promesse rejetée — ${msg}` });
    });
    captureResourceErrors();
  }

  // Logs du core + sidecars python (flux SSE). `seen` dédoublonne avec l'historique récupéré ci-dessous ;
  // une entrée DÉJÀ vue qui revient porte un compteur de répétitions remis à jour (cf. logbus).
  const seen = new Set<number>();
  nr.onConsoleLog?.((e) => {
    if (!e) return;
    if (seen.has(e.id)) { updateLog(`c${e.id}`, { t: e.t, repeat: e.repeat }); return; }
    seen.add(e.id);
    pushLog({ id: `c${e.id}`, t: e.t, source: e.source, level: e.level, message: e.message, repeat: e.repeat });
  });
  // Historique (logs émis avant l'abonnement : démarrage du core, erreurs antérieures).
  void nr.consoleLogs?.()
    .then((r) => {
      if (!r || !r.ok || !Array.isArray(r.logs)) return;
      const hist = r.logs
        .filter((e) => !seen.has(e.id))
        .map((e) => { seen.add(e.id); return { id: `c${e.id}`, t: e.t, source: e.source, level: e.level, message: e.message, repeat: e.repeat }; });
      setLogs([...hist, ...getConsoleSnapshot()].sort((a, b) => a.t - b.t));
    })
    .catch(() => {});

  logAt("log", "system", "Console NetsuRush prête.");
}
