// Choix du niveau de détail d'une image du board : quand une vignette remplace la source pleine.
// Le critère décide de la mémoire consommée par une planche entière — une condition inversée et
// c'est soit trente bitmaps pleine définition gardés en vie, soit une planche floue au zoom.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const Module = require('node:module');

const root = path.join(__dirname, '..');
const rel = 'src/components/reference/boardImageLod.ts';
// Le module tire React, le pont et le store : on ne garde que la décision pure.
const src = fs.readFileSync(path.join(root, rel), 'utf8')
  .replace(/^import[^;]*;$/gm, '')
  .replace(/export function useImageLod[\s\S]*$/m, '');
const js = esbuild.transformSync(src, { loader: 'ts', format: 'cjs' }).code;
const mod = new Module(rel, null);
mod._compile(js, path.join(root, rel));
const { lodEligible } = mod.exports;

const img = (over = {}) => ({ kind: 'image', ref: 'C:/rushes/a.png', w: 200, natW: 1920, ...over });

test('a large source shown small goes through its thumbnail', () => {
  assert.equal(lodEligible(img()), true);
});

test('a source barely larger than its box keeps the full image', () => {
  // 1,5× : l'échange ne rendrait presque rien et se verrait au moindre zoom.
  assert.equal(lodEligible(img({ natW: 300 })), false);
  assert.equal(lodEligible(img({ natW: 0 })), false);
});

test('a big item keeps the full image', () => {
  assert.equal(lodEligible(img({ w: 900 })), false);
});

test('an animated image is never replaced by a still thumbnail', () => {
  for (const ext of ['gif', 'webp', 'avif', 'apng']) {
    assert.equal(lodEligible(img({ ref: `C:/rushes/a.${ext}` })), false, ext);
  }
});

test('only local still images qualify', () => {
  assert.equal(lodEligible(img({ ref: 'https://cdn.example/a.png' })), false);
  assert.equal(lodEligible(img({ ref: 'blob:abc' })), false);
  assert.equal(lodEligible(img({ ref: 'data:image/png;base64,AA' })), false);
  assert.equal(lodEligible(img({ kind: 'video' })), false);
  assert.equal(lodEligible(img({ ref: '' })), false);
});

test('an item still loading or already missing is left alone', () => {
  assert.equal(lodEligible(img({ loading: true })), false);
  assert.equal(lodEligible(img({ missing: true })), false);
});

test('the thumbnail only stands in for a much larger source shown small', () => {
  // Marges volontairement larges : une vignette qui se devine à l'écran est pire que la mémoire
  // qu'elle économise.
  const src = fs.readFileSync(path.join(root, rel), 'utf8');
  assert.ok(Number(/const LOD_MIN_RATIO = (\d+)/.exec(src)[1]) >= 4);
  assert.ok(Number(/const LOD_MAX_W = (\d+)/.exec(src)[1]) <= 320);
  // Une fois repassée en pleine définition, une source y reste : refaire l'aller-retour à chaque
  // franchissement du seuil redécoderait toute la planche d'un coup.
  assert.match(src, /const pinnedFull = new Set<string>\(\)/);
  assert.match(src, /!pinnedFull\.has\(item\.ref\)/);
});
