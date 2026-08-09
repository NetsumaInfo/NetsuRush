// Variantes d'en-tête présentées à l'importeur d'un hôte.
//
// Pourquoi : Premiere écrit `<xmeml version="4">` avec un `<!DOCTYPE xmeml>`. L'import MANUEL de
// Resolve accepte ce document — vérifié en production — mais `ImportTimelineFromFile` le refuse
// sans un mot. Un importeur de script plus strict que celui de l'interface est l'explication la
// plus économique, et ces variantes sont la seule façon de la mettre à l'épreuve.

const test = require('node:test');
const assert = require('node:assert');
const { importVariants, declaredVersion, TARGET_VERSION } = require('../core/transfer/xmeml/normalize');

const PREMIERE_HEADER = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!DOCTYPE xmeml>',
  '<xmeml version="4">',
  '\t<sequence id="sequence-24"><name>1</name></sequence>',
  '</xmeml>',
].join('\n');

test('la version déclarée est lue telle quelle', () => {
  assert.equal(declaredVersion(PREMIERE_HEADER), '4');
  assert.equal(declaredVersion('<xmeml version="5">'), '5');
  assert.equal(declaredVersion('pas du xmeml'), null);
});

test("le document d'ORIGINE est toujours essayé en premier", () => {
  // Si l'hôte l'accepte tel quel, rien ne doit être modifié : on ne réécrit pas un montage sur une
  // hypothèse.
  const variants = importVariants(PREMIERE_HEADER);
  assert.equal(variants[0].label, 'source');
  assert.equal(variants[0].text, PREMIERE_HEADER);
});

test('la version et le DOCTYPE sont les deux seules retouches', () => {
  const labels = importVariants(PREMIERE_HEADER).map((v) => v.label);
  assert.deepEqual(labels, ['source', `version ${TARGET_VERSION}`, 'sans DOCTYPE', `version ${TARGET_VERSION} sans DOCTYPE`]);
});

test('les retouches ne touchent QUE l’en-tête', () => {
  for (const variant of importVariants(PREMIERE_HEADER)) {
    assert.match(variant.text, /<sequence id="sequence-24"><name>1<\/name><\/sequence>/);
  }
});

test('la variante de version porte bien la version visée', () => {
  const bumped = importVariants(PREMIERE_HEADER).find((v) => v.label === `version ${TARGET_VERSION}`);
  assert.equal(declaredVersion(bumped.text), TARGET_VERSION);
  assert.match(bumped.text, /<!DOCTYPE xmeml>/);
});

test('la variante sans DOCTYPE le retire sans toucher à la version', () => {
  const stripped = importVariants(PREMIERE_HEADER).find((v) => v.label === 'sans DOCTYPE');
  assert.doesNotMatch(stripped.text, /<!DOCTYPE/);
  assert.equal(declaredVersion(stripped.text), '4');
});

test('un document DÉJÀ conforme ne produit aucun essai supplémentaire', () => {
  // Chaque essai coûte un appel à un hôte modal : une variante identique n'a rien à prouver.
  assert.deepEqual(importVariants('<xmeml version="5"><sequence/></xmeml>').map((v) => v.label), ['source']);
});

test("un document qui n'est pas du xmeml traverse intact", () => {
  const other = '<fcpxml version="1.9"><library/></fcpxml>';
  assert.deepEqual(importVariants(other), [{ label: 'source', text: other }]);
});
