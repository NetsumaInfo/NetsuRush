// Voie du transfert Resolve → Premiere : pose par script (défaut) ou import natif du fichier
// d'échange (sur demande).
//
// L'import applique bien images clés et vitesse lui-même, mais l'importeur de Premiere crée SES
// PROPRES éléments de projet — les mêmes rushs réapparaissent en double — et le titre qu'il pose est
// un générateur FCP7 hérité, dont ni le corps ni le multi-ligne ne suivent. La pose par script fait
// mieux sur les trois depuis qu'elle pose les titres par `.mogrt`.
const test = require('node:test');
const assert = require('node:assert/strict');

const { canImportToPremiere, adobePayload } = require('../core/transfer');

test('par défaut, Resolve → Premiere passe par la pose par script', () => {
  assert.equal(canImportToPremiere('resolve', {}), false);
  assert.equal(canImportToPremiere('resolve', { mode: 'new', mediaMode: 'copy' }), false);
});

test('l’import natif se demande explicitement', () => {
  assert.equal(canImportToPremiere('resolve', { vehicle: 'import' }), true);
});

test('même demandé, l’import cède quand il ne sait pas faire', () => {
  // Il crée toujours une séquence neuve et suit les chemins écrits dans le XML.
  const asked = (over) => canImportToPremiere('resolve', { vehicle: 'import', ...over });
  assert.equal(asked({ mode: 'append' }), false);
  assert.equal(asked({ target: 'Séquence 01' }), false);
  assert.equal(asked({ videoOnly: true }), false);
  assert.equal(asked({ mediaMode: 'reencode' }), false);
  assert.equal(asked({ mediaMode: 'remux' }), false);
});

test('seule une source Resolve a un fichier d’échange à faire importer', () => {
  // Une séquence Premiere ne se ré-importe pas dans Premiere, et After Effects n'exporte pas de XML.
  assert.equal(canImportToPremiere('aeft', { vehicle: 'import' }), false);
  assert.equal(canImportToPremiere('ppro', { vehicle: 'import' }), false);
});

test('les titres partent dans la charge utile, en secondes, avec le modèle', () => {
  const doc = {
    fps: 25, clips: [], endFrame: 290,
    graphics: [{ track: 3, name: 'Text', text: 'test beta\nyes', font: 'Tahoma', size: 298, tlStart: 165, tlEnd: 290 }],
  };
  const payload = adobePayload(doc, { name: 'T', mogrt: 'C:/panneau/assets/netsurush-title.mogrt' });

  assert.equal(payload.mogrt, 'C:/panneau/assets/netsurush-title.mogrt');
  assert.deepEqual(payload.graphics, [{
    track: 3, name: 'Text', text: 'test beta\nyes', font: 'Tahoma', size: 298, tlStart: 6.6, tlEnd: 11.6,
  }]);
});
