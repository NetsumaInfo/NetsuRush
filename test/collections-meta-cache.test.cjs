// Listing des collections : méta mise en cache (sans re-décoder les plans) et invalidée à l'écriture.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createCollectionStore } = require('../core/collections.js');

function store() {
  return createCollectionStore(fs.mkdtempSync(path.join(os.tmpdir(), 'nr-coll-test-')));
}

test('list returns meta and reflects writes (cache invalidation)', () => {
  const st = store();
  const { id } = st.saveCollection({ name: 'A', tags: ['grp'] });
  assert.equal(st.listCollections()[0].count, 0);
  st.addShots(id, [{ path: 'a.mkv', in: 0, out: 1, tags: ['zeta', 'alpha'], label: 'L' }]);
  let m = st.listCollections().find((x) => x.id === id);
  assert.equal(m.count, 1);
  assert.deepEqual(m.tags, ['alpha', 'zeta']);
  assert.deepEqual(m.labels, ['L']);
  assert.deepEqual(m.collTags, ['grp']);
  assert.equal(m.preview.length, 1);
  assert.deepEqual(st.allTags(), ['alpha', 'grp', 'zeta']);
  // second call served from cache, identical
  assert.deepEqual(st.listCollections().find((x) => x.id === id), m);
  const shotId = st.loadCollection(id).shots[0].id;
  st.updateShot(id, shotId, { tags: ['beta'] });
  m = st.listCollections().find((x) => x.id === id);
  assert.deepEqual(m.tags, ['beta']);
  assert.deepEqual(st.allTags(), ['beta', 'grp']);
  st.removeShot(id, shotId);
  assert.equal(st.listCollections().find((x) => x.id === id).count, 0);
  st.deleteCollection(id);
  assert.equal(st.listCollections().length, 0);
});

test('offlineShots reports missing sources asynchronously', async () => {
  const st = store();
  const real = path.join(os.tmpdir(), `nr-real-${Date.now()}.mkv`);
  fs.writeFileSync(real, 'x');
  const { id } = st.saveCollection({ name: 'B' });
  st.addShots(id, [
    { path: real, in: 0, out: 1 },
    { path: path.join(os.tmpdir(), 'nr-missing-zzz.mkv'), in: 0, out: 1 },
    { path: path.join(os.tmpdir(), 'nr-missing-zzz.mkv'), in: 5, out: 6 },
  ]);
  const r = await st.offlineShots(id);
  assert.equal(r.ok, true);
  assert.equal(r.offline, 1);
  assert.equal(r.missing[0].count, 2);
  fs.unlinkSync(real);
});
