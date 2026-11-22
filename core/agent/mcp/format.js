// @ts-check
// Pure MCP helpers shared by the stdio server and its tests: protocol negotiation and the shaping
// of a registry result into an MCP tool result. No business module is required here — the stdio
// server runs outside the core and must stay loadable on its own.

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

/// Newest first. A client asking for one of these gets it back; anything else gets the newest,
/// as the spec prescribes, and the client decides whether it can live with it.
const PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/** @param {any} requested */
function negotiateVersion(requested) {
  return PROTOCOL_VERSIONS.includes(String(requested)) ? String(requested) : PROTOCOL_VERSIONS[0];
}

const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const IMAGE_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
const MEDIA_TYPES = {
  ...IMAGE_TYPES,
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
  '.avi': 'video/x-msvideo', '.mxf': 'application/mxf', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4', '.json': 'application/json', '.jsx': 'text/javascript', '.xml': 'application/xml',
};

/** @param {string} p */
const mimeOf = (p) => /** @type {Record<string,string>} */ (MEDIA_TYPES)[path.extname(p).toLowerCase()];

/// Turns a registry result into an MCP `tools/call` result.
///
/// Tools attach media through two reserved keys rather than through the protocol, so the in-app
/// engines (which speak no MCP) see plain JSON: `__images` (local image paths the model should look
/// at) become image blocks, `__files` (media the model may open) become resource links. Both are
/// stripped from the JSON so paths are not sent twice.
/**
 * @param {any} result
 * @param {{ readFile?: (p:string)=>Buffer }} [io]
 */
function toCallResult(result, io = {}) {
  const readFile = io.readFile || ((p) => fs.readFileSync(p));
  /** @type {any[]} */
  const content = [];
  let data = result;
  /** @type {any[]} */
  let images = [];
  /** @type {any[]} */
  let files = [];
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const { __images, __files, ...rest } = result;
    images = Array.isArray(__images) ? __images : [];
    files = Array.isArray(__files) ? __files : [];
    data = rest;
  }
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  content.push({ type: 'text', text });

  let skipped = 0;
  for (const entry of images.slice(0, MAX_IMAGES)) {
    const p = typeof entry === 'string' ? entry : entry && entry.path;
    const mimeType = (entry && entry.mimeType) || (p && /** @type {Record<string,string>} */ (IMAGE_TYPES)[path.extname(p).toLowerCase()]);
    if (!p || !mimeType) { skipped += 1; continue; }
    try {
      const buf = readFile(p);
      if (buf.length > MAX_IMAGE_BYTES) { skipped += 1; continue; }
      content.push({ type: 'image', data: buf.toString('base64'), mimeType });
    } catch { skipped += 1; }
  }
  for (const entry of files) {
    const p = typeof entry === 'string' ? entry : entry && entry.path;
    if (!p) continue;
    const link = { type: 'resource_link', uri: pathToFileURL(p).href, name: (entry && entry.name) || path.basename(p) };
    const mimeType = (entry && entry.mimeType) || mimeOf(p);
    content.push(mimeType ? { ...link, mimeType } : link);
  }
  if (skipped) content.push({ type: 'text', text: `(${skipped} image(s) unreadable or too large, omitted)` });

  const isError = !!(data && typeof data === 'object' && data.ok === false);
  /** @type {any} */
  const out = { content, isError };
  // Structured content must be an object for every protocol version we still answer. It is left
  // out when media rides along: a client that prefers it would otherwise drop the image blocks.
  if (content.length === 1 && data && typeof data === 'object' && !Array.isArray(data)) out.structuredContent = data;
  return out;
}

module.exports = { PROTOCOL_VERSIONS, negotiateVersion, toCallResult, MAX_IMAGES };
