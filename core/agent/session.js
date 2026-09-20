// @ts-check
// Orchestrateur de la Chat IA. Aiguille un tour de conversation vers le bon moteur :
//   provider 'anthropic' / 'openai' → BYOK (boucle tool-use possédée ici, outils du registry)
//   provider 'cli'                  → spawn l'agent CLI (claude/codex), outils via MCP (mcpConfigPath)
// Diffuse les événements normalisés en SSE `chat:event` {runId, ev}. La permission est appliquée
// AVANT chaque exécution d'outil (peut diffuser `chat:approval` et attendre la réponse du renderer).

const fs = require('fs');
const path = require('path');
const { createModelCatalog } = require('./models');
const { bodyFor: thinkingBody, cliArgsFor: thinkingCliArgs } = require('./thinking');
const { runAnthropic } = require('./byok/anthropic');
const { runOpenAI } = require('./byok/openai');
const { probeProvider } = require('./probe');
const { startCliRun } = require('./runtimes/runs');
const { getDef } = require('./runtimes/defs');
const { detectAgents } = require('./runtimes/detection');

/**
 * @param {{ registry:any, permissions:any, broadcast:(ch:string,p:any)=>void,
 *           dataDir?:string, resolveMcp?:any,
 *           mcpConfigPath?:(surface?:string)=>(string|undefined) }} deps
 */
function createSession(deps) {
  const { registry, permissions, broadcast } = deps;

  /// Le dossier de travail de l'agent CLI. VIDE, et hors du depot.
  ///
  /// Sans lui, `spawn` retombait sur le dossier courant du core — les sources de
  /// NetsuRush — et l'agent, qui embarque ses propres Read/Edit/Write/Bash, y
  /// modifiait les fichiers directement plutot que d'appeler nos outils. Le
  /// rechargement a chaud faisait le reste : l'application redemarrait toute
  /// seule au milieu d'une conversation.
  ///
  /// Le dossier reste vide a dessein : l'agent n'a rien a lire sur le disque,
  /// tout ce qu'il peut faire passe par les outils MCP.
  function agentWorkspace() {
    const base = deps.dataDir || require('os').tmpdir();
    const dir = path.join(base, 'agent-workspace');
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* deja la */ }
    return dir;
  }

  // Secrets EN RAM uniquement (jamais écrits sur disque par le core ; au repos = Stronghold côté Tauri).
  const keys = { anthropic: '', openai: '', openaiBaseUrl: '', openrouter: '', xai: '', xaiBaseUrl: '' };
  const catalog = createModelCatalog();
  /** @type {Map<string,{ abort:AbortController, child?:import('child_process').ChildProcess }>} */
  const runs = new Map();
  // Le tour CLI en cours. Un agent en ligne de commande execute ses outils par
  // le pont MCP, un chemin qui ne connait pas le `runId` : sans cette trace, ses
  // evenements n'auraient aucun tour auquel s'attacher et le renderer, qui filtre
  // dessus, les jetterait tous.
  /** @type {string|null} */
  let activeCliRun = null;

  /** @param {string} runId @param {any} ev */
  function emit(runId, ev) { broadcast('chat:event', { runId, ev }); }

  /// Teste une connexion. Une clé fournie dans la requête l'emporte, pour
  /// pouvoir essayer AVANT d'enregistrer ; sinon on teste celle en session.
  /** @param {{provider?:string, key?:string, baseUrl?:string, model?:string}} request */
  async function probe(request) {
    const provider = String(request.provider || '');
    const stored = provider === 'anthropic' ? keys.anthropic
      : provider === 'openai' ? keys.openai
        : provider === 'openrouter' ? keys.openrouter
          : provider === 'xai' ? keys.xai : '';
    const baseUrl = request.baseUrl
      || (provider === 'openai' ? keys.openaiBaseUrl : provider === 'xai' ? keys.xaiBaseUrl : '');
    return probeProvider({
      provider,
      key: request.key || stored,
      baseUrl: baseUrl || undefined,
      model: request.model || undefined,
    });
  }

  /** @param {{mode?:string, anthropicKey?:string, openaiKey?:string, openaiBaseUrl?:string,
   *            openrouterKey?:string, xaiKey?:string, xaiBaseUrl?:string,
   *            duplicateFirst?:boolean, resolveUnsafe?:boolean}} cfg */
  function configure(cfg) {
    if (cfg.mode) permissions.setMode(cfg.mode);
    // `bmd_run_script_unsafe` : le seul outil du serveur Blackmagic qui sorte du
    // bac à sable (fichiers, réseau, sous-processus). Il entre ou sort du
    // registre ici — aucun mode de permission ne peut le contenir une fois le
    // script parti, donc c'est un choix explicite, pas un réglage de risque.
    if (typeof cfg.resolveUnsafe === 'boolean' && deps.resolveMcp) {
      void deps.resolveMcp.setUnsafe(cfg.resolveUnsafe);
    }
    if (typeof cfg.anthropicKey === 'string') keys.anthropic = cfg.anthropicKey;
    if (typeof cfg.openaiKey === 'string') keys.openai = cfg.openaiKey;
    if (typeof cfg.openaiBaseUrl === 'string') keys.openaiBaseUrl = cfg.openaiBaseUrl;
    if (typeof cfg.openrouterKey === 'string') keys.openrouter = cfg.openrouterKey;
    if (typeof cfg.xaiKey === 'string') keys.xai = cfg.xaiKey;
    // EU accounts are served from eu-west-1; the default is the US endpoint.
    if (typeof cfg.xaiBaseUrl === 'string') keys.xaiBaseUrl = cfg.xaiBaseUrl;
    if (typeof cfg.duplicateFirst === 'boolean') permissions.setDuplicateFirst(cfg.duplicateFirst);
    // Une cle qui change change la liste : le catalogue passe de la source
    // approximative (OpenRouter, sans cle) a la liste exacte du fournisseur.
    if (typeof cfg.anthropicKey === 'string' || typeof cfg.openaiKey === 'string'
      || typeof cfg.openrouterKey === 'string' || typeof cfg.xaiKey === 'string') catalog.clear();
    return { ok: true };
  }

  /// Modeles disponibles pour un fournisseur. La cle vit ici, en RAM : l'UI
  /// n'a pas a la renvoyer pour obtenir la liste qu'elle debloque.
  /** @param {{provider?:string, refresh?:boolean}} request */
  async function listModels(request) {
    const provider = String((request && request.provider) || '');
    const key = provider === 'anthropic' ? keys.anthropic
      : provider === 'openai' ? keys.openai
        : provider === 'openrouter' ? keys.openrouter
          : provider === 'xai' ? keys.xai : '';
    const baseUrl = provider === 'openai' ? keys.openaiBaseUrl
      : provider === 'xai' ? keys.xaiBaseUrl : '';
    return catalog.list(provider, {
      key,
      baseUrl: baseUrl || undefined,
      refresh: !!(request && request.refresh),
    });
  }

  // Agents disponibles : CLI détectés sur le PATH + providers BYOK selon clés présentes + mode courant.
  async function listAgents() {
    const cli = await detectAgents();
    // Le serveur de Blackmagic est découvert, pas configuré : le panneau dit
    // s'il a été trouvé, quelle version, et combien d'outils il a apportés.
    // `refresh` et non `ready` : c'est le bouton « relancer la détection », et
    // Resolve ouvert APRÈS l'application doit pouvoir être rattrapé sans
    // redémarrer le core. Sans outils en place, il retente ; avec, il ne fait rien.
    if (deps.resolveMcp) { try { await deps.resolveMcp.refresh(); } catch { /* statut porte l'erreur */ } }
    return {
      mode: permissions.getMode(),
      duplicateFirst: permissions.getDuplicateFirst(),
      resolveMcp: deps.resolveMcp ? deps.resolveMcp.status() : null,
      byok: {
        anthropic: !!keys.anthropic,
        openai: !!keys.openai,
        openrouter: !!keys.openrouter,
        xai: !!keys.xai,
      },
      cli,
    };
  }

  // Exécute un outil sous contrôle de permission. Renvoie le résultat (ou un refus).
  // Doublure : avant la 1re écriture du tour, duplique la timeline courante et bascule dessus →
  // toutes les écritures suivantes frappent la COPIE, l'originale reste intacte. Combinable avec
  // n'importe quel mode, parce que vouloir une copie de sécurité et vouloir être consulté sont deux
  // souhaits différents.
  /** @param {string} runId */
  function makeRunTool(runId) {
    let duplicated = false;
    return async (/** @type {string} */ name, /** @type {any} */ input) => {
      const tool = registry.get(name);
      const risk = (tool && (tool.riskFor ? tool.riskFor(input) : tool.risk)) || 'read';

      if (permissions.getDuplicateFirst() && risk !== 'read' && !duplicated) {
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
  /** @param {string|undefined} system @param {Array<{role:string,content:string,images?:Array<{mediaType:string,data:string}>}>} messages */
  function composePrompt(system, messages) {
    const parts = [];
    if (system) parts.push(system);
    for (const m of messages) {
      // Un agent CLI recoit un prompt TEXTE : il n'a pas de canal pour une
      // image. On le DIT plutot que de la laisser disparaitre en silence, sinon
      // le modele repond a une demande dont il lui manque la moitie.
      const note = Array.isArray(m.images) && m.images.length
        ? ` [${m.images.length} image(s) jointe(s) — non lisibles par un agent en ligne de commande ;`
          + ' demande a l\'utilisateur de decrire ce qu\'elles montrent]'
        : '';
      parts.push(`${m.role === 'assistant' ? 'Assistant' : 'Utilisateur'}: ${m.content}${note}`);
    }
    parts.push('Assistant:');
    return parts.join('\n\n');
  }

  /**
   * @param {{ runId:string, provider:'anthropic'|'openai'|'openrouter'|'xai'|'cli', agent?:string, model?:string,
   *           messages:Array<{role:'user'|'assistant',content:string,images?:Array<{mediaType:string,data:string}>}>, system?:string,
   *           surface?:'pilot'|'flow', thinking?:string }} opts
   */
  async function send(opts) {
    const { runId, provider, agent, model, messages, system, surface, thinking } = opts;
    const abort = new AbortController();
    const entry = { abort };
    runs.set(runId, entry);
    const runTool = makeRunTool(runId);
    const onEvent = (/** @type {any} */ e) => emit(runId, e);

    // Les outils du serveur MCP de Blackmagic arrivent dans le registre APRÈS le
    // démarrage, puisqu'ils sont lus sur le serveur. Sans cette attente, le
    // premier message d'une session partait avec la liste d'avant : outils
    // visibles dans le panneau, absents du modèle.
    if (deps.resolveMcp) { try { await deps.resolveMcp.ready(); } catch { /* le tour part sans eux */ } }

    try {
      if (provider === 'anthropic') {
        await runAnthropic({ apiKey: keys.anthropic, model, system, messages, thinking, tools: registry.toAnthropicTools(surface), runTool, onEvent, signal: abort.signal });
      } else if (provider === 'openai') {
        await runOpenAI({ apiKey: keys.openai, baseUrl: keys.openaiBaseUrl || undefined, model, system, messages, extraBody: thinkingBody('openai', thinking), tools: registry.toOpenAITools(surface), runTool, onEvent, signal: abort.signal });
      } else if (provider === 'xai') {
        // Documented as compatible with the OpenAI REST shape, so the existing
        // tool-calling loop drives it unchanged: a base URL and a key, not an
        // adapter. EU accounts use eu-west-1.api.x.ai instead.
        await runOpenAI({
          apiKey: keys.xai, baseUrl: keys.xaiBaseUrl || 'https://api.x.ai/v1',
          model: model || 'grok-4.6',
          system, messages, extraBody: thinkingBody('xai', thinking),
          tools: registry.toOpenAITools(surface), runTool, onEvent, signal: abort.signal,
        });
      } else if (provider === 'openrouter') {
        // OpenRouter = API OpenAI-compatible → même boucle tool-calling, baseUrl + clé dédiées.
        await runOpenAI({
          apiKey: keys.openrouter, baseUrl: 'https://openrouter.ai/api/v1',
          // Defaut relevé : `claude-sonnet-4.5` avait deux generations de retard.
          model: model || 'anthropic/claude-sonnet-5',
          system, messages, extraBody: thinkingBody('openrouter', thinking),
          tools: registry.toOpenAITools(surface), runTool, onEvent, signal: abort.signal,
        });
      } else if (provider === 'cli') {
        const def = getDef(agent || 'claude');
        if (!def) { onEvent({ type: 'error', message: `agent inconnu : ${agent}` }); onEvent({ type: 'done', stopReason: 'error' }); return { ok: true }; }
        const prompt = composePrompt(system, messages);
        const mcpConfigPath = deps.mcpConfigPath ? deps.mcpConfigPath(surface) : undefined;
        activeCliRun = runId;
        try {
          // La liste blanche est construite a partir du registre : elle suit
          // exactement ce que le pont MCP expose pour cette surface, donc un
          // outil retire du registre cesse d'etre autorise sans qu'on y pense.
          const allowedTools = (registry.toMcpTools
            ? registry.toMcpTools(surface === 'flow' ? 'flow' : 'pilot')
            : []).map((/** @type {any} */ t) => `mcp__netsurush__${t.name}`);
          const r = startCliRun({
            def, prompt, model, mcpConfigPath, onEvent,
            cwd: agentWorkspace(),
            allowedTools,
            extraArgs: thinkingCliArgs(def.id, thinking),
          });
          entry.child = r.child;
          await r.done;
        } finally {
          activeCliRun = null;
        }
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

  /// Le tour CLI en cours, ou `null`. Sert au pont MCP a attribuer ses
  /// evenements d'outil au bon tour.
  function currentCliRun() { return activeCliRun; }

  return {
    probe, configure, listAgents, listModels, send, cancel, cancelAll,
    currentCliRun, respondApproval: permissions.respond,
  };
}

module.exports = { createSession };
