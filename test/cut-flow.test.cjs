// Flux de rushs du Découpage : plusieurs rushs enchaînés dans UNE grille défilante.
//
// Ce que ces tests protègent, c'est la promesse de la vue : défiler un flux doit être indiscernable
// de défiler un rush unique. Concrètement — les plans sont publiés d'un bloc (jamais un rush qui
// s'ajoute sous le curseur), l'ordre du flux est celui de la grille (jamais un tri par secondes qui
// mélangerait les rushs), et chaque carte vise son propre fichier.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const root = path.join(__dirname, '..');
const rushes = path.join(root, 'src', 'components', 'rushes');

function loadTs(file) {
  const full = path.join(rushes, file);
  const compiled = ts.transpileModule(fs.readFileSync(full, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = new Module(full, module);
  mod.filename = full;
  mod.paths = module.paths;
  mod._compile(compiled, full);
  return mod.exports;
}

const flow = loadTs('cutFlow.ts');
const seg = (id, p) => ({ id, in: id, out: id + 1, path: p });

test('flow offsets mark where each clip starts in the flattened grid', () => {
  const segments = [seg(1, 'a'), seg(2, 'a'), seg(3, 'b'), seg(4, 'c'), seg(5, 'c'), seg(6, 'c')];
  assert.deepEqual(flow.flowOffsets(segments, ['a', 'b', 'c']), [0, 2, 3, 6]);
});

test('a clip with no shots yet takes no room and never becomes the current one', () => {
  const segments = [seg(1, 'a'), seg(2, 'c')];
  const offsets = flow.flowOffsets(segments, ['a', 'b', 'c']);
  assert.deepEqual(offsets, [0, 1, 1, 2]);
  // Rang 1 = le premier plan de « c » : le rush vide entre les deux ne s'intercale pas.
  assert.equal(flow.flowIndexOfShot(offsets, 1), 2);
});

test('shots of a single-clip grid carry no path and still resolve to that clip', () => {
  const segments = [{ id: 1, in: 0, out: 1 }, { id: 2, in: 1, out: 2 }];
  assert.deepEqual(flow.flowOffsets(segments, ['solo']), [0, 2]);
});

test('the current clip follows the row scrolled to the top of the grid', () => {
  const offsets = [0, 8, 20, 24];       // 8 plans, puis 12, puis 4
  const cell = 160;                      // rangée = 160*9/16 + 12 = 102 px
  const rowH = flow.rowHeight(cell);
  assert.equal(flow.firstVisibleShot(0, cell, 4), 0);
  assert.equal(flow.flowIndexOfShot(offsets, flow.firstVisibleShot(0, cell, 4)), 0);
  // Deux rangées de 4 = rang 8 = première vignette du deuxième rush.
  assert.equal(flow.firstVisibleShot(rowH * 2, cell, 4), 8);
  assert.equal(flow.flowIndexOfShot(offsets, flow.firstVisibleShot(rowH * 2, cell, 4)), 1);
  // Un défilement d'une demi-rangée reste sur la rangée du haut : l'entête ne clignote pas.
  assert.equal(flow.flowIndexOfShot(offsets, flow.firstVisibleShot(rowH * 1.5, cell, 4)), 0);
});

test('jumping to a clip lands its first shot on a row boundary', () => {
  const cell = 160;
  const rowH = flow.rowHeight(cell);
  assert.equal(flow.scrollOffsetOfShot(8, cell, 4), rowH * 2);
  // Rang au milieu d'une rangée → on remonte au début de CETTE rangée, jamais à moitié coupé.
  assert.equal(flow.scrollOffsetOfShot(9, cell, 4), rowH * 2);
  assert.equal(flow.scrollOffsetOfShot(0, cell, 4), 0);
});

test('a grid without measured geometry never divides by zero', () => {
  assert.equal(flow.firstVisibleShot(500, 0, 4), 0);
  assert.equal(flow.firstVisibleShot(500, 160, 0), 0);
  assert.equal(flow.scrollOffsetOfShot(12, 160, 0), 0);
  assert.equal(flow.flowIndexOfShot([], 5), 0);
});

test('the flow publishes every clip at once instead of one at a time', () => {
  const source = fs.readFileSync(path.join(rushes, 'useShotDetection.ts'), 'utf8');
  // Les caches des rushs sont lus EN PARALLÈLE puis posés par un seul setSegments : c'est ce qui
  // empêche un rush d'apparaître en cours de défilement.
  assert.match(source, /const loaded = await Promise\.all\(paths\.map/);
  const cacheEffect = source.slice(source.indexOf('const loaded = await Promise.all'));
  assert.equal((cacheEffect.match(/setSegments\(/g) || []).length, 1);
});

test('shots keep the order of the flow, never a global sort by seconds', () => {
  // Deux rushs ont chacun leurs secondes : trier la grille par `in` les entrelacerait.
  const actions = fs.readFileSync(path.join(rushes, 'useCutActions.ts'), 'utf8');
  assert.doesNotMatch(actions, /\.sort\(\(a, b\) => a\.in - b\.in\)\)/);
  const detection = fs.readFileSync(path.join(rushes, 'useShotDetection.ts'), 'utf8');
  assert.match(detection, /const all = paths\.flatMap\(\(p\) => fresh\.get\(p\) \?\? kept\.get\(p\) \?\? \[\]\)/);
});

test('editing stays inside one clip while selection may cross the whole flow', () => {
  const actions = fs.readFileSync(path.join(rushes, 'useCutActions.ts'), 'utf8');
  // Fusion : groupée par fichier, et chaque groupe enregistre la sienne.
  assert.match(actions, /const byPath = new Map<string, Segment\[\]>/);
  assert.match(actions, /recordMerge\(path, union\)/);
  // Retrait : chaque plan écarté part avec son fichier.
  assert.match(actions, /recordRemoval\(chosen\.map\(\(s\) => \(\{ path: pathOf\(s\), span: span\(s\) \}\)\)\)/);
});

test('only the header follows the scroll, never the grid', () => {
  // Le rush courant vit dans CutFlowNav. Tenu dans CutStudio, franchir une frontière de rush
  // re-rendait le studio entier — donc reconstruisait les centaines de vignettes de la grille,
  // exactement pendant qu'on défile.
  const studio = fs.readFileSync(path.join(rushes, 'CutStudio.tsx'), 'utf8');
  assert.doesNotMatch(studio, /useFlowPosition/);
  assert.match(studio, /<CutFlowNav flow=\{flow\}/);
  const nav = fs.readFileSync(path.join(rushes, 'CutFlowNav.tsx'), 'utf8');
  assert.match(nav, /useFlowPosition\(scrollEl, offsets, cell, cols, flow\.length > 1\)/);
  // Le nom du rush est donné EXPLICITEMENT : Base UI rend sinon la valeur brute, et l'entête
  // affichait le rang (« 0 ») au lieu du nom.
  assert.match(nav, /<SelectValue>\s*\n\s*<span[^>]*>\{current\?\.name\}<\/span>/);
});

test('the scroll read happens once per frame, not once per event', () => {
  const source = fs.readFileSync(path.join(rushes, 'cutFlow.ts'), 'utf8');
  assert.match(source, /if \(frame == null\) frame = requestAnimationFrame\(read\)/);
  assert.match(source, /addEventListener\("scroll", onScroll, \{ passive: true \}\)/);
  assert.match(source, /cancelAnimationFrame\(frame\)/);
});

test('the flow derives its landmarks in a single pass over the shots', () => {
  // Deux balayages séparés d'une liste de plusieurs milliers de plans valaient un balayage de trop.
  const studio = fs.readFileSync(path.join(rushes, 'CutStudio.tsx'), 'utf8');
  assert.match(studio, /const \{ offsets, uncut \} = useMemo\(/);
  assert.equal((studio.match(/useMemo\(\(\) => new Set\(segments/g) || []).length, 0);
});

test('every card and every export target the file of its own shot', () => {
  const studio = fs.readFileSync(path.join(rushes, 'CutStudio.tsx'), 'utf8');
  assert.match(studio, /clipPath=\{path\} clipName=\{nameOf\(path\)\} srcFrames=\{srcFramesOf\(path\)\}/);
  assert.match(studio, /const exportInputs = \(\) => selectedList\(\)\.map\(\(s\) => \(\{ input: pathOf\(s\)/);
  const exp = fs.readFileSync(path.join(rushes, 'useCutExport.ts'), 'utf8');
  // Un montage porte un seul fichier source : un flux enchaîne donc les appels sur LA MÊME timeline.
  assert.match(exp, /function groupByPath/);
  assert.match(exp, /\{ mode: "append" as const, timelineName: timeline \}/);
});
