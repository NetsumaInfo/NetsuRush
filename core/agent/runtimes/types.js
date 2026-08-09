// @ts-check
// Typedefs partagés du registre d'agents CLI (data-driven, façon open-design runtimes/defs).
// Module sans runtime (juste des types JSDoc référencés par defs/detection/runs).

/**
 * @typedef {'claude-stream-json'|'codex-json'|'text'} StreamFormat
 *
 * @typedef {Object} BuildArgsOpts
 * @property {string} prompt
 * @property {string} [model]
 * @property {string} [mcpConfigPath]  chemin du .mcp.json injecté (outils NetsuRush)
 * @property {string} [cwd]
 *
 * @typedef {Object} RuntimeAgentDef
 * @property {string} id            identifiant stable (ex. 'claude')
 * @property {string} name          libellé UI (ex. 'Claude Code')
 * @property {string} bin           binaire principal sur le PATH
 * @property {string[]} [fallbackBins]
 * @property {string[]} versionArgs args de sonde de version (ex. ['--version'])
 * @property {(o:BuildArgsOpts)=>string[]} buildArgs  args de lancement complets
 * @property {StreamFormat} streamFormat
 * @property {boolean} [promptViaStdin]  true = prompt écrit sur stdin (sinon positionnel)
 * @property {'mcp-config-flag'|'codex-config'|null} [mcpInjection]
 * @property {string[]} [models]    modèles connus (UI), informatif
 */

module.exports = {};
