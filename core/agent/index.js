// @ts-check
// Façade du module agent (Chat IA). Assemble : registre d'outils (modules NetsuRush existants +,
// plus tard, catalogue Resolve), porte de permission, session (CLI + BYOK), serveur MCP (exposition
// aux CLI agents) et persistance des conversations. Consommé par core/rpc.js.

const { createToolRegistry } = require('./tools/registry');
const { createNetsuRushTools } = require('./tools/netsurush');
const { createPermissions } = require('./permissions');
const { createSession } = require('./session');
const { createChatStore } = require('./store');
const { openAgentLogin, openAgentInstall } = require('./login'); // terminal interactif
const { createResolveTools } = require('./tools/resolve'); // catalogue Resolve (compound dispatchers)
const { createResolveMcp } = require('./tools/resolveMcp'); // serveur MCP officiel Blackmagic, replié dans le registre
const { createMcpBridge } = require('./mcp/server'); // serveur MCP stdio exposant le registry aux CLI
const { createExternalAccess } = require('./mcp/external'); // external MCP clients (Claude Desktop, Codex…)
const { createAppTools } = require('./tools/app'); // one compound tool per app domain, over rpc channels
const { createJobs } = require('./jobs'); // long tool calls outliving an MCP request
const { createResources } = require('./resources'); // MCP resources (read-only data snapshots)
const { createSubagents, subagentAllows, TOOLS: SUBAGENT_TOOLS, SURFACES: SUBAGENT_SURFACES } = require('./subagents'); // parallel Haiku agents
const { t } = require('../i18n');
const fs = require('fs');
const path = require('path');

/**
 * @param {{
 *   broadcast:(ch:string,p:any)=>void, ev:any, dataDir:string,
 *   invoke?:(channel:string, args?:any[])=>Promise<any>,
 *   channels?:()=>string[], channelSource?:(channel:string)=>string,
 *   modules:{ resolveMod:any, timeline:any, sidecars:any, thumbs:any, proxy:any, ffmpeg:any,
 *             aeExporter:any,
 *             guarded:(fn:Function)=>Function, rOp:(fn:Function)=>Function }
 * }} deps
 */
function createAgent(deps) {
  const { broadcast, ev, dataDir, modules } = deps;
  // Lazy: rpc.js builds its channel table after the agent, and the app tools only call it later.
  const invoke = async (/** @type {string} */ channel, /** @type {any[]} */ args = []) => {
    if (!deps.invoke) throw new Error(`rpc channel unavailable: ${channel}`);
    return deps.invoke(channel, args);
  };
  const jobs = createJobs();

  const registry = createToolRegistry();
  registry.registerAll(createNetsuRushTools({ ...modules, ev }));
  registry.registerAll(createResolveTools({ ...modules, ev }));
  const external = createExternalAccess({ dataDir });
  // Filled once the MCP bridge exists: sub-agents spawn through its per-surface configs.
  /** @type {any} */
  let subagents = null;
  registry.registerAll(createAppTools({
    invoke, jobs,
    subagents: {
      dispatch: (/** @type {any} */ a) => subagents.dispatch(a),
      status: () => subagents.status(),
      cancelAll: () => subagents.cancelAll(),
    },
    channels: () => (deps.channels ? deps.channels() : []),
    channelSource: (channel) => (deps.channelSource ? deps.channelSource(channel) : ''),
  }));
  const resources = createResources({ invoke, jobs });
  /// Last external calls, for the settings view: the user sees what a connected agent did.
  /** @type {any[]} */
  const recent = [];
  const RECENT_MAX = 20;
  const EXTERNAL_APPROVAL_MS = 120000;
  // Serveur MCP officiel de Blackmagic (livré avec Resolve Studio 21.1+). Ses
  // outils sont DÉCOUVERTS, pas déclarés ici : ils arrivent donc dans le
  // registre après coup, et `send` attend `ready()` avant de composer sa liste.
  // Absent (Resolve pas installé, édition gratuite) : le reste fonctionne.
  const resolveMcp = createResolveMcp({ registry });
  void resolveMcp.ready();

  const permissions = createPermissions({ broadcast });
  // Numerote les appels venus du pont MCP, pour que chaque resultat retrouve la
  // ligne qui l'attend dans la trace.
  let mcpCallSeq = 0;
  const store = createChatStore(dataDir);

  // Serveur MCP : écrit un .mcp.json pointant sur lui-même et l'expose aux CLI agents (claude --mcp-config).
  const mcp = createMcpBridge({ registry, permissions, dataDir });

  subagents = createSubagents({
    workspace: () => {
      const dir = path.join(dataDir, 'agent-workspace');
      try { fs.mkdirSync(dir, { recursive: true }); } catch { /* already there */ }
      return dir;
    },
    mcpConfigPath: (surface) => mcp.mcpConfigPath(surface),
    settings: () => external.get(),
    broadcast,
  });

  const session = createSession({
    registry, permissions, broadcast, dataDir, resolveMcp,
    mcpConfigPath: (surface) => mcp.mcpConfigPath(surface),
  });

  function announceExternal() {
    const state = externalState();
    broadcast('mcp:external:changed', state);
    return state;
  }

  function externalState() {
    return { ...external.get(), clients: external.clients(), recent: [...recent], serverCommand: external.serverSpec() };
  }

  /// A sub-agent's rights were fixed when it was dispatched, and it has nobody to ask.
  /** @param {string} surface @param {string} name @param {any} input @param {'read'|'write'|'destructive'} risk */
  async function subagentCall(surface, name, input, risk) {
    if (!subagentAllows(surface, name, risk)) return { ok: false, error: t('agentSubagentRefused') };
    const result = await registry.execute(name, input, { runId: surface });
    if (risk !== 'read' && !(result && result.ok === false)) broadcast('agent:dataChanged', { tool: name, action: input.action });
    return result;
  }

  /** @param {string} name @param {any} input @param {'read'|'write'|'destructive'} risk */
  async function externalCall(name, input, risk) {
    const settings = external.get();
    const log = (/** @type {boolean} */ ok, /** @type {string|undefined} */ error) => {
      const entry = { at: Date.now(), name, ...(input.action ? { action: String(input.action) } : {}), risk, ok, ...(error ? { error } : {}) };
      recent.unshift(entry);
      recent.length = Math.min(recent.length, RECENT_MAX);
      broadcast('mcp:activity', entry);
    };
    if (!settings.enabled) {
      const refused = { ok: false, error: t('agentExternalDisabled') };
      log(false, refused.error);
      return refused;
    }
    const perm = await permissions.check('external', { name, input, risk }, { mode: settings.mode, timeoutMs: EXTERNAL_APPROVAL_MS });
    if (!perm.approved) {
      const refused = { ok: false, error: perm.reason || t('agentActionRefused') };
      log(false, refused.error);
      return refused;
    }
    const result = await registry.execute(name, input, { runId: 'external' });
    const failed = !!(result && typeof result === 'object' && result.ok === false);
    log(!failed, failed ? String(result.error || '') : undefined);
    if (risk !== 'read' && !failed) broadcast('agent:dataChanged', { tool: name, action: input.action });
    return result;
  }

  return {
    // Session / moteur
    configure: session.configure,
    listAgents: session.listAgents,
    /// Modeles d'un fournisseur, tires de son API quand une cle est en place et
    /// du catalogue public d'OpenRouter sinon — jamais d'une liste tapee a la main.
    listModels: (/** @type {any} */ request) => session.listModels(request || {}),
    send: session.send,
    cancel: session.cancel,
    /// Arrêt du core : le serveur MCP de Blackmagic est un processus enfant, et
    /// le laisser derrière garderait une connexion ouverte sur Resolve.
    cancelAll: () => { session.cancelAll(); subagents.cancelAll(); resolveMcp.close(); },
    subagentsCancel: () => subagents.cancelAll(),
    respondApproval: session.respondApproval,
    // Outils (debug / UI)
    describeTools: () => registry.describe(),
    /// Le test de connexion. Les clés vivent dans la session (en RAM) : le
    /// panneau n'a pas à les renvoyer pour tester celle qui est déjà en place.
    probe: (/** @type {any} */ request) => session.probe(request || {}),
    login: (/** @type {any} */ request) => openAgentLogin(request || {}),
    install: (/** @type {any} */ request) => openAgentInstall(request || {}),

    // Pont MCP (serveur stdio thin) : liste + exécution sous permission (contexte CLI).
    // Narrowed rather than trusted: the surface arrives from a spawned process's
    // environment, so an unknown value falls back instead of filtering to none.
    toolList: (/** @type {string|undefined} */ surface) => (
      SUBAGENT_SURFACES.includes(String(surface))
        ? registry.toMcpTools('external').filter((/** @type {any} */ tool) => SUBAGENT_TOOLS.includes(tool.name))
        : registry.toMcpTools(registry.SURFACES.includes(/** @type {any} */ (surface)) ? /** @type {any} */ (surface) : 'pilot')
    ),
    ///
    /// Diffuse `tool_use` puis `tool_result`, exactement comme la boucle BYOK.
    /// Il ne diffusait rien : avec un agent CLI, l'interface ne voyait donc ni
    /// l'appel ni son resultat. Dans NetsuFlow, ou la proposition de montage
    /// VOYAGE dans le resultat de `flow_propose`, cela voulait dire un agent qui
    /// repond « proposition prete » sans qu'aucune carte n'apparaisse et sans
    /// bouton pour l'appliquer — la fonction entiere hors service.
    ///
    /// `surface` 'external' is a client the user connected from outside the app: it has its own
    /// switch and permission mode, its prompts expire, and each call is logged for the settings.
    toolCall: async (/** @type {string} */ name, /** @type {any} */ input, /** @type {string|undefined} */ surface) => {
      const tool = registry.get(name);
      const risk = (tool && (tool.riskFor ? tool.riskFor(input) : tool.risk)) || 'read';
      if (surface === 'external') return externalCall(name, input || {}, risk);
      if (SUBAGENT_SURFACES.includes(String(surface))) return subagentCall(String(surface), name, input || {}, risk);
      const runId = session.currentCliRun();
      // Un identifiant d'appel stable, pour que le resultat retrouve sa ligne.
      const callId = `mcp-${Date.now().toString(36)}-${(mcpCallSeq += 1)}`;
      const emit = (/** @type {any} */ ev) => { if (runId) broadcast('chat:event', { runId, ev }); };

      emit({ type: 'tool_use', id: callId, name, input });
      const perm = await permissions.check('cli', { name, input, risk });
      if (!perm.approved) {
        const refused = { ok: false, error: perm.reason || t('agentActionRefused') };
        emit({ type: 'tool_result', id: callId, ok: false, content: refused });
        return refused;
      }
      const result = await registry.execute(name, input, { runId: runId || 'cli' });
      // `ok` vient du resultat quand il en porte un : un outil qui echoue sans
      // lever doit s'afficher en echec, pas en succes silencieux.
      emit({
        type: 'tool_result', id: callId,
        ok: !(result && typeof result === 'object' && result.ok === false),
        content: result,
      });
      if (risk !== 'read') broadcast('agent:dataChanged', { tool: name, action: input && input.action });
      return result;
    },
    // Resources (MCP) — read-only snapshots for external clients.
    resourceList: () => resources.list(),
    resourceTemplates: () => resources.listTemplates(),
    resourceRead: (/** @type {string} */ uri) => resources.read(uri),
    // External MCP clients: settings, client config install, recent activity.
    externalState,
    /// Every change is broadcast: several windows (the app, a browser tab) show the same settings.
    externalSet: (/** @type {any} */ patch) => { external.set(patch || {}); return announceExternal(); },
    externalInstall: (/** @type {string} */ id) => { const r = external.install(String(id)); announceExternal(); return r; },
    externalUninstall: (/** @type {string} */ id) => { const r = external.uninstall(String(id)); announceExternal(); return r; },
    externalSnippet: () => external.snippet(),
    observeBroadcast: (/** @type {string} */ channel, /** @type {any} */ payload) => jobs.observe(channel, payload),
    // Historique
    listConversations: store.listConversations,
    loadConversation: store.loadConversation,
    saveConversation: store.saveConversation,
    deleteConversation: store.deleteConversation,
    // Exposés pour le serveur MCP autonome (sidecar) si besoin
    registry, permissions,
  };
}

module.exports = { createAgent };
