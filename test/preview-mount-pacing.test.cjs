// Rythmeur de montage des <video> de préchauffe : il étale les créations sur les images sans jamais
// en perdre. C'est ce qui sépare un défilement fluide d'un défilement par à-coups — créer un
// WebMediaPlayer est un travail synchrone du thread principal.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { readFileSync } = require('node:fs');
const ts = require('typescript');

// Le module est du TypeScript côté renderer : on le transpile pour l'exercer ici, avec un
// requestAnimationFrame piloté à la main (chaque `tick` = une image, de durée choisie).
function loadPool() {
  const src = readFileSync(path.join(__dirname, '..', 'src', 'lib', 'previewVideoPool.ts'), 'utf8');
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const pending = [];
  let now = 0;
  const sandbox = {
    exports: {},
    requestAnimationFrame: (fn) => { pending.push(fn); return pending.length; },
    cancelAnimationFrame: () => {},
    performance: { now: () => now },
  };
  new Function('exports', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', js)(
    sandbox.exports, sandbox.requestAnimationFrame, sandbox.cancelAnimationFrame, sandbox.performance,
  );
  // Avance d'une image de `frameMs`, puis exécute les rappels programmés pour elle.
  const tick = (frameMs = 1000 / 60) => {
    now += frameMs;
    const due = pending.splice(0, pending.length);
    for (const fn of due) fn();
  };
  return { pool: sandbox.exports, tick };
}

test('les montages sont étalés sur les images, jamais tous dans la même', () => {
  const { pool, tick } = loadPool();
  const granted = [];
  for (let i = 0; i < 30; i++) pool.requestPreloadMount(i, () => granted.push(i));
  assert.strictEqual(granted.length, 0, 'rien ne doit être accordé avant la première image');
  tick();
  assert.ok(granted.length > 0 && granted.length <= 3, `image saine : 1 à 3 montages, reçu ${granted.length}`);
  const first = granted.length;
  tick();
  assert.ok(granted.length > first, 'la file continue de se vider aux images suivantes');
  assert.ok(granted.length < 30, 'et jamais tout d\'un coup');
});

test('une image longue (défilement qui coûte cher) réduit le débit', () => {
  const { pool, tick } = loadPool();
  const sain = [];
  const p1 = loadPool();
  for (let i = 0; i < 20; i++) p1.pool.requestPreloadMount(i, () => sain.push(i));
  p1.tick(1000 / 60); p1.tick(1000 / 60);
  const debitSain = sain.length;

  const charge = [];
  for (let i = 0; i < 20; i++) pool.requestPreloadMount(i, () => charge.push(i));
  tick(1000 / 60);   // amorce
  tick(60);          // image à 60 ms : la machine peine
  const debitCharge = charge.length;
  assert.ok(debitCharge < debitSain, `sous charge le débit doit baisser (${debitCharge} vs ${debitSain})`);
});

test('tout finit par être monté : rien n\'est perdu en route', () => {
  const { pool, tick } = loadPool();
  const granted = [];
  for (let i = 0; i < 40; i++) pool.requestPreloadMount(i, () => granted.push(i));
  for (let n = 0; n < 60 && granted.length < 40; n++) tick();
  assert.strictEqual(granted.length, 40, 'les 40 montages doivent finir par être accordés');
});

test('les cartes du HAUT sont servies en premier', () => {
  const { pool, tick } = loadPool();
  const granted = [];
  for (const order of [12, 3, 40, 1, 25]) pool.requestPreloadMount(order, () => granted.push(order));
  tick();
  assert.deepStrictEqual(granted.slice(0, 3), [1, 3, 12], 'ordre croissant, du haut de la grille vers le bas');
});

test('une carte repartie avant son tour ne monte rien', () => {
  const { pool, tick } = loadPool();
  const granted = [];
  const abandon = pool.requestPreloadMount(1, () => granted.push('partie'));
  pool.requestPreloadMount(2, () => granted.push('restee'));
  abandon();
  tick();
  assert.deepStrictEqual(granted, ['restee']);
});

test('le remise à zéro vide la file (changement de rush)', () => {
  const { pool, tick } = loadPool();
  const granted = [];
  for (let i = 0; i < 10; i++) pool.requestPreloadMount(i, () => granted.push(i));
  pool.resetPreloadMounts();
  tick();
  assert.strictEqual(granted.length, 0, 'aucune carte de l\'ancien rush ne doit être montée');
});
