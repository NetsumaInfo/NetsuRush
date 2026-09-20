// @ts-check
// Where Blackmagic's own MCP server lives.
//
// Resolve Studio 21.1 ships `ResolveMCP.exe` (a `.mcpb` bundle sits next to it,
// but that one is the Claude Desktop extension: same server, wrapped for a
// different installer). We never vendor it — it comes from the user's Resolve
// install, and its version has to match the Resolve it drives.
//
// Shared on purpose with `scripts/resolve-mcp.cjs`, so the path the app spawns
// and the path an external MCP host spawns are resolved by the same code.

const fs = require('fs');
const path = require('path');

/// Candidate locations, most specific first. Windows is the measured one; the
/// macOS and Linux entries are the documented install layouts and have not been
/// verified on those platforms.
function candidates() {
  const list = [];
  const fromEnv = process.env.NR_RESOLVE_MCP;
  if (fromEnv) list.push(fromEnv);

  if (process.platform === 'win32') {
    const roots = [
      process.env.ProgramFiles,
      process.env['ProgramW6432'],
      'C:\\Program Files',
    ].filter(Boolean);
    for (const root of roots) {
      list.push(path.join(String(root), 'Blackmagic Design', 'DaVinci Resolve', 'ResolveMCP.exe'));
    }
  } else if (process.platform === 'darwin') {
    list.push('/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/MacOS/ResolveMCP');
    list.push('/Applications/DaVinci Resolve/ResolveMCP');
  } else {
    list.push('/opt/resolve/bin/ResolveMCP');
    list.push('/opt/resolve/ResolveMCP');
  }
  return list;
}

/// The server binary, or `null` when Resolve is not installed (or is the free
/// edition, which does not ship it). Never throws: an absent server is a normal
/// state, not a failure — the rest of the agent works without it.
/** @returns {string|null} */
function findResolveMcp() {
  for (const p of candidates()) {
    try { if (p && fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return null;
}

module.exports = { findResolveMcp, candidates };
