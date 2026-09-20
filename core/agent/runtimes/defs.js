// @ts-check
// Registre data-driven des agents CLI.
//
// `modelsFrom` nomme le fournisseur dont l'agent sert les modeles, et c'est lui
// qui alimente la liste (cf. core/agent/models.js) : les tableaux `models`
// ci-dessous ne sont qu'un filet pour une machine hors ligne. Ils etaient la
// seule source avant, et ils avaient pris une generation de retard sans que
// rien ne le signale — choisir Codex proposait des modeles perimes.
// Registre data-driven des agents CLI. Ajouter un agent = ajouter une entrée ici (façon open-design
// runtimes/defs/*). Chaque def décrit comment LANCER le CLI et PARSER sa sortie ; les outils NetsuRush
// sont fournis au CLI via le serveur MCP (.mcp.json injecté, cf. mcpInjection).

/** @type {import('./types').RuntimeAgentDef[]} */
const DEFS = [
  {
    id: 'claude',
    name: 'Claude Code',
    // `/login` est une commande DANS la session interactive, pas un argument :
    // lancer le CLI nu ouvre la session, et l'utilisateur tape /login.
    loginArgs: [],
    bin: 'claude',
    fallbackBins: ['claude.cmd'],
    versionArgs: ['--version'],
    streamFormat: 'claude-stream-json',
    promptViaStdin: true,
    mcpInjection: 'mcp-config-flag',
    modelsFrom: 'anthropic',
    models: ['claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
    // `--permission-mode bypassPermissions` a ete RETIRE. Il approuvait d'office
    // TOUS les outils integres — Bash, Edit, Write — et la porte de permission
    // de NetsuRush ne couvre que nos outils MCP : « Lecture seule » n'etait donc
    // pas en lecture seule. A la place, une liste blanche stricte des seuls
    // outils qu'on expose, et un refus explicite de l'ecriture et du shell.
    buildArgs: ({ model, mcpConfigPath, allowedTools }) => [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      ...(model ? ['--model', model] : []),
      ...(mcpConfigPath ? ['--mcp-config', mcpConfigPath] : []),
      ...(allowedTools && allowedTools.length ? ['--allowedTools', ...allowedTools] : []),
      '--disallowedTools', 'Bash', 'Edit', 'Write', 'NotebookEdit', 'Task', 'WebFetch', 'WebSearch',
    ],
  },
  {
    id: 'codex',
    name: 'Codex',
    loginArgs: ['login'],
    bin: 'codex',
    fallbackBins: ['codex.cmd'],
    versionArgs: ['--version'],
    streamFormat: 'codex-json',
    promptViaStdin: false,
    mcpInjection: 'codex-config',
    modelsFrom: 'openai',
    models: ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
    buildArgs: ({ prompt, model }) => [
      'exec',
      '--json',
      '--skip-git-repo-check',
      // `workspace-write` rendait le dossier de travail inscriptible. L'agent
      // n'a que des outils MCP a appeler ici : rien a ecrire sur le disque.
      '--sandbox', 'read-only',
      ...(model ? ['-c', `model=${model}`] : []),
      prompt,
    ],
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    loginArgs: [],
    bin: 'gemini',
    fallbackBins: ['gemini.cmd'],
    versionArgs: ['--version'],
    streamFormat: 'text',
    promptViaStdin: true,
    mcpInjection: null,
    modelsFrom: 'google',
    models: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3-pro'],
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
    // OpenCode parle a plusieurs fournisseurs : son catalogue est celui
    // d'OpenRouter, slugs `editeur/modele` compris.
    modelsFrom: 'openrouter',
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
    modelsFrom: 'openrouter',
    models: ['qwen3.8-max', 'qwen3.8-flash', 'qwen3-coder-plus'],
    buildArgs: ({ model }) => (model ? ['-m', model] : []),
  },
  {
    // GitHub's agent, GA since February 2026. `-p` is non-interactive.
    // A known trap: in that mode the workspace `.mcp.json` is skipped in
    // silence, so the config has to be passed explicitly or the NetsuRush
    // tools are simply absent with no error to explain it.
    id: 'copilot',
    name: 'GitHub Copilot CLI',
    loginArgs: ['login'],
    bin: 'copilot',
    fallbackBins: ['copilot.cmd'],
    versionArgs: ['--version'],
    streamFormat: 'text',
    promptViaStdin: false,
    mcpInjection: 'copilot-additional-config',
    // Copilot sert des modeles Anthropic ET OpenAI ; seul un catalogue
    // multi-editeurs les couvre tous les deux.
    modelsFrom: 'openrouter',
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
    loginArgs: ['login'],
    bin: 'grok',
    fallbackBins: ['grok.cmd'],
    versionArgs: ['--version'],
    streamFormat: 'claude-stream-json',
    promptViaStdin: false,
    mcpInjection: null,
    modelsFrom: 'xai',
    models: ['grok-4.6', 'grok-4.5', 'grok-4.3'],
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
    loginArgs: ['login'],
    bin: 'agy',
    fallbackBins: ['agy.cmd'],
    versionArgs: ['--version'],
    streamFormat: 'claude-stream-json',
    promptViaStdin: false,
    mcpInjection: null,
    modelsFrom: 'google',
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
    loginArgs: ['login'],
    bin: 'cursor-agent',
    fallbackBins: ['cursor-agent.cmd'],
    versionArgs: ['--version'],
    streamFormat: 'text',
    promptViaStdin: false,
    mcpInjection: null,
    modelsFrom: 'openrouter',
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
    modelsFrom: 'openrouter',
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
