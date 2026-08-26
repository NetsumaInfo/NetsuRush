const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'components', 'rushes', 'TimelineLiveView.tsx'),
  'utf8',
);

test('Timeline Live right player reuses the exact card proxy request', () => {
  const playCut = source.slice(source.indexOf('async function playCut'), source.indexOf('const selCount'));
  assert.match(playCut, /grid\.getProxy\(c\.path, c\.in, c\.out, "high"\)/);
  assert.doesNotMatch(playCut, /requireVideo|nextProxyToken/);
});

test('shared Timeline Live proxy requests coalesce while generation is in flight', () => {
  const grid = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'components', 'rushes', 'previewCache.ts'),
    'utf8',
  );
  assert.match(grid, /pendingRef = useRef<Map<string, Promise<string \| null>>>/);
  assert.match(grid, /const inFlight = pendingRef\.current\.get\(key\);\s*if \(inFlight\) return inFlight;/);
  assert.match(grid, /pendingRef\.current\.set\(key, request\)/);
});

test('Timeline Live double click opens the player without pinning playback inside the card', () => {
  const card = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'components', 'rushes', 'ShotCard.tsx'),
    'utf8',
  );
  assert.match(card, /onDoubleClick=\{onPlay\}/);
  assert.match(source, /play=\{grid\.gridPlay\}/);
  assert.doesNotMatch(source, /play=\{[^}]*playingId/);
});

test('collection cards also reserve inline playback for hover or autoplay', () => {
  const collection = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'components', 'collections', 'CollectionDetail.tsx'),
    'utf8',
  );
  assert.match(collection, /play=\{grid\.gridPlay\}/);
  assert.doesNotMatch(collection, /trimShot|setTrimShot|TrimDialog/);
  assert.doesNotMatch(collection, /playingId|setPlayingId/);
});

test('Timeline Live activates its first cut when a timeline opens', () => {
  assert.match(source, /if \(!activeCutId \|\| !visibleCuts\.some\(\(cut\) => cut\.id === activeCutId\)\)/);
  assert.match(source, /void playCut\(first\)/);
});

test('building the grid stays left of the spring, framing it stays right', () => {
  // Le ressort partage la barre en deux : à gauche ce qui FABRIQUE la grille (sélection, vignettes,
  // aperçus, lecture), à droite ce qui la CADRE ou la SORT (densité, destination, export). Les deux
  // vues qui partagent cette grille doivent le partager pareil — le Découpage avait dérivé et
  // renvoyait ses trois boutons de fabrication à droite.
  const dir = path.join(__dirname, '..', 'src', 'components', 'rushes');
  for (const file of ['CutStudio.tsx', 'TimelineLiveView.tsx']) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    const density = src.indexOf('<LayoutGrid className="mr-0.5');
    assert.ok(density > 0, file);
    const at = (needle) => {
      const i = src.lastIndexOf(needle, density);
      assert.ok(i > 0, `${file}: ${needle}`);
      return i;
    };
    const thumbs = at('<ImageIcon className="size-3.5" />');
    const proxies = at('<Zap className="size-3.5" />');
    const play = at('shared.autoplayPreviews');
    const spring = at('<div className="flex-1" />');
    assert.ok(thumbs < proxies, `${file}: vignettes avant aperçus`);
    assert.ok(proxies < play, `${file}: aperçus avant lecture`);
    assert.ok(play < spring, `${file}: les trois boutons sont à gauche du ressort`);
  }
  // Collections est le cas à part assumé : sa gauche porte déjà le nom de la collection, ses tags et
  // sa recherche, donc tout le groupe part à droite.
});

test('Timeline Live exposes the effective export timeline target in the top toolbar', () => {
  const occurrences = source.match(/<ExportTimelineTarget\b/g) || [];
  assert.equal(occurrences.length, 2, 'toolbar and export panel must edit the same profile target');
});
