// Miroir durable du localStorage (core/uistate.js) : ce qui est écrit doit se relire après un
// redémarrage, et un patch ne doit jamais effacer une clé qu'il ne mentionne pas.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-uistate-'));
process.env.NR_HOME = HOME;

const { createUiState, STATE_FILE, MAX_VALUE_BYTES } = require('../core/uistate');

function newStore() {
  const sent = [];
  const store = createUiState({ broadcast: (channel, payload) => sent.push({ channel, payload }) });
  return { store, sent };
}

test.beforeEach(() => { try { fs.unlinkSync(STATE_FILE); } catch (_) {} });

test('un réglage écrit se relit après redémarrage du core', () => {
  const { store } = newStore();
  store.set({ 'nr.cut.model': 'omnishotcut' });
  const { store: restarted } = newStore();
  assert.deepStrictEqual(restarted.get().state, { 'nr.cut.model': 'omnishotcut' });
});

test('un patch ne touche que ses clés, null supprime', () => {
  const { store } = newStore();
  store.set({ 'nr-theme': 'dark', 'nr.cols': '6' });
  store.set({ 'nr.cols': '8' });
  assert.deepStrictEqual(store.get().state, { 'nr-theme': 'dark', 'nr.cols': '8' });
  store.set({ 'nr-theme': null });
  assert.deepStrictEqual(store.get().state, { 'nr.cols': '8' });
});

test('diffusion uniquement quand quelque chose change', () => {
  const { store, sent } = newStore();
  store.set({ 'nr-theme': 'dark' });
  store.set({ 'nr-theme': 'dark' });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].channel, 'uistate:changed');
  assert.deepStrictEqual(sent[0].payload, { patch: { 'nr-theme': 'dark' } });
});

test('une valeur démesurée est refusée sans perdre le reste', () => {
  const { store } = newStore();
  const huge = 'x'.repeat(MAX_VALUE_BYTES + 1);
  const result = store.set({ 'nr-theme': 'dark', 'nr.huge': huge });
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.skipped, ['nr.huge']);
  assert.deepStrictEqual(store.get().state, { 'nr-theme': 'dark' });
});

test('un fichier illisible ne fait pas tomber le core', () => {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(STATE_FILE, '{ pas du json');
  const { store } = newStore();
  assert.deepStrictEqual(store.get().state, {});
  store.set({ 'nr-theme': 'dark' });
  assert.deepStrictEqual(store.get().state, { 'nr-theme': 'dark' });
});

test('valeurs non-chaînes ignorées à la relecture', () => {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ 'nr-theme': 'dark', 'nr.bad': { a: 1 } }));
  const { store } = newStore();
  assert.deepStrictEqual(store.get().state, { 'nr-theme': 'dark' });
});
