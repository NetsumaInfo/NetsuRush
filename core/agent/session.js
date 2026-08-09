// @ts-check
// Orchestrateur de la Chat IA. Aiguille un tour de conversation vers le bon moteur :
//   provider 'anthropic' / 'openai' → BYOK (boucle tool-use possédée ici, outils du registry)
//   provider 'cli'                  → spawn l'agent CLI (claude/codex), outils via MCP (mcpConfigPath)
// Diffuse les événements normalisés en SSE `chat:event` {runId, ev}. La permission est appliquée
// AVANT chaque exécution d'outil (peut diffuser `chat:approval` et attendre la réponse du renderer).

const { runAnthropic } = require('./byok/anthropic');
const { runOpenAI } = require('./byok/openai');
const { startCliRun } = require('./runtimes/runs');
const { getDef } = require('./runtimes/defs');
const { detectAgents } = require('./runtimes/detection');

/**
 * @param {{ registry:any, permissions:any, broadcast:(ch:string,p:any)=>void, mcpConfigPath?:()=>(string|undefined) }} deps
 */
function createSession(deps) {
  const { registry, permissions, broadcast } = deps;

  // Secrets EN RAM uniquement (jamais écrits sur disque par le core ; au repos = Stronghold côté Tauri).
  const keys = { anthropic: '', openai: '', openaiBaseUrl: '', openrouter: '' };
  /** @type {Map<string,{ abort:AbortController, child?:import('child_process').ChildProcess }>} */
  const runs = new Map();

  /** @param {string} runId @param {any} ev */
  function emit(runId, ev) { broadcast('chat:event', { runId, ev }); }

  /** @param {{mode?:string, anthropicKey?:string, openaiKey?:string, openaiBaseUrl?:string, openrouterKey?:string}} cfg */
  function configure(cfg) {
    if (cfg.mode) permissions.setMode(cfg.mode);
    if (typeof cfg.anthropicKey === 'string') keys.anthropic = cfg.anthropicKey;
    if (typeof cfg.openaiKey === 'string') keys.openai = cfg.openaiKey;
    if (typeof cfg.openaiBaseUrl === 'string') keys.openaiBaseUrl = cfg.openaiBaseUrl;
    if (typeof cfg.openrouterKey === 'string') keys.openrouter = cfg.openrouterKey;
    return { ok: true };
  }

  // Agents disponibles : CLI détectés sur le PATH + providers BYOK selon clés présentes + mode courant.
  async function listAgents() {
    const cli = await detectAgents();
    return {
      mode: permissions.getMode(),
      byok: {
        anthropic: !!keys.anthropic,
        openai: !!keys.openai,
        openrouter: !!keys.openrouter,
      },
      cli,
    };
  }

  // Exécute un outil sous contrôle de permission. Renvoie le résultat (ou un refus).
  // Mode 'safe' (doublure) : avant la 1re écriture du tour, duplique la timeline courante et bascule
  // dessus → toutes les écritures suivantes frappent la COPIE, l'originale reste intacte.
  /** @param {string} runId */
  function makeRunTool(runId) {
    let duplicated = false;
    return async (/** @type {string} */ name, /** @type {any} */ input) => {
      const tool = registry.get(name);
      const risk = (tool && (tool.riskFor ? tool.riskFor(input) : tool.risk)) || 'read';

      if (permissions.getMode() === 'safe' && risk !== 'read' && !duplicated) {
        duplicated = true; // une seule doublure par tour, même si la duplication échoue
        try {
          const r = await registry.execute('resolve_timeline', { action: 'duplicate' }, { runId });
          if (r && r.ok && r.name) emit(runId, { type: 'status', label: `doublure créée : ${r.name}` });
        } catch { /* pas de timeline ouverte → rien à dupliquer, on continue */ }
      }

      const perm = await permissions.check(runId, { name, input, risk });
      if (!perm.approved) return { ok: false, error: perm.reason || 'action refusée' };
      return registry.execute(name, input, { runId });
    };
  }

  // Compose un prompt unique pour les CLI one-shot (system + historique + dernier message).
  /** @param {string|undefined} system @param {Array<{role:string,content:string}>} messages */
  function composePrompt(system, messages) {
    const parts = [];
    if (system) parts.push(system);
    for (const m of messages) parts.push(`${m.role === 'assistant' ? 'Assistant' : 'Utilisateur'}: ${m.content}`);
    parts.push('Assistant:');
    return parts.join('\n\n');
  }

  /**
   * @param {{ runId:string, provider:'anthropic'|'openai'|'openrouter'|'cli', agent?:string, model?:string,
   *           messages:Array<{role:'user'|'assistant',content:string}>, system?:string }} opts
   */
  async function send(opts) {
    const { runId, provider, agent, model, messages, system } = opts;
    const abort = new AbortController();
    const entry = { abort };
    runs.set(runId, entry);
    const runTool = makeRunTool(runId);
    const onEvent = (/** @type {any} */ e) => emit(runId, e);

    try {
      if (provider === 'anthropic') {
        await runAnthropic({ apiKey: keys.anthropic, model, system, messages, tools: registry.toAnthropicTools(), runTool, onEvent, signal: abort.signal });
      } else if (provider === 'openai') {
        await runOpenAI({ apiKey: keys.openai, baseUrl: keys.openaiBaseUrl || undefined, model, system, messages, tools: registry.toOpenAITools(), runTool, onEvent, signal: abort.signal });
      } else if (provider === 'openrouter') {
        // OpenRouter = API OpenAI-compatible → même boucle tool-calling, baseUrl + clé dédiées.
        await runOpenAI({
          apiKey: keys.openrouter, baseUrl: 'https://openrouter.ai/api/v1',
          model: model || 'anthropic/claude-sonnet-4.5',
          system, messages, tools: registry.toOpenAITools(), runTool, onEvent, signal: abort.signal,
        });
      } else if (provider === 'cli') {
        const def = getDef(agent || 'claude');
        if (!def) { onEvent({ type: 'error', message: `agent inconnu : ${agent}` }); onEvent({ type: 'done', stopReason: 'error' }); return { ok: true }; }
        const prompt = composePrompt(system, messages);
        const mcpConfigPath = deps.mcpConfigPath ? deps.mcpConfigPath() : undefined;
        const r = startCliRun({ def, prompt, model, mcpConfigPath, onEvent });
        entry.child = r.child;
        await r.done;
      } else {
        onEvent({ type: 'error', message: `fournisseur inconnu : ${provider}` });
        onEvent({ type: 'done', stopReason: 'error' });
      }
    } catch (e) {
      onEvent({ type: 'error', message: String((e && /** @type {any} */(e).message) || e) });
      onEvent({ type: 'done', stopReason: 'error' });
    } finally {
      runs.delete(runId);
    }
    return { ok: true };
  }

  /** @param {string} runId */
  function cancel(runId) {
    const r = runs.get(runId);
    if (!r) return { ok: false };
    try { r.abort.abort(); } catch { /* noop */ }
    try { r.child && r.child.kill(); } catch { /* noop */ }
    runs.delete(runId);
    emit(runId, { type: 'done', stopReason: 'cancelled' });
    return { ok: true };
  }

  function cancelAll() {
    for (const id of [...runs.keys()]) cancel(id);
    permissions.cancelAll();
  }

  return { configure, listAgents, send, cancel, cancelAll, respondApproval: permissions.respond };
}

module.exports = { createSession };
