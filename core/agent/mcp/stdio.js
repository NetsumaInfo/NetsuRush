// @ts-check
// Standalone MCP stdio server. Spawned either by the in-app CLI agents (claude --mcp-config / codex)
// or by an EXTERNAL client the user connected (Claude Desktop, Claude Code, Codex, Cursor…).
// Transport = JSON-RPC 2.0, one message per line on stdin/stdout. Thin proxy: tools and resources
// are forwarded to the core (HTTP /rpc) so they run inside THE core process (single Python bridge,
// permission gate). Runs outside the core and requires no business module.
//
// Finding the core: the in-app configs carry its URL and token in the environment. An external
// client's config cannot — the port and the token change at every launch — so it reads
// `core-port.json`, which the core rewrites each time it starts, on every call. A config written
// once therefore survives restarts of the app.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { negotiateVersion, toCallResult } = require('./format');

const SURFACE = process.env.NR_SURFACE || 'external';
const SERVER_VERSION = '1.0.0';

const INSTRUCTIONS = [
  'NetsuRush is a desktop app for video editors (rush library, shot detection, semantic search, collections of shots,',
  'exports, AI processing, DaVinci Resolve / Premiere / After Effects bridges). Every tool runs inside the running app.',
  'Start with netsu_library (imported rushes) or netsu_search (semantic visual search; index first with action=index).',
  'Collections (netsu_collections) hold SHOTS (file + in/out). Long actions return a jobId: follow it with netsu_jobs.',
  'Look before judging: search hits come with a sheet (a shot\'s frames in one image, reading order) that shows the action, netsu_media sheet makes a larger one, netsu_media overview scans a whole rush page by page. Grids have numbers written on them: identify a shot by the number you read, never by counting rows. Frame ranges are inclusive.',
  'To sort, name folders by PATH ("Anime/OP", "" = root): moves create the missing ones. netsu_library move, netsu_collections move / move_shots, resolve_media_pool move_clips / move_folder.',
  'resolve_* and bmd_* drive DaVinci Resolve (Studio, External scripting = Local). Use build_timeline for frame-accurate timelines.',
  'To cover many rushes fast, fan out with netsu_agents and keep its default tier, eco: cheap sub-agents are the norm here.',
  'Writes the user has not allowed are refused with a reason; do not retry them in a loop.',
].join(' ');

function nrHome() {
  if (process.env.NR_HOME) return process.env.NR_HOME;
  return process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'NetsuRush')
    : path.join(os.homedir(), '.netsurush');
}

/** @returns {{ url:string, token:string } | null} */
function published() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(nrHome(), 'core-port.json'), 'utf8'));
    if (!j || !j.url) return null;
    if (j.pid) {
      try { process.kill(Number(j.pid), 0); } catch (e) {
        // EPERM means the process exists but belongs to someone else; anything else, it is gone.
        if (/** @type {any} */ (e).code !== 'EPERM') return null;
      }
    }
    return { url: String(j.url), token: String(j.token || '') };
  } catch { return null; }
}

/** @returns {{ url:string, token:string }[]} */
function endpoints() {
  /** @type {{ url:string, token:string }[]} */
  const list = [];
  if (process.env.NR_CORE_URL) list.push({ url: process.env.NR_CORE_URL, token: process.env.NR_CORE_TOKEN || '' });
  const file = published();
  if (file && !list.some((e) => e.url === file.url && e.token === file.token)) list.push(file);
  return list;
}

const NOT_RUNNING = 'NetsuRush is not running. Ask the user to open the NetsuRush app, then retry.';

/** @param {string} channel @param {any[]} args */
async function rpc(channel, args) {
  const targets = endpoints();
  if (!targets.length) throw new Error(NOT_RUNNING);
  let last = /** @type {any} */ (null);
  for (const target of targets) {
    let r;
    try {
      r = await fetch(`${target.url}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(target.token ? { 'x-nr-token': target.token } : {}) },
        body: JSON.stringify({ channel, args }),
      });
    } catch (e) {
      // The app answered nothing in time: it is busy, not gone. Telling the agent to reopen it sent
      // the user to restart an app that was working.
      const code = /** @type {any} */ (e).cause && /** @type {any} */ (e).cause.code;
      last = new Error(code === 'UND_ERR_HEADERS_TIMEOUT' ? 'NetsuRush took too long to answer this call; the work may still be running.' : NOT_RUNNING);
      continue;
    }
    // A stale token (the app restarted under an in-app config) is answered 403: try the next target.
    if (r.status === 403) { last = new Error('NetsuRush refused the connection (stale token). Retry once the app is open.'); continue; }
    if (!r.ok) throw new Error(`NetsuRush core HTTP ${r.status}`);
    const j = /** @type {any} */ (await r.json());
    if (!j || !j.ok) throw new Error((j && j.error) || `core rpc error: ${channel}`);
    return j.result;
  }
  throw last || new Error(NOT_RUNNING);
}

/** @param {any} msg */
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
/** @param {any} id @param {any} result */
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
/** @param {any} id @param {string} message @param {number} [code] */
function fail(id, message, code = -32000) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

/** @param {any} req */
async function handle(req) {
  const { id, method, params } = req;
  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: negotiateVersion(params && params.protocolVersion),
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
        serverInfo: { name: 'netsurush', title: 'NetsuRush', version: SERVER_VERSION },
        instructions: INSTRUCTIONS,
      });
      return;
    case 'ping':
      reply(id, {});
      return;
    case 'tools/list':
      try { reply(id, { tools: await rpc('agent:toolList', [SURFACE]) }); } catch (e) { fail(id, String((e && /** @type {any} */ (e).message) || e)); }
      return;
    case 'tools/call': {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      try {
        reply(id, toCallResult(await rpc('agent:toolCall', [name, args, SURFACE])));
      } catch (e) {
        // A tool that cannot run is a tool error the model can read, not a protocol failure: the
        // client would otherwise report a dead server.
        reply(id, { content: [{ type: 'text', text: String((e && /** @type {any} */ (e).message) || e) }], isError: true });
      }
      return;
    }
    case 'resources/list':
      try { reply(id, { resources: await rpc('agent:resources', [SURFACE]) }); } catch (e) { fail(id, String((e && /** @type {any} */ (e).message) || e)); }
      return;
    case 'resources/templates/list':
      try { reply(id, { resourceTemplates: await rpc('agent:resourceTemplates', [SURFACE]) }); } catch (e) { fail(id, String((e && /** @type {any} */ (e).message) || e)); }
      return;
    case 'resources/read':
      try { reply(id, await rpc('agent:resourceRead', [params && params.uri, SURFACE])); } catch (e) { fail(id, String((e && /** @type {any} */ (e).message) || e), -32002); }
      return;
    default:
      // Notifications (initialized, cancelled…) carry no id and get no answer.
      if (id != null) fail(id, `unknown method: ${method}`, -32601);
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let req; try { req = JSON.parse(line); } catch { continue; }
    void handle(req);
  }
});
process.stdin.on('end', () => process.exit(0));
