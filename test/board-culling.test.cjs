// Culling du board : quand la zone montée est refaite, et ce qu'elle laisse monter.
// Ces deux décisions bornent à elles seules ce que Chromium doit mettre en page, décoder et
// composer. Une seule d'entre elles à sens unique et la fenêtre finit figée.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const Module = require('node:module');

const root = path.join(__dirname, '..');
const rel = 'src/components/reference/useBoardCulling.ts';
// Le module tire React : on ne garde que les décisions pures.
const raw = fs.readFileSync(path.join(root, rel), 'utf8');
const src = raw
  .replace(/^import[^;]*;$/gm, '')
  .replace(/export function useBoardCulling[\s\S]*$/m, '');
const js = esbuild.transformSync(src, { loader: 'ts', format: 'cjs' }).code;
const mod = new Module(rel, null);
mod._compile(js, path.join(root, rel));
const { needsResync, zoneFor, capNearest } = mod.exports;

// Viewport de 1920×1080 px écran, à un zoom donné, centré sur l'origine du board.
const vp = (scale) => ({ x: 0, y: 0, w: 1920 / scale, h: 1080 / scale });

test('the mounted zone is rebuilt when the viewport leaves it', () => {
  const z = zoneFor(vp(1));
  assert.equal(needsResync(z, vp(1)), false, 'immobile : rien à refaire');
  const moved = { ...vp(1), x: 5000, y: 0 };
  assert.equal(needsResync(z, moved), true);
});

// LE bug du gel. En zoomant, le viewport rétrécit À L'INTÉRIEUR de la zone : la seule condition de
// sortie n'est alors plus jamais vraie, la zone reste figée à sa taille de vue d'ensemble, et tout ce
// qui avait été monté pour survoler la planche y reste monté — chacun mesurant désormais des dizaines
// de milliers de pixels à l'écran.
test('the mounted zone is also rebuilt when zooming in shrinks the viewport inside it', () => {
  const z = zoneFor(vp(0.1)); // vue d'ensemble
  assert.equal(needsResync(z, vp(0.1)), false);
  // Le viewport reste contenu dans la zone à chaque cran : sans le second critère, tout ceci
  // renverrait `false` jusqu'au zoom maximal.
  assert.equal(needsResync(z, vp(1)), true, 'un facteur 10 doit resserrer la zone');
  assert.equal(needsResync(z, vp(64)), true, 'au zoom maximal, à plus forte raison');
});

test('the rebuild threshold leaves a full octave of zoom before firing', () => {
  // Une zone neuve vaut 2,5× le viewport, et le seuil est à 5× : un facteur 2 de marge exactement.
  // Trop bas, on refait la zone à chaque cran de molette ; trop haut, le gel revient.
  const z = zoneFor(vp(1));
  assert.equal(needsResync(z, vp(1.9)), false, 'moins d’un doublement : aucun recalcul');
  assert.equal(needsResync(z, vp(2.1)), true, 'au-delà du doublement : on resserre');
});

const item = (id, x, kind = 'image') => ({ id, kind, x, y: 0, w: 100, h: 100 });
// Distance au centre : ici l'abscisse suffit, les items sont alignés.
const dist = (it) => Math.abs(it.x);
const none = () => false;

test('the item budget keeps the ones nearest the viewport centre', () => {
  const list = [item('a', 900), item('b', 100), item('c', 500), item('d', 50)];
  const kept = capNearest(list, 2, () => true, dist, none);
  assert.deepEqual(kept.map((it) => it.id), ['b', 'd'], 'les deux plus proches, dans l’ordre d’origine');
});

test('a budget wider than the list changes nothing at all', () => {
  const list = [item('a', 10), item('b', 20)];
  assert.equal(capNearest(list, 5, () => true, dist, none), list, 'même tableau, aucune copie');
});

test('an item under an active gesture crosses every budget, and costs none', () => {
  const list = [item('a', 900), item('b', 100), item('c', 500)];
  const kept = capNearest(list, 1, () => true, dist, (it) => it.id === 'a');
  // 'a' est le plus LOIN : sans l'exemption il tombait le premier. Et il ne mange pas le budget,
  // sinon garder la sélection reviendrait à démonter ce qu'on regarde.
  assert.deepEqual(kept.map((it) => it.id), ['a', 'b']);
});

test('the media budget only counts media, and applies on top of the global one', () => {
  const list = [
    item('v1', 10, 'video'), item('v2', 20, 'video'), item('v3', 30, 'video'),
    item('i1', 900), item('i2', 950),
  ];
  const kept = capNearest(list, 2, (it) => it.kind === 'video', dist, none);
  assert.deepEqual(kept.map((it) => it.id), ['v1', 'v2', 'i1', 'i2'],
    'les images, qui ne consomment pas de lecteur, traversent intactes');
});

// Le raccourci « peu d'items, on monte tout » a un angle mort : une planche d'une trentaine d'images
// ne l'atteint jamais, et magnifiée soixante fois chacune couvre des dizaines de milliers de pixels.
// C'est le cas qui figeait la fenêtre — le raccourci doit donc tomber dès qu'on a le nez dessus.
test('the small-board shortcut is disabled once the view is magnified', () => {
  assert.match(raw, /const CULL_ALWAYS_ZOOM = (\d+)/);
  const zoom = Number(/const CULL_ALWAYS_ZOOM = (\d+)/.exec(raw)[1]);
  assert.ok(zoom <= 2, `le raccourci doit tomber dès ${zoom}× au plus`);
  assert.match(raw, /items\.length < CULL_MIN_ITEMS && zone\.scale <= CULL_ALWAYS_ZOOM/);
  // La zone doit donc retenir le zoom auquel elle a été bâtie, sinon le filtrage ne peut pas trancher.
  assert.match(raw, /scale: view\.scale/);
});

// L'épinglage de la sélection est là pour les GESTES (drag de groupe, inspecteur). Sans plafond, un
// Ctrl+A sur un mur de 200 items les épinglait TOUS au montage — les deux budgets contournés d'un
// coup, exactement le scénario de gel que le culling existe pour empêcher.
test('a wall-sized selection stops pinning items past both budgets', () => {
  assert.match(raw, /const FORCED_SELECTION_MAX = (\d+)/);
  const cap = Number(/const FORCED_SELECTION_MAX = (\d+)/.exec(raw)[1]);
  const media = Number(/const MEDIA_BUDGET = (\d+)/.exec(raw)[1]);
  assert.ok(cap > 0 && cap <= media, `le plafond d'épinglage ${cap} doit rester sous le budget média`);
  assert.match(raw, /selectedIds\.length <= FORCED_SELECTION_MAX \? selectedIds : \[\]/);
});

test('both budgets stay well under what the browser tolerates', () => {
  // Chromium cesse de créer un lecteur média au-delà d'environ 75 par frame, SANS erreur.
  assert.ok(Number(/const MEDIA_BUDGET = (\d+)/.exec(raw)[1]) <= 60);
  // Le plafond global, lui, borne la mise en page et le décodage : à fort dézoom la zone couvre la
  // planche entière, et un item d'un pixel à l'écran coûte autant qu'un autre.
  const items = Number(/const ITEM_BUDGET = (\d+)/.exec(raw)[1]);
  assert.ok(items > 0 && items <= 400, `plafond global ${items} hors de portée utile`);
});
