// L'extension CEP est une COPIE dans %APPDATA% : rien ne la met à jour quand NetsuRush évolue.
// La resynchronisation repose entièrement sur l'empreinte de CONTENU (les mtimes ne survivent pas à
// la copie) — ces tests verrouillent cette propriété, sans quoi le panneau se réinstallerait à
// chaque démarrage ou, pire, resterait figé sur une version obsolète.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { panelContentHash, panelVersion, panelSyncAction } = require('../core/adobePanel');
const { sanitizeSetupOptions } = require('../core/setup');

function makePanel(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-panel-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

const MANIFEST = '<ExtensionManifest ExtensionBundleId="com.netsurush.panel" ExtensionBundleVersion="0.2.0">';

test('panel hash ignores copy timestamps but follows content', () => {
  const src = makePanel({ 'CSXS/manifest.xml': MANIFEST, 'js/panel.js': 'var a = 1;' });
  const copy = makePanel({});
  fs.mkdirSync(path.join(copy, 'CSXS'), { recursive: true });
  fs.mkdirSync(path.join(copy, 'js'), { recursive: true });
  fs.copyFileSync(path.join(src, 'CSXS/manifest.xml'), path.join(copy, 'CSXS/manifest.xml'));
  fs.copyFileSync(path.join(src, 'js/panel.js'), path.join(copy, 'js/panel.js'));

  assert.equal(panelContentHash(copy), panelContentHash(src));

  fs.writeFileSync(path.join(src, 'js/panel.js'), 'var a = 2;');
  assert.notEqual(panelContentHash(src), panelContentHash(copy));
});

test('panel hash reflects an added file and stays null on an empty folder', () => {
  const dir = makePanel({ 'CSXS/manifest.xml': MANIFEST });
  const before = panelContentHash(dir);
  fs.mkdirSync(path.join(dir, 'jsx'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'jsx', 'host.jsx'), 'NR();');
  assert.notEqual(panelContentHash(dir), before);
  assert.equal(panelContentHash(makePanel({})), null);
});

test('panel version comes from the manifest bundle version', () => {
  assert.equal(panelVersion(makePanel({ 'CSXS/manifest.xml': MANIFEST })), '0.2.0');
  assert.equal(panelVersion(makePanel({})), null);
});

test('setup keeps the Adobe extension choice as a boolean', () => {
  assert.equal(sanitizeSetupOptions({ modules: [], models: [], adobePanel: true }).adobePanel, true);
  assert.equal(sanitizeSetupOptions({ modules: [], models: [] }).adobePanel, false);
});

// La pose automatique est la seule écriture que NetsuRush fait dans le dossier Adobe sans qu'on la
// demande : chaque refus doit être tenu, sinon le panneau revient à chaque démarrage.
const FRESH = { autoUpdate: true, installedAt: null, removedAt: null, sourceHash: null, version: null, updatedAt: null };
const ABSENT = { installed: false, outdated: false };

test('panel is installed on its own when an Adobe host is present', () => {
  assert.deepEqual(panelSyncAction(FRESH, ABSENT, true), { action: 'install' });
});

test('nothing is written without an Adobe host on the machine', () => {
  assert.deepEqual(panelSyncAction(FRESH, ABSENT, false), { action: 'none', reason: 'noHost' });
});

test('a panel removed by hand is never put back', () => {
  const removed = { ...FRESH, installedAt: 1700000000000 };
  assert.deepEqual(panelSyncAction(removed, ABSENT, true), { action: 'none', reason: 'removed' });
});

test('automatic management off blocks both the install and the update', () => {
  const off = { ...FRESH, autoUpdate: false };
  assert.deepEqual(panelSyncAction(off, ABSENT, true), { action: 'none', reason: 'autoUpdate' });
  assert.deepEqual(panelSyncAction(off, { installed: true, outdated: true }, true), { action: 'none', reason: 'autoUpdate' });
});

test('an installed panel is updated only when it diverges from the shipped one', () => {
  const installed = { ...FRESH, installedAt: 1700000000000 };
  assert.deepEqual(panelSyncAction(installed, { installed: true, outdated: true }, true), { action: 'update' });
  assert.deepEqual(panelSyncAction(installed, { installed: true, outdated: false }, true), { action: 'none', reason: 'upToDate' });
});
