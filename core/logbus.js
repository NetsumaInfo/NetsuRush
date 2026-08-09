// @ts-check
// Bus de logs centralisé : capte les logs du core (console.*) ET les sorties des sidecars Python,
// les garde en anneau et les diffuse en SSE `console:log`. Alimente le panneau Console
// (Paramètres › Système › Console) — utile pour le debug et les bêta-testeurs (copier / exporter /
// envoyer un rapport de bug).
//
// Trois règles de QUALITÉ du journal, chacune corrigeant un défaut qui rendait un rapport illisible :
//  1. le stderr d'un sidecar arrive en CHUNKS, coupés n'importe où — découper naïvement sur les
//     retours à la ligne tronquait le message à chaque fois. On garde le fragment incomplet ;
//  2. une traceback Python est UN évènement de 5 à 30 lignes ; émise ligne par ligne, elle noyait
//     l'anneau et la cause (dernière ligne) se retrouvait loin du contexte. On la regroupe ;
//  3. une boucle qui échoue écrit 400 fois la même ligne et expulse tout l'historique utile de
//     l'anneau. Les répétitions consécutives incrémentent un compteur au lieu d'empiler.

const MAX = 800;
// Au-delà, la même ligne redevient un évènement à part entière (une erreur qui revient une minute
// plus tard n'est pas la même occurrence).
const DEDUPE_WINDOW_MS = 15000;
// Un sidecar silencieux garde son dernier fragment en attente : au-delà, on l'émet tel quel plutôt
// que de le perdre (un message sans retour à la ligne final, ex. une invite ou une barre ncurses).
const FLUSH_IDLE_MS = 400;

/** @typedef {{ id:number, t:number, source:string, level:'log'|'warn'|'error', message:string, repeat?:number }} LogEntry */

/** @type {LogEntry[]} */
let logs = [];
let seq = 0;
/** @type {((channel:string, payload:any)=>void)|null} */
let broadcast = null;
let patched = false;

function fmt(a) {
  if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? `\n${a.stack}` : ''}`;
  if (typeof a === 'string') return a;
  try { return JSON.stringify(a); } catch (_) { return String(a); }
}

// Marqueurs de progression internes (STAGE/PROGRESS/PHASE) → bruit pur, exclus du journal lisible.
function isMarker(line) { return /^(STAGE:|PROGRESS:|PHASE:)/.test(line); }
// Lignes stderr connues-bénignes (mentionnent « error » mais sont informatives) → jamais rouge.
function isBenign(line) {
  return /(ok to ignore|it's ok to ignore|experimentalwarning|futurewarning|userwarning|deprecat|skipping the post-processing|error_bad_lines)/i.test(line);
}
function guessLevel(line) {
  if (isBenign(line)) return 'warn';
  // `CUDA out of memory`, `ModuleNotFoundError`, `RuntimeError` : le mot « error » ne suffit pas —
  // les suffixes Python (`…Error`, `…Exception`) et les codes de sortie non nuls comptent aussi.
  if (/(^|\s)(\w*(Error|Exception)\b)|traceback|fatal|\bfailed\b|\babort(ed)?\b|out of memory|core dumped|exit(ed)? with code [1-9]|❌/i.test(line)) return 'error';
  if (/(warn|warning|⚠|deprecat)/i.test(line)) return 'warn';
  return 'log';
}

/** Deux entrées consécutives identiques → une seule, avec un compteur. @param {LogEntry} last */
function isRepeat(last, source, level, message) {
  return !!last && last.source === source && last.level === level && last.message === message
    && Date.now() - last.t < DEDUPE_WINDOW_MS;
}

// Ajoute une entrée à l'anneau et la diffuse (si un broadcaster est branché).
function emit(source, level, message) {
  const msg = String(message == null ? '' : message).replace(/\s+$/, '');
  if (!msg) return;
  const src = String(source || 'core');
  const lvl = level === 'warn' || level === 'error' ? level : 'log';

  const last = logs[logs.length - 1];
  if (isRepeat(last, src, lvl, msg)) {
    // Même id : le consommateur met à jour l'entrée déjà affichée au lieu d'en ajouter une.
    last.repeat = (last.repeat || 1) + 1;
    last.t = Date.now();
    if (broadcast) { try { broadcast('console:log', last); } catch (_) {} }
    return;
  }

  /** @type {LogEntry} */
  const entry = { id: ++seq, t: Date.now(), source: src, level: lvl, message: msg };
  logs.push(entry);
  if (logs.length > MAX) logs = logs.slice(-MAX);
  if (broadcast) { try { broadcast('console:log', entry); } catch (_) {} }
}

// --- Sidecars python : reconstitution des lignes + regroupement des tracebacks ------------------

/** @typedef {{ tail:string, block:string[], closing:boolean, timer:NodeJS.Timeout|null }} PyBuffer */
/** @type {Map<string, PyBuffer>} */
const pyBuffers = new Map();

function pyBuffer(name) {
  let b = pyBuffers.get(name);
  if (!b) { b = { tail: '', block: [], closing: false, timer: null }; pyBuffers.set(name, b); }
  return b;
}

const TRACEBACK_START = /^Traceback \(most recent call last\)/;
// Une traceback chaînée continue après ces phrases : fermer le bloc là couperait la vraie cause.
const TRACEBACK_CHAIN = /^(During handling of the above exception|The above exception was the direct cause)/;

/** Vide le bloc de traceback en cours en UNE entrée. @param {string} name @param {PyBuffer} b */
function flushBlock(name, b) {
  if (b.block.length) emit('python:' + name, 'error', b.block.join('\n'));
  b.block = [];
  b.closing = false;
}

/**
 * Alimente le bloc de traceback en cours. Rend `true` si la ligne y a été absorbée.
 *
 * La fermeture est DIFFÉRÉE d'une ligne : la ligne à la marge qui suit la pile est le type de
 * l'exception, mais elle peut être suivie de « During handling of the above exception… » et d'une
 * seconde traceback. Fermer au premier type couperait la chaîne en trois entrées et séparerait la
 * cause réelle de son contexte. Le bloc en attente part au plus tard sur la temporisation d'inactivité.
 * @param {string} name @param {PyBuffer} b @param {string} line @returns {boolean}
 */
function feedBlock(name, b, line) {
  if (!b.block.length) return false;
  const trimmed = line.trim();
  if (!trimmed) return true; // ligne vide : séparateur entre deux tracebacks chaînées
  if (b.closing) {
    if (TRACEBACK_CHAIN.test(trimmed) || TRACEBACK_START.test(trimmed)) {
      b.closing = false;
      b.block.push(line);
      return true;
    }
    flushBlock(name, b); // la ligne appartient à autre chose : elle sera traitée normalement
    return false;
  }
  b.block.push(line);
  // Une ligne à la marge termine la pile — sauf l'en-tête d'une traceback chaînée, qui en ouvre une.
  if (!/^\s/.test(line) && !TRACEBACK_START.test(trimmed) && !TRACEBACK_CHAIN.test(trimmed)) b.closing = true;
  return true;
}

/** @param {string} name @param {PyBuffer} b @param {string} raw */
function feedLine(name, b, raw) {
  const line = raw.replace(/\s+$/, '');
  if (feedBlock(name, b, line)) return;
  const trimmed = line.trim();
  if (!trimmed || isMarker(trimmed)) return;
  if (TRACEBACK_START.test(trimmed)) { b.block.push(line); return; }
  emit('python:' + name, guessLevel(trimmed), trimmed);
}

/** Découpe un chunk stderr d'un sidecar python en entrées de log. @param {string} name @param {any} chunk */
function py(name, chunk) {
  const b = pyBuffer(name);
  if (b.timer) clearTimeout(b.timer);
  const parts = (b.tail + String(chunk || '')).split(/\r?\n/);
  b.tail = parts.pop() || ''; // dernier élément = fragment sans retour à la ligne
  for (const line of parts) feedLine(name, b, line);
  b.timer = setTimeout(() => pyFlush(name), FLUSH_IDLE_MS);
  if (b.timer.unref) b.timer.unref();
}

/** Émet ce qui reste en attente pour un sidecar (fin de process, silence prolongé). @param {string} name */
function pyFlush(name) {
  const b = pyBuffers.get(name);
  if (!b) return;
  if (b.timer) { clearTimeout(b.timer); b.timer = null; }
  if (b.tail.trim()) { feedLine(name, b, b.tail); b.tail = ''; }
  flushBlock(name, b);
}

// --- Branchement -------------------------------------------------------------------------------

// Branche la diffusion SSE et capte les console.* du core (1 seule fois, idempotent).
function attach(b) {
  broadcast = b;
  if (patched) return;
  patched = true;
  const c = /** @type {any} */ (console);
  for (const level of /** @type {const} */ (['log', 'warn', 'error'])) {
    const orig = c[level].bind(console);
    c[level] = (/** @type {any[]} */ ...args) => {
      orig(...args);
      try { emit('core', level, args.map(fmt).join(' ')); } catch (_) {}
    };
  }
  // Avertissements natifs Node (ExperimentalWarning SQLite, DeprecationWarning…) : émis par Node sur
  // process.stderr, JAMAIS via console.* → sinon absents du journal, ou perçus comme "erreur" par les
  // testeurs. On les capte explicitement en niveau `warn` (ce sont des avertissements, pas des erreurs).
  process.on('warning', (w) => {
    try { emit('core', 'warn', `${w.name}: ${w.message}`); } catch (_) {}
  });
  // Une promesse rejetée sans `catch` ne passe par aucun console.* : le service s'arrêtait (ou restait
  // à moitié vivant) sans que le journal en garde la moindre trace, et le rapport de bug arrivait
  // avec un trou exactement là où était la cause. On la journalise et on laisse le service tourner :
  // l'utilisateur récupère la cause, l'action en cours a de toute façon déjà échoué.
  process.on('unhandledRejection', (reason) => {
    try { emit('core', 'error', `Promesse rejetée sans gestion — ${fmt(reason)}`); } catch (_) {}
  });
  // Exception non attrapée : le processus DOIT mourir (état imprévisible), mais pas avant que la
  // cause soit dans l'anneau et poussée aux abonnés SSE — d'où la sortie différée.
  process.on('uncaughtException', (err) => {
    try { emit('core', 'error', `Exception non attrapée — ${fmt(err)}`); } catch (_) {}
    setTimeout(() => process.exit(1), 150);
  });
  emit('system', 'log', 'Console NetsuRush démarrée.');
}

function snapshot() { return logs.slice(); }
function clear() { logs = []; }

module.exports = { attach, emit, py, pyFlush, snapshot, clear, guessLevel };
