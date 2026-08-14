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
const { lodEligible, zoomCeil } = mod.exports;

// 200×120 unités board, source 1920 px de large. Au zoom 1 : 200×120 à l'écran.
const img = (over = {}) => ({ kind: 'image', ref: 'C:/rushes/a.png', w: 200, h: 120, natW: 1920, ...over });
// Par défaut on interroge depuis la source PLEINE : c'est le seuil d'entrée qui s'applique.
const at = (zoom, over, onThumb = false) => lodEligible(img(over), zoom, onThumb);

test('a large source shown small goes through its thumbnail', () => {
  assert.equal(at(1), true);
});

test('a source barely larger than its box keeps the full image', () => {
  // 1,5× : l'échange ne rendrait presque rien et se verrait au moindre zoom.
  assert.equal(at(1, { natW: 300 }), false);
  assert.equal(at(1, { natW: 0 }), false);
});

test('a big item keeps the full image', () => {
  assert.equal(at(1, { w: 900, h: 540 }), false);
});

// Le critère est en pixels ÉCRAN : le même item change de camp selon le zoom, sans que sa géométrie
// board ne bouge. C'est tout l'intérêt — une version antérieure ne regardait que les unités board,
// donc à fort dézoom des items d'un pixel gardaient leur source pleine décodée.
test('the same item follows the zoom, in screen pixels', () => {
  assert.equal(at(1), true, 'affiché en 200×120 : la vignette suffit');
  assert.equal(at(4), false, 'affiché en 800×480 : la vignette se verrait');
  assert.equal(at(0.01), true, 'affiché en 2×1 : la source pleine serait du gâchis pur');
});

test('an animated image is never replaced by a still thumbnail', () => {
  for (const ext of ['gif', 'webp', 'avif', 'apng']) {
    assert.equal(at(1, { ref: `C:/rushes/a.${ext}` }), false, ext);
  }
});

test('only local still images qualify', () => {
  assert.equal(at(1, { ref: 'https://cdn.example/a.png' }), false);
  assert.equal(at(1, { ref: 'blob:abc' }), false);
  assert.equal(at(1, { ref: 'data:image/png;base64,AA' }), false);
  assert.equal(at(1, { kind: 'video' }), false);
  assert.equal(at(1, { ref: '' }), false);
});

test('an item still loading or already missing is left alone', () => {
  assert.equal(at(1, { loading: true }), false);
  assert.equal(at(1, { missing: true }), false);
});

// Le zoom est quantifié à l'octave : sans ça, chaque item s'abonnerait à la valeur exacte du zoom et
// un cran de molette re-rendrait la planche entière.
test('the subscribed zoom is quantised to octaves, and never underestimates', () => {
  for (const s of [0.002, 0.03, 0.4, 1, 1.01, 2, 3, 7.9, 64]) {
    const z = zoomCeil(s);
    assert.ok(z >= s, `${z} doit majorer ${s}`);
    assert.equal(Math.log2(z), Math.round(Math.log2(z)), `${z} doit être une puissance de 2`);
  }
  // Une octave entière de zoom sans changement de valeur : c'est la borne des re-rendus.
  assert.equal(zoomCeil(1.01), zoomCeil(1.99));
  assert.notEqual(zoomCeil(1.99), zoomCeil(2.01));
});

// Sans bande morte, un aller-retour de molette autour du seuil faisait basculer toute la planche à
// chaque cran — et chaque bascule est un changement de `src`, donc un clignotement.
test('the swap has a dead band: entering and leaving use different thresholds', () => {
  // 120 unités de haut × 2 = 240 px écran : entre les deux seuils (180 et 360).
  assert.equal(at(2, {}, false), false, 'depuis la source pleine, on n’y passe pas encore');
  assert.equal(at(2, {}, true), true, 'déjà en vignette, on y reste');
  // Hors de la bande, l'état courant ne change rien.
  assert.equal(at(1, {}, false), true);
  assert.equal(at(1, {}, true), true);
  assert.equal(at(4, {}, false), false);
  assert.equal(at(4, {}, true), false);
});

test('the thumbnail only stands in for a much larger source shown small', () => {
  // Marges volontairement larges : une vignette qui se devine à l'écran est pire que la mémoire
  // qu'elle économise. 180 px écran contre un cran de vignette à 360 px de haut = ×2 de réserve.
  const raw = fs.readFileSync(path.join(root, rel), 'utf8');
  assert.ok(Number(/const LOD_MIN_RATIO = (\d+)/.exec(raw)[1]) >= 4);
  const enter = Number(/const LOD_ENTER_SCREEN_H = (\d+)/.exec(raw)[1]);
  const leave = Number(/const LOD_LEAVE_SCREEN_H = (\d+)/.exec(raw)[1]);
  assert.ok(enter <= 180, `seuil d'entrée ${enter} : la vignette se verrait`);
  // Une octave pleine de bande morte : exactement le pas du zoom quantifié, donc jamais deux
  // bascules dans le même mouvement de molette.
  assert.ok(leave >= enter * 2, `bande morte ${enter}→${leave} trop étroite`);
});

// Le culling remonte les items à chaque dézoom. Repartir systématiquement sur la source pleine
// ferait donc décoder le gros bitmap pour une seule frame, à chaque dézoom — l'exact contraire du
// but. Au montage il n'y a rien à l'écran à préserver : on prend la bonne source tout de suite.
test('a remounted item starts on the right source, not on the full one', () => {
  const raw = fs.readFileSync(path.join(root, rel), 'utf8');
  assert.match(raw, /function firstSrc\(item: BoardItem\): string/);
  assert.match(raw, /useState\(\(\) => firstSrc\(item\)\)/);
  // …mais seulement sur une vignette DÉJÀ peinte : l'échec d'une vignette n'est pas rattrapé (la
  // récupération est réservée à la source pleine), donc une entrée de cache purgée entre-temps
  // laisserait une case cassée que rien ne remplace.
  assert.match(raw, /decoded\.has\(thumb\)/);
  assert.match(raw, /decoded\.add\(src\)/);
});

// LE clignotement. Affecter `src` vide le <img> à l'instant même : Chromium ne repeint qu'après
// décodage, et la case est blanche entre les deux. À l'échelle d'une planche, toutes les petites
// images clignotent à chaque palier de zoom franchi.
test('the displayed source only changes once the new one is decoded', () => {
  const raw = fs.readFileSync(path.join(root, rel), 'utf8');
  assert.match(raw, /img\.decode\?\.\(\)/, 'la cible doit être DÉCODÉE, pas seulement chargée');
  // Un seul chemin doit pouvoir changer la source affichée, et il passe par preload().
  const swaps = raw.match(/setShown\(/g) ?? [];
  assert.equal(swaps.length, 2, 'un échange après décodage, plus la remise à zéro de fichier');
  assert.match(raw, /void preload\(target\)\.then\(\(ok\) => \{[\s\S]*?setShown\(target\)/,
    'l’échange doit vivre DANS la résolution du préchargement');
});
