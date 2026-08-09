// @ts-check
// Registre data-driven des agents CLI. Ajouter un agent = ajouter une entrée ici (façon open-design
// runtimes/defs/*). Chaque def décrit comment LANCER le CLI et PARSER sa sortie ; les outils NetsuRush
// sont fournis au CLI via le serveur MCP (.mcp.json injecté, cf. mcpInjection).

/** @type {import('./types').RuntimeAgentDef[]} */
const DEFS = [
  {
    id: 'claude',
    name: 'Claude Code',
    bin: 'claude',
    fallbackBins: ['claude.cmd'],
    versionArgs: ['--version'],
    streamFormat: 'claude-stream-json',
    promptViaStdin: true,
    mcpInjection: 'mcp-config-flag',
    models: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
    buildArgs: ({ model, mcpConfigPath }) => [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      ...(model ? ['--model', model] : []),
      ...(mcpConfigPath ? ['--mcp-config', mcpConfigPath] : []),
      '--permission-mode', 'bypassPermissions',
    ],
  },
  {
    id: 'codex',
    name: 'Codex',
    bin: 'codex',
    fallbackBins: ['codex.cmd'],
    versionArgs: ['--version'],
    streamFormat: 'codex-json',
    promptViaStdin: false,
    mcpInjection: 'codex-config',
    models: ['gpt-5-codex', 'o4-mini'],
    buildArgs: ({ prompt, model }) => [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--sandbox', 'workspace-write',
      ...(model ? ['-c', `model=${model}`] : []),
      prompt,
    ],
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    bin: 'gemini',
    fallbackBins: ['gemini.cmd'],
    versionArgs: ['--version'],
    streamFormat: 'text',
    promptViaStdin: true,
    mcpInjection: null,
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    buildArgs: ({ model }) => (model ? ['-m', model] : []),
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    bin: 'opencode',
    fallbackBins: ['opencode.cmd'],
    versionArgs: ['--version'],
    streamFormat: 'text',
    promptViaStdin: false,
    mcpInjection: null,
    models: [],
    buildArgs: ({ prompt, model }) => ['run', ...(model ? ['--model', model] : []), prompt],
  },
  {
    id: 'qwen',
    name: 'Qwen Code',
    bin: 'qwen',
    fallbackBins: ['qwen.cmd'],
    versionArgs: ['--version'],
    streamFormat: 'text',
    promptViaStdin: true, // fork de Gemini CLI : même interface (prompt sur stdin, sortie texte)
    mcpInjection: null,
    models: ['qwen3-coder-plus', 'qwen3-coder-flash'],
    buildArgs: ({ model }) => (model ? ['-m', model] : []),
  },
  {
    id: 'cursor',
    name: 'Cursor Agent',
    bin: 'cursor-agent',
    fallbackBins: ['cursor-agent.cmd'],
    versionArgs: ['--version'],
    streamFormat: 'text',
    promptViaStdin: false,
    mcpInjection: null,
    models: [],
    buildArgs: ({ prompt, model }) => ['-p', ...(model ? ['--model', model] : []), prompt],
  },
  {
    id: 'aider',
    name: 'Aider',
    bin: 'aider',
    fallbackBins: ['aider.cmd'],
    versionArgs: ['--version'],
    streamFormat: 'text',
    promptViaStdin: false,
    mcpInjection: null,
    models: [],
    // --no-git : pas dans un dépôt ; --yes-always : one-shot sans confirmations interactives
    buildArgs: ({ prompt, model }) => ['--message', prompt, '--no-git', '--yes-always', ...(model ? ['--model', model] : [])],
  },
];

const BY_ID = new Map(DEFS.map((d) => [d.id, d]));

/** @param {string} id */
function getDef(id) { return BY_ID.get(id) || null; }
function listDefs() { return DEFS; }

module.exports = { DEFS, getDef, listDefs };
