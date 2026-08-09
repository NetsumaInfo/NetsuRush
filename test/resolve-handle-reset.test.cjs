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
