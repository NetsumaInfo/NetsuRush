// Voie d'écriture Resolve : import natif du fichier d'échange, ou pose plan par plan.
// L'importeur de Resolve applique lui-même les images clés, les niveaux audio et la vitesse ;
// la pose par l'API ne le peut pas. Choisir la mauvaise voie change silencieusement le résultat.

const test = require('node:test');
const assert = require('node:assert');
const { importOptions } = require('../core/transfer/importResolve');

function doc(paths) {
  return {
    ok: true, host: 'ppro', timeline: 'Montage', fps: 25, width: 1920, height: 1080,
    startFrame: 0, endFrame: 100, missing: [],
    clips: paths.map((path, index) => ({
      kind: 'video', track: 1, path, name: 'c' + index, fps: 25, srcFrames: 0,
      srcIn: 0, srcOut: 9, tlStart: index * 10, tlEnd: index * 10 + 10,
    })),
  };
}

test("l'import vise un nom de timeline et réclame les sources", () => {
  const options = importOptions('Montage 2', doc(['C:/rush/a.mov']));
  assert.equal(options.timelineName, 'Montage 2');
  assert.equal(options.importSourceClips, true);
});

test('un dossier source UNIQUE est proposé en repli de recherche', () => {
  const options = importOptions('T', doc(['C:/rush/a.mov', 'C:/rush/b.mov']));
  assert.equal(options.sourceClipsPath, 'C:/rush');
});

test('des dossiers MULTIPLES ne donnent aucun repli : les chemins du XML font foi', () => {
  // L'API n'accepte qu'une racine ; en imposer une seule enverrait Resolve chercher les autres
  // médias au mauvais endroit.
  const options = importOptions('T', doc(['C:/rush/a.mov', 'D:/autre/b.mov']));
  assert.equal(options.sourceClipsPath, undefined);
});

test('les antislashs Windows sont reconnus comme séparateurs', () => {
  const options = importOptions('T', doc(['C:\\rush\\a.mov', 'C:\\rush\\b.mov']));
  assert.equal(options.sourceClipsPath, 'C:\\rush');
});

test('un document sans plan ne propose aucun repli', () => {
  assert.equal(importOptions('T', doc([])).sourceClipsPath, undefined);
});
