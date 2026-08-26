// Sortie IMAGE du hub de traitements (image fixe / séquence numérotée) et NOMMAGE des sorties.
//
// Le nommage et la forme de sortie sont du TypeScript sans dépendance runtime : on les transpile à
// la volée (esbuild, déjà présent via Vite) et on les exécute pour de vrai — un test qui se
// contenterait de lire le source laisserait passer un motif mal résolu ou une collision non vue.
// Les arguments ffmpeg, eux, viennent du core (JS) et sont vérifiés directement.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');
const Module = require('node:module');

const root = path.join(__dirname, '..');

// `import type` est effacé par esbuild : ces deux modules n'ont aucune autre dépendance.
function loadTs(rel) {
  const src = fs.readFileSync(path.join(root, rel), 'utf8');
  const js = esbuild.transformSync(src, { loader: 'ts', format: 'cjs' }).code;
  const mod = new Module(rel, null);
  mod._compile(js, path.join(root, rel));
  return mod.exports;
}

const naming = loadTs('src/components/upscale/outputNaming.ts');
const imageOut = loadTs('src/components/upscale/imageOutput.ts');
const core = require('../core/imageOutput');

const AT = Date.parse('2026-08-25T10:00:00Z');
const src = (name, extra = {}) => ({ name, path: `S:/rush/${name}`, ...extra });
const TOKENS = { op: 'upscaled', scale: '4x', model: 'anime' };

// ---------------------------------------------------------------- nommage

test('le motif par défaut reproduit le nom historique de chaque op', () => {
  const upscale = naming.resolveOutputName(src('clip.mp4'), 0, naming.DEFAULT_PATTERN, TOKENS, AT);
  assert.equal(upscale, 'clip_upscaled_4x');
  // Un jeton VIDE ne doit pas laisser de séparateur orphelin : « clip_depth_ » serait un nom sale.
  const depth = naming.resolveOutputName(src('clip.mp4'), 0, naming.DEFAULT_PATTERN,
    { op: 'depth', scale: '', model: 'da3-small' }, AT);
  assert.equal(depth, 'clip_depth');
});

test('les jetons couvrent nom, modèle, date et rang', () => {
  const out = naming.resolveOutputName(src('clip.mp4'), 4, '{date}_{name}_{model}_{nnn}', TOKENS, AT);
  assert.match(out, /^\d{4}-\d{2}-\d{2}_clip_anime_005$/);
});

test('un jeton inconnu reste littéral et les caractères interdits sautent', () => {
  const out = naming.resolveOutputName(src('a:b*c.mp4'), 0, '{name}_{nope}', TOKENS, AT);
  assert.equal(out, 'abc_{nope}');
});

test('un média renommé sort du motif partagé', () => {
  const out = naming.resolveOutputName(src('clip.mp4', { outName: 'générique fin' }), 0,
    naming.DEFAULT_PATTERN, TOKENS, AT);
  assert.equal(out, 'générique fin');
});

test('un motif qui ne produit rien retombe sur le nom source', () => {
  assert.equal(naming.resolveOutputName(src('clip.mp4'), 0, '___', TOKENS, AT), 'clip');
});

test('deux sources qui retombent sur le même nom sont signalées nominativement', () => {
  // Même nom de fichier dans deux dossiers : le motif par défaut les fait se télescoper.
  const sources = [
    { name: 'clip.mp4', path: 'S:/a/clip.mp4' },
    { name: 'clip.mov', path: 'S:/b/clip.mov' },
    { name: 'autre.mp4', path: 'S:/a/autre.mp4' },
  ];
  const report = naming.reviewOutputNames(sources, naming.DEFAULT_PATTERN, TOKENS, AT);
  assert.equal(report.problem, 'duplicateOutputNames');
  assert.equal(report.collisions.length, 1);
  assert.deepEqual(report.collisions[0].indexes, [0, 1]);
  assert.equal(report.collisions[0].name, 'clip_upscaled_4x');

  // La réparation en un clic : un compteur dans le motif suffit à les séparer.
  const fixed = naming.reviewOutputNames(sources, naming.numberedPattern(naming.DEFAULT_PATTERN), TOKENS, AT);
  assert.equal(fixed.problem, null);
  assert.deepEqual(fixed.names, ['clip_upscaled_4x_01', 'clip_upscaled_4x_02', 'autre_upscaled_4x_03']);
});

test('la collision est insensible à la casse (le disque l’est aussi)', () => {
  const report = naming.reviewOutputNames(
    [{ name: 'Clip.mp4', path: 'S:/a/Clip.mp4' }, { name: 'clip.mov', path: 'S:/b/clip.mov' }],
    '{name}', TOKENS, AT);
  assert.equal(report.problem, 'duplicateOutputNames');
});

test('numberedPattern n’empile pas deux compteurs', () => {
  assert.equal(naming.numberedPattern('{name}_{nn}'), '{name}_{nn}');
});

// ---------------------------------------------------------------- forme de sortie (renderer)

test('une image fixe sort en image quoi que dise le réglage', () => {
  const settings = { ...imageOut.DEFAULT_IMAGE_OUTPUT, outputKind: 'video' };
  assert.equal(imageOut.outputKindFor(settings, src('photo.png')), 'image');
  assert.equal(imageOut.outputKindFor(settings, src('clip.mp4')), 'video');
  assert.equal(imageOut.outputKindFor({ ...settings, outputKind: 'sequence' }, src('clip.mp4')), 'sequence');
});

test('le GIF animé reste une vidéo (sinon il perdrait toutes ses frames sauf la première)', () => {
  assert.equal(imageOut.isStillSource(src('boucle.gif')), false);
  assert.equal(imageOut.isStillSource(src('photo.JPEG')), true);
});

test('l’aperçu du nom montre le vrai fichier écrit', () => {
  const settings = imageOut.DEFAULT_IMAGE_OUTPUT;
  assert.equal(imageOut.outputSample('clip_upscaled_4x', 'video', settings, 'mkv'), 'clip_upscaled_4x.mkv');
  assert.equal(imageOut.outputSample('clip_upscaled_4x', 'image', settings, 'mp4'), 'clip_upscaled_4x.png');
  // Une séquence part dans SON dossier : des centaines d'images à plat seraient illisibles.
  assert.equal(imageOut.outputSample('clip_upscaled_4x', 'sequence', settings, 'mp4'),
    'clip_upscaled_4x/clip_upscaled_4x_000001.png');
  assert.equal(
    imageOut.outputSample('clip', 'sequence', { ...settings, imageFormat: 'jpeg', seqPadding: 4, seqStart: 1001 }, 'mp4'),
    'clip/clip_1001.jpg');
});

test('un réglage persisté hors bornes est ramené dans le domaine', () => {
  const coerced = imageOut.coerceImageOutput({
    outputKind: 'nawak', imageFormat: 'tiff', pngBits: 32, pngCompression: 99, jpegQuality: -4, seqPadding: 40,
  });
  assert.equal(coerced.outputKind, 'video');
  assert.equal(coerced.imageFormat, 'png');
  assert.equal(coerced.pngBits, 8);
  assert.equal(coerced.pngCompression, 9);
  assert.equal(coerced.jpegQuality, 1);
  assert.equal(coerced.seqPadding, 8);
});

// ---------------------------------------------------------------- arguments ffmpeg (core)

test('le PNG écrit la profondeur demandée, avec ou sans alpha', () => {
  const spec8 = core.imageSpec({ imageFormat: 'png', pngBits: 8, pngCompression: 3 });
  assert.deepEqual(core.imageEncodeArgs(spec8),
    ['-c:v', 'png', '-compression_level', '3', '-pix_fmt', 'rgb24']);
  assert.deepEqual(core.imageEncodeArgs(spec8, { alpha: true }),
    ['-c:v', 'png', '-compression_level', '3', '-pix_fmt', 'rgba']);
  const spec16 = core.imageSpec({ imageFormat: 'png', pngBits: 16 });
  assert.deepEqual(core.imageEncodeArgs(spec16).slice(-2), ['-pix_fmt', 'rgb48be']);
  assert.deepEqual(core.imageEncodeArgs(spec16, { alpha: true }).slice(-2), ['-pix_fmt', 'rgba64be']);
});

test('la qualité JPEG 1..100 se replie sur l’échelle inversée de mjpeg', () => {
  assert.equal(core.jpegQscale(100), 2);
  assert.equal(core.jpegQscale(1), 31);
  assert.ok(core.jpegQscale(92) < core.jpegQscale(60));   // plus de qualité = q plus bas
  const spec = core.imageSpec({ imageFormat: 'jpeg', jpegQuality: 92 });
  assert.deepEqual(core.imageEncodeArgs(spec),
    ['-c:v', 'mjpeg', '-q:v', String(core.jpegQscale(92)), '-pix_fmt', 'yuvj444p']);
});

test('une valeur de sortie inconnue retombe sur la vidéo', () => {
  assert.equal(core.outputKind({}), 'video');
  assert.equal(core.outputKind({ outputKind: 'nawak' }), 'video');
  assert.equal(core.outputKind({ outputKind: 'sequence' }), 'sequence');
  assert.equal(core.outputKind({ outputKind: 'image' }), 'image');
});

test('la séquence part dans son dossier, l’image reste un fichier', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-imgout-'));
  try {
    const spec = core.imageSpec({ imageFormat: 'png', seqPadding: 4, seqStart: 1001 });
    const seq = await core.imageTarget({ outDir: dir, base: 'clip_upscaled_4x', tag: '_plan2', kind: 'sequence', spec });
    assert.equal(seq.dir, path.join(dir, 'clip_upscaled_4x_plan2'));
    assert.ok(fs.existsSync(seq.dir), 'le dossier de la séquence est créé avant le job');
    assert.equal(path.basename(seq.out), 'clip_upscaled_4x_plan2_%04d.png');
    // L'import Media Pool vise le DOSSIER : Resolve n'accepte pas un motif de fichiers.
    assert.equal(seq.imported, seq.dir);

    const one = await core.imageTarget({ outDir: dir, base: 'photo_upscaled_4x', kind: 'image', spec });
    assert.equal(one.out, path.join(dir, 'photo_upscaled_4x.png'));
    assert.equal(one.imported, one.out);
    assert.equal(one.dir, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('une sortie vidéo n’ajoute RIEN à la requête du sidecar', () => {
  const spec = core.imageSpec({});
  assert.deepEqual(core.imagePayload('video', spec), {});
  const payload = core.imagePayload('sequence', spec, { alpha: true });
  assert.equal(payload.out_kind, 'sequence');
  assert.equal(payload.img_format, 'png');
  assert.deepEqual(payload.image_args.slice(-2), ['-pix_fmt', 'rgba']);
});

// ---------------------------------------------------------------- câblage

test('les quatre ops du hub transmettent la sortie image au sidecar', () => {
  const sidecars = fs.readFileSync(path.join(root, 'core', 'sidecars.js'), 'utf8');
  const payloads = sidecars.match(/\.\.\.imagePayload\(kind, spec/g) || [];
  // upscale + interpolation + depth + détourage.
  assert.equal(payloads.length, 4);
  const shader = fs.readFileSync(path.join(root, 'core', 'shaderUpscale.js'), 'utf8');
  assert.match(shader, /imageArgs, single: kind === 'image'/);
});

test('une chaîne force la vidéo à chaque étape (son entrée suivante doit être lisible)', () => {
  const pipeline = fs.readFileSync(path.join(root, 'core', 'pipeline.js'), 'utf8');
  assert.match(pipeline, /outputKind: 'video'/);
});

test('RTX VSR refuse une sortie image au lieu de changer de moteur en douce', () => {
  const turbo = fs.readFileSync(path.join(root, 'core', 'turbo.js'), 'utf8');
  assert.match(turbo, /if \(kind !== 'video'\) return Promise\.resolve\(\{ ok: false, error: t\('rtxVideoOnly'\) \}\)/);
});
