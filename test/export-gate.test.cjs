// Portail de créneaux d'encodage (core/export/gate.js) : c'est LUI qui rend le rendu en lot sûr.
// Sans plafond global, 5 rendus lancés ensemble ouvraient 5 × N ffmpeg (sessions NVENC saturées).
const test = require('node:test');
const assert = require('node:assert');

const gate = require('../core/export/gate.js');

// Compteur d'encodes RÉELLEMENT en vol pendant l'exécution d'un lot.
async function runBatch(count, limit, onPeak) {
  const job = gate.register(limit);
  let inFlight = 0;
  try {
    await Promise.all(Array.from({ length: count }, () => gate.withSlot(async () => {
      inFlight++;
      onPeak(inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    })));
  } finally {
    job.release();
  }
}

test('un job ne dépasse jamais sa propre limite', async () => {
  let peak = 0;
  await runBatch(12, 3, (n) => { peak = Math.max(peak, n); });
  assert.strictEqual(peak, 3);
  assert.strictEqual(gate.stats().active, 0);
});

test('un job strict encore en vol bride les autres', async () => {
  // Un encode CPU (limite 2) est déclaré et TIENT pendant tout le lot remux (limite 4) : le total
  // simultané reste à 2, jamais 6. Le plafond ne remonte qu'une fois le job strict relâché.
  const cpuJob = gate.register(2);
  let peak = 0;
  try {
    await runBatch(8, 4, (n) => { peak = Math.max(peak, n); });
  } finally {
    cpuJob.release();
  }
  assert.ok(peak <= 2, `pic observé ${peak}, attendu ≤ 2`);
  assert.strictEqual(gate.stats().active, 0);
});

test('le plafond remonte quand le job le plus strict se termine', async () => {
  const strict = gate.register(1);
  assert.strictEqual(gate.stats().limit, 1);
  strict.release();
  assert.strictEqual(gate.stats().limit, gate.DEFAULT_LIMIT);
});

test('tous les créneaux sont rendus même si un encode échoue', async () => {
  const job = gate.register(2);
  await Promise.allSettled([
    gate.withSlot(async () => { throw new Error('ffmpeg a échoué'); }),
    gate.withSlot(async () => {}),
  ]);
  job.release();
  assert.strictEqual(gate.stats().active, 0);
  assert.strictEqual(gate.stats().waiting, 0);
});
