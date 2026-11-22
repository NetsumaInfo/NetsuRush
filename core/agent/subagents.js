// @ts-check
// Sub-agents: many small agent processes working in parallel on footage, each with the NetsuRush MCP
// server and nothing else. They run on whichever CLI is installed (Claude Code, else Codex), so the
// caller asks for a TIER and never for a model: 'eco' (the default, Haiku or Luna) or 'normal'. How
// many run at once is a setting, not a constant; tasks beyond it wait in a queue shared by every
// dispatch, so two parent agents cannot multiply the load.
//
// A sub-agent must stay cheap, so it starts bare: a short system prompt instead of Claude Code's,
// no built-in tools, none of the user's MCP servers, hooks, skills or CLAUDE.md, and only the
// footage tools rather than the whole registry (17 000 tokens of definitions, per sub-agent).
// `--bare` would be simpler but refuses subscription logins.
//
// The Codex runtime has never run against a real subscription: its arguments follow `codex exec
// --help` (0.156), nothing more.
//
// Rights ride in the MCP surface of the spawned server: 'subagent' reads only, 'subagent-write' may
// also write. Neither ever reaches a destructive action, and neither can dispatch further agents.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { startCliRun } = require('./runtimes/runs');
const { getDef } = require('./runtimes/defs');
const { detectAgents } = require('./runtimes/detection');

const READ_SURFACE = 'subagent';
const WRITE_SURFACE = 'subagent-write';
const SURFACES = [READ_SURFACE, WRITE_SURFACE];

/// What a sub-agent can reach. Footage work only: no Resolve scripting, no rpc escape hatch, no
/// netsu_agents (a sub-agent dispatching sub-agents has no bound).
const TOOLS = [
  'netsu_search', 'netsu_media', 'netsu_library', 'netsu_collections', 'netsu_characters', 'netsu_jobs',
  'list_timelines', 'read_timeline', 'resolve_status',
];

const MAX_TASKS = 200;
const TASK_TIMEOUT_MS = 10 * 60 * 1000;
const DETECT_TTL_MS = 5 * 60 * 1000;
const TIERS = ['eco', 'normal'];
const EFFORTS = ['low', 'medium', 'high'];
const DEFAULT_EFFORT = 'medium';
/// Tried in this order: the first one installed runs the sub-agents.
const ENGINES = ['claude', 'codex'];
const MAX_ANSWER_CHARS = 8000;

const SYSTEM_PROMPT = [
  'You are a sub-agent of NetsuRush, a desktop app for video editors. You do ONE focused job on footage and report back to the agent that dispatched you.',
  'Use the NetsuRush tools (netsu_search, netsu_media…); there is nothing else to work with. Search results and netsu_media are your eyes: a sheet shows a shot\'s frames in one image, left to right then top to bottom, so read the ACTION from it, not one still. netsu_media overview scans a whole rush page by page. Grids have numbers written on them: identify each shot by the number you READ, never by counting rows, and take its frames from the entry with that number. A shot detection can be wrong: if the frames of one "shot" clearly show different scenes, say so.',
  'A shot is a file plus inclusive frames. Be fast: a few tool calls, no narration. If a file is not indexed, say so instead of guessing.',
  'End with your findings only, one JSON object per line: {"file":"...","inFrame":0,"outFrame":0,"score":0.0,"note":"what is in the shot"}, then one last line of plain text summing up what you did. If you found nothing, say that in one line.',
].join('\n');

/** @param {any} value */
const clean = (value) => String(value == null ? '' : value).trim();

/// The spawn goes through a shell (it resolves claude.cmd), so a model name must be checked before
/// it reaches the command line: Codex's comes from a cache file on disk.
const SAFE_MODEL = /^[A-Za-z0-9._:\-[\]]+$/;

/// Codex lists what the account can use in its own cache. The family is stable (luna, terra) while
/// the version moves, and the cache is ordered best first; the fallback is the offline net.
/** @param {string} family @param {string} fallback */
function codexModel(family, fallback) {
  try {
    const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const cache = JSON.parse(fs.readFileSync(path.join(home, 'models_cache.json'), 'utf8'));
    const hit = (cache.models || [])
      .filter((/** @type {any} */ m) => m && m.visibility === 'list' && String(m.slug || '').includes(family))
      .sort((/** @type {any} */ a, /** @type {any} */ b) => (a.priority ?? 0) - (b.priority ?? 0))[0];
    if (hit) return String(hit.slug);
  } catch { /* no cache yet: the fallback */ }
  return fallback;
}

/** @type {Record<string, Record<string, ()=>string>>} */
const TIER_MODELS = {
  claude: { eco: () => 'haiku', normal: () => 'sonnet' },
  codex: { eco: () => codexModel('luna', 'gpt-5.6-luna'), normal: () => codexModel('terra', 'gpt-5.6-terra') },
};

/** @param {string} value a path of ours: it may hold spaces (a Windows user name), never quotes */
const shellPath = (value) => (/\s/.test(value) ? `"${value}"` : value);

/**
 * @param {{
 *   workspace:()=>string,
 *   mcpConfigPath:(surface:string)=>string|undefined,
 *   settings:()=>{ maxSubagents:number },
 *   broadcast?:(channel:string, payload:any)=>void,
 *   start?:typeof startCliRun,
 *   detect?:()=>Promise<Array<{id:string, available:boolean}>>,
 * }} deps
 */
function createSubagents(deps) {
  const start = deps.start || startCliRun;
  const broadcast = deps.broadcast || (() => {});
  const detect = deps.detect || detectAgents;
  /** @type {{ at:number, id:string|null }|null} */
  let detected = null;
  /** @type {Set<any>} */
  const running = new Set();
  /** @type {Array<{ begin:()=>void, drop:()=>void }>} */
  const waiting = [];
  let seq = 0;

  function capacity() { return Math.max(1, Number(deps.settings().maxSubagents) || 1); }

  function pump() {
    while (waiting.length && running.size < capacity()) {
      const next = waiting.shift();
      if (next) next.begin();
    }
  }

  /// First installed engine. Remembered for a while: probing every CLI costs a process each, and a
  /// dispatch may come every few seconds.
  async function engine() {
    if (detected && Date.now() - detected.at < DETECT_TTL_MS) return detected.id;
    const agents = await detect();
    const id = ENGINES.find((e) => agents.some((a) => a.id === e && a.available)) || null;
    detected = { at: Date.now(), id };
    return id;
  }

  function systemPromptFile() {
    const file = path.join(deps.workspace(), 'subagent-system-prompt.txt');
    fs.writeFileSync(file, SYSTEM_PROMPT);
    return file;
  }

  /// Claude Code's own definition, with the arguments that keep a sub-agent light. The spawn goes
  /// through a shell: the prompts travel on stdin, the system prompt in a file, and paths are quoted.
  /** @param {string} id @param {string} surface @param {string} effort */
  function runtime(id, surface, effort) {
    const base = getDef(id);
    if (!base) throw new Error(`runtime is not defined: ${id}`);
    if (id === 'codex') return codexRuntime(base, surface, effort);
    const promptFile = systemPromptFile();
    return {
      ...base,
      buildArgs: (/** @type {any} */ o) => [
        '-p', '--output-format', 'stream-json', '--verbose',
        '--model', o.model,
        '--effort', effort,
        '--tools', '""',
        '--mcp-config', shellPath(String(o.mcpConfigPath)),
        '--strict-mcp-config',
        '--setting-sources', '""',
        '--disable-slash-commands',
        '--no-session-persistence',
        '--system-prompt-file', shellPath(promptFile),
        '--allowedTools', ...(o.allowedTools || []),
      ],
    };
  }

  /// Codex has no system prompt flag, no MCP config file and no tool allow-list: the prompt carries
  /// the instructions, and the server is declared with `-c` overrides. Only the surface and NR_HOME
  /// are passed: the stdio server reads the core's address and token from core-port.json, which
  /// keeps the token off the command line. TOML literal strings, inside shell double quotes.
  /** @param {any} base @param {string} surface @param {string} effort */
  function codexRuntime(base, surface, effort) {
    const literal = (/** @type {string} */ s) => `'${s}'`;
    const override = (/** @type {string} */ key, /** @type {string} */ value) => ['-c', `"${key}=${value}"`];
    const server = 'mcp_servers.netsurush';
    return {
      ...base,
      promptViaStdin: true,
      buildArgs: (/** @type {any} */ o) => {
        const env = [`NR_SURFACE=${literal(surface)}`];
        if (process.env.NR_HOME) env.push(`NR_HOME=${literal(process.env.NR_HOME)}`);
        return [
          'exec', '--json', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config',
          '--sandbox', 'read-only',
          '-m', o.model,
          ...override('approval_policy', literal('never')),
          ...override('model_reasoning_effort', literal(effort)),
          ...override('features.shell_tool', 'false'),
          ...override(`${server}.command`, literal(process.execPath)),
          ...override(`${server}.args`, `[${literal(path.join(__dirname, 'mcp', 'stdio.js'))}]`),
          ...override(`${server}.env`, `{${env.join(',')}}`),
          '-',
        ];
      },
    };
  }

  /** @param {{ name:string, prompt:string }} task @param {{ surface:string, model:string, def:any, promptPrefix:string }} run */
  function runOne(task, run) {
    return new Promise((resolve) => {
      const begin = () => {
        const startedAt = Date.now();
        /** @type {any} */
        const out = { name: task.name, ok: true, toolCalls: 0, costUsd: 0, answer: '' };
        const handle = { child: /** @type {any} */ (null), cancelled: false };
        running.add(handle);
        const timer = setTimeout(() => {
          out.ok = false;
          out.error = `timed out after ${Math.round(TASK_TIMEOUT_MS / 60000)} minutes`;
          kill(handle);
        }, TASK_TIMEOUT_MS);
        const finish = () => {
          clearTimeout(timer);
          running.delete(handle);
          out.seconds = Math.round((Date.now() - startedAt) / 1000);
          if (handle.cancelled) { out.ok = false; out.error = 'cancelled'; }
          if (out.answer.length > MAX_ANSWER_CHARS) {
            out.answer = `${out.answer.slice(0, MAX_ANSWER_CHARS)}\n… (answer cut at ${MAX_ANSWER_CHARS} characters)`;
          }
          resolve(out);
          pump();
        };
        try {
          const r = start({
            def: run.def,
            prompt: `${run.promptPrefix}${task.prompt}`,
            model: run.model,
            mcpConfigPath: deps.mcpConfigPath(run.surface),
            cwd: deps.workspace(),
            allowedTools: TOOLS.map((name) => `mcp__netsurush__${name}`),
            onEvent: (/** @type {any} */ e) => {
              // Each assistant message is a block of text: the last one is the report, the
              // earlier ones narrate the way there.
              if (e.type === 'text' && e.delta) out.answer = String(e.delta);
              else if (e.type === 'tool_use') out.toolCalls += 1;
              else if (e.type === 'usage') out.costUsd += e.costUsd || 0;
              else if (e.type === 'error') { out.ok = false; out.error = String(e.message || 'failed'); }
            },
          });
          handle.child = r.child;
          if (handle.cancelled) kill(handle);
          r.done.then(finish, (e) => { out.ok = false; out.error = String(e); finish(); });
        } catch (e) {
          out.ok = false;
          out.error = String((e && /** @type {any} */ (e).message) || e);
          finish();
        }
      };
      if (running.size < capacity()) begin();
      else waiting.push({ begin, drop: () => resolve({ name: task.name, ok: false, error: 'cancelled', toolCalls: 0, costUsd: 0, answer: '', seconds: 0 }) });
    });
  }

  /** @param {any} handle */
  function kill(handle) {
    handle.cancelled = true;
    try { handle.child && handle.child.kill(); } catch { /* already gone */ }
  }

  /// Task list from explicit tasks, or one prompt spread over a list of files: the common "go
  /// through these rushes" case, where the caller should not have to write N prompts.
  /** @param {any} a */
  function taskList(a) {
    /** @type {{ name:string, prompt:string }[]} */
    const tasks = [];
    for (const t of Array.isArray(a.tasks) ? a.tasks : []) {
      const prompt = clean(t && t.prompt);
      if (prompt) tasks.push({ name: clean(t.name) || `agent ${tasks.length + 1}`, prompt });
    }
    const files = (Array.isArray(a.files) ? a.files : []).map(clean).filter(Boolean);
    if (files.length && clean(a.prompt)) {
      const size = Math.max(1, Number(a.filesPerAgent) || 1);
      for (let i = 0; i < files.length; i += size) {
        const batch = files.slice(i, i + size);
        tasks.push({
          name: size === 1 ? path.basename(batch[0]) : `files ${i + 1}-${i + batch.length}`,
          prompt: `${clean(a.prompt)}\n\nFiles to cover:\n${batch.map((f) => `- ${f}`).join('\n')}`,
        });
      }
    } else if (!files.length && clean(a.prompt) && !tasks.length) {
      tasks.push({ name: 'agent 1', prompt: clean(a.prompt) });
    }
    return tasks;
  }

  /** @param {any} a */
  async function dispatch(a) {
    const tasks = taskList(a || {});
    if (!tasks.length) return { ok: false, error: 'nothing to do: pass tasks[{prompt}], or prompt with files[]' };
    if (tasks.length > MAX_TASKS) return { ok: false, error: `too many tasks at once: ${tasks.length} (limit ${MAX_TASKS})` };
    const tier = a.tier === undefined ? 'eco' : String(a.tier);
    if (!TIERS.includes(tier)) return { ok: false, error: `unknown tier: ${tier} (eco or normal)` };
    const effort = a.effort === undefined ? DEFAULT_EFFORT : String(a.effort);
    if (!EFFORTS.includes(effort)) return { ok: false, error: `unknown effort: ${effort} (${EFFORTS.join(', ')})` };
    const id = await engine();
    if (!id) return { ok: false, error: 'no sub-agent engine: install Claude Code or Codex and log in' };
    const model = TIER_MODELS[id][tier]();
    if (!SAFE_MODEL.test(model)) return { ok: false, error: `invalid model name: ${model}` };
    const surface = a.access === 'write' ? WRITE_SURFACE : READ_SURFACE;
    const run = {
      surface,
      model,
      def: runtime(id, surface, effort),
      promptPrefix: id === 'codex' ? `${SYSTEM_PROMPT}\n\n` : '',
    };
    const dispatchId = (seq += 1);
    let done = 0;
    const tell = () => broadcast('subagents:progress', { dispatchId, total: tasks.length, done, running: running.size, queued: waiting.length });
    tell();
    const results = await Promise.all(tasks.map((task) => runOne(task, run).then((r) => {
      done += 1;
      tell();
      return r;
    })));
    const failed = results.filter((r) => !r.ok).length;
    return {
      ok: failed < results.length,
      engine: id,
      tier,
      effort,
      model: run.model,
      access: a.access === 'write' ? 'write' : 'read',
      total: results.length,
      failed,
      costUsd: Math.round(results.reduce((n, r) => n + r.costUsd, 0) * 10000) / 10000,
      results,
    };
  }

  async function status() {
    return { max: capacity(), running: running.size, queued: waiting.length, engine: await engine() };
  }

  /// Stops everything. The queue is emptied first, or each kill would start the next task in line.
  function cancelAll() {
    const stopped = running.size + waiting.length;
    for (const queued of waiting.splice(0)) queued.drop();
    for (const handle of running) kill(handle);
    return { ok: true, stopped };
  }

  return { dispatch, status, cancelAll };
}

/// Decides a sub-agent's tool call. Separate from the app's permission gate: a sub-agent has nobody
/// to ask, its rights were fixed when it was dispatched.
/** @param {string} surface @param {string} name @param {'read'|'write'|'destructive'} risk */
function subagentAllows(surface, name, risk) {
  if (!TOOLS.includes(name)) return false;
  if (risk === 'read') return true;
  return surface === WRITE_SURFACE && risk === 'write';
}

module.exports = { createSubagents, subagentAllows, codexModel, TOOLS, TIERS, EFFORTS, SURFACES, SYSTEM_PROMPT };
