// Nommage des fichiers d'export (core/export/naming.js). Deux choses s'y jouent qui ne se voient
// qu'à l'usage : le gabarit PAR DÉFAUT doit reproduire le nommage historique à l'identique (sinon
// une mise à jour renomme les sorties de tous les profils existants), et deux plans ne doivent
// JAMAIS planifier le même fichier — les plans s'encodent en parallèle, une collision ferait écrire
// deux ffmpeg dans le même fichier au lieu de produire deux exports.
// Couvre aussi le séparateur noir de la fusion (core/export/spacer.js), qui obéit à la même
// contrainte invisible : ses paramètres doivent coller à ceux des plans, sinon la concaténation
// par copie échoue et tout le montage se ré-encode.
const test = require('node:test');
const assert = require('node:assert');

const naming = require('../core/export/naming.js');

const CLIP = { input: 'C:/rushes/ep01 - scene.mkv', start: 12.34, end: 18.5 };
const NEVER = () => false;

/** Planifie un lot dans un dossier vide (aucun fichier préexistant). */
const plan = (clips, opts = {}) => naming.planOutputs(clips, {
  dir: '/out', ext: 'mp4', base: 'export', exists: NEVER, ...opts,
});

test('le gabarit par défaut reproduit le nommage historique', () => {
  const outs = plan([CLIP, CLIP, CLIP]);
  assert.deepStrictEqual(outs, ['/out/export_001.mp4', '/out/export_002.mp4', '/out/export_003.mp4']);
});

test('la fusion perd son index et retombe sur le nom de base', () => {
  // Le fichier fusionné est UNIQUE : le gabarit par défaut doit y rendre `export.mp4` (comportement
  // historique), pas `export_.mp4` ni un numéro qui ne désignerait rien.
  const name = naming.resolveName(undefined, { base: 'export', index: null });
  assert.strictEqual(name, 'export');
});

test('les jetons décrivent le plan', () => {
  const name = naming.resolveName('{source}_{index}_{start}-{end}_{duration}', {
    base: 'export', source: CLIP.input, index: 2, start: CLIP.start, end: CLIP.end,
  });
  assert.strictEqual(name, 'ep01 - scene_002_00-00-12.340-00-00-18.500_6.16s');
});

test('le timecode est à largeur fixe, donc trié dans l ordre chronologique', () => {
  const names = [3600.5, 61, 9.25].map((s) => naming.resolveName('{start}', { base: 'x', start: s }));
  assert.deepStrictEqual([...names].sort(), ['00-00-09.250', '00-01-01.000', '01-00-00.500']);
});

test('la durée annoncée peut différer de l écart entre les bornes (fusion)', () => {
  // La fusion enchaîne des plans de sources différentes : la longueur du fichier est la SOMME des
  // plans, jamais l'écart entre la première et la dernière borne.
  const name = naming.resolveName('{duration}', { base: 'x', start: 10, end: 200, duration: 12.5 });
  assert.strictEqual(name, '12.50s');
});

test('un jeton vide n abandonne pas ses séparateurs', () => {
  // `{label}` est absent la plupart du temps : sans repli des séparateurs on sortait « export__002 ».
  const name = naming.resolveName('{base}_{label}_{index}', { base: 'export', index: 2 });
  assert.strictEqual(name, 'export_002');
});

test('un jeton inconnu reste visible au lieu de disparaître', () => {
  // Une faute de frappe doit se lire dans le nom produit : effacée en silence, elle passerait pour
  // un gabarit qui ne fonctionne pas.
  const name = naming.resolveName('{base}-{sourcename}', { base: 'export' });
  assert.strictEqual(name, 'export-{sourcename}');
});

test('un gabarit qui ne résout rien retombe sur le nom de base', () => {
  assert.strictEqual(naming.resolveName('{label}', { base: 'collection' }), 'collection');
  assert.strictEqual(naming.resolveName('{label}', { base: '' }), 'export');
});

test('les caractères interdits par le système sont neutralisés', () => {
  const name = naming.resolveName('{base}', { base: 'a/b:c*d?e"f<g>h|i' });
  assert.ok(!/[\\/:*?"<>|]/.test(name), `nom encore illégal : ${name}`);
});

test('deux plans qui résolvent le même nom ne se partagent pas un fichier', () => {
  // Le gabarit peut parfaitement ignorer l'index (« {source} ») : sans réservation, les deux plans
  // du même rush s'écriraient l'un sur l'autre — en parallèle, donc avec un résultat indéterminé.
  const outs = plan([CLIP, CLIP], { template: '{source}' });
  assert.deepStrictEqual(outs, ['/out/ep01 - scene.mp4', '/out/ep01 - scene (2).mp4']);
});

test('un fichier déjà sur le disque n est pas écrasé', () => {
  const outs = plan([CLIP], { exists: (p) => p === '/out/export_001.mp4' });
  assert.deepStrictEqual(outs, ['/out/export_001 (2).mp4']);
});

test('la réservation ignore la casse (systèmes de fichiers insensibles)', () => {
  const taken = new Set();
  const first = naming.uniqueOutput('/out', 'Plan', 'mp4', { taken, exists: NEVER });
  const second = naming.uniqueOutput('/out', 'plan', 'mp4', { taken, exists: NEVER });
  assert.strictEqual(first, '/out/Plan.mp4');
  assert.strictEqual(second, '/out/plan (2).mp4');
});

test('le séparateur suit celui du dossier de sortie', () => {
  assert.deepStrictEqual(plan([CLIP], { dir: 'C:\\out' }), ['C:\\out\\export_001.mp4']);
});

// --- Séparateur noir de la fusion (core/export/spacer.js) -------------------------------------
const spacer = require('../core/export/spacer.js');

const SPACER_BASE = {
  seconds: 1, width: 1920, height: 1080, fps: 25,
  audio: { codec: 'aac', channels: 2, sampleRate: 48000 },
  audioMode: 'aac', videoArgs: ['-c:v', 'libx264'], audioArgs: ['-c:a', 'aac'], tagArgs: [],
  out: '/w/spacer.mp4',
};

test('le noir va ENTRE les plans, jamais aux extrémités', () => {
  // Un montage qui s'ouvre ou se termine sur du noir a l'air tronqué : on ne marque que les coupes.
  assert.deepStrictEqual(spacer.interleave(['a', 'b', 'c'], 's'), ['a', 's', 'b', 's', 'c']);
  assert.deepStrictEqual(spacer.interleave(['a'], 's'), ['a']);
  assert.deepStrictEqual(spacer.interleave(['a', 'b'], null), ['a', 'b']);
});

test('le noir reprend les paramètres réels du premier morceau', () => {
  // C'est la condition pour que la concaténation reste en COPIE : le démuxeur `concat` compare les
  // paramètres d'un morceau au suivant et refuse dès qu'ils diffèrent.
  const args = spacer.spacerArgs(SPACER_BASE);
  assert.ok(args.includes('color=c=black:s=1920x1080:r=25:d=1'), args.join(' '));
  assert.ok(args.includes('anullsrc=channel_layout=stereo:sample_rate=48000'), args.join(' '));
  assert.deepStrictEqual(args.slice(-3), ['-c:a', 'aac', '/w/spacer.mp4']);
});

test('des plans sans piste audio donnent un noir sans piste audio', () => {
  // Un silence en trop suffit à faire échouer la copie : le noir doit avoir les MÊMES flux.
  const args = spacer.spacerArgs({ ...SPACER_BASE, audio: null });
  assert.ok(args.includes('-an'));
  assert.ok(!args.some((a) => String(a).startsWith('anullsrc')));
});

test('en mode copie, le silence est encodé dans le codec des plans', () => {
  // « Copier » un flux qu'on vient de générer n'a pas de sens : le silence doit être ENCODÉ, et dans
  // le codec des plans, sinon la concaténation par copie tombe.
  assert.deepStrictEqual(spacer.silenceCodecArgs('copy', 'opus', ['-c:a', 'copy']), ['-c:a', 'libopus']);
  assert.deepStrictEqual(spacer.silenceCodecArgs('copy', 'ac3', ['-c:a', 'copy']), ['-c:a', 'ac3']);
  assert.deepStrictEqual(spacer.silenceCodecArgs('aac_256', 'ac3', ['-c:a', 'aac', '-b:a', '256k']),
    ['-c:a', 'aac', '-b:a', '256k']);
});

test('une disposition de canaux inconnue retombe sur le stéréo', () => {
  assert.strictEqual(spacer.channelLayout(1), 'mono');
  assert.strictEqual(spacer.channelLayout(6), '5.1');
  assert.strictEqual(spacer.channelLayout(3), 'stereo');
});

test('l aperçu de l éditeur emploie le résolveur de l export', () => {
  // L'aperçu passe par le core PRÉCISÉMENT pour ne pas pouvoir diverger du fichier écrit.
  const { previewName } = require('../core/export.js');
  const profile = { workflow: 'video_remux', container: 'mkv', name: 'Copie', codec: 'h264_high' };
  const preview = previewName({ profile });
  assert.strictEqual(preview.name, 'export_001.mkv');
  assert.strictEqual(preview.merged, 'export.mkv');
  assert.deepStrictEqual(preview.tokens, naming.NAMING_TOKENS);
  assert.strictEqual(previewName({ profile: { ...profile, naming: '{codec}' } }).name, 'copy.mkv');
});
