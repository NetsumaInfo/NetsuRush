// Browser-to-loopback boundary for the Node control plane. CORS is not authentication, so the
// request itself is refused before RPC/SSE handling when neither the shared token nor the Host and
// Origin pair identifies a trusted caller.

'use strict';

// Shared token injected by the Tauri shell (NR_CORE_TOKEN, see src-tauri/src/lib.rs). Out-of-process
// integrations that hold it — the Adobe CEP panel, the MCP bridge — are trusted whatever their
// origin: they read it from a file, and a web page cannot open a file. Empty under a bare
// `npm run core`, where the origin check alone applies.
const NR_TOKEN = process.env.NR_CORE_TOKEN || '';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const TAURI_ORIGINS = new Set([
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
]);

function hostName(headers) {
  return String(headers.host || '').replace(/:\d+$/, '').toLowerCase();
}

function rendererOriginAllowed(origin) {
  if (!origin) return true; // native and local non-browser clients do not send Origin
  if (TAURI_ORIGINS.has(String(origin))) return true;
  try {
    const parsed = new URL(String(origin));
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
  } catch (_) {
    // `null` lands here, which is what a sandboxed frame on a hostile page sends. It stays refused:
    // a caller that legitimately has no usable origin carries the token instead.
    return false;
  }
}

// `tk` in the query string is the only channel EventSource leaves open: it sets no header.
function tokenAllowed(headers, url) {
  if (!NR_TOKEN) return false;
  if (headers['x-nr-token'] === NR_TOKEN) return true;
  return !!url && url.searchParams.get('tk') === NR_TOKEN;
}

function controlRequestAllowed(headers, url) {
  if (tokenAllowed(headers, url)) return true;
  return LOOPBACK_HOSTS.has(hostName(headers)) && rendererOriginAllowed(headers.origin);
}

module.exports = { controlRequestAllowed, rendererOriginAllowed, tokenAllowed };
