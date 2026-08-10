const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const CARDS = ['src/components/rushes/SceneCard.tsx', 'src/components/rushes/ShotCard.tsx'];
const GRIDS = [
  'src/components/rushes/CutStudio.tsx',
  'src/components/rushes/TimelineLiveView.tsx',
  'src/components/collections/CollectionDetail.tsx',
];

// Changer la densité (+/-) ne doit toucher QUE le conteneur de grille. Une géométrie passée en prop
// à chaque carte rerendait des centaines de composants et réabonnait leurs observateurs par cran.
test('changing thumbnail density does not rerender every scene card', () => {
  for (const file of CARDS) {
    const src = read(file);
    assert.doesNotMatch(src, /\bcellH\b|\bcols\b/,
      `${file} must not take grid geometry as a prop: it would rerender on every density step`);
  }
  assert.doesNotMatch(read('src/components/rushes/useSceneCardMedia.ts'), /\bcols\b/,
    'viewport observers must stay subscribed while thumbnail density changes');
});

// content-visibility est ce qui garde une grille de plusieurs centaines de plans défilable : sans
// lui, chaque carte hors écran fait toujours sa mise en page et sa peinture.
test('preview cards keep content-visibility with an exact offscreen height', () => {
  for (const file of CARDS) {
    assert.match(read(file), /\bnr-grid-card\b/,
      `${file} must use the shared preview-card class (content-visibility + --nr-cell-h)`);
    assert.doesNotMatch(read(file), /containIntrinsicSize/,
      `${file} must not carry a per-card intrinsic size`);
  }
  const css = read('src/index.css');
  assert.match(css, /\.nr-grid-card\s*\{[^}]*content-visibility:\s*auto/,
    'the shared card class must skip offscreen rendering');
  assert.match(css, /\.nr-grid-card\s*\{[^}]*contain-intrinsic-size:\s*var\(--nr-cell-h/,
    'the offscreen height must come from the grid container variable');
  assert.doesNotMatch(css, /\.nr-grid-card\s*\{[^}]*contain-intrinsic-size:\s*auto\s/,
    'the `auto` keyword remembers the previous density and would desynchronise the scrollbar');
});

// L'habillage de survol (racines Base UI : infobulle, popover, menu contextuel) ne doit pas suivre
// la bande d'anticipation : traîner le curseur de la barre le montait/démontait pour des dizaines de
// cartes à la fois, sur le thread qui fait justement avancer un défilement traîné à la souris.
test('hover chrome mounts for the pointed card, not for the whole prefetch band', () => {
  for (const file of CARDS) {
    const src = read(file);
    assert.match(src, /\binteractive\b/,
      `${file} must gate its hover chrome on pointer/keyboard presence`);
    assert.doesNotMatch(src, /\{near && \(|\(near \|\| selected\)/,
      `${file} must not mount Base UI roots for every card of the thumbnail band`);
  }
  assert.match(read('src/components/rushes/useSceneCardMedia.ts'), /interactive:\s*pointerOn \|\| focusOn/,
    'the hook must expose pointer/keyboard presence separately from the prefetch band');
});

// La hauteur de rangée réelle est publiée une seule fois, par le conteneur : la barre de défilement
// mesure alors exactement ce qui sera rendu, à toutes les densités.
test('every preview grid publishes the real row height', () => {
  assert.match(read('src/components/rushes/cutStudioShared.ts'), /--nr-cell-h/,
    'gridContainerStyle must publish the row height');
  for (const file of GRIDS) {
    assert.match(read(file), /gridContainerStyle\(/,
      `${file} must style its grid through gridContainerStyle`);
  }
});
