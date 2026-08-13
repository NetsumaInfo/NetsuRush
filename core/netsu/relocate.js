// @ts-check
// Read-only recovery of media moved with or below a working .netsu project.

const fs = require('node:fs');
const path = require('node:path');
const sidecar = require('./sidecar');
const { headSha } = require('./embed');

const MAX_ENTRIES = 10000;

/** @param {string} filePath */
function existingFile(filePath) {
  try { return fs.statSync(filePath).isFile(); } catch (_) { return false; }
}

/** @param {string} netsuPath @param {string} token */
function findCompanionFile(netsuPath, token) {
  if (!sidecar.isSidecarToken(token)) return '';
  const canonical = sidecar.resolveSidecar(netsuPath, token);
  if (!canonical) return ''; // traversal or malformed token
  if (existingFile(canonical)) return canonical;

  const relative = String(token).slice(sidecar.TOKEN.length).split('/').join(path.sep);
  const parent = path.dirname(path.resolve(netsuPath));
  /** @type {string[]} */
  const matches = [];
  let entries;
  try { entries = fs.readdirSync(parent, { withFileTypes: true }); } catch (_) { return ''; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.toLowerCase().endsWith(sidecar.DIR_SUFFIX)) continue;
    const root = path.join(parent, entry.name);
    const candidate = path.resolve(root, relative);
    if (candidate !== root && !candidate.startsWith(root + path.sep)) continue;
    if (existingFile(candidate)) matches.push(candidate);
    if (matches.length > 1) return '';
  }
  return matches.length === 1 ? matches[0] : '';
}

/** @param {string} root @returns {string[]} */
function walkBounded(root) {
  /** @type {string[]} */
  const files = [];
  const pending = [root];
  let visited = 0;
  while (pending.length && visited < MAX_ENTRIES) {
    const dir = pending.pop();
    if (!dir) break;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_ENTRIES) break;
      const candidate = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile()) files.push(candidate);
    }
  }
  return files;
}

/**
 * @param {string} netsuPath
 * @param {{ name?: unknown, size?: unknown, head_sha?: unknown }} row
 */
function findReferencedFile(netsuPath, row) {
  const name = String(row && row.name || '');
  const size = Number(row && row.size) || 0;
  const expectedHead = String(row && row.head_sha || '');
  if (!name || size <= 0) return '';
  const root = path.dirname(path.resolve(netsuPath));
  const candidates = walkBounded(root).filter((candidate) => {
    if (path.basename(candidate).toLowerCase() !== name.toLowerCase()) return false;
    try { return fs.statSync(candidate).size === size; } catch (_) { return false; }
  });
  /** @type {string[]} */
  const matches = [];
  for (const candidate of candidates) {
    try {
      if (!expectedHead || headSha(candidate) === expectedHead) matches.push(candidate);
    } catch (_) { /* unreadable candidate */ }
    if (matches.length > 1) return '';
  }
  return matches.length === 1 ? matches[0] : '';
}

/**
 * Retrouve d'un coup, dans un dossier choisi par l'utilisateur, les médias qu'un board reçu ne
 * sait plus où prendre. Un partage « lien » ou « aperçu » arrive avec autant de placeholders que de
 * rushs référencés : les relocaliser un par un est une corvée qui ne dit rien de plus que « ils
 * sont tous là, dans ce dossier ».
 *
 * Un candidat compte s'il porte le même NOM et la même TAILLE. Deux fichiers homonymes de même
 * taille rendent la réponse ambiguë : on n'en propose alors aucun plutôt que de deviner.
 * @param {string} dirPath
 * @param {{ id: string, name: string, size?: number }[]} wanted
 * @returns {{ ok: boolean, found: { id: string, path: string }[], scanned: number, error?: string }}
 */
function matchIn(dirPath, wanted) {
  const root = path.resolve(String(dirPath || ''));
  if (!root || !fs.existsSync(root)) return { ok: false, found: [], scanned: 0, error: 'dossier introuvable' };
  const files = walkBounded(root);
  /** @type {Map<string, string[]>} */
  const byName = new Map();
  for (const file of files) {
    const key = path.basename(file).toLowerCase();
    const list = byName.get(key);
    if (list) list.push(file);
    else byName.set(key, [file]);
  }

  const found = [];
  for (const want of Array.isArray(wanted) ? wanted : []) {
    const name = String(want && want.name || '').toLowerCase();
    if (!name) continue;
    const size = Number(want && want.size) || 0;
    const candidates = (byName.get(name) || []).filter((candidate) => {
      if (!size) return true;
      try { return fs.statSync(candidate).size === size; } catch (_) { return false; }
    });
    if (candidates.length === 1) found.push({ id: String(want.id), path: candidates[0] });
  }
  return { ok: true, found, scanned: files.length };
}

module.exports = { MAX_ENTRIES, findCompanionFile, findReferencedFile, matchIn };
