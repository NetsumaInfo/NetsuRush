// Aimant du board : accrochage d'un rectangle déplacé sur les bords, centres et coins des voisins,
// plus le collage bord à bord. Logique pure — exécutée pour de vrai (transpilée à la volée).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const Module = require('node:module');

const root = path.join(__dirname, '..');
function loadTs(rel) {
  const src = fs.readFileSync(path.join(root, rel), 'utf8');
  const js = esbuild.transformSync(src, { loader: 'ts', format: 'cjs' }).code;
  const mod = new Module(rel, null);
  mod._compile(js, path.join(root, rel));
  return mod.exports;
}

const snap = loadTs('src/components/reference/boardSnap.ts');
const rect = (x, y, w, h) => ({ x, y, w, h });

test('aligns left edges when close enough', () => {
  const res = snap.snapMove(rect(103, 400, 100, 100), [rect(100, 0, 200, 200)], 8);
  assert.equal(res.dx, -3);
  assert.equal(res.dy, 0);
  assert.ok(res.guides.some((g) => g.axis === 'x' && g.at === 100));
});

test('ignores neighbours beyond the threshold', () => {
  const res = snap.snapMove(rect(140, 400, 100, 100), [rect(100, 0, 200, 200)], 8);
  assert.equal(res.dx, 0);
  assert.equal(res.dy, 0);
  assert.equal(res.guides.length, 0);
});

test('sticks edge to edge with no gap', () => {
  // Bord droit du déplacé à 5 px du bord gauche du voisin → il vient le toucher.
  const res = snap.snapMove(rect(0, 0, 95, 100), [rect(100, 0, 100, 100)], 8, 0);
  assert.equal(res.dx, 5);
});

test('honours the stick gap', () => {
  const res = snap.snapMove(rect(0, 0, 95, 100), [rect(100, 0, 100, 100)], 12, 10);
  // Collage à 10 px : le bord droit doit finir à 90.
  assert.equal(res.dx, -5);
});

test('snaps both axes at once — an item drops into a corner', () => {
  const res = snap.snapMove(rect(97, 203, 50, 50), [rect(100, 200, 300, 300)], 8);
  assert.equal(res.dx, 3);
  assert.equal(res.dy, -3);
  assert.equal(res.guides.length, 2);
});

test('centres align too', () => {
  // Centre du déplacé à 402, centre du voisin à 400.
  const res = snap.snapMove(rect(377, 900, 50, 50), [rect(300, 0, 200, 200)], 8);
  assert.equal(res.dx, -2);
});

test('no targets, no snapping', () => {
  const res = snap.snapMove(rect(0, 0, 10, 10), [], 8);
  assert.deepEqual([res.dx, res.dy, res.guides.length], [0, 0, 0]);
});

test('a zero threshold disables the magnet', () => {
  const res = snap.snapMove(rect(101, 0, 100, 100), [rect(100, 0, 100, 100)], 0);
  assert.equal(res.dx, 0);
});

test('snapValue picks the closest candidate only', () => {
  assert.deepEqual(snap.snapValue(100, [96, 140], 8), { value: 96, at: 96 });
  assert.deepEqual(snap.snapValue(100, [140], 8), { value: 100, at: null });
});
