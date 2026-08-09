// L'allowlist de NetsuBridge vit côté renderer (TypeScript), les tables ffmpeg côté core : rien ne
// relie les deux à la compilation. Un codec ajouté à l'allowlist sans entrée dans la table d'encodage
// partirait donc en repli silencieux (h264_high pour la vidéo, AAC pour le son) au lieu d'échouer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { listAudioModes, listCodecs } = require('../core/export/encodeArgs');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'components', 'transfer', 'transferEncoding.ts'),
  'utf8',
);

/** Valeurs littérales d'un `new Set<…>([...])` nommé dans transferEncoding.ts. */
function setMembers(name) {
  const block = new RegExp(`${name}[^=]*=\\s*new Set<[^>]+>\\(\\[([^\\]]*)\\]`).exec(SOURCE);
  assert.ok(block, `${name} introuvable dans transferEncoding.ts`);
  return block[1].match(/"([^"]+)"/g).map((s) => s.slice(1, -1));
}

const codecs = setMembers('NLE_CODECS');
const containers = setMembers('NLE_CONTAINERS');
const audio = setMembers('NLE_AUDIO');

test('every transferable codec has real ffmpeg arguments', () => {
  const known = new Set(listCodecs());
  for (const codec of codecs) assert.ok(known.has(codec), `${codec} absent de la table d'encodage`);
});

test('every transferable audio mode has real ffmpeg arguments', () => {
  const known = new Set(listAudioModes());
  for (const mode of audio) assert.ok(known.has(mode), `${mode} absent de la table audio`);
});

test('excludes the codecs no editing application imports', () => {
  // AV1, VP9 et FFV1 sont des formats de diffusion ou d'archivage, jamais de montage.
  for (const codec of codecs) {
    assert.ok(!/^(av1_|vp9|ffv1)/.test(codec), `${codec} n'est pas un codec de montage`);
  }
  // Opus n'est pas muxé en MOV ; MP3, FLAC et ALAC ne sont pas importés par Premiere Pro.
  for (const mode of audio) {
    assert.ok(!/^(opus|mp3|flac|alac)/.test(mode), `${mode} n'est pas lu par les logiciels de montage`);
  }
  // Ni Premiere ni After Effects n'ouvrent le conteneur Matroska, ni WebM.
  assert.deepEqual([...containers].sort(), ['mov', 'mp4']);
});
