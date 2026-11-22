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

// GetSourceStartFrame lit parfois UNE image trop tôt (et GetSourceEndFrame avec lui) ; GetLeftOffset
// donne alors la vraie première image. Mesuré sur Resolve Studio 21.1.2 en exportant l'image de la
// timeline (Timeline.ExportFrame) et en la comparant à la source décodée : plan posé 951→964, lu
// ssf=950 sef=964 left=951 ; plan BluRay coupé entre 1928 et 1929, lu ssf=1928 left=1929.
const { correctSourceStart } = require('../core/timeline-insertion');

test('à cadence égale, GetLeftOffset une image plus loin corrige le début, la durée règle la fin', () => {
  // Fin en retard avec le début (sef=964 pour une fin exclusive 965).
  const a = correctSourceStart(950, 964, 951, { sameRate: true });
  assert.deepEqual(a, { ssf: 951, sef: 964 });
  assert.equal(sourceOutFrame(a.ssf, a.sef, 14), 964, 'le plan relu retombe sur 951→964');
  // Fin déjà juste (sef=2034 exclusif) : mesuré sur le plan BluRay, 1929→2033 sur 105 images.
  const b = correctSourceStart(1928, 2034, 1929, { sameRate: true });
  assert.equal(sourceOutFrame(b.ssf, b.sef, 105), 2033);
});

test('GetLeftOffset ne tranche que ce désaccord d’une image', () => {
  // Autre cadence : GetLeftOffset compte des images de TIMELINE (OBS 30 i/s sur 24 : 79 contre 100).
  assert.deepEqual(correctSourceStart(100, 101, 79, { sameRate: false }), { ssf: 100, sef: 101 });
  assert.deepEqual(correctSourceStart(950, 964, 951, { sameRate: false }), { ssf: 950, sef: 964 });
  // Timecode source porté par GetLeftOffset (86313 = 01:00:00:00 à 23.976).
  assert.deepEqual(correctSourceStart(0, 120, 86313, { sameRate: true }), { ssf: 0, sef: 120 });
  // Écart de plusieurs images (dérive connue) : on garde GetSourceStartFrame.
  assert.deepEqual(correctSourceStart(36, 49, 40, { sameRate: true }), { ssf: 36, sef: 49 });
  // Freeze et reverse ne se corrigent pas.
  assert.deepEqual(correctSourceStart(3599, 3599, 3600, { sameRate: true }), { ssf: 3599, sef: 3599 });
  assert.deepEqual(correctSourceStart(60, 20, 61, { sameRate: true }), { ssf: 60, sef: 20 });
  // Au-delà de la dernière image du fichier : pas une position source.
  assert.deepEqual(correctSourceStart(95, 96, 96, { sameRate: true, maxFrame: 95 }), { ssf: 95, sef: 96 });
});

test('la lecture AE applique la correction seulement à cadence égale', async () => {
  const it = item({ ssf: 950, sef: 964, leftOffset: 951 });
  const same = await sourceRange(it, 0, 14, 0, 3771, true);
  assert.equal(same.srcIn, 951);
  assert.equal(same.srcOut, 964);
  assert.equal(same.retimed, false);
  const other = await sourceRange(it, 0, 14, 0, 3771, false);
  assert.equal(other.srcIn, 950);
});
