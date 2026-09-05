// Le magasin d'assets du board (`core/boardStorage.js`) décide ce que l'app peut effacer d'elle-même.
// Sa règle de sûreté est asymétrique : un faux négatif coûte quelques mégaoctets gardés pour rien,
// un faux positif détruit le travail de quelqu'un. Ces tests fixent le côté qui n'est pas
// négociable — une copie unique n'est jamais libérable, et le renderer ne désigne jamais un fichier
// à supprimer.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createBoardStorage } = require('../core/boardStorage');

function tmpdir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `nr-${name}-`));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Magasin d'assets minimal, plus un refStore qui répond ce que le test veut éprouver. */
function harness({ files, scenes = [] }) {
  const assetsDir = tmpdir('assets');
  const written = {};
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(assetsDir, name);
    fs.writeFileSync(file, body);
    // `SETTLE_MS` protège les fichiers écrits à l'instant : ils seraient tous ignorés.
    const old = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(file, old, old);
    written[name] = file;
  }
  const refStore = {
    assetsDir,
    isAppAsset: (p) => path.dirname(path.resolve(String(p))).toLowerCase() === assetsDir.toLowerCase(),
    listScenes: () => scenes.map((scene) => ({ id: scene.id, name: scene.name })),
    loadScene: (id) => scenes.find((scene) => scene.id === id) || null,
    sceneRefs: (scene, into) => {
      for (const ref of (scene && scene.refs) || []) into.add(path.resolve(ref).toLowerCase());
      return into;
    },
  };
  const storage = createBoardStorage({ refStore, netsu: {} });
  return { assetsDir, written, storage };
}

test('an asset no scene claims and that exists nowhere else is an orphan, never freeable', async () => {
  const { storage, written } = harness({ files: { 'a1b2c3d4e5f60718.png': 'unique bytes' } });
  const audit = await storage.audit({});
  assert.equal(audit.ok, true);
  assert.equal(audit.assets.freeable.files, 0);
  assert.equal(audit.assets.orphans.files, 1);

  // « Libérer » ne touche que les doubles : la copie unique est toujours là après.
  const freed = await storage.free({});
  assert.equal(freed.ok, true);
  assert.equal(freed.files, 0);
  assert.ok(fs.existsSync(written['a1b2c3d4e5f60718.png']));
});

test('an asset a scene still points at is held, and its scene is reported as sole holder', async () => {
  const assetName = 'ffeeddccbbaa9988.png';
  const probe = harness({ files: { [assetName]: 'held bytes' } });
  const held = harness({
    files: { [assetName]: 'held bytes' },
    scenes: [{ id: 's1', name: 'Board A', refs: [path.join(probe.assetsDir, assetName)] }],
  });
  // La scène doit pointer sur le magasin DE CE harness, pas sur celui de la sonde.
  held.storage = createBoardStorage({
    refStore: {
      assetsDir: held.assetsDir,
      isAppAsset: (p) => path.dirname(path.resolve(String(p))).toLowerCase() === held.assetsDir.toLowerCase(),
      listScenes: () => [{ id: 's1', name: 'Board A' }],
      loadScene: () => ({ id: 's1', name: 'Board A', refs: [held.written[assetName]] }),
      sceneRefs: (scene, into) => {
        for (const ref of scene.refs) into.add(path.resolve(ref).toLowerCase());
        return into;
      },
    },
    netsu: {},
  });

  const audit = await held.storage.audit({});
  assert.equal(audit.assets.held.files, 1);
  assert.equal(audit.assets.orphans.files, 0);
  assert.equal(audit.assets.freeable.files, 0);
  const [scene] = audit.assets.held.scenes;
  assert.equal(scene.id, 's1');
  // Aucun projet ne détient ces octets : la scène est SEULE dépositaire, donc archivable.
  assert.equal(scene.soleFiles, 1);
});

test('a media placed on the open board but not yet saved is held, not orphaned', async () => {
  const name = '00112233445566778899aabbccddeeff.png';
  const { storage, written } = harness({ files: { [name]: 'live bytes' } });
  const audit = await storage.audit({ liveRefs: [written[name]] });
  assert.equal(audit.assets.orphans.files, 0);
  assert.equal(audit.assets.held.files, 1);
});

test('moving orphans refuses a destination inside the store itself', async () => {
  const { storage, assetsDir } = harness({ files: { 'aabbccddeeff0011.png': 'x' } });
  for (const destDir of [assetsDir, path.join(assetsDir, 'sub')]) {
    const result = await storage.moveOrphans({ destDir });
    assert.equal(result.ok, false, `${destDir} should be refused`);
  }
});

test('a shared board is never archived into a project', async () => {
  const assetsDir = tmpdir('assets-shared');
  const storage = createBoardStorage({
    refStore: {
      assetsDir,
      isAppAsset: () => false,
      listScenes: () => [],
      loadScene: () => ({ id: 's1', name: 'Shared', collaboration: { projectId: 'p1' } }),
      sceneRefs: (_scene, into) => into,
    },
    // Un board partagé ne garde aucun item : l'archiver écrirait un projet vide ET effacerait la
    // liaison au document, seule autorité sur son contenu. `netsu` doit donc rester intouché.
    netsu: { saveProjectAs: () => assert.fail('a shared board must not be archived') },
  });
  const result = await storage.archiveScene({ sceneId: 's1', destPath: path.join(assetsDir, 'x.netsu') });
  assert.equal(result.ok, false);
});

test('the renderer asks for a SCOPE, never for paths to delete', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'settings', 'storage', 'BoardAssetsSection.tsx'), 'utf8');
  // Aucun chemin ne remonte : le core recalcule ce qui est libérable à l'instant de l'écriture, donc
  // un asset devenu utile entre l'affichage et le clic n'est pas emporté par un audit périmé.
  assert.doesNotMatch(source, /storageFree\(\{[^}]*path/);
  assert.match(source, /storageFree\(\{ liveRefs: liveMediaRefs\(\) \}\)/);
  // La section « copie unique » ne propose aucune suppression : seulement de quoi sortir les
  // fichiers du magasin, ce qui est un déplacement vérifié.
  const sole = source.slice(source.indexOf('SECTION 2'));
  assert.doesNotMatch(sole, /storageFree|variant="destructive"/);
  assert.match(sole, /moveOrphans\(\)/);
  assert.match(source, /storageMoveOrphans\(\{ destDir, liveRefs: liveMediaRefs\(\) \}\)/);
});

test('the boot sweep only removes duplicates', () => {
  const rpc = fs.readFileSync(path.join(__dirname, '..', 'core', 'rpc.js'), 'utf8');
  const sweep = rpc.slice(rpc.indexOf('ASSET_SWEEP_DELAY_MS'));
  assert.match(sweep, /boardStorage\.free\(\{\}\)/);
  assert.doesNotMatch(sweep.slice(0, 600), /refStore\.sweepAssets/);
});
