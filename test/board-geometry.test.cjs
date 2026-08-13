// Géométrie pure du board de référence : emprise d'un item tourné, repère normalisé (ancres de
// dessin), uniformisation de taille et rangement (packing, grille, ligne, colonne).
//
// Ces fonctions sont du TypeScript sans dépendance runtime : on les transpile à la volée (esbuild,
// déjà présent via Vite) et on les exécute pour de vrai. Un test qui ne ferait que lire le source
// laisserait passer une erreur de signe ou un facteur d'échelle faux.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const Module = require('node:module');

const root = path.join(__dirname, '..');

// Charge un module TS du board en neutralisant ses imports de `referenceShared` (qui tirerait tout
// le pont applicatif). Les constantes réellement utilisées sont réinjectées.
function loadTs(rel, prelude = '') {
  const src = fs.readFileSync(path.join(root, rel), 'utf8')
    .replace(/^import[^;]*from\s+"\.\/referenceShared";$/gm, '');
  const js = esbuild.transformSync(prelude + src, { loader: 'ts', format: 'cjs' }).code;
  const mod = new Module(rel, null);
  mod._compile(js, path.join(root, rel));
  return mod.exports;
}

const arrange = loadTs('src/components/reference/boardArrange.ts', 'const MIN_SIZE = 48;\n');

const box = (id, x, y, w, h, rotation = 0) => ({ id, x, y, w, h, rotation });

test('rotatedBBox measures the real footprint and keeps the centre', () => {
  const square = box('a', 0, 0, 100, 100, 45);
  const b = arrange.rotatedBBox(square);
  // Un carré de 100 tourné à 45° occupe 100·√2 sur les deux axes, autour du même centre.
  assert.ok(Math.abs(b.w - 100 * Math.SQRT2) < 0.001);
  assert.ok(Math.abs(b.h - 100 * Math.SQRT2) < 0.001);
  assert.equal(b.cx, 50);
  assert.equal(b.cy, 50);

  const flat = arrange.rotatedBBox(box('b', 10, 20, 200, 50));
  assert.deepEqual([flat.x, flat.y, flat.w, flat.h], [10, 20, 200, 50]);
});

test('item space survives rotation and mirrors', () => {
  const item = { x: 100, y: 50, w: 200, h: 80, rotation: 37, flipH: true, flipV: false };
  for (const [fx, fy] of [[0, 0], [1, 1], [0.25, 0.75], [0.5, 0.5]]) {
    const world = arrange.fromItemSpace(item, fx, fy);
    const back = arrange.toItemSpace(item, world.x, world.y);
    assert.ok(Math.abs(back.fx - fx) < 1e-9, `fx ${back.fx} ≠ ${fx}`);
    assert.ok(Math.abs(back.fy - fy) < 1e-9, `fy ${back.fy} ≠ ${fy}`);
  }
  // Le centre normalisé est le centre géométrique, quelles que soient rotation et miroirs.
  const centre = arrange.fromItemSpace(item, 0.5, 0.5);
  assert.ok(Math.abs(centre.x - 200) < 1e-9);
  assert.ok(Math.abs(centre.y - 90) < 1e-9);
});

test('normalize equalises height without moving anything', () => {
  const sel = [box('a', 0, 0, 100, 100), box('b', 500, 0, 200, 400)];
  const out = arrange.computeNormalize(sel, 'height');
  assert.equal(out.size, 2);
  const a = out.get('a');
  const b = out.get('b');
  // Moyenne des hauteurs = 250 → les deux items la partagent.
  assert.ok(Math.abs(a.h - 250) < 1e-9);
  assert.ok(Math.abs(b.h - 250) < 1e-9);
  // Ratio conservé, centre conservé.
  assert.ok(Math.abs(a.w / a.h - 1) < 1e-9);
  assert.ok(Math.abs(b.w / b.h - 0.5) < 1e-9);
  assert.ok(Math.abs(a.x + a.w / 2 - 50) < 1e-9);
  assert.ok(Math.abs(b.y + b.h / 2 - 200) < 1e-9);
});

test('normalize by area equalises surfaces', () => {
  const sel = [box('a', 0, 0, 100, 100), box('b', 0, 0, 300, 300)];
  const out = arrange.computeNormalize(sel, 'area');
  const a = out.get('a');
  const b = out.get('b');
  assert.ok(Math.abs(a.w * a.h - b.w * b.h) < 1e-6);
});

test('normalize needs at least two items', () => {
  assert.equal(arrange.computeNormalize([box('a', 0, 0, 10, 10)], 'width').size, 0);
});

test('packing leaves no overlap and honours the gap', () => {
  const sel = [
    box('a', 0, 0, 200, 120), box('b', 900, 40, 160, 160),
    box('c', 300, 700, 300, 90), box('d', -400, 200, 120, 240),
    box('e', 50, 50, 220, 220),
  ];
  const gap = 20;
  const pos = arrange.computeArrange(sel, 'pack', { gap });
  assert.equal(pos.size, sel.length);

  const placed = sel.map((it) => ({ ...it, ...pos.get(it.id) }));
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const A = placed[i];
      const B = placed[j];
      const overlapX = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x);
      const overlapY = Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y);
      assert.ok(overlapX <= 1e-9 || overlapY <= 1e-9, `${A.id} chevauche ${B.id}`);
    }
  }
});

test('row and column order by name when asked', () => {
  const sel = [
    { ...box('x', 0, 0, 100, 100), ref: 'C:/rushes/shot_10.png' },
    { ...box('y', 0, 0, 100, 100), ref: 'C:/rushes/shot_2.png' },
    { ...box('z', 0, 0, 100, 100), ref: 'C:/rushes/shot_1.png' },
  ];
  const pos = arrange.computeArrange(sel, 'row', { gap: 10, sort: 'name' });
  const order = [...pos.entries()].sort((a, b) => a[1].x - b[1].x).map(([id]) => id);
  // Tri NATUREL : shot_2 avant shot_10, sinon la planche sort dans l'ordre lexicographique.
  assert.deepEqual(order, ['z', 'y', 'x']);
});

test('arranging keeps the selection centred where it was', () => {
  const sel = [box('a', 0, 0, 100, 100), box('b', 400, 300, 100, 100)];
  const before = arrange.boundsOf(sel);
  const pos = arrange.computeArrange(sel, 'grid', { gap: 0 });
  const after = arrange.boundsOf(sel.map((it) => ({ ...it, ...pos.get(it.id) })));
  const cx = (b) => b.x + b.w / 2;
  const cy = (b) => b.y + b.h / 2;
  assert.ok(Math.abs(cx(before) - cx(after)) < 1e-6);
  assert.ok(Math.abs(cy(before) - cy(after)) < 1e-6);
});
