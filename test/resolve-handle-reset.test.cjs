// Le registre de handles ne doit être purgé qu'UNE FOIS par opération bracketée.
const test = require('node:test');
const assert = require('node:assert');

function loadProxyWithFakeBridge() {
  const bridgePath = require.resolve('../core/resolve-bridge.js');
  const proxyPath = require.resolve('../core/resolve-proxy.js');
  delete require.cache[proxyPath];
  delete require.cache[bridgePath];
  const resets = { count: 0 };
  require.cache[bridgePath] = {
    id: bridgePath, filename: bridgePath, loaded: true, exports: {
      createResolveBridge: () => ({
        connect: async () => ({ connected: true }),
        reset: async () => { resets.count += 1; },
        invoke: async () => null,
        attr: async () => null,
      }),
    },
  };
  const proxy = require(proxyPath);
  delete require.cache[proxyPath];
  delete require.cache[bridgePath];
  return { proxy, resets };
}

test('une opération bracketée ne purge le registre qu\'une seule fois', async () => {
  const { proxy, resets } = loadProxyWithFakeBridge();
  proxy.beginResolveOp();
  await proxy.getResolve();
  await proxy.getResolve();
  await proxy.getResolve();
  proxy.endResolveOp();
  // Purger à chaque appel invalidait les handles pris au premier — « handle invalide » en plein
  // transfert, d'autant plus probable que l'opération est longue.
  assert.equal(resets.count, 1);
});

test('chaque nouvelle opération repart d\'un registre propre', async () => {
  const { proxy, resets } = loadProxyWithFakeBridge();
  for (let i = 0; i < 3; i++) {
    proxy.beginResolveOp();
    await proxy.getResolve();
    await proxy.getResolve();
    proxy.endResolveOp();
  }
  assert.equal(resets.count, 3);
});

test('deux opérations qui se CHEVAUCHENT ne purgent pas sous les pieds l\'une de l\'autre', async () => {
  const { proxy, resets } = loadProxyWithFakeBridge();
  proxy.beginResolveOp();
  await proxy.getResolve();
  proxy.beginResolveOp();
  await proxy.getResolve();
  proxy.endResolveOp();
  proxy.endResolveOp();
  assert.equal(resets.count, 1);
});

test('hors bracket, chaque appel repart bien d\'un registre propre', async () => {
  const { proxy, resets } = loadProxyWithFakeBridge();
  await proxy.getResolve();
  await proxy.getResolve();
  assert.equal(resets.count, 2);
});

test('un appel NON bracketé pendant une op bracketée ne purge pas le registre', async () => {
  const { proxy, resets } = loadProxyWithFakeBridge();
  proxy.beginResolveOp();
  await proxy.getResolve();
  await proxy.getResolve(); // lecture concurrente sans bracket
  proxy.endResolveOp();
  assert.equal(resets.count, 1);
});

// Le corollaire : tout canal qui touche Resolve DOIT être bracketé, sinon il tient des handles à la
// profondeur 0 et l'op bracketée suivante les purge sous ses pieds (cas vécu : NetsuBridge, la liste
// des timelines et l'aperçu partant ensemble au changement d'hôte).
test('les canaux Resolve de rpc.js sont tous bracketés', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../core/rpc.js'), 'utf8');
  const CHANNELS = [
    'resolve:status', 'resolve:listMediaPool', 'resolve:import', 'resolve:importToBin',
    'resolve:buildTimeline', 'resolve:listTimelines', 'resolve:timelineTree', 'resolve:timelineThumbs',
    'resolve:readTimelineCuts', 'resolve:cutTimeline',
    'transfer:sources', 'transfer:read', 'transfer:run',
    'script:mediaPool', 'script:importMedia', 'script:buildTimeline',
  ];
  for (const ch of CHANNELS) {
    const line = src.split('\n').find((l) => l.includes(`"${ch}":`));
    assert.ok(line, `canal absent de rpc.js : ${ch}`);
    assert.match(line, /:\s*(guarded|rOp)\(/, `canal Resolve non bracketé : ${ch}`);
  }
});
