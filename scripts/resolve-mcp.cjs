#!/usr/bin/env node
// Launches Blackmagic's official MCP server (shipped inside DaVinci Resolve
// Studio 21.1+) as a stdio child, for any MCP host that reads the repository's
// `.mcp.json` — Claude Code, Codex, Copilot CLI.
//
// The indirection exists because the server is an absolute path inside the
// Resolve install, and that path differs per platform and per install root.
// Hard-coding one in `.mcp.json` would work on exactly one machine, which is
// not a thing to commit to a public repository. `NR_RESOLVE_MCP` overrides the
// search for an install that is somewhere else entirely.
//
// The app does not go through this file: `core/agent/tools/resolveMcp.js` talks
// to the same server directly, and both resolve the path with `resolveBin.js`.

const { spawn } = require('child_process');
const { findResolveMcp, candidates } = require('../core/agent/mcp/resolveBin');

const bin = findResolveMcp();
if (!bin) {
  // stdout is the JSON-RPC channel: a diagnostic there would corrupt the
  // handshake, so this goes to stderr, where MCP hosts show it.
  process.stderr.write(
    'ResolveMCP introuvable. Il est livré avec DaVinci Resolve Studio 21.1+ '
    + '(l\'édition gratuite ne le contient pas).\nCherché dans :\n'
    + candidates().map((p) => `  ${p}`).join('\n')
    + '\nDéfinis NR_RESOLVE_MCP sur le binaire si ton installation est ailleurs.\n',
  );
  process.exit(1);
}

const child = spawn(bin, process.argv.slice(2), { stdio: 'inherit', windowsHide: true });
child.on('error', (e) => {
  process.stderr.write(`ResolveMCP: lancement impossible — ${e.message}\n`);
  process.exit(1);
});
child.on('close', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { child.kill(sig); } catch { /* already gone */ } });
}
