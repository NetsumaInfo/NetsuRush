// Archivage d'une collection : changer de dossier de stockage migre ce qui existe et RÉ-EXPORTE le
// reste. Ce ré-export doit partir en UN SEUL lot : un appel d'export par plan déclare une limite de 1
// au portail d'encodage, et la limite effective étant la plus basse des jobs en cours, tout se
// sérialisait — un dossier de 200 plans se ré-encodait un par un alors que le GPU en tient plusieurs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createCollectionArchive } = require('../core/collectionArchive.js');

const PROFILE = { id: 'p1', container: 'mp4', workflow: 'video_encode' };
const SHOTS = [
  { path: 'A.mkv', in: 0, out: 1 },
  { path: 'B.mkv', in: 2, out: 3 },
  { path: 'C.mkv', in: 4, out: 5 },
];

/** Collection déjà archivée dans `from`, dont SEUL le premier fichier existe encore sur disque. */
function scenario(exportClips) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-archive-test-'));
  const from = path.join(root, 'ancien');
  const to = path.join(root, 'nouveau');
  fs.mkdirSync(from, { recursive: true });
  const known = [0, 1, 2].map((i) => path.join(from, `Sel_00${i + 1}.mp4`));
  fs.writeFileSync(known[0], 'x');

  const marks = [];
  const collectionStore = {
    loadCollection: () => ({
      id: 'c1', name: 'Sel', shots: SHOTS,
      archive: { dir: from, lastAt: 1, files: known },
    }),
    markArchived: (id, payload) => marks.push({ id, payload }),
  };
  const calls = [];
  const exportMod = {
    exportClips: async (event, opts) => {
      calls.push(opts);
      return exportClips(opts);
    },
  };
  return { root, from, to, calls, marks, archive: createCollectionArchive({ collectionStore, exportMod }) };
}

test('relocate re-exports every missing clip in a single batched call', async () => {
  const s = scenario((opts) => ({ ok: true, files: opts.savePaths, outs: opts.savePaths, failed: 0 }));
  try {
    const r = await s.archive.relocate(null, 'c1', { dir: s.to, profile: PROFILE });

    assert.equal(s.calls.length, 1, 'un seul appel d’export, pas un par plan');
    assert.equal(s.calls[0].clips.length, 2);
    assert.deepEqual(s.calls[0].savePaths, [
      path.join(s.to, 'Sel_002.mp4'),
      path.join(s.to, 'Sel_003.mp4'),
    ]);
    assert.equal(r.ok, true);
    assert.equal(r.moved, 1);
    assert.equal(r.exported, 2);
    assert.equal(r.failed, 0);
    // Fichier déjà présent : déplacé, pas ré-encodé.
    assert.equal(fs.existsSync(path.join(s.to, 'Sel_001.mp4')), true);
    assert.equal(fs.existsSync(path.join(s.from, 'Sel_001.mp4')), false);
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

// --- Ne rien refaire deux fois ---------------------------------------------------------------
// Un archivage repart à chaque plan rangé (synchro auto). Sans ce tri, activer l'upscale rendait la
// fonction inutilisable : chaque ajout relançait le GPU sur toute la collection.

const UP_PROFILE = { id: 'p1', container: 'mp4', workflow: 'video_encode', codec: 'h264_high' };
const IDENT_SHOTS = [
  { id: 's1', path: 'A.mkv', in: 0, out: 1 },
  { id: 's2', path: 'B.mkv', in: 2, out: 3 },
];

/** Collection à archiver dans un dossier neuf, avec des dépendances d'upscale entièrement simulées. */
function upscaleScenario({ shots = IDENT_SHOTS, archive = null, describe = () => null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-archive-up-'));
  const dir = path.join(root, 'archive');
  const marks = [];
  const collectionStore = {
    loadCollection: () => ({ id: 'c1', name: 'Sel', shots, archive }),
    markArchived: (id, payload) => marks.push(payload),
  };
  const exported = [];
  const exportMod = {
    exportClips: async (event, opts) => {
      exported.push(opts);
      return { ok: true, files: opts.savePaths, outs: opts.savePaths, failed: 0 };
    },
  };
  const upscaled = [];
  const upscaleMod = {
    runUpscale: async (event, opts) => {
      upscaled.push(opts);
      fs.mkdirSync(path.dirname(opts.savePath), { recursive: true });
      fs.writeFileSync(opts.savePath, 'up');
      return { ok: true, outputs: [opts.savePath] };
    },
  };
  const turboMod = { isTurboShader: (id) => String(id).startsWith('artcnn'), runTurbo: (s, e, o) => s.runUpscale(e, o) };
  const recorded = [];
  const ledger = {
    fingerprint: (input) => JSON.stringify([input.src, input.in, input.out, input.upscale]),
    statSource: () => ({ mtimeMs: null, size: null }),
    describe,
    lookup: () => null,
    record: (key, file) => recorded.push({ key, file }),
  };
  return {
    root, dir, marks, exported, upscaled, recorded,
    archive: createCollectionArchive({ collectionStore, exportMod, upscaleMod, turboMod, ledger }),
  };
}

const UPSCALE = { enabled: true, model: 'fallin', scale: 2 };

test('a shot already archived with the same settings is not produced again', async () => {
  const s = upscaleScenario();
  try {
    const first = await s.archive.archive(null, 'c1', { dir: s.dir, profile: UP_PROFILE, upscale: UPSCALE });
    assert.equal(first.ok, true);
    assert.equal(s.upscaled.length, 2, 'premier passage : les deux plans sont produits');
    assert.equal(first.rendered, 2);

    // Deuxième passage avec l'état d'archivage rendu par le premier : plus rien à faire.
    const s2 = upscaleScenario({ archive: { dir: s.dir, lastAt: 1, entries: s.marks[0].entries } });
    // Le second scénario a son propre dossier temporaire : on rejoue sur le dossier du premier.
    const again = await s2.archive.archive(null, 'c1', { dir: s.dir, profile: UP_PROFILE, upscale: UPSCALE });
    assert.equal(again.ok, true);
    assert.equal(again.skipped, 2, 'rien n’a changé : aucun encodage');
    assert.equal(s2.upscaled.length, 0);
    assert.equal(s2.exported.length, 0);
    fs.rmSync(s2.root, { recursive: true, force: true });
  } finally { fs.rmSync(s.root, { recursive: true, force: true }); }
});

test('the same content produced elsewhere is copied, never regenerated', async () => {
  const s = upscaleScenario();
  try {
    await s.archive.archive(null, 'c1', { dir: s.dir, profile: UP_PROFILE, upscale: UPSCALE });
    const produced = s.marks[0].entries;

    // Même collection, AUTRE dossier de stockage : le contenu existe, il n'y a rien à recalculer.
    const other = upscaleScenario({ archive: { dir: s.dir, lastAt: 1, entries: produced } });
    const r = await other.archive.archive(null, 'c1', { dir: other.dir, profile: UP_PROFILE, upscale: UPSCALE });
    assert.equal(r.copied, 2);
    assert.equal(other.upscaled.length, 0, 'le GPU ne doit pas être repayé pour un fichier existant');
    assert.equal(fs.existsSync(path.join(other.dir, 'Sel_001.mp4')), true);
    fs.rmSync(other.root, { recursive: true, force: true });
  } finally { fs.rmSync(s.root, { recursive: true, force: true }); }
});

test('a source that is already one of our upscales is not upscaled again', async () => {
  // B.mkv a été produit par un upscale ×2 : le ré-agrandir en ×2 n'ajouterait aucun détail.
  const s = upscaleScenario({ describe: (p) => (p === 'B.mkv' ? { scale: 2, model: 'fallin' } : null) });
  try {
    const r = await s.archive.archive(null, 'c1', { dir: s.dir, profile: UP_PROFILE, upscale: UPSCALE });
    assert.equal(r.ok, true);
    assert.equal(s.upscaled.length, 1, 'seul le plan non upscalé passe par le GPU');
    assert.equal(s.upscaled[0].input, 'A.mkv');
    assert.equal(s.exported.length, 1, 'l’autre repart par l’export normal');
    assert.deepEqual(s.exported[0].clips.map((c) => c.input), ['B.mkv']);
  } finally { fs.rmSync(s.root, { recursive: true, force: true }); }
});

test('upscaling forces re-encoding: a remux profile cannot stay a stream copy', async () => {
  const s = upscaleScenario({ describe: () => ({ scale: 9 }) }); // tout est déjà upscalé → export seul
  try {
    await s.archive.archive(null, 'c1', { dir: s.dir, profile: { ...UP_PROFILE, workflow: 'video_remux' }, upscale: UPSCALE });
    assert.equal(s.exported[0].profile.workflow, 'video_encode');
  } finally { fs.rmSync(s.root, { recursive: true, force: true }); }
});

test('archive entries survive shot removal (identity, not index)', async () => {
  const s = upscaleScenario();
  try {
    await s.archive.archive(null, 'c1', { dir: s.dir, profile: UP_PROFILE, upscale: UPSCALE });
    const entries = s.marks[0].entries;
    assert.deepEqual(Object.keys(entries).sort(), ['s1', 's2']);

    // Le premier plan est retiré : le second garde SON fichier, il ne doit pas hériter de l'autre.
    const after = upscaleScenario({
      shots: [IDENT_SHOTS[1]], archive: { dir: s.dir, lastAt: 1, entries },
    });
    const r = await after.archive.archive(null, 'c1', { dir: s.dir, profile: UP_PROFILE, upscale: UPSCALE });
    // Les noms sont numérotés : le plan restant devient le n°1. Son contenu est RECOPIÉ (pas
    // régénéré), et l'ancien n°2 — un fichier que nous avions écrit — est retiré du dossier.
    assert.equal(after.upscaled.length, 0, 'aucun encodage : le contenu existait déjà');
    assert.equal(r.copied, 1);
    assert.equal(r.pruned, 1);
    assert.equal(after.marks[0].entries.s2.file, path.join(s.dir, 'Sel_001.mp4'));
    assert.equal(fs.existsSync(path.join(s.dir, 'Sel_002.mp4')), false, 'pas de doublon orphelin');
    fs.rmSync(after.root, { recursive: true, force: true });
  } finally { fs.rmSync(s.root, { recursive: true, force: true }); }
});

test('relocate keeps the file list aligned on shots when part of the batch fails', async () => {
  // Le 2e plan du lot échoue (null dans `outs`) : son index doit rester vide, pas décaler les suivants.
  const s = scenario((opts) => ({ ok: true, files: [opts.savePaths[0]], outs: [opts.savePaths[0], null], failed: 1 }));
  try {
    const r = await s.archive.relocate(null, 'c1', { dir: s.to, profile: PROFILE });

    assert.equal(r.failed, 1);
    assert.equal(r.exported, 1);
    const files = s.marks[0].payload.files;
    assert.equal(files.length, SHOTS.length);
    assert.equal(files[1], path.join(s.to, 'Sel_002.mp4'));
    assert.equal(files[2], null);
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});
