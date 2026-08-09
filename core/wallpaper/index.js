// @ts-check
// Bibliothèque des fonds d'écran : ingestion, catalogue, variantes, suppression.
//
// Une entrée = un dossier NR_HOME/wallpapers/<hash de contenu>/ contenant son `meta.json` et ses
// variantes déjà encodées. Le hash de contenu (patron de `saveAsset`, core/reference.js) rend
// l'import IDEMPOTENT : réimporter le même fichier ne réencode rien et ne duplique rien.
//
// Les variantes sont produites PARESSEUSEMENT : seule la marche de flou 0 est cuite à l'import, les
// autres n'existent qu'une fois demandées. Cuire les huit d'avance ferait payer à l'import un flou
// que l'utilisateur n'essaiera peut-être jamais.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fsp, WALLPAPER_DIR } = require('../config');
const { BLUR_STEPS, BASE_WIDTH, blurRadius, probeSource, encodeStill, encodeLoop } = require('./encode');

const META_NAME = 'meta.json';
const ID_LENGTH = 12;
/** Résolutions d'import proposées. La source n'est jamais agrandie. */
const MAX_WIDTHS = { hd: 1280, fhd: 1920, qhd: 2560 };
const DEFAULT_MAX_WIDTH = MAX_WIDTHS.fhd;

// Encodages en vol, clés par chemin de sortie : deux fenêtres qui demandent la même variante au même
// instant doivent partager UN encodage, sinon deux ffmpeg écrivent le même fichier.
const inFlight = new Map();

const fail = (error) => ({ ok: false, error: String((error && error.message) || error) });

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex').slice(0, ID_LENGTH)));
  });
}

function entryDir(id) {
  return path.join(WALLPAPER_DIR, id);
}

/** Nom de variante : la marche et la nature (animée ou fixe) suffisent à l'identifier. */
function variantName(kind, step, animated) {
  const useLoop = kind === 'animated' && animated;
  return useLoop ? `a${step}.mp4` : `p${step}.webp`;
}

async function readMeta(id) {
  const raw = await fsp.readFile(path.join(entryDir(id), META_NAME), 'utf8');
  const meta = JSON.parse(raw);
  if (!meta || meta.id !== id) throw new Error(`métadonnées de fond illisibles (${id})`);
  return meta;
}

/** Une entrée n'est valide que si son `meta.json` ET sa variante de base sont sur le disque. */
async function readEntry(id) {
  const meta = await readMeta(id);
  const base = path.join(entryDir(id), variantName(meta.kind, 0, true));
  await fsp.access(base);
  return { ...meta, base, poster: path.join(entryDir(id), variantName(meta.kind, 0, false)) };
}

async function encodeVariant(meta, dest, step, animated) {
  const pending = inFlight.get(dest);
  if (pending) return pending;
  const source = path.join(entryDir(meta.id), meta.sourceName);
  const job = (meta.kind === 'animated' && animated
    ? encodeLoop(source, dest, { step, baseWidth: meta.baseWidth, duration: meta.duration })
    : encodeStill(source, dest, { step, baseWidth: meta.baseWidth })
  ).finally(() => inFlight.delete(dest));
  inFlight.set(dest, job);
  return job;
}

/**
 * Importe un fichier comme fond. La SOURCE est copiée dans l'entrée : sans elle, déplacer ou
 * renommer le fichier d'origine casserait toute variante pas encore encodée.
 */
async function importWallpaper(srcPath, opts = {}) {
  try {
    const file = String(srcPath || '');
    if (!file) return fail('aucun fichier');
    const probe = await probeSource(file);
    const id = await hashFile(file);
    const dir = entryDir(id);
    const existing = await readEntry(id).catch(() => null);
    if (existing) return { ok: true, entry: existing, reused: true };

    await fsp.mkdir(dir, { recursive: true });
    const sourceName = `source${path.extname(file).toLowerCase() || '.bin'}`;
    await fsp.copyFile(file, path.join(dir, sourceName));

    const requested = MAX_WIDTHS[opts.quality] || DEFAULT_MAX_WIDTH;
    const meta = {
      id,
      name: path.basename(file),
      sourceName,
      kind: probe.animated ? 'animated' : 'still',
      width: probe.width,
      height: probe.height,
      duration: probe.duration,
      fps: probe.fps,
      // La source n'est jamais agrandie : un fond de 900 px reste un fond de 900 px.
      baseWidth: Math.min(probe.width, requested, BASE_WIDTH * 2),
      createdAt: Date.now(),
    };
    await fsp.writeFile(path.join(dir, META_NAME), JSON.stringify(meta, null, 2), 'utf8');

    // Poster d'abord : c'est lui qui s'affiche pendant que la boucle s'encode, et lui qui reste
    // quand l'animation est figée.
    await encodeVariant(meta, path.join(dir, variantName(meta.kind, 0, false)), 0, false);
    if (meta.kind === 'animated') {
      await encodeVariant(meta, path.join(dir, variantName(meta.kind, 0, true)), 0, true);
    }
    return { ok: true, entry: await readEntry(id), reused: false };
  } catch (e) {
    return fail(e);
  }
}

async function listWallpapers() {
  try {
    const names = await fsp.readdir(WALLPAPER_DIR).catch(() => []);
    const entries = await Promise.all(names.map((name) => readEntry(name).catch(() => null)));
    return { ok: true, entries: entries.filter(Boolean).sort((a, b) => b.createdAt - a.createdAt) };
  } catch (e) {
    return fail(e);
  }
}

/** Chemin d'une variante, encodée à la demande puis conservée : une marche ne se recalcule jamais. */
async function variant(id, opts = {}) {
  try {
    const step = Math.min(Math.max(Math.round(Number(opts.blur) || 0), 0), BLUR_STEPS.length - 1);
    const animated = opts.animated !== false;
    const meta = await readMeta(String(id || ''));
    const dest = path.join(entryDir(meta.id), variantName(meta.kind, step, animated));
    const ready = await fsp.access(dest).then(() => true, () => false);
    if (!ready) await encodeVariant(meta, dest, step, animated);
    return { ok: true, path: dest, step, radius: blurRadius(step), animated: animated && meta.kind === 'animated' };
  } catch (e) {
    return fail(e);
  }
}

/** Un chemin appartient-il à la bibliothèque ? Seul cas où l'on s'autorise à supprimer. */
function isOwned(target) {
  const root = path.resolve(WALLPAPER_DIR).toLowerCase();
  const dir = path.resolve(target).toLowerCase();
  return dir.startsWith(root + path.sep) && dir !== root;
}

async function removeWallpaper(id) {
  try {
    const dir = entryDir(String(id || ''));
    if (!isOwned(dir)) return { ok: true, removed: false };
    await fsp.rm(dir, { recursive: true, force: true });
    return { ok: true, removed: true };
  } catch (e) {
    return fail(e);
  }
}

module.exports = { importWallpaper, listWallpapers, variant, removeWallpaper, isOwned, MAX_WIDTHS };
