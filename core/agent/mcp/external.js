// @ts-check
// External MCP clients: the AI apps the user connects to NetsuRush from outside (Claude Desktop,
// Claude Code, Codex, Cursor). Holds their access settings (on/off, permission mode — persisted by
// the core so they hold even when no window has mounted the settings) and writes each client's own
// config file so it spawns our stdio server.
//
// Each client file is shared with the user and with the client itself: only the `netsurush` entry is
// ever touched, the rest of the file is kept as read, and the previous content is saved beside it
// before the first write.

const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER_NAME = 'netsurush';
const MODES = ['read-only', 'ask', 'auto'];
const DEFAULT_SUBAGENTS = 8;
const MAX_SUBAGENTS = 64;

/** @param {any} value */
function subagentCount(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_SUBAGENTS) : DEFAULT_SUBAGENTS;
}

/// Claude Code's own sub-agent definition, installed with the MCP entry: lets a Claude Code session
/// fan out Haiku agents on footage with its native Task tool. The marker tells our file from one the
/// user wrote under the same name, which is never touched.
const SCOUT_MARKER = '<!-- installed by NetsuRush -->';
const SCOUT_TOOLS = ['netsu_search', 'netsu_media', 'netsu_library', 'netsu_collections', 'netsu_characters', 'netsu_jobs', 'list_timelines', 'read_timeline', 'resolve_status'];
const SCOUT_AGENT = `---
name: netsu-scout
description: Fast Haiku scout for NetsuRush footage. Use MANY in parallel to search rushes, look at shot thumbnails, sort and gather shots into collections. Give each one a complete, self-contained job (which files, what to look for).
model: haiku
tools: ${SCOUT_TOOLS.map((n) => `mcp__${SERVER_NAME}__${n}`).join(', ')}
---
${SCOUT_MARKER}
You do ONE focused job on video footage through the NetsuRush tools and report back.
Search results and netsu_media are your eyes: a sheet shows a shot's frames in one image, left to right then top to bottom, so read the ACTION from it, not one still. netsu_media overview scans a whole rush page by page. Grids have numbers written on them: identify each shot by the number you READ, never by counting rows. A shot is a file plus inclusive frames. If a file is not indexed, say so instead of guessing (index is heavy GPU work: only run it if asked).
Be fast: a few tool calls, no narration. End with your findings only, one JSON object per line: {"file":"...","inFrame":0,"outFrame":0,"score":0.0,"note":"what is in the shot"}, then one line summing up what you did.
`;

function scoutPath() { return path.join(os.homedir(), '.claude', 'agents', 'netsu-scout.md'); }

function installScout() {
  const p = scoutPath();
  try { if (!fs.readFileSync(p, 'utf8').includes(SCOUT_MARKER)) return; } catch { /* absent: ours to write */ }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, SCOUT_AGENT);
}

function removeScout() {
  const p = scoutPath();
  try { if (fs.readFileSync(p, 'utf8').includes(SCOUT_MARKER)) fs.unlinkSync(p); } catch { /* absent */ }
}

/** @param {string} p */
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {
    if (/** @type {any} */ (e).code === 'ENOENT') return {};
    throw new Error(`${p}: unreadable JSON (${/** @type {any} */ (e).message}); fix or remove it, then retry`);
  }
}

/** @param {string} p @param {string} text */
function writeWithBackup(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const backup = `${p}.netsurush.bak`;
  if (fs.existsSync(p) && !fs.existsSync(backup)) fs.copyFileSync(p, backup);
  // Written to a sibling then renamed: a client reading its config mid-write never sees half a file.
  const tmp = `${p}.netsurush.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, p);
}

/** @param {string} s */
function tomlString(s) {
  return s.includes("'") ? JSON.stringify(s) : `'${s}'`;
}

/// Removes the `[mcp_servers.netsurush]` table and its sub-tables from a TOML text.
/** @param {string} text */
function stripTomlServer(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let skipping = false;
  for (const line of lines) {
    const header = line.match(/^\s*\[\s*([^\]]+?)\s*\]\s*(#.*)?$/);
    if (header) skipping = header[1] === `mcp_servers.${SERVER_NAME}` || header[1].startsWith(`mcp_servers.${SERVER_NAME}.`);
    if (!skipping) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** @param {{ command:string, args:string[], env:Record<string,string> }} server */
function tomlServer(server) {
  const env = Object.entries(server.env).map(([k, v]) => `${k} = ${tomlString(v)}`).join(', ');
  return [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${tomlString(server.command)}`,
    `args = [${server.args.map(tomlString).join(', ')}]`,
    `env = { ${env} }`,
    '',
  ].join('\n');
}

function home() { return os.homedir(); }

function claudeDesktopPath() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'darwin') return path.join(home(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home(), '.config'), 'Claude', 'claude_desktop_config.json');
}

/**
 * @typedef {{ command:string, args:string[], env:Record<string,string> }} ServerSpec
 * @typedef {{ id:string, label:string, configPath:()=>string, detect:()=>boolean,
 *   installed:(p:string)=>boolean, install:(p:string, s:ServerSpec)=>void, uninstall:(p:string)=>void }} ClientDef
 */

/** @param {(entry:ServerSpec)=>any} [shape] @returns {Pick<ClientDef,'installed'|'install'|'uninstall'>} */
function jsonClient(shape = (s) => s) {
  return {
    installed: (p) => !!(readJson(p).mcpServers || {})[SERVER_NAME],
    install: (p, s) => {
      const cfg = readJson(p);
      cfg.mcpServers = { ...(cfg.mcpServers || {}), [SERVER_NAME]: shape(s) };
      writeWithBackup(p, JSON.stringify(cfg, null, 2));
    },
    uninstall: (p) => {
      if (!fs.existsSync(p)) return;
      const cfg = readJson(p);
      if (!cfg.mcpServers || !cfg.mcpServers[SERVER_NAME]) return;
      delete cfg.mcpServers[SERVER_NAME];
      writeWithBackup(p, JSON.stringify(cfg, null, 2));
    },
  };
}

/** @param {Pick<ClientDef,'installed'|'install'|'uninstall'>} client */
function withScout(client) {
  return {
    ...client,
    install: (/** @type {string} */ p, /** @type {ServerSpec} */ s) => { client.install(p, s); installScout(); },
    uninstall: (/** @type {string} */ p) => { client.uninstall(p); removeScout(); },
  };
}

/** @type {ClientDef[]} */
const CLIENTS = [
  {
    id: 'claude-desktop', label: 'Claude Desktop',
    configPath: claudeDesktopPath,
    detect: () => fs.existsSync(path.dirname(claudeDesktopPath())),
    ...jsonClient(),
  },
  {
    // User scope of Claude Code lives in ~/.claude.json, distinct from Claude Desktop's registry.
    id: 'claude-code', label: 'Claude Code',
    configPath: () => path.join(home(), '.claude.json'),
    detect: () => fs.existsSync(path.join(home(), '.claude.json')) || fs.existsSync(path.join(home(), '.claude')),
    ...withScout(jsonClient((s) => ({ type: 'stdio', ...s }))),
  },
  {
    id: 'codex', label: 'Codex',
    configPath: () => path.join(process.env.CODEX_HOME || path.join(home(), '.codex'), 'config.toml'),
    detect: () => fs.existsSync(process.env.CODEX_HOME || path.join(home(), '.codex')),
    installed: (p) => {
      try { return new RegExp(`^\\s*\\[\\s*mcp_servers\\.${SERVER_NAME}\\s*\\]`, 'm').test(fs.readFileSync(p, 'utf8')); } catch { return false; }
    },
    install: (p, s) => {
      let text = '';
      try { text = fs.readFileSync(p, 'utf8'); } catch { /* new file */ }
      const kept = stripTomlServer(text).replace(/\s*$/, '');
      writeWithBackup(p, `${kept ? `${kept}\n\n` : ''}${tomlServer(s)}`);
    },
    uninstall: (p) => {
      let text;
      try { text = fs.readFileSync(p, 'utf8'); } catch { return; }
      const kept = stripTomlServer(text);
      if (kept !== text) writeWithBackup(p, kept.replace(/\s*$/, '\n'));
    },
  },
  {
    id: 'cursor', label: 'Cursor',
    configPath: () => path.join(home(), '.cursor', 'mcp.json'),
    detect: () => fs.existsSync(path.join(home(), '.cursor')),
    ...jsonClient(),
  },
];

/** @param {{ dataDir:string, stdioScript?:string }} deps */
function createExternalAccess(deps) {
  const file = path.join(deps.dataDir, 'mcp', 'external.json');
  const stdioScript = deps.stdioScript || path.join(__dirname, 'stdio.js');
  /** @type {{ enabled:boolean, mode:'read-only'|'ask'|'auto', maxSubagents:number }} */
  let settings = { enabled: true, mode: 'ask', maxSubagents: DEFAULT_SUBAGENTS };
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof saved.enabled === 'boolean') settings.enabled = saved.enabled;
    if (MODES.includes(saved.mode)) settings.mode = saved.mode;
    settings.maxSubagents = subagentCount(saved.maxSubagents);
  } catch { /* defaults */ }

  function persist() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(settings, null, 2));
    } catch { /* settings stay in memory */ }
  }

  /// What every client spawns: this very Node (the bundled node.exe in a release, the PATH one in
  /// dev) on the stdio server. NR_HOME rides along when it is overridden, so the server reads the
  /// `core-port.json` this core publishes and not the default one.
  /** @returns {ServerSpec} */
  function serverSpec() {
    /** @type {Record<string,string>} */
    const env = { NR_SURFACE: 'external' };
    if (process.env.NR_HOME) env.NR_HOME = process.env.NR_HOME;
    return { command: process.execPath, args: [stdioScript], env };
  }

  function clients() {
    return CLIENTS.map((c) => {
      const configPath = c.configPath();
      let installed = false;
      try { installed = c.installed(configPath); } catch { /* unreadable file: not ours */ }
      return { id: c.id, label: c.label, configPath, installed, detected: c.detect() };
    });
  }

  /** @param {string} id */
  function find(id) {
    const c = CLIENTS.find((x) => x.id === id);
    if (!c) throw new Error(`unknown MCP client: ${id}`);
    return c;
  }

  return {
    get: () => ({ ...settings }),
    /** @param {{ enabled?:boolean, mode?:string, maxSubagents?:number }} patch */
    set(patch) {
      if (patch && typeof patch.enabled === 'boolean') settings.enabled = patch.enabled;
      if (patch && MODES.includes(String(patch.mode))) settings.mode = /** @type {any} */ (patch.mode);
      if (patch && patch.maxSubagents !== undefined) settings.maxSubagents = subagentCount(patch.maxSubagents);
      persist();
      return { ...settings };
    },
    clients,
    serverSpec,
    /** @param {string} id */
    install(id) {
      try {
        const c = find(id);
        const p = c.configPath();
        c.install(p, serverSpec());
        return { ok: true, configPath: p };
      } catch (e) { return { ok: false, error: String((e && /** @type {any} */ (e).message) || e) }; }
    },
    /** @param {string} id */
    uninstall(id) {
      try { const c = find(id); c.uninstall(c.configPath()); return { ok: true }; } catch (e) { return { ok: false, error: String((e && /** @type {any} */ (e).message) || e) }; }
    },
    snippet: () => ({ json: JSON.stringify({ mcpServers: { [SERVER_NAME]: serverSpec() } }, null, 2) }),
  };
}

module.exports = { createExternalAccess, stripTomlServer, tomlServer, CLIENTS };
