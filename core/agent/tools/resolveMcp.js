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
const { t } = require('../../i18n');

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

/// A script that only READS is a read, and must pass as one.
///
/// `run_script` declared destructive wholesale made "ask" mode unusable —
/// every "what is in my timeline?" opened a confirmation — and "read-only"
/// mode refused even inspection, which is exactly what it is for.
///
/// Recognition works by an ALLOW LIST of verbs, never a deny list: a call
/// whose verb is not known to read counts as a write. A method added by a
/// future Resolve version therefore falls on the safe side without this file
/// having to know it.
const READ_VERBS = /^(Get|Is|Has|Are|Can|Count|Find|Search|Exists|List|To|Print|Format|Join|Split|Strip|Lower|Upper|Replace|Append|Sort|Keys|Values|Items|Copy)$/;

/// Sandbox escapes, or dynamic evaluation: the script could then write
/// without any visible call saying so.
const ESCAPES = /\b(exec|eval|compile|__import__|open|globals|locals|getattr|setattr)\s*\(/;

/// The real risk of a `run_script`, read from the script itself.
/** @param {any} input @returns {'read'|'destructive'} */
function scriptRisk(input) {
  const code = String((input && (input.script || input.code)) || '');
  if (!code.trim() || ESCAPES.test(code)) return 'destructive';
  // Every method call in the script: `object.Method(`. `Append`/`Copy` are on
  // the allow list for Python lists, not for the Resolve API — hence the
  // explicit refusal of the API methods that carry those names.
  if (/\.\s*(AppendToTimeline|CopyGrades|CopyTimeline)\s*\(/.test(code)) return 'destructive';
  const calls = code.match(/\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/g) || [];
  for (const call of calls) {
    const name = String(call).replace(/^\.\s*/, '').replace(/\s*\($/, '');
    // The verb = the first CamelCase word (`GetClipProperty` → `Get`), or the
    // whole name for a lowercase Python method (`keys`, `sort`).
    const verb = /^[A-Z]/.test(name) ? (name.match(/^[A-Z][a-z]*/) || [name])[0] : name;
    if (!READ_VERBS.test(verb) && !READ_VERBS.test(name.replace(/^./, (c) => c.toUpperCase()))) {
      return 'destructive';
    }
  }
  return 'read';
}

/// Runaway guard, in characters (~50,000 tokens).
///
/// Measured on Resolve 21.1: `get_scripting_api` returns the complete `.pyi`
/// stub, 146,000 characters — 36,500 tokens in ONE result, paid again on every
/// following turn of a BYOK loop. The others come nowhere near
/// (`search_scripting_api`: 6,700; the docs: 1,300).
///
/// The cap therefore sits ABOVE the stub rather than below: cutting it would
/// make a tool that always fails, which is worse than expensive. The pilot
/// prompt is what sends the model searching before pulling everything. What
/// stays blocked here is the result that runs away — a `run_script` pouring a
/// whole file into the conversation.
const MAX_CHARS = 200_000;

/// Too big = REFUSED, never truncated. An API stub cut in half is worse than
/// none: the model reads in it the absence of a class that exists, and then
/// claims it is not in the API. The refusal names the narrow path instead.
/** @param {string} name @param {number} size */
function tooBig(name, size) {
  const vars = { name, size, max: MAX_CHARS };
  return {
    ok: false,
    error: name === 'get_scripting_api' ? t('agentMcpResultTooLargeApi', vars) : t('agentMcpResultTooLarge', vars),
  };
}

/// MCP results are content blocks; the registry speaks plain objects. Text
/// parts are joined, structured output is passed through under `data`, and
/// `isError` becomes our own failure shape so the panel marks the line red.
/** @param {any} result @param {string} [name] */
function normalize(result, name = 'tool') {
  const blocks = Array.isArray(result && result.content) ? result.content : [];
  const text = blocks.filter((b) => b && b.type === 'text').map((b) => String(b.text || '')).join('\n');
  if (result && result.isError) return { ok: false, error: text || t('agentResolveMcpError') };
  const data = result && result.structuredContent;
  const size = text.length + (data === undefined ? 0 : JSON.stringify(data).length);
  if (size > MAX_CHARS) return tooBig(name, size);
  return { ok: true, ...(text ? { text } : {}), ...(data !== undefined ? { data } : {}) };
}

/**
 * `client` and `bin` are injectable: that is what lets the wiring (risks,
 * prefix, out-of-sandbox switch) be checked against a fake server, without
 * requiring a Resolve Studio install on the test machine.
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
    if (!client) { error = t('agentResolveMcpMissing'); return; }
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
          // Only `run_script` is judged on its content. `run_script_unsafe`
          // stays destructive whatever it reads: outside the sandbox, a
          // "read-only" script still reaches the disk and the network.
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

  /// A new attempt when the previous one gave nothing. Resolve started AFTER
  /// NetsuRush is the common case: without this path, the "detect again"
  /// button would have replayed the already-resolved promise and the user
  /// would have stayed on "no answer" until the application restarted.
  async function refresh() {
    if (registered.length) return; // already in place: nothing to retry
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
