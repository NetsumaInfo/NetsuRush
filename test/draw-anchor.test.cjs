// Liaison des tracés aux médias : accrochage automatique en fin de tracé, résolution des
// coordonnées depuis la géométrie courante de l'item, déliaison, item disparu.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const Module = require('node:module');

const root = path.join(__dirname, '..');
const files = new Map();

// Résolution maison des imports relatifs entre modules du board (chaîne courte et connue), avec
// neutralisation de `referenceShared` (types seulement à l'exécution).
function loadTs(rel, prelude = '') {
  if (files.has(rel)) return files.get(rel);
  const abs = path.join(root, rel);
  const src = fs.readFileSync(abs, 'utf8').replace(/^import[^;]*from\s+"\.\/referenceShared";$/gm, '');
  const js = esbuild.transformSync(prelude + src, { loader: 'ts', format: 'cjs' }).code;
  const mod = new Module(rel, null);
  mod.require = (id) => {
    if (id.startsWith('./')) return loadTs(path.posix.join(path.posix.dirname(rel.replace(/\\/g, '/')), `${id.slice(2)}.ts`));
    return require(id);
  };
  mod._compile(js, abs);
  files.set(rel, mod.exports);
  return mod.exports;
}

const anchor = loadTs('src/components/reference/drawAnchor.ts', 'const MIN_SIZE = 48;\n');

const item = (over) => ({ id: 'img', kind: 'image', x: 0, y: 0, w: 200, h: 100, rotation: 0, z: 1, ...over });
const arrow = (p) => ({ id: 's1', t: 'arrow', c: '#fff', w: 2, p });

test('an arrow drawn between two images is held by both ends', () => {
  const a = item({ id: 'a', x: 0, y: 0, w: 100, h: 100 });
  const b = item({ id: 'b', x: 400, y: 0, w: 100, h: 100 });
  const shape = anchor.attachShape(arrow([50, 50, 450, 50]), [a, b]);
  assert.equal(shape.a1.id, 'a');
  assert.equal(shape.a2.id, 'b');
  assert.equal(anchor.anchorCount(shape), 2);

  // L'image d'arrivée part 200 px plus bas : la flèche la suit.
  const moved = { ...b, y: 200 };
  const solved = anchor.resolveShape(shape, anchor.indexItems([a, moved]));
  assert.deepEqual(solved.p.slice(0, 2), [50, 50]);
  assert.ok(Math.abs(solved.p[2] - 450) < 1e-9);
  assert.ok(Math.abs(solved.p[3] - 250) < 1e-9);
});

test('a stroke drawn over an image belongs to it and follows rotation and resize', () => {
  const img = item({ x: 0, y: 0, w: 200, h: 100 });
  const pen = { id: 'p1', t: 'pen', c: '#fff', w: 2, p: [50, 25, 150, 75] };
  const owned = anchor.attachShape(pen, [img]);
  assert.equal(owned.own, 'img');
  assert.equal(owned.ownPts.length, 4);

  // Image agrandie ×2 : le tracé s'étire avec elle.
  const bigger = { ...img, w: 400, h: 200 };
  const scaled = anchor.resolveShape(owned, anchor.indexItems([bigger]));
  assert.ok(Math.abs(scaled.p[0] - 100) < 1e-9);
  assert.ok(Math.abs(scaled.p[1] - 50) < 1e-9);

  // Image tournée à 180° : le tracé tourne avec elle (le point passe de l'autre côté du centre).
  const turned = { ...img, rotation: 180 };
  const rotated = anchor.resolveShape(owned, anchor.indexItems([turned]));
  assert.ok(Math.abs(rotated.p[0] - 150) < 1e-9);
  assert.ok(Math.abs(rotated.p[1] - 75) < 1e-9);
});

test('a stroke mostly outside an image stays free', () => {
  const img = item({ x: 0, y: 0, w: 100, h: 100 });
  const pen = { id: 'p2', t: 'pen', c: '#fff', w: 2, p: [80, 80, 400, 400] };
  const free = anchor.attachShape(pen, [img]);
  assert.equal(free.own, undefined);
  assert.equal(anchor.anchorCount(free), 0);
});

test('a deleted item leaves the shape where it was, never a ghost', () => {
  const a = item({ id: 'a', x: 0, y: 0, w: 100, h: 100 });
  const b = item({ id: 'b', x: 400, y: 0, w: 100, h: 100 });
  const shape = anchor.attachShape(arrow([50, 50, 450, 50]), [a, b]);
  const solved = anchor.resolveShape(shape, anchor.indexItems([a])); // « b » supprimé
  assert.deepEqual(solved.p, [50, 50, 450, 50]);
});

test('unlinking freezes the shape at its displayed position', () => {
  const img = item({ x: 0, y: 0, w: 200, h: 100 });
  const owned = anchor.attachShape({ id: 'p3', t: 'pen', c: '#fff', w: 2, p: [50, 25, 150, 75] }, [img]);
  const moved = { ...img, x: 1000 };
  const free = anchor.detachShape(owned, anchor.indexItems([moved]));
  assert.equal(free.own, undefined);
  assert.equal(free.ownPts, undefined);
  assert.ok(Math.abs(free.p[0] - 1050) < 1e-9);
});

test('resolveShapes returns the same array when nothing is linked', () => {
  const shapes = [{ id: 'x', t: 'pen', c: '#fff', w: 1, p: [0, 0, 1, 1] }];
  assert.equal(anchor.resolveShapes(shapes, []), shapes);
});
