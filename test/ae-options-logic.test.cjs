// Le panneau d'options AE décide de ce qu'il DEMANDE (dossier de sortie, codec, conteneur) à partir
// d'une table côté renderer, alors que le refus, lui, tombe côté core. Rien ne relie les deux à la
// compilation : quand ils divergent, le panneau réclame un dossier sans raison, ou laisse partir un
// export que le core refuse. Ces tests tiennent les deux bouts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { audioOut } = require('../core/ae/codecs');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
const AE_SHARED = read('src', 'components', 'ae', 'aeShared.tsx');
const AE_HOOK = read('src', 'components', 'ae', 'useAeExport.ts');
const AE_CORE = read('core', 'aeExport.js');

test('un conteneur audio ne reçoit que le codec qu il sait porter', () => {
  // L'AIFF n'accepte pas le PCM little-endian : le muxeur refusait le fichier après le transcode.
  assert.deepEqual(audioOut('pcm', 192, 'aiff'), { ext: 'aiff', args: ['-c:a', 'pcm_s16be'] });
  assert.deepEqual(audioOut('pcm', 192, 'wav'), { ext: 'wav', args: ['-c:a', 'pcm_s16le'] });
  assert.deepEqual(audioOut('aac', 256, 'm4a'), { ext: 'm4a', args: ['-c:a', 'aac', '-b:a', '256k'] });
  assert.deepEqual(audioOut('remux', 192, 'm4a'), { ext: 'm4a', args: ['-c:a', 'copy'] });
});

test('le panneau propose les seuls conteneurs que le codec accepte', () => {
  const fn = /export function videoContainersFor[\s\S]*?\n}/.exec(AE_SHARED);
  assert.ok(fn, 'videoContainersFor introuvable');
  // Le remux recopie le flux source : le codec choisi ne s'y applique pas, MP4 reste ouvert.
  assert.match(fn[0], /videoMode === "remux"\) return \["mov", "mp4"\]/);
  // Sur un réencode, ProRes et DNxHR n'existent qu'en MOV : les offrir en MP4 = couple refusé.
  assert.match(fn[0], /"prores"[\s\S]*"dnxhr"[\s\S]*\["mov"\]/);
});

test('le mode de timeline imbriquée par défaut est le même des deux côtés', () => {
  const ui = /useState<AeNestedMode>\("(\w+)"\)/.exec(AE_HOOK);
  const core = /nestedMode = '(\w+)'/.exec(AE_CORE);
  assert.ok(ui && core, 'défaut de nestedMode introuvable');
  // `render` fait rendre chaque timeline imbriquée par Resolve, donc exige un dossier de sortie :
  // par défaut d'un seul côté, le panneau le réclamait dès l'ouverture sans qu'aucun réglage l'exige.
  assert.equal(ui[1], core[1]);
});

test('tout ce qui écrit sur le disque figure dans la table des motifs', () => {
  const fn = /aeOutputReasons[\s\S]*?\n}/.exec(AE_SHARED);
  assert.ok(fn, 'aeOutputReasons introuvable');
  for (const reason of ['reencode', 'remux', 'bake', 'nestedRender', 'audio']) {
    assert.match(fn[0], new RegExp(`"${reason}"`), `motif ${reason} absent`);
  }
  // Le core impose le réencode dès que la vitesse est cuite — ou qu'on agrandit, qui remplace les
  // pixels. Sans `bake` dans la table, le dossier n'était réclamé nulle part et le refus ne tombait
  // qu'au lancement de l'export.
  assert.match(AE_CORE, /const vMode = \(bake \|\| grow\) \? 'reencode' : videoMode;/);
});
