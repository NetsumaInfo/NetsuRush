// Unités de la trajectoire Premiere. Le jsx est chargé POUR DE VRAI dans un contexte `vm` : une
// regex sur le source ne prouverait pas que la conversion est juste.
//
// Pourquoi ce test existe : Premiere compte sa trajectoire en FRACTION de l'image (0 = bord
// gauche/haut, 1 = bord droit/bas), pas en pixels. Traitée comme des pixels, une position centrée
// (0,5 ; 0,5) devenait (−959,5 ; −539,5) — le plan partait hors cadre, et le symptôme observé
// était « les transformations sont excessives », jamais « les unités sont fausses ».

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadPproHost() {
  const context = {
    app: { project: null },
    $: {},
    File: function () { return { exists: false }; },
    BridgeTalk: { appName: 'premierepro' },
    Time: function () {},
    qe: undefined,
    console,
    NRJSON: { stringify: JSON.stringify },
  };
  vm.createContext(context);
  const file = path.join(__dirname, '..', 'adobe-cep', 'jsx', 'host-ppro.jsx');
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: 'host-ppro.jsx' });
  return context;
}

const HOST = loadPproHost();
const FRAME = { width: 1920, height: 1080 };

test('le centre de Premiere est le zéro du document', () => {
  assert.deepEqual(HOST.nrPproPointToPixels([0.5, 0.5], FRAME), { x: 0, y: 0 });
});

test('les bords deviennent la demi-image en pixels, signés depuis le centre', () => {
  assert.deepEqual(HOST.nrPproPointToPixels([0, 0], FRAME), { x: -960, y: -540 });
  assert.deepEqual(HOST.nrPproPointToPixels([1, 1], FRAME), { x: 960, y: 540 });
});

test('un quart vers la droite vaut un quart de largeur', () => {
  assert.deepEqual(HOST.nrPproPointToPixels([0.75, 0.5], FRAME), { x: 480, y: 0 });
});

test("l'aller-retour rend la valeur d'origine", () => {
  for (const point of [[0.5, 0.5], [0, 0], [1, 1], [0.75, 0.25]]) {
    const pixels = HOST.nrPproPointToPixels(point, FRAME);
    assert.deepEqual(HOST.nrPproPointFromPixels(pixels, FRAME), point);
  }
});

test('une valeur illisible vaut le centre, jamais NaN', () => {
  // Un NaN posé chez la cible y reste et ne se voit qu'à l'écran.
  assert.deepEqual(HOST.nrPproPointToPixels(null, FRAME), { x: 0, y: 0 });
  assert.deepEqual(HOST.nrPproPointFromPixels(undefined, FRAME), [0.5, 0.5]);
});

test('une séquence sans dimensions retombe sur 1080p au lieu de diviser par zéro', () => {
  assert.deepEqual(HOST.nrPproFrameSize({}), { width: 1920, height: 1080 });
  assert.deepEqual(HOST.nrPproFrameSize({ frameSizeHorizontal: 0, frameSizeVertical: 0 }), { width: 1920, height: 1080 });
  assert.deepEqual(HOST.nrPproFrameSize({ frameSizeHorizontal: 3840, frameSizeVertical: 2160 }), { width: 3840, height: 2160 });
});

test('la conversion suit la taille RÉELLE de la séquence, pas une constante', () => {
  const uhd = { width: 3840, height: 2160 };
  assert.deepEqual(HOST.nrPproPointToPixels([0, 0], uhd), { x: -1920, y: -1080 });
});

// --- niveau audio --------------------------------------------------------------------------------

test("le paramètre « Niveau » de Premiere n'est PAS en décibels", () => {
  // Valeurs RÉELLEMENT observées dans un projet : envoyées telles quelles comme gain, elles
  // valaient 0,02 dB au lieu de −18 dB, soit un fondu qui ne se voyait nulle part.
  assert.ok(Math.abs(HOST.nrPproLevelToDb(0.02157769352198) - -18.32) < 0.01);
  assert.ok(Math.abs(HOST.nrPproLevelToDb(0.08184082061052) - -6.74) < 0.01);
});

test('le niveau UNITÉ correspond au décalage de 15 dB du fader', () => {
  // 0 dB n'est pas 1,0 : le fader de Premiere monte jusqu'à +15 dB, d'où le décalage.
  assert.ok(Math.abs(HOST.nrPproLevelToDb(1) - 15) < 1e-9);
  assert.ok(Math.abs(HOST.nrPproDbToLevel(0) - Math.pow(10, -0.75)) < 1e-9);
});

test('la conversion fait un aller-retour fidèle', () => {
  for (const db of [0, -6, -18.32, 6, 15]) {
    assert.ok(Math.abs(HOST.nrPproLevelToDb(HOST.nrPproDbToLevel(db)) - db) < 1e-9, `${db} dB`);
  }
});

test('le silence ne devient pas −∞ : aucun format ne le transporte', () => {
  assert.equal(HOST.nrPproLevelToDb(0), -96);
  assert.equal(HOST.nrPproLevelToDb(-1), -96);
  assert.equal(HOST.nrPproDbToLevel('abc'), 0);
});
