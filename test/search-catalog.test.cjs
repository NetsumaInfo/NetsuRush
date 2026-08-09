const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { modelTag, createSearchCatalog } = require('../core/searchCatalog');

// Le tag suit la variante ACTIVE : il est lu à l'appel, pas figé au require.
const MODEL_TAG = modelTag();

test('reads NetsuSearch startup data directly from SQLite', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-search-catalog-'));
  const dbPath = path.join(dir, 'netsurush.db');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE frame_embeddings_v1(file_path TEXT, model TEXT);
      CREATE TABLE face_embeddings_v2(file_path TEXT, domain TEXT);
      CREATE TABLE characters_v1(id INTEGER, name TEXT, notes TEXT, tags TEXT, color TEXT, avatar BLOB);
      CREATE TABLE character_samples_v1(char_id INTEGER, domain TEXT);
    `);
    const frame = db.prepare('INSERT INTO frame_embeddings_v1 VALUES (?, ?)');
    frame.run('a.mp4', MODEL_TAG); frame.run('a.mp4', MODEL_TAG); frame.run('b.mp4', MODEL_TAG);
    db.prepare('INSERT INTO face_embeddings_v2 VALUES (?, ?)').run('a.mp4', 'anime');
    db.prepare('INSERT INTO characters_v1 VALUES (?, ?, ?, ?, ?, ?)')
      .run(1, 'Mina', '', '["hero"]', '#fff', Buffer.from([1, 2, 3]));
    db.prepare('INSERT INTO character_samples_v1 VALUES (?, ?)').run(1, 'anime');
  } finally {
    db.close();
  }

  const catalog = createSearchCatalog(dbPath);
  assert.deepEqual(catalog.status(), { clips: 2, frames: 3, model: MODEL_TAG, error: null });
  assert.deepEqual(catalog.faceStatus(), { faces: 1, clips: 1, anime: 1, real: 0, error: null });
  const chars = catalog.characters().characters;
  assert.equal(chars[0].name, 'Mina');
  assert.equal(chars[0].total, 1);
  assert.match(chars[0].avatar, /^data:image\/jpeg;base64,/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('returns an immediate empty catalog before the database exists', () => {
  const missing = path.join(os.tmpdir(), `nr-search-missing-${Date.now()}.db`);
  const catalog = createSearchCatalog(missing);
  assert.equal(catalog.status().frames, 0);
  assert.equal(catalog.faceStatus().faces, 0);
  assert.deepEqual(catalog.characters().characters, []);
});
