// @ts-check
// Registre d'outils de l'agent IA — SOURCE UNIQUE des capacités exposées à l'IA. Chaque outil est
// décrit une fois (nom, description, schéma d'entrée JSON Schema, niveau de risque, handler) puis
// surfacé de TROIS façons : (a) tools Anthropic (BYOK), (b) tools OpenAI (BYOK Codex/GPT), (c) tools
// MCP (CLI agents claude/codex via le serveur MCP). Une seule implémentation, trois transports.
//
// risk : 'read' (lecture seule, jamais destructif) · 'write' (crée/modifie, réversible) ·
//        'destructive' (supprime/rend/écrase, difficilement réversible). Pilote la porte de permission.

/**
 * @typedef {'read'|'write'|'destructive'} ToolRisk
 * @typedef {Object} ToolDef
 * @property {string} name
 * @property {string} description
 * @property {object} inputSchema  JSON Schema de l'objet d'arguments
 * @property {ToolRisk} risk
 * @property {(input:any)=>ToolRisk} [riskFor]  risque dynamique par appel (dispatchers compound)
 * @property {(args:any, ctx:any)=>Promise<any>|any} handler
 */

function createToolRegistry() {
  /** @type {Map<string, ToolDef>} */
  const tools = new Map();

  /** @param {ToolDef} tool */
  function register(tool) {
    if (!tool || !tool.name) throw new Error('outil sans nom');
    if (tools.has(tool.name)) throw new Error(`outil déjà enregistré : ${tool.name}`);
    tools.set(tool.name, {
      risk: 'read',
      inputSchema: { type: 'object', properties: {} },
      ...tool,
    });
  }

  /** @param {ToolDef[]} list */
  function registerAll(list) {
    for (const t of list || []) register(t);
  }

  /** @param {string} name */
  function get(name) {
    return tools.get(name) || null;
  }

  function list() {
    return [...tools.values()];
  }

  // Métadonnées seules (sans handler) — pour l'UI / le debug.
  function describe() {
    return list().map((t) => ({ name: t.name, description: t.description, risk: t.risk }));
  }

  // --- Surfaces de définition (3 formats) -----------------------------------
  function toAnthropicTools() {
    return list().map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  }

  function toOpenAITools() {
    return list().map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
  }

  function toMcpTools() {
    return list().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  // Exécute un outil. La permission est gérée EN AMONT (session/permissions), pas ici.
  /** @param {string} name @param {any} args @param {any} ctx */
  async function execute(name, args, ctx) {
    const t = tools.get(name);
    if (!t) return { ok: false, error: `outil inconnu : ${name}` };
    try {
      const result = await t.handler(args || {}, ctx || {});
      return result;
    } catch (e) {
      return { ok: false, error: String((e && /** @type {any} */(e).message) || e) };
    }
  }

  return {
    register, registerAll, get, list, describe,
    toAnthropicTools, toOpenAITools, toMcpTools, execute,
  };
}

module.exports = { createToolRegistry };
