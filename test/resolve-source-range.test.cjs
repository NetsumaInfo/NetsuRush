// Bornes SOURCE d'un plan Resolve : `GetSourceEndFrame` est une fin EXCLUSIVE plafonnée à la dernière
// image du fichier. Mesuré sur Resolve Studio 21.1.2 (MKV de 34072 images) : une plage posée 0→95
// rend sef=95 pour 95 images, un clip entier rend sef=34071 pour 34072 images — et un fichier entier
// de 96 images sef=95, la mesure qui l'avait fait croire inclusif. La durée timeline tranche.
const test = require('node:test');
const assert = require('node:assert/strict');

const { sourceRange } = require('../core/ae/timelineRead');
const { sourceOutFrame } = require('../core/timeline-insertion');

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

test('un plan posé avec des bornes lit sef comme une fin exclusive', async () => {
  // AppendToTimeline 494→548 : 54 images, la dernière montrée est la 547.
  const out = await sourceRange(item({ ssf: 494, sef: 548 }), 0, 54, 0, 34071);
  assert.equal(out.srcIn, 494);
  assert.equal(out.srcOut, 547);
  assert.equal(out.srcSpan, 54);
  assert.equal(out.retimed, false);
});

test('un plan qui s’arrête juste avant la dernière image ne la récupère pas', () => {
  // 34000→34071 posé : 71 images, sef=34071 = dernière image du fichier, mais exclusive ici.
  assert.equal(sourceOutFrame(34000, 34071, 71, 34071), 34070);
  // Le même sef, plafonné, pour un plan qui va jusqu'au bout : 72 images.
  assert.equal(sourceOutFrame(34000, 34071, 72, 34071), 34071);
});
