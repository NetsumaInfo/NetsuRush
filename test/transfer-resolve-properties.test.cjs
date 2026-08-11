const test = require('node:test');
const assert = require('node:assert/strict');

const { requestsFor, applyResolveClip, closeEnough } = require('../core/transfer/resolveApply');
const { candidatesFor, locateResolveClip, normalizePath } = require('../core/transfer/resolveLocate');

const clip = (over = {}) => ({
  kind: 'video', track: 2, path: 'C:/A.mov', name: 'a', fps: 25, srcFrames: 100,
  srcIn: 10, srcOut: 33, tlStart: 100, tlEnd: 124, ...over,
});
const placement = { startFrame: 10, endFrame: 33, recordFrame: 1100, trackIndex: 2, mediaType: 1 };

// `sourceEnd` = GetSourceEndFrame, INCLUSIF comme `srcOut` (mesuré sur Resolve 21.0.3).
test('le fingerprint Resolve tient compte du type, de la piste, du chemin et des frames', () => {
  const item = {};
  const snapshots = [
    { item, kind: 'video', track: 2, path: 'c:/a.mov', start: 1100, end: 1124, sourceStart: 10, sourceEnd: 33 },
    { item: {}, kind: 'video', track: 1, path: 'c:/a.mov', start: 1100, end: 1124, sourceStart: 10, sourceEnd: 33 },
  ];
  assert.equal(normalizePath('C:\\A.MOV'), 'c:/a.mov');
  assert.deepEqual(candidatesFor(snapshots, clip(), placement), [snapshots[0]]);
  assert.equal(locateResolveClip(snapshots, clip(), placement).item, item);
});

test('deux candidats identiques sont ambigus, aucun n’est choisi', () => {
  const candidate = { kind: 'video', track: 2, path: 'c:/a.mov', start: 1100, end: 1124, sourceStart: 10, sourceEnd: 33 };
  const found = locateResolveClip([{ ...candidate, item: {} }, { ...candidate, item: {} }], clip(), placement);
  assert.equal(found.ok, false);
  assert.equal(found.reason, 'ambiguousTimelineItem');
});

const transform = {
  position: { value: { x: 20, y: 30 } }, scale: { value: { x: 2, y: 1.5 } },
  anchor: { value: { x: 965, y: 534 } }, rotation: { value: 12 }, opacity: { value: 50 },
  flipX: { value: true }, crop: { left: { value: 4 } },
};

test('les transformations canoniques deviennent les clés Resolve attendues', () => {
  // L'ancrage du document est en pixels SOURCE depuis le coin haut-gauche (convention Premiere/AE) ;
  // Resolve le compte depuis le CENTRE, Y vers le haut.
  const requests = requestsFor(clip({ srcWidth: 1920, srcHeight: 1080, video: { transform } }));
  assert.deepEqual(requests.map((r) => [r.key, r.value]), [
    ['Pan', 20], ['Tilt', -30], ['ZoomX', 2], ['ZoomY', 1.5],
    ['AnchorPointX', 5], ['AnchorPointY', 6], ['RotationAngle', 12], ['Opacity', 50],
    ['FlipX', true], ['CropLeft', 4],
  ]);
});

test('sans dimensions source, l’ancrage n’est pas inventé', () => {
  const keys = requestsFor(clip({ video: { transform } })).map((r) => r.key);
  assert.equal(keys.indexOf('AnchorPointX'), -1);
  assert.equal(keys.indexOf('AnchorPointY'), -1);
  assert.ok(keys.indexOf('Pan') >= 0);
});

test('une propriété ANIMÉE n’est jamais réécrite en valeur fixe lors du contrôle', async () => {
  const values = { Pan: 999 };
  const item = {
    SetProperty: async (key, value) => { values[key] = value; return true; },
    GetProperty: async (key) => values[key],
  };
  const animated = { position: { value: { x: 20, y: 30 }, keyframes: [{ frame: 0, value: { x: 0, y: 0 } }] } };
  const report = await applyResolveClip(item, clip({ video: { transform: animated } }), 0, { mode: 'verify' });
  assert.equal(values.Pan, 999, 'la valeur posée par l’import doit survivre');
  assert.equal(report.find((r) => r.property === 'video.position.keyframes').status, 'applied');
});

test('chaque propriété Resolve est relue et un refus reste visible', async () => {
  const values = {};
  const item = {
    SetProperty: async (key, value) => { if (key === 'Opacity') return false; values[key] = value; return true; },
    GetProperty: async (key) => values[key],
  };
  const report = await applyResolveClip(item, clip({ video: { transform: {
    scale: { value: { x: 2, y: 2 } }, opacity: { value: 40 },
  } } }), 0);
  assert.equal(report.filter((r) => r.status === 'applied').length, 2);
  assert.equal(report.find((r) => r.property === 'video.opacity').status, 'unsupported');
});

test('le readback numérique tolère uniquement les petits écarts', () => {
  assert.equal(closeEnough(1, 1.00001), true);
  assert.equal(closeEnough(1, 1.01), false);
});

// --- valeurs neutres -----------------------------------------------------------------------------

test("une valeur NEUTRE n'est pas écrite sur un plan qu'on vient de poser", async () => {
  // Une ancre centrée vaut 0/0 chez Resolve : l'écrire n'apporte rien et l'expose au refus, ce qui
  // remplissait le rapport de « anchor rejeté » sur des plans parfaitement normaux.
  const written = [];
  const item = {
    SetProperty: (key, value) => { written.push([key, value]); return true; },
    GetProperty: () => 0,
  };
  const clip = {
    kind: 'video', srcWidth: 1920, srcHeight: 1080,
    video: { transform: {
      anchor: { value: { x: 960, y: 540 } },
      scale: { value: { x: 1, y: 1 } },
      opacity: { value: 100 },
      position: { value: { x: 0, y: 0 } },
    } },
  };
  const out = await applyResolveClip(item, clip, 0, { mode: 'write' });
  assert.deepEqual(written, []);
  assert.deepEqual(out, []);
});

test('une valeur qui CHANGE quelque chose est bien écrite', async () => {
  const written = [];
  const item = {
    SetProperty: (key, value) => { written.push([key, value]); return true; },
    GetProperty: (key) => (written.find(([k]) => k === key) || [])[1],
  };
  const clip = {
    kind: 'video', srcWidth: 1920, srcHeight: 1080,
    video: { transform: { scale: { value: { x: 1.5, y: 1.5 } }, opacity: { value: 50 } } },
  };
  const out = await applyResolveClip(item, clip, 0, { mode: 'write' });
  assert.deepEqual(written, [['ZoomX', 1.5], ['ZoomY', 1.5], ['Opacity', 50]]);
  assert.equal(out.every((r) => r.status === 'applied'), true);
});

test('une propriété ANIMÉE reste écrite même à valeur neutre : sa courbe, elle, bouge', async () => {
  const written = [];
  const item = { SetProperty: (key, value) => { written.push([key, value]); return true; }, GetProperty: () => 1 };
  const clip = {
    kind: 'video',
    video: { transform: { scale: { value: { x: 1, y: 1 }, keyframes: [{ frame: 0, value: { x: 1, y: 1 } }, { frame: 10, value: { x: 2, y: 2 } }] } } },
  };
  await applyResolveClip(item, clip, 0, { mode: 'write' });
  assert.deepEqual(written, [['ZoomX', 1], ['ZoomY', 1]]);
});

test('le refus rapporte la VALEUR demandée, pas seulement le nom', async () => {
  const item = { SetProperty: () => false, GetProperty: () => undefined };
  const clip = { kind: 'video', video: { transform: { opacity: { value: 42 } } } };
  const out = await applyResolveClip(item, clip, 0, { mode: 'write' });
  assert.equal(out[0].reason, 'setPropertyRejected');
  assert.equal(out[0].expected, 42);
});
