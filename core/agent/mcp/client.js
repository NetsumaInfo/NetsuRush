// @ts-check
// Minimal MCP client over stdio. Speaks the transport the other way round from
// `mcp/stdio.js`: that one IS a server we hand to CLI agents, this one CONSUMES
// a third-party server (today: Blackmagic's `ResolveMCP.exe`).
//
// Newline-delimited JSON-RPC, which is what the stdio transport specifies and
// what the Resolve server emits. The child's stderr is a log stream, not a
// channel: we keep the tail for error messages and drop the rest.
//
// The process starts LAZILY, on the first call, and is respawned after a crash
// by the next one. Spawning it at boot would launch a Resolve-side helper for
// every user who never opens the chat.

const { spawn } = require('child_process');
const { t } = require('../../i18n');

const PROTOCOL_VERSION = '2025-06-18';

/**
 * @param {{ command:string, args?:string[], env?:NodeJS.ProcessEnv, label?:string,
 *           handshakeMs?:number, callMs?:number }} opts
 */
function createMcpClient(opts) {
  const label = opts.label || 'mcp';
  const handshakeMs = opts.handshakeMs || 20_000;
  const callMs = opts.callMs || 180_000;

  /** @type {import('child_process').ChildProcess|null} */
  let child = null;
  /** @type {Promise<{ serverInfo:any, instructions:string }>|null} */
  let ready = null;
  /** @type {Map<number, { resolve:(v:any)=>void, reject:(e:Error)=>void, timer:NodeJS.Timeout }>} */
  const pending = new Map();
  let seq = 0;
  let errTail = '';

  function fail(/** @type {Error} */ e) {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(e); }
    pending.clear();
  }

  /// Drops the whole connection. The next call spawns a fresh process rather
  /// than talking to a half-dead one.
  function reset(/** @type {Error} */ e) {
    fail(e);
    child = null;
    ready = null;
  }

  function send(/** @type {any} */ msg) {
    if (!child || !child.stdin || !child.stdin.writable) throw new Error(t('agentMcpServerStopped', { label }));
    child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  /** @param {string} method @param {any} params @param {number} timeoutMs */
  function request(method, params, timeoutMs) {
    const id = (seq += 1);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(t('agentMcpNoAnswer', { label, method, seconds: Math.round(timeoutMs / 1000) })));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { send({ jsonrpc: '2.0', id, method, params: params || {} }); }
      catch (e) { clearTimeout(timer); pending.delete(id); reject(/** @type {Error} */ (e)); }
    });
  }

  function onLine(/** @type {string} */ line) {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; } // log noise on stdout: ignored
    if (!msg || typeof msg.id !== 'number') return; // notification
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(String(msg.error.message || msg.error.code || t('agentMcpError', { label }))));
    else p.resolve(msg.result);
  }

  /// Spawns and performs the handshake once; concurrent callers await the same
  /// promise instead of starting a second server.
  function start() {
    if (ready) return ready;
    ready = (async () => {
      const c = spawn(opts.command, opts.args || [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...(opts.env || {}) },
        windowsHide: true,
      });
      child = c;
      let buf = '';
      c.stdout.setEncoding('utf8');
      c.stdout.on('data', (d) => {
        buf += d.toString();
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          onLine(line);
        }
      });
      c.stderr.setEncoding('utf8');
      c.stderr.on('data', (d) => { errTail = (errTail + d.toString()).slice(-2000); });
      c.on('error', (e) => reset(new Error(t('agentMcpLaunchFailed', { label, detail: String(e.message || e) }))));
      c.on('close', (code) => {
        const exited = t('agentMcpServerExited', { label, code: String(code) });
        reset(new Error(errTail.trim() ? `${exited}\n${errTail.trim().slice(-300)}` : exited));
      });

      const result = await request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'netsurush', version: process.env.NR_VERSION || '0' },
      }, handshakeMs);
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      return {
        serverInfo: (result && result.serverInfo) || {},
        instructions: String((result && result.instructions) || ''),
      };
    })();
    // A failed handshake must not stick: clear the memoised promise so the next
    // attempt actually retries instead of replaying the same rejection forever.
    ready.catch(() => { ready = null; child = null; });
    return ready;
  }

  async function listTools() {
    await start();
    const r = await request('tools/list', {}, handshakeMs);
    return Array.isArray(r && r.tools) ? r.tools : [];
  }

  /** @param {string} name @param {any} args */
  async function callTool(name, args) {
    await start();
    return request('tools/call', { name, arguments: args || {} }, callMs);
  }

  function close() {
    const c = child;
    child = null;
    ready = null;
    fail(new Error(t('agentMcpClosed', { label })));
    try { c && c.kill(); } catch { /* already gone */ }
  }

  function running() { return !!child; }

  return { start, listTools, callTool, close, running };
}

module.exports = { createMcpClient, PROTOCOL_VERSION };
