// @ts-check
// Serveur MCP stdio AUTONOME, spawné par un CLI agent (claude --mcp-config / codex). Transport =
// JSON-RPC 2.0 ligne-à-ligne sur stdin/stdout (transport stdio MCP). Thin proxy : tools/list et
// tools/call sont reforwardés au core (HTTP /rpc) → exécution dans le process core (pont Python
// unique + permission). Lancé hors du core ; ne require AUCUN module métier.

const CORE_URL = process.env.NR_CORE_URL || 'http://127.0.0.1:8730';
const TOKEN = process.env.NR_CORE_TOKEN || '';

async function rpc(channel, args) {
  const r = await fetch(`${CORE_URL}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(TOKEN ? { 'x-nr-token': TOKEN } : {}) },
    body: JSON.stringify({ channel, args }),
  });
  if (!r.ok) throw new Error(`Core RPC HTTP ${r.status}`);
  const j = /** @type {any} */ (await r.json());
  if (!j || !j.ok) throw new Error((j && j.error) || `core rpc error: ${channel}`);
  return j.result;
}

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function fail(id, message) { send({ jsonrpc: '2.0', id, error: { code: -32000, message } }); }

async function handle(req) {
  const { id, method, params } = req;
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'netsurush', version: '0.1.0' },
    });
    return;
  }
  if (method === 'notifications/initialized') return; // notification, pas de réponse
  if (method === 'ping') { reply(id, {}); return; }
  if (method === 'tools/list') {
    try { reply(id, { tools: await rpc('agent:toolList', []) }); }
    catch (e) { fail(id, String((e && e.message) || e)); }
    return;
  }
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    try {
      const result = await rpc('agent:toolCall', [name, args]);
      const isError = !!(result && result.ok === false);
      reply(id, { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }], isError });
    } catch (e) { fail(id, String((e && e.message) || e)); }
    return;
  }
  if (id != null) fail(id, `méthode inconnue : ${method}`);
}

let buf = '';
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
