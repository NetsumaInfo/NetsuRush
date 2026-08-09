// @ts-check
// core/netsu/legacyZip.js
// Archives .netsu v1 (ZIP) : LECTURE seule, plus aucune écriture de board.
//
// Le format de partage du board est désormais un conteneur SQLite (core/netsu/db.js), mais les
// archives déjà envoyées doivent rester ouvrables — c'est la seule raison d'être de ce fichier.
// Le writer ZIP v1 des boards a été supprimé avec la bascule ; `zipStore` survit parce que le
// Carnet écrit encore ses exports en ZIP (core/nbfile.js).
//
// Writer/reader maison, zéro dépendance : méthode STORE + CRC32, donc des octets « PK » lisibles
// par n'importe quel dézippeur.

const { t } = require('../i18n');

// --- CRC32 (table) ----------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** @param {Buffer} buf */
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// --- ZIP writer (STORE : les médias sont déjà compressés) --------------------------------------
// entries = [{ name, data:Buffer }]. Date DOS fixe → archive déterministe.
/** @param {{ name: string, data: Buffer }[]} entries @returns {Buffer} */
function zipStore(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  const DOS_TIME = 0;
  const DOS_DATE = 0x21; // 1980-01-01
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = e.data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // signature en-tête local
    local.writeUInt16LE(20, 4);         // version requise
    local.writeUInt16LE(0x0800, 6);     // drapeau : nom UTF-8
    local.writeUInt16LE(0, 8);          // méthode : store
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // signature central directory
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += local.length + name.length + data.length;
  }
  const cdStart = offset;
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // End Of Central Directory
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  return Buffer.concat([...parts, ...central, eocd]);
}

// --- ZIP reader : parcours des en-têtes locaux (le bit streaming n'est jamais écrit → les tailles
// sont connues dans l'en-tête, pas de data descriptor). S'arrête au central directory.
/** @param {Buffer} buf @returns {Map<string, Buffer>} */
function unzip(buf) {
  const files = new Map();
  let i = 0;
  while (i + 4 <= buf.length && buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8);
    const compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.toString('utf8', i + 30, i + 30 + nameLen);
    const dataStart = i + 30 + nameLen + extraLen;
    const data = buf.subarray(dataStart, dataStart + compSize);
    if (method === 0) files.set(name, Buffer.from(data)); // seul le store était produit
    i = dataStart + compSize;
  }
  return files;
}

/**
 * Résout un token v1 : `asset:<sha>` (octets embarqués, déjà réécrits dans le cache) ou `ref:<id>`
 * (gros média laissé dehors, retrouvé s'il n'a pas bougé). Tout autre token est un lien à laisser
 * tel quel. Renvoie `{ path, missing }` : `missing` décrit ce qu'il faut relocaliser.
 */
function makeTokenResolver(shaToPath, refsById, fs) {
  return (rawToken, fallbackKind) => {
    const token = String(rawToken || '');
    if (token.startsWith('asset:')) {
      const p = shaToPath.get(token.slice(6));
      if (p) return { path: p, missing: null };
      return { path: '', missing: { name: 'asset', size: 0, kind: fallbackKind } };
    }
    if (token.startsWith('ref:')) {
      const meta = refsById.get(token.slice(4));
      if (meta && meta.origPath) {
        try {
          const st = fs.statSync(meta.origPath);
          if (st.isFile() && (!meta.size || st.size === meta.size)) return { path: meta.origPath, missing: null };
        } catch (_) { /* introuvable → placeholder */ }
      }
      return { path: '', missing: meta ? { name: meta.name, size: meta.size, kind: meta.kind } : null };
    }
    return { path: token, missing: undefined }; // lien YouTube/embed/distant/data, ou ref vide
  };
}

/** @param {any} item @param {(t: string, k: string) => any} resolveToken */
function detokenizeV1Item(item, resolveToken) {
  if (item.kind === 'sequence') {
    const tokens = Array.isArray(item.frames) ? item.frames : [];
    const frames = [];
    let missSize = 0;
    for (const token of tokens) {
      const { path: p, missing } = resolveToken(token, 'image');
      frames.push(p || '');
      if (!p && missing) missSize += missing.size || 0;
    }
    const allMissing = tokens.length > 0 && frames.every((p) => !p);
    return {
      ...item,
      frames,
      ref: frames.find(Boolean) || '',
      missing: allMissing
        ? { name: `Séquence — ${tokens.length} image(s)`, size: missSize, kind: 'sequence' }
        : undefined,
    };
  }
  const ref = String(item.ref || '');
  if (!ref.startsWith('asset:') && !ref.startsWith('ref:')) return item;
  const { path: p, missing } = resolveToken(ref, item.kind);
  if (p) return { ...item, ref: p, missing: undefined };
  return { ...item, ref: '', missing: missing || item.missing || { name: 'média', size: 0, kind: item.kind } };
}

/**
 * Lit une archive board v1 déjà en mémoire. Rend la MÊME forme que la lecture v2.
 * @param {any} refStore @param {Buffer} buf @param {typeof import('node:fs')} fs
 */
function readZipBoard(refStore, buf, fs) {
  const files = unzip(buf);
  const boardRaw = files.get('board.json');
  if (!boardRaw) return { ok: false, error: t('missingArchiveFile') };

  let board;
  try { board = JSON.parse(boardRaw.toString('utf8')); } catch (_) { return { ok: false, error: t('unreadableFile') }; }
  if (board.format !== 'netsu') return { ok: false, error: t('unknownFormat') };
  if (board.type !== 'board') return { ok: false, error: `${t('unsupportedType')}: ${board.type}`, type: board.type };

  let manifest = { refs: [], counts: null };
  const manRaw = files.get('manifest.json');
  if (manRaw) { try { manifest = JSON.parse(manRaw.toString('utf8')); } catch (_) { /* manifeste optionnel */ } }

  // Chaque asset embarqué est réécrit dans le cache d'assets — saveAsset déduplique par contenu.
  const shaToPath = new Map();
  for (const [name, data] of files) {
    const m = name.match(/^assets\/([0-9a-f]+)\.(\w+)$/i);
    if (!m) continue;
    const saved = refStore.saveAsset(data, m[2]);
    if (saved.ok && saved.path) shaToPath.set(m[1], saved.path);
  }

  const resolveToken = makeTokenResolver(shaToPath, new Map((manifest.refs || []).map((r) => [r.id, r])), fs);
  const items = (board.items || []).map((it) => detokenizeV1Item(it, resolveToken));
  return {
    ok: true,
    scene: { name: board.name || t('untitled'), items, view: board.view || null },
    counts: manifest.counts || null,
  };
}

module.exports = { zipStore, unzip, crc32, readZipBoard };
