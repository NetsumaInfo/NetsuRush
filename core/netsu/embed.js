// @ts-check
// core/netsu/embed.js
// Produit les octets décrits par core/netsu/levels.js et les range dans le conteneur.
//
// Ce module est la FRONTIÈRE : c'est le seul du dossier netsu/ qui sonde des fichiers et lance
// ffmpeg. La décision (quoi produire) reste dans levels.js, pure et testable ; le rangement reste
// dans blobs.js. Ici on ne fait qu'exécuter.
//
// Pourquoi ne PAS réutiliser core/proxy.js#proxySegment, qui encode pourtant déjà des extraits :
// il PLAFONNE la durée à 4 s (core/proxy.js:220) parce qu'il sert des aperçus qui tournent en
// boucle. Un média embarqué doit couvrir la plage réelle, marge comprise. On reprend donc les
// mêmes briques d'encodage (core/proxyEncoder.js) sans le plafond ni la file d'attente de lecture —
// ce qui garantit aussi qu'embarquer un board ne vole pas les créneaux d'encodage de l'aperçu.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { run, probeMedia } = require('../ffmpeg');
const { thumbnail } = require('../thumbs');
const { getCapabilities } = require('../export/capabilities');
const { selectProxyEncoder, proxyVideoArgs, proxyContainerArgs } = require('../proxyEncoder');
const blobs = require('./blobs');
const levels = require('./levels');

// Empreinte de relocalisation : les premiers octets suffisent à reconnaître un rush chez le
// destinataire sans relire 4 Go. Deux fichiers qui partagent tête ET taille sont le même média.
const HEAD_BYTES = 4 * 1024 * 1024;
// Position du poster dans la plage : un poil après le début, pour éviter un fondu au noir d'entrée.
const POSTER_OFFSET_SEC = 0.25;
const POSTER_HEIGHT = 360;

/** @param {string} filePath @returns {string} */
function headSha(filePath) {
  const buf = Buffer.allocUnsafe(HEAD_BYTES);
  const fd = fs.openSync(filePath, 'r');
  try {
    const read = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    return blobs.sha256(buf.subarray(0, Math.max(0, read)));
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Tout ce qu'on sait du média D'ORIGINE. Sert à l'estimation de poids (aucun encodage) comme à
 * l'embarquement. `error` plutôt qu'une exception : un fichier disparu ne doit pas faire échouer
 * l'export entier, il devient un item « manquant ».
 * @param {string} filePath
 * @returns {Promise<{ ok: boolean, path: string, name: string, size: number, mtime: number,
 *                     duration: number, width: number, height: number, error?: string }>}
 */
async function describeSource(filePath) {
  const empty = { path: filePath, name: path.basename(filePath || ''), size: 0, mtime: 0, duration: 0, width: 0, height: 0 };
  let stat;
  try { stat = fs.statSync(filePath); } catch (e) { return { ok: false, ...empty, error: String((e && e.message) || e) }; }
  let probe = { duration: 0, width: 0, height: 0 };
  try { probe = await probeMedia(filePath); } catch (_) { /* image ou conteneur non sondable : dimensions inconnues */ }
  return {
    ok: true,
    path: filePath,
    name: path.basename(filePath),
    size: stat.size,
    mtime: Math.round(stat.mtimeMs),
    duration: Number(probe.duration) || 0,
    width: Number(probe.width) || 0,
    height: Number(probe.height) || 0,
  };
}

/** Identité de contenu du média source (indépendante du chemin, donc valable d'une machine à l'autre). */
function mediaIdOf(source) {
  const head = source.size > 0 ? headSha(source.path) : '';
  return { id: crypto.createHash('sha256').update(`${head}|${source.size}`).digest('hex').slice(0, 32), head };
}

/**
 * Décrit le média d'origine dans le conteneur. `keepPath` dit si le CHEMIN ABSOLU a le droit d'y
 * entrer : dans un projet oui, c'est ce qui retrouve le rush d'une séance à l'autre ; dans un
 * fichier PARTAGÉ non — il ne dirait rien au destinataire (sa machine n'a pas cette arborescence)
 * et publierait le nom de session et le rangement de disque de l'expéditeur. La relocalisation
 * n'en a pas besoin : elle travaille sur nom + taille + empreinte de tête.
 * @param {any} db @param {ReturnType<typeof describeSource> extends Promise<infer T> ? T : never} source
 * @param {{ keepPath?: boolean }} [opts]
 */
function recordMedia(db, source, opts) {
  const { id, head } = mediaIdOf(source);
  const keepPath = !opts || opts.keepPath !== false;
  db.prepare(
    `INSERT INTO media (id, path, name, size, mtime, head_sha, duration, width, height)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET path = excluded.path, name = excluded.name,
       mtime = excluded.mtime, duration = excluded.duration`,
  ).run(id, keepPath ? source.path : '', source.name, source.size, source.mtime, head, source.duration, source.width, source.height);
  return id;
}

/** Arguments audio du clip embarqué — mêmes valeurs que l'aperçu, pour un seul vocabulaire d'encodage. */
function audioArgs(container) {
  return container === 'webm' ? ['-c:a', 'libvorbis', '-b:a', '64k'] : ['-c:a', 'aac', '-b:a', '96k'];
}

/**
 * Encode la plage demandée dans un fichier temporaire et rend son chemin. L'appelant le range puis
 * le supprime — d'où le `withTempDir` qui garantit le nettoyage même en cas d'échec ffmpeg.
 * @param {string} input @param {{ start: number, end: number, height: number, preset: string }} clip
 * @param {string} workDir
 */
async function encodeClip(input, clip, workDir) {
  let caps;
  try { caps = await getCapabilities(); } catch (_) { caps = { h264Encoder: null, h265Encoder: null, codecEncoderOptions: {} }; }
  const encoder = selectProxyEncoder('hevc', caps, 'auto');
  const out = path.join(workDir, `clip.${encoder.extension}`);
  const duration = Math.max(0.1, clip.end - clip.start);
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', String(clip.start), '-i', input, '-t', String(duration),
    '-vf', `scale=-2:${clip.height}:flags=fast_bilinear`,
    ...proxyVideoArgs(encoder, /** @type {any} */ (clip.preset)),
    ...proxyContainerArgs(encoder),
    ...audioArgs(encoder.container),
  ];
  if (encoder.container === 'mp4') args.push('-movflags', '+faststart');
  args.push('-f', encoder.container, out);
  await run('ffmpeg', args);
  if (!fs.existsSync(out) || fs.statSync(out).size === 0) {
    throw new Error(`clip vide (${path.basename(input)} ${clip.start}→${clip.end})`);
  }
  return { file: out, ext: encoder.extension };
}

/** @template T @param {(dir: string) => Promise<T>} fn @returns {Promise<T>} */
async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'netsurush-netsu-'));
  try {
    return await fn(dir);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* nettoyage best-effort */ }
  }
}

/** Poster : une image fixe qui permet d'afficher l'item même sans son média. */
async function embedPoster(handle, source, atSecond) {
  try {
    const file = await thumbnail(source.path, atSecond, 'high', { height: POSTER_HEIGHT });
    if (!file || !fs.existsSync(file)) return null;
    return (await blobs.putFileAsync(handle, file)).sha;
  } catch (_) {
    return null; // un poster manquant dégrade l'affichage, il ne doit pas faire rater l'export
  }
}

/**
 * Embarque un média au niveau demandé. `itemId` absent = média SECONDAIRE (une frame de séquence,
 * par exemple) : on range les octets sans écrire de ligne `item_media`, qui n'a qu'une entrée par
 * item et serait écrasée à chaque frame.
 * @param {{ handle: any, docId: string, itemId?: string|null, item: any, filePath: string,
 *           level?: unknown, quality?: unknown, marginSec?: unknown, keepPath?: boolean }} args
 * @returns {Promise<{ mode: string, level: string, bytes: number, mediaId: string|null,
 *                     posterSha: string|null, clipSha: string|null, long: boolean, error?: string }>}
 */
async function embedItem({ handle, docId, itemId, item, filePath, level, quality, marginSec, keepPath }) {
  const idle = {
    mode: 'none', level: levels.normalizeLevel(level), bytes: 0,
    mediaId: null, posterSha: null, clipSha: null, long: false,
  };
  const probePlan = levels.planEmbed(item, { level, quality, marginSec });
  if (probePlan.mode === 'none' || !filePath) return idle;

  const source = await describeSource(filePath);
  if (!source.ok) return { ...idle, error: source.error };

  // On replanifie AVEC la durée réelle : sans elle, la marge d'un plan collé à la fin du média
  // déborderait et ffmpeg rendrait un fichier vide.
  const plan = levels.planEmbed(item, { level, quality, marginSec, duration: source.duration });
  const mediaId = handle.tx((db) => recordMedia(db, source, { keepPath })).result;
  const base = { ...idle, mode: plan.mode, level: plan.level, mediaId, long: plan.long };
  const remember = (shas) => {
    if (!itemId) return;
    handle.tx((db) => writeItemMedia(db, docId, itemId, plan, { mediaId, ...shas }));
  };

  if (plan.mode === 'link') {
    const posterSha = await embedPoster(handle, source, POSTER_OFFSET_SEC);
    const posterInfo = posterSha ? blobs.blobInfo(handle.db, posterSha) : null;
    remember({ posterSha, clipSha: null });
    return { ...base, posterSha, bytes: posterInfo ? posterInfo.size : 0 };
  }

  if (plan.mode === 'file') {
    const ext = path.extname(source.path).slice(1).toLowerCase();
    const { sha } = await blobs.putFileAsync(handle, source.path, ext);
    remember({ posterSha: null, clipSha: sha });
    return { ...base, clipSha: sha, bytes: source.size };
  }

  const clip = plan.clip;
  const posterSha = await embedPoster(handle, source, clip.start + POSTER_OFFSET_SEC);
  const clipSha = await withTempDir(async (dir) => {
    const { file, ext } = await encodeClip(source.path, clip, dir);
    return (await blobs.putFileAsync(handle, file, ext)).sha;
  });
  remember({ posterSha, clipSha });
  const clipSize = blobs.blobInfo(handle.db, clipSha);
  const posterSize = posterSha ? blobs.blobInfo(handle.db, posterSha) : null;
  return {
    ...base,
    posterSha,
    clipSha,
    bytes: (clipSize ? clipSize.size : 0) + (posterSize ? posterSize.size : 0),
  };
}

/** @param {any} db @param {string} docId @param {string} itemId @param {any} plan @param {any} shas */
function writeItemMedia(db, docId, itemId, plan, shas) {
  db.prepare(
    `INSERT INTO item_media (doc_id, item_id, level, quality, margin_sec, media_id, poster_sha, clip_sha, clip_in, clip_out)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(doc_id, item_id) DO UPDATE SET level = excluded.level, quality = excluded.quality,
       margin_sec = excluded.margin_sec, media_id = excluded.media_id, poster_sha = excluded.poster_sha,
       clip_sha = excluded.clip_sha, clip_in = excluded.clip_in, clip_out = excluded.clip_out`,
  ).run(
    docId, itemId, plan.level, plan.quality, plan.marginSec, shas.mediaId,
    shas.posterSha, shas.clipSha,
    plan.clip ? plan.clip.start : null,
    plan.clip ? plan.clip.end : null,
  );
}

module.exports = { describeSource, embedItem, recordMedia, mediaIdOf, headSha, HEAD_BYTES };
