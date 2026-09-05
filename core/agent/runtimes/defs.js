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
    models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
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
    // GitHub's agent, GA since February 2026. `-p` is non-interactive.
    // A known trap: in that mode the workspace `.mcp.json` is skipped in
    // silence, so the config has to be passed explicitly or the NetsuRush
    // tools are simply absent with no error to explain it.
    id: 'copilot',
    name: 'GitHub Copilot CLI',
    bin: 'copilot',
    fallbackBins: ['copilot.cmd'],
    versionArgs: ['--version'],
    streamFormat: 'text',
    promptViaStdin: false,
    mcpInjection: 'copilot-additional-config',
    models: [],
    buildArgs: ({ prompt, model, mcpConfigPath }) => [
      '-p', prompt,
      '--no-ask-user',
      ...(model ? ['--model', model] : []),
      ...(mcpConfigPath ? ['--additional-mcp-config', mcpConfigPath] : []),
    ],
  },
  {
    // xAI's harness. It can emit newline-delimited JSON in the Anthropic
    // Messages wire format, so the parser we already have for Claude Code
    // reads it as-is rather than needing one of its own.
    id: 'grok',
    name: 'Grok Build',
    bin: 'grok',
    fallbackBins: ['grok.cmd'],
    versionArgs: ['--version'],
    streamFormat: 'claude-stream-json',
    promptViaStdin: false,
    mcpInjection: null,
    models: ['grok-4.6', 'grok-4.5'],
    buildArgs: ({ prompt, model }) => [
      '-p', prompt,
      '--output-format', 'streaming-messages-json',
      '--always-approve',
      '--no-auto-update',
      ...(model ? ['--model', model] : []),
    ],
  },
  {
    // Google's Go-based successor to the Gemini CLI. Same print-mode shape as
    // Claude Code, including a real stream-json output format.
    id: 'antigravity',
    name: 'Antigravity',
    bin: 'agy',
    fallbackBins: ['agy.cmd'],
    versionArgs: ['--version'],
    streamFormat: 'claude-stream-json',
    promptViaStdin: false,
    mcpInjection: null,
    models: [],
    buildArgs: ({ prompt, model }) => [
      '-p', prompt,
      '--output-format', 'stream-json',
      ...(model ? ['--model', model] : []),
    ],
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
