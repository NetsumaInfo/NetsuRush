// @ts-check
// Blackmagic's official MCP server, folded into the NetsuRush tool registry.
//
// Resolve Studio 21.1 ships its own MCP server (`ResolveMCP.exe`). We could
// hand it to the CLI agents as a second entry in the `.mcp.json` we write, and
// that would be one line — but the agent would then call it DIRECTLY, and the
// NetsuRush permission gate only ever sees our own tools. "Read only" would let
// a script rewrite the project. So the server is consumed here instead: its
// tools are re-registered as ordinary registry tools, which means one gate for
// everything, the same trace in the panel, and BYOK engines get them too rather
// than only the CLI ones.
//
// Names are prefixed `bmd_` because `run_script` next to our `resolve_*` family
// says nothing about who runs it, and because the registry refuses duplicates.
//
// The tool list is READ FROM THE SERVER, never typed here: the schemas ship
// with Resolve and change with it. Only the risk of each tool is ours to
// decide, since the server has no notion of our permission modes.

const { createMcpClient } = require('../mcp/client');
const { findResolveMcp } = require('../mcp/resolveBin');

const PREFIX = 'bmd_';

/// Risk per tool, for the permission gate. Anything unlisted falls back to
/// 'destructive': a tool this file has never seen is exactly the one that
/// should not slip through as read-only.
///
/// `run_script` carries the default for a script that writes: the sandbox
/// stops it touching FILES, not the project, and an arbitrary script can
/// delete timelines and clips. A script that only reads is recognised as such
/// by `scriptRisk` below and downgraded per call.
const RISK = {
  get_resolve_status: 'read',
  get_whats_new: 'read',
  get_scripting_api: 'read',
  search_scripting_api: 'read',
  get_scripting_docs: 'read',
  list_dctls: 'read',
  list_luts: 'read',
  launch_resolve: 'write',
  update_dctl: 'write',
  generate_lut: 'write',
  run_script: 'destructive',
  run_script_unsafe: 'destructive',
  delete_dctl: 'destructive',
  delete_lut: 'destructive',
};

/// Full filesystem, network and subprocess access, by its own description.
/// That is the capability `runtimes/defs.js` denies CLI agents outright (no
/// Bash, no Write), and no permission mode of ours can sandbox it once the
/// script is running. Registered only when the user turns it on.
const UNSAFE = 'run_script_unsafe';

/// The server describes its tools in terms of its own names ("use
/// `get_scripting_api`"), which do not exist on our side. Rewriting the
/// references keeps the advice actionable instead of sending the model after a
/// tool it will be told does not exist.
/** @param {string} text @param {string[]} names */
function reprefix(text, names) {
  let out = String(text || '');
  for (const n of names) out = out.split(`\`${n}\``).join(`\`${PREFIX}${n}\``);
  return out;
}

/// Un script qui ne fait que LIRE est une lecture, et doit passer comme telle.
///
/// `run_script` déclaré destructif en bloc rendait le mode « demander »
/// inutilisable — chaque « qu'y a-t-il dans ma timeline ? » ouvrait une
/// confirmation — et le mode « lecture seule » refusait jusqu'à l'inspection,
/// alors que c'est précisément ce qu'on y veut.
///
/// La reconnaissance marche par LISTE BLANCHE de verbes, jamais par liste
/// noire : un appel dont le verbe n'est pas connu pour lire compte comme une
/// écriture. Une méthode ajoutée par une version future de Resolve tombe donc
/// du côté prudent, sans que ce fichier ait à la connaître.
const READ_VERBS = /^(Get|Is|Has|Are|Can|Count|Find|Search|Exists|List|To|Print|Format|Join|Split|Strip|Lower|Upper|Replace|Append|Sort|Keys|Values|Items|Copy)$/;

/// Sorties du bac à sable, ou évaluation dynamique : le script pourrait alors
/// écrire sans qu'aucun appel visible ne le dise.
const ESCAPES = /\b(exec|eval|compile|__import__|open|globals|locals|getattr|setattr)\s*\(/;

/// Le risque réel d'un `run_script`, lu dans le script lui-même.
/** @param {any} input @returns {'read'|'destructive'} */
function scriptRisk(input) {
  const code = String((input && (input.script || input.code)) || '');
  if (!code.trim() || ESCAPES.test(code)) return 'destructive';
  // Tout appel de méthode du script : `objet.Methode(`. `Append`/`Copy` sont
  // dans la liste blanche pour les listes Python, pas pour l'API Resolve —
  // d'où le refus explicite des deux méthodes de l'API qui portent ces noms.
  if (/\.\s*(AppendToTimeline|CopyGrades|CopyTimeline)\s*\(/.test(code)) return 'destructive';
  const calls = code.match(/\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/g) || [];
  for (const call of calls) {
    const name = String(call).replace(/^\.\s*/, '').replace(/\s*\($/, '');
    // Le verbe = le premier mot CamelCase (`GetClipProperty` → `Get`), ou le
    // nom entier pour une méthode Python en minuscules (`keys`, `sort`).
    const verb = /^[A-Z]/.test(name) ? (name.match(/^[A-Z][a-z]*/) || [name])[0] : name;
    if (!READ_VERBS.test(verb) && !READ_VERBS.test(name.replace(/^./, (c) => c.toUpperCase()))) {
      return 'destructive';
    }
  }
  return 'read';
}

/// Garde-fou anti-emballement, en caractères (~50 000 tokens).
///
/// Mesuré sur Resolve 21.1 : `get_scripting_api` renvoie le stub `.pyi`
/// complet, 146 000 caractères — 36 500 tokens dans UN résultat, repayés à
/// chaque tour suivant d'une boucle BYOK. Les autres n'en approchent pas
/// (`search_scripting_api` : 6 700 ; la doc : 1 300).
///
/// Le plafond passe donc AU-DESSUS du stub plutôt qu'en dessous : le couper
/// ferait un outil qui échoue toujours, ce qui est pire que cher. C'est le
/// prompt pilote qui envoie chercher avant de tout tirer. Ce qui reste barré
/// ici, c'est le résultat qui part en vrille — un `run_script` qui déverse un
/// fichier entier dans la conversation.
const MAX_CHARS = 200_000;

/// Trop gros = REFUSÉ, jamais tronqué. Un stub d'API coupé en deux est pire
/// qu'absent : le modèle y lit l'absence d'une classe qui existe, et affirme
/// derrière qu'elle n'est pas dans l'API. Le refus, lui, nomme le chemin étroit.
/** @param {string} name @param {number} size */
function tooBig(name, size) {
  const advice = name === 'get_scripting_api'
    ? 'Utilise `bmd_search_scripting_api {pattern}` : il renvoie les types et fonctions qui correspondent, pas le stub entier.'
    : 'Restreins la demande (moins de champs dans `result`, une plage plus courte) et rappelle l’outil.';
  return { ok: false, error: `résultat de ${name} trop volumineux (${size} caractères, plafond ${MAX_CHARS}). ${advice}` };
}

/// MCP results are content blocks; the registry speaks plain objects. Text
/// parts are joined, structured output is passed through under `data`, and
/// `isError` becomes our own failure shape so the panel marks the line red.
/** @param {any} result @param {string} [name] */
function normalize(result, name = 'l’outil') {
  const blocks = Array.isArray(result && result.content) ? result.content : [];
  const text = blocks.filter((b) => b && b.type === 'text').map((b) => String(b.text || '')).join('\n');
  if (result && result.isError) return { ok: false, error: text || 'erreur du serveur MCP Resolve' };
  const data = result && result.structuredContent;
  const size = text.length + (data === undefined ? 0 : JSON.stringify(data).length);
  if (size > MAX_CHARS) return tooBig(name, size);
  return { ok: true, ...(text ? { text } : {}), ...(data !== undefined ? { data } : {}) };
}

/**
 * `client` et `bin` sont injectables : c'est ce qui permet de vérifier le
 * câblage (risques, préfixe, interrupteur hors bac à sable) contre un serveur
 * factice, sans exiger une installation de Resolve Studio sur la machine de
 * test.
 * @param {{ registry:any, bin?:string|null, client?:any }} deps
 */
function createResolveMcp({ registry, bin: forcedBin, client: forcedClient }) {
  const bin = forcedBin !== undefined ? forcedBin : findResolveMcp();
  const client = forcedClient
    || (bin ? createMcpClient({ command: bin, label: 'ResolveMCP' }) : null);

  /** @type {string[]} */
  let registered = [];
  let unsafe = false;
  /** @type {{ name?:string, version?:string }} */
  let serverInfo = {};
  let error = '';
  /** @type {Promise<void>|null} */
  let hydration = null;

  function removeAll() {
    for (const name of registered) registry.unregister(name);
    registered = [];
  }

  /// Pulls the tool list off the server and mirrors it into the registry.
  /// Idempotent: called again (after the unsafe switch moves) it replaces what
  /// it registered last time rather than colliding with it.
  async function hydrate() {
    if (!client) { error = 'serveur MCP Resolve introuvable'; return; }
    try {
      const info = await client.start();
      serverInfo = info.serverInfo || {};
      const tools = await client.listTools();
      const names = tools.map((/** @type {any} */ t) => String(t.name));
      removeAll();
      for (const tool of tools) {
        const name = String(tool.name);
        if (name === UNSAFE && !unsafe) continue;
        const risk = /** @type {any} */ (RISK[/** @type {keyof typeof RISK} */ (name)] || 'destructive');
        registry.register({
          name: `${PREFIX}${name}`,
          description: reprefix(tool.description, names),
          inputSchema: tool.inputSchema || { type: 'object', properties: {} },
          risk,
          // `run_script` seul est jugé sur pièce. `run_script_unsafe` reste
          // destructif quoi qu'il lise : hors du bac à sable, un script « en
          // lecture » atteint quand même le disque et le réseau.
          ...(name === 'run_script' ? { riskFor: scriptRisk } : {}),
          surfaces: ['pilot'],
          handler: async (/** @type {any} */ args) => {
            try { return normalize(await client.callTool(name, args), name); }
            catch (e) { return { ok: false, error: String((e && /** @type {any} */ (e).message) || e) }; }
          },
        });
        registered.push(`${PREFIX}${name}`);
      }
      error = '';
    } catch (e) {
      error = String((e && /** @type {any} */ (e).message) || e);
      removeAll();
    }
  }

  /// Kicked off at boot and awaited before a turn builds its tool list. Without
  /// the await, the first message of a session would be sent with the Resolve
  /// tools still missing — present in the panel, absent from the model.
  function ready() {
    if (!hydration) hydration = hydrate();
    return hydration;
  }

  /// Nouvelle tentative quand la précédente n'a rien donné. Resolve lancé APRÈS
  /// NetsuRush est le cas courant : sans ce chemin, le bouton « relancer la
  /// détection » aurait rejoué la promesse déjà résolue et l'utilisateur serait
  /// resté devant « sans réponse » jusqu'au redémarrage de l'application.
  async function refresh() {
    if (registered.length) return; // déjà en place : rien à retenter
    hydration = hydrate();
    await hydration;
  }

  /** @param {boolean} on */
  async function setUnsafe(on) {
    const next = !!on;
    if (next === unsafe) return;
    unsafe = next;
    hydration = hydrate();
    await hydration;
  }

  function status() {
    return {
      available: !!bin && registered.length > 0,
      installed: !!bin,
      path: bin || '',
      version: String(serverInfo.version || ''),
      server: String(serverInfo.name || ''),
      tools: [...registered],
      unsafe,
      error,
    };
  }

  function close() { if (client) client.close(); }

  return { ready, refresh, setUnsafe, status, close, PREFIX };
}

module.exports = { createResolveMcp, RISK, PREFIX, UNSAFE, MAX_CHARS, normalize, reprefix, scriptRisk };
