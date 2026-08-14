// Niveau de détail des vidéos et séquences du board : quand le lecteur cède la place à une frame
// fixe. Un <video> décode à la résolution SOURCE quelle que soit sa taille affichée — sans ces
// règles, la vue d'ensemble d'un board fait tourner des dizaines de décodeurs pour des cases de
// quelques dizaines de pixels.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const Module = require('node:module');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const rel = 'src/components/reference/boardVideoLod.ts';
// Le module tire React, le store et boardImageLod : on ne garde que les décisions pures.
const src = 'const isRemoteRef = (r) => /^(https?:|data:|blob:)/i.test(r);\n'
  + read(rel)
    .replace(/^import[^;]*;$/gm, '')
    .replace(/export function useVideoStill[\s\S]*$/m, '');
const js = esbuild.transformSync(src, { loader: 'ts', format: 'cjs' }).code;
const mod = new Module(rel, null);
mod._compile(js, path.join(root, rel));
const { stillSized, videoLodEligible, posterTime } = mod.exports;

// 200×120 unités board, fichier local.
const vid = (over = {}) => ({ kind: 'video', ref: 'C:/rushes/a.mp4', w: 200, h: 120, ...over });

test('a video shrunk to a postage stamp is frozen to its poster frame', () => {
  assert.equal(videoLodEligible(vid(), 0.5, false), true, '60 px écran : figée');
  assert.equal(videoLodEligible(vid(), 2, false), false, '240 px écran : elle joue');
});

// Sans bande morte, un aller-retour de molette autour du seuil remonterait/démonterait le lecteur à
// chaque cran — et chaque remontage est un flux rouvert plus un décodeur relancé.
test('the still swap has a dead band one octave wide', () => {
  // 120 × 1 = 120 px écran : entre les deux seuils (96 et 192).
  assert.equal(stillSized(vid(), 1, false), false, 'en lecture, on n’y passe pas encore');
  assert.equal(stillSized(vid(), 1, true), true, 'déjà figée, on y reste');
  const raw = read(rel);
  const enter = Number(/const STILL_ENTER_SCREEN_H = (\d+)/.exec(raw)[1]);
  const leave = Number(/const STILL_LEAVE_SCREEN_H = (\d+)/.exec(raw)[1]);
  assert.ok(leave >= enter * 2, `bande morte ${enter}→${leave} plus étroite que le pas de zoom quantifié`);
});

test('only local playable videos are swapped for a still', () => {
  assert.equal(videoLodEligible(vid({ ref: 'https://cdn.example/a.mp4' }), 0.5, false), false);
  assert.equal(videoLodEligible(vid({ kind: 'image' }), 0.5, false), false);
  assert.equal(videoLodEligible(vid({ loading: true }), 0.5, false), false);
  assert.equal(videoLodEligible(vid({ missing: { name: 'a' } }), 0.5, false), false);
});

test('the poster frame of a trimmed cut is the cut start, not the file start', () => {
  assert.equal(posterTime(vid()), 0);
  assert.equal(posterTime(vid({ trimIn: 12.5 })), 12.5);
});

// Câblage : le routage passe par le mode timbre-poste, le <video> porte l'affiche en poster natif,
// et l'échange n'est fait qu'affiche DÉCODÉE (preload du module image).
test('the video LOD is wired into the board item', () => {
  const board = read('src/components/reference/BoardItem.tsx');
  assert.match(board, /<VideoWithStill item=\{item\} \/>/, 'le routage vidéo passe par le LOD');
  assert.match(board, /poster=\{poster\}/, 'le <video> doit porter son affiche native');
  assert.match(read(rel), /void preload\(src\)\.then\(\(ok\) => \{ if \(alive && ok\) setStill\(src\); \}\);/,
    'l’échange vers l’affiche doit vivre dans la résolution du préchargement');
});

// La zone de culling couvre ~6× l'aire du viewport : un média monté n'est pas forcément VISIBLE.
// Vidéos et séquences hors champ doivent se mettre en pause (le ping-pong y faisait 15 seeks/s).
test('mounted media pause when actually off screen', () => {
  const board = read('src/components/reference/BoardItem.tsx');
  const hooks = board.match(/useOnScreen\(/g) ?? [];
  assert.ok(hooks.length >= 2, 'vidéo ET séquence doivent observer leur visibilité réelle');
  assert.match(board, /!mediaSuspended && onScreen && playMode !== "off"/);
  assert.match(read('src/components/reference/useOnScreen.ts'), /IntersectionObserver/);
});

// Le proxy d'un cut est encodé à la hauteur ÉCRAN crantée : zoomé, le cut est net ; dézoomé, il ne
// décode plus du 1080p pour une case de 100 px.
test('trimmed-cut proxies follow the on-screen size, quantised', () => {
  const board = read('src/components/reference/BoardItem.tsx');
  assert.match(board, /const proxH = Math\.min\(1080, Math\.max\(240, Math\.ceil\(\(\(item\.h \|\| 240\) \* zoom\) \/ 240\) \* 240\)\)/);
});

// « Tout figer » doit atteindre TOUS les médias : l'iframe d'un embed était la seule à continuer de
// décoder sous un board gelé. Elle est démontée sous gel explicite (le masquage ne suffit pas).
test('freezing the board unmounts embed iframes', () => {
  const embed = read('src/components/reference/EmbedItem.tsx');
  assert.match(embed, /useBoard\(\(s\) => s\.frozen\)/);
  assert.match(embed, /if \(frozen\) \{/);
  assert.match(embed, /t\("embed\.frozen"\)/);
});

// Les tracés du calque de dessin suivent la même règle que les items : hors du viewport élargi, pas
// de rendu — sinon la couche promue prend pour bornes la bbox de TOUTES les formes.
test('draw shapes outside the widened viewport are culled', () => {
  const layer = read('src/components/reference/DrawLayer.tsx');
  assert.match(layer, /const drawnShapes = useMemo/);
  assert.match(layer, /<StaticShapes shapes=\{drawnShapes\}/);
});
