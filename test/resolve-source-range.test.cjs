// Bornes SOURCE d'un plan Resolve : `GetSourceEndFrame` est INCLUSIF.
//
// Mesuré sur Resolve Studio 21.0.3, sur des plans posés ENTIERS et non rognés : un fichier de
// 96 images occupant 96 images de timeline rend `ssf=0, sef=95`. Le lire comme exclusif retirait la
// dernière image de CHAQUE plan et inventait une vitesse de 95/96 sur un plan qui n'est pas retimé —
// de faux retimes partout, et les vrais noyés dedans.
const test = require('node:test');
const assert = require('node:assert/strict');

const { sourceRange } = require('../core/ae/timelineRead');

const item = (values) => ({
  GetSourceStartFrame: async () => values.ssf,
  GetSourceEndFrame: async () => values.sef,
  GetLeftOffset: async () => values.leftOffset,
  GetDuration: async () => values.duration,
});

test('un plan entier non retimé occupe TOUTE sa source, dernière image comprise', async () => {
  // Fichier de 96 images (0..95) posé sur 96 images de timeline.
  const out = await sourceRange(item({ ssf: 0, sef: 95 }), 194, 290, 0, 95);
  assert.equal(out.srcIn, 0);
  assert.equal(out.srcOut, 95);
  assert.equal(out.srcSpan, 96);
  assert.equal(out.retimed, false, 'un plan posé tel quel n’est pas un retime');
});

test('une accélération réelle reste un retime', async () => {
  // 35 images de source (0..34) tenues sur 29 images de timeline.
  const out = await sourceRange(item({ ssf: 0, sef: 34 }), 0, 29, 0, 34);
  assert.equal(out.srcSpan, 35);
  assert.equal(out.retimed, true);
  assert.equal(out.freeze, false);
});

test('un plan inversé couvre la même plage, dans l’autre sens', async () => {
  const out = await sourceRange(item({ ssf: 95, sef: 10 }), 0, 86, 0, 95);
  assert.equal(out.reverse, true);
  assert.equal(out.srcIn, 10);
  assert.equal(out.srcOut, 95);
  assert.equal(out.srcSpan, 86);
});

test('un freeze tient UNE image', async () => {
  const out = await sourceRange(item({ ssf: 42, sef: 42 }), 0, 50, 0, 95);
  assert.equal(out.freeze, true);
  assert.equal(out.srcIn, 42);
  assert.equal(out.srcOut, 42);
  assert.equal(out.srcSpan, 1);
});

test('sans les frames source, le repli GetLeftOffset garde la durée timeline', async () => {
  const out = await sourceRange(item({ ssf: NaN, sef: NaN, leftOffset: 12, duration: 40 }), 100, 140, 0, 500);
  assert.equal(out.srcIn, 12);
  assert.equal(out.srcOut, 51, 'bornes inclusives : 40 images à partir de 12');
  assert.equal(out.srcSpan, 40);
});
