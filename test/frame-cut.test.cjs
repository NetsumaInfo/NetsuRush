// encodeCutBounds : bornes frame-exactes d'un ré-encodage. Le seek recule d'un quart de frame (un
// pts arrondi sous la borne jetait la première frame) et la fin est bornée en NOMBRE DE FRAMES (une
// borne en durée retombe sur l'arrondi du paquet limite et sort une frame en trop).
const test = require('node:test');
const assert = require('node:assert');
const { encodeCutBounds } = require('../core/export/frameCut');

test('le seek recule d\'un quart de frame et la vidéo est bornée en frames', () => {
  const b = encodeCutBounds(10, 12, 24);
  assert.ok(b);
  assert.ok(Math.abs(b.ss - (10 - 0.25 / 24)) < 1e-9);
  assert.strictEqual(b.vframes, 48);
  assert.ok(Math.abs(b.duration - (12 - b.ss)) < 1e-9);
});

test('le quart de frame ne franchit jamais la frame précédente', () => {
  const fps = 24000 / 1001;
  for (const frame of [1, 2, 25, 12000, 124284]) {
    const b = encodeCutBounds(frame / fps, (frame + 7) / fps, fps);
    assert.ok(b.ss > (frame - 1) / fps, `frame ${frame} : le seek attrape la frame précédente`);
    assert.ok(b.ss < frame / fps, `frame ${frame} : le seek ne protège pas de l'arrondi`);
    assert.strictEqual(b.vframes, 7);
  }
});

test('un plan d\'une seule frame reste à une frame', () => {
  const fps = 24000 / 1001;
  assert.strictEqual(encodeCutBounds(100 / fps, 101 / fps, fps).vframes, 1);
});

test('le seek ne passe jamais avant le début du fichier', () => {
  assert.strictEqual(encodeCutBounds(0, 1, 24).ss, 0);
});

test('fps inconnu ou bornes inversées → null (l\'appelant garde l\'ancien -ss/-t)', () => {
  assert.strictEqual(encodeCutBounds(10, 12, 0), null);
  assert.strictEqual(encodeCutBounds(12, 10, 24), null);
  assert.strictEqual(encodeCutBounds(10, 10, 24), null);
});
