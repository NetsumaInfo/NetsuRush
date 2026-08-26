// @ts-check
// Sortie IMAGE du hub de traitements : un fichier image (source fixe) ou une séquence numérotée
// (source vidéo). Une seule table d'arguments ffmpeg, comme `export/encodeArgs` pour la vidéo :
// le core résout, les sidecars écrivent. La séquence part TOUJOURS dans son propre dossier — des
// centaines d'images à côté des vidéos rendraient le dossier de sortie inutilisable.

const path = require('path');
const fsp = require('fs').promises;

const IMAGE_EXT = { png: 'png', jpeg: 'jpg' };

/** @param {unknown} v @param {number} lo @param {number} hi @param {number} fallback */
function clamp(v, lo, hi, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;
}

/**
 * Forme de sortie demandée. Tout ce qui n'est pas reconnu retombe sur la vidéo : un réglage
 * persisté d'une version antérieure ne doit jamais changer le format écrit.
 * @param {any} opts @returns {'video'|'sequence'|'image'}
 */
function outputKind(opts) {
  const kind = String(opts?.outputKind || 'video');
  return kind === 'sequence' || kind === 'image' ? kind : 'video';
}

/**
 * Réglages image normalisés (format, profondeur, compression, numérotation).
 * @param {any} opts
 */
function imageSpec(opts) {
  const format = String(opts?.imageFormat || 'png') === 'jpeg' ? 'jpeg' : 'png';
  return {
    format,
    ext: IMAGE_EXT[format],
    bits: Number(opts?.pngBits) === 16 ? 16 : 8,
    compression: clamp(opts?.pngCompression, 0, 9, 6),
    quality: clamp(opts?.jpegQuality, 1, 100, 92),
    padding: clamp(opts?.seqPadding, 3, 8, 6),
    start: clamp(opts?.seqStart, 0, 999999, 1),
  };
}

// mjpeg pilote sa qualité par -q:v, où 2 = meilleur et 31 = pire. On expose un 1..100 familier et
// on le replie sur cette échelle inversée.
const jpegQscale = (quality) => Math.max(2, Math.min(31, Math.round(31 - ((clamp(quality, 1, 100, 92) - 1) * 29) / 99)));

/**
 * Arguments d'encodage d'UNE image (ou d'une image de séquence). Le PNG reste sans perte quelle que
 * soit la compression : seuls le temps d'écriture et le poids changent.
 * @param {ReturnType<typeof imageSpec>} spec
 * @param {{ alpha?: boolean }} [opts] alpha = la sortie porte un canal de transparence (détourage)
 */
function imageEncodeArgs(spec, opts = {}) {
  if (spec.format === 'jpeg') {
    // Le JPEG n'a pas d'alpha : un détourage passe par le PNG (le renderer ne propose même pas
    // le choix), et une sortie opaque garde le 4:4:4 pour ne pas cribler les aplats d'artefacts.
    return ['-c:v', 'mjpeg', '-q:v', String(jpegQscale(spec.quality)), '-pix_fmt', 'yuvj444p'];
  }
  const alpha = !!opts.alpha;
  const pix = spec.bits >= 16
    ? (alpha ? 'rgba64be' : 'rgb48be')
    : (alpha ? 'rgba' : 'rgb24');
  return ['-c:v', 'png', '-compression_level', String(spec.compression), '-pix_fmt', pix];
}

/**
 * Motif de numérotation d'une séquence, relatif au dossier de la séquence.
 * @param {string} base @param {ReturnType<typeof imageSpec>} spec
 */
const sequencePattern = (base, spec) => `${base}_%0${spec.padding}d.${spec.ext}`;

/**
 * Destination d'UN job image. Renvoie le chemin passé au sidecar (`out`, motif pour une séquence)
 * et ce qu'il faut importer au Media Pool (`imported` : le DOSSIER pour une séquence, Resolve
 * n'acceptant une séquence d'images que par son dossier).
 * @param {{ outDir: string, base: string, tag?: string, kind: 'sequence'|'image', spec: ReturnType<typeof imageSpec> }} args
 * @returns {Promise<{ out: string, imported: string, dir: string|null }>}
 */
async function imageTarget({ outDir, base, tag = '', kind, spec }) {
  if (kind === 'image') {
    const out = path.join(outDir, `${base}${tag}.${spec.ext}`);
    return { out, imported: out, dir: null };
  }
  const dir = path.join(outDir, `${base}${tag}`);
  await fsp.mkdir(dir, { recursive: true });
  const out = path.join(dir, sequencePattern(`${base}${tag}`, spec));
  return { out, imported: dir, dir };
}

/**
 * Bloc envoyé aux sidecars Python. Vide pour une sortie vidéo : rien ne change alors du contrat
 * historique (codec/audio), et un sidecar plus ancien continue de fonctionner.
 * @param {'video'|'sequence'|'image'} kind @param {ReturnType<typeof imageSpec>} spec
 * @param {{ alpha?: boolean }} [opts]
 */
function imagePayload(kind, spec, opts = {}) {
  if (kind === 'video') return {};
  return {
    out_kind: kind,
    img_format: spec.format,
    png_bits: spec.bits,
    png_compression: spec.compression,
    jpeg_quality: spec.quality,
    seq_start: spec.start,
    image_args: imageEncodeArgs(spec, opts),
  };
}

module.exports = {
  IMAGE_EXT, outputKind, imageSpec, imageEncodeArgs, imageTarget, imagePayload,
  sequencePattern, jpegQscale,
};
