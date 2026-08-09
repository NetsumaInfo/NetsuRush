// Écriture d'une animation DANS Resolve, de bout en bout, avec un TimelineItem stubé qui se comporte
// comme l'API : `ExportFusionComp` écrit un fichier, `ImportFusionComp` en lit un. Tout ce qui n'est
// pas Resolve lui-même est donc exercé pour de vrai, fichiers temporaires compris.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { applyFusionAnimation } = require('../core/transfer/fusion/apply');
const { readSkeleton, buildAnimatedComp } = require('../core/transfer/fusion/compText');

const SKELETON = `{
	Tools = ordered() {
		MediaIn1 = MediaIn {
			Inputs = { Layer = Input { Value = "0", }, },
			ViewInfo = OperatorInfo { Pos = { 0, 0 } },
		},
		MediaOut1 = MediaOut {
			Inputs = {
				Input = Input {
					SourceOp = "MediaIn1",
					Source = "Output",
				},
			},
			ViewInfo = OperatorInfo { Pos = { 110, 0 } },
		}
	},
	ActiveTool = "MediaOut1"
}`;

const animatedClip = {
  kind: 'video', track: 1, path: 'C:/rush/A.mov', name: 'A', fps: 25, srcFrames: 500,
  srcIn: 0, srcOut: 49, tlStart: 0, tlEnd: 50, srcWidth: 1920, srcHeight: 1080,
  video: { transform: { position: {
    value: { x: -480, y: 0 },
    keyframes: [{ frame: 0, value: { x: -480, y: 0 } }, { frame: 50, value: { x: 480, y: 0 } }],
  } } },
};

/**
 * TimelineItem minimal. `exportBroken` simule une version de Resolve qui refuse l'export ;
 * `dropAnimation` simule un import qui avale la greffe (le cas que la relecture doit attraper).
 */
function fakeItem({ comps = [], exportBroken = false, importBroken = false, dropAnimation = false } = {}) {
  const state = { comps: comps.slice(), imported: null, written: [], deleted: [] };
  return {
    state,
    GetFusionCompCount: async () => state.comps.length,
    GetFusionCompNameList: async () => state.comps.map((c) => c.name),
    AddFusionComp: async () => {
      state.comps.push({ name: `Composition ${state.comps.length + 1}`, text: SKELETON });
      return {};
    },
    DeleteFusionCompByName: async (name) => {
      const index = state.comps.findIndex((c) => c.name === name);
      if (index >= 0) state.comps.splice(index, 1);
      state.deleted.push(name);
      return true;
    },
    ExportFusionComp: async (filePath, index) => {
      if (exportBroken) return false;
      const comp = state.comps[index - 1];
      if (!comp) return false;
      fs.writeFileSync(filePath, dropAnimation ? SKELETON : comp.text, 'utf8');
      state.written.push(filePath);
      return true;
    },
    ImportFusionComp: async (filePath) => {
      if (importBroken) return null;
      const text = fs.readFileSync(filePath, 'utf8');
      state.imported = text;
      state.comps.push({ name: `NetsuRush ${state.comps.length + 1}`, text });
      return {};
    },
  };
}

const timeline = { width: 1920, height: 1080 };

test('l’animation est posée, relue et confirmée', async () => {
  const item = fakeItem();
  const result = await applyFusionAnimation(item, animatedClip, timeline);
  assert.deepEqual(result, { ok: true, verified: true });
  assert.match(item.state.imported, /NRTransform = Transform \{/);
  assert.match(item.state.imported, /MediaOut1 = MediaOut \{[\s\S]*SourceOp = "NRTransform"/);
  assert.match(item.state.imported, /NRTransformCenterX = BezierSpline/);
});

test('la composition de TRAVAIL est supprimée, la composition animée reste', async () => {
  const item = fakeItem();
  await applyFusionAnimation(item, animatedClip, timeline);
  assert.deepEqual(item.state.deleted, ['Composition 1'], 'seule la comp créée pour le squelette part');
  assert.deepEqual(item.state.comps.map((c) => c.name), ['NetsuRush 2']);
});

test('une composition DÉJÀ posée par l’utilisateur n’est jamais supprimée', async () => {
  const item = fakeItem({ comps: [{ name: 'Fusion Composition 1', text: SKELETON }] });
  const result = await applyFusionAnimation(item, animatedClip, timeline);
  assert.equal(result.ok, true);
  assert.deepEqual(item.state.deleted, []);
});

test('un import avalé par Resolve est DÉTECTÉ, pas supposé réussi', async () => {
  const item = fakeItem({ dropAnimation: true });
  const result = await applyFusionAnimation(item, animatedClip, timeline);
  assert.deepEqual(result, { ok: true, verified: false });
});

test('un import refusé laisse le plan intact et le dit', async () => {
  const item = fakeItem({ importBroken: true });
  const result = await applyFusionAnimation(item, animatedClip, timeline);
  assert.deepEqual(result, { ok: false, reason: 'fusionCompImportRefused' });
  assert.deepEqual(item.state.comps, [], 'la comp de travail est nettoyée même en cas d’échec');
});

test('une version sans export de composition retombe proprement', async () => {
  const item = fakeItem({ exportBroken: true });
  const result = await applyFusionAnimation(item, animatedClip, timeline);
  assert.deepEqual(result, { ok: false, reason: 'fusionCompExportFailed' });
  assert.deepEqual(item.state.comps, []);
});

test('un plan sans image clé ne touche jamais à Fusion', async () => {
  const item = fakeItem();
  const still = { ...animatedClip, video: { transform: { position: { value: { x: 10, y: 0 } } } } };
  const result = await applyFusionAnimation(item, still, timeline);
  assert.deepEqual(result, { ok: false, reason: 'clipNotAnimated' });
  assert.deepEqual(item.state.comps, []);
});

test('aucun fichier temporaire ne survit à l’opération', async () => {
  const item = fakeItem();
  await applyFusionAnimation(item, animatedClip, timeline);
  for (const filePath of item.state.written) assert.equal(fs.existsSync(filePath), false, filePath);
});

// --- format réel d'ExportFusionComp ---------------------------------------------------------------

// `ExportFusionComp` écrit la comp au format Fusion AUTONOME : les nœuds de la page Fusion y sortent
// en `Loader`/`Saver`, jamais en `MediaIn`/`MediaOut`. Relevé sur Resolve Studio 21.0.3 — ne chercher
// que les seconds rendait TOUT squelette illisible, donc aucune image clé jamais posée.
const STANDALONE_SKELETON = [
  'Composition {',
  '\tCurrentTime = 0,',
  '\tRenderRange = { 0, 94 },',
  '\tGlobalStart = 0,',
  '\tVersion = "DaVinci Resolve Studio 21.0.3.0007",',
  '\tTools = {',
  '\t\tMediaIn1 = Loader {',
  '\t\t\tExtentSet = true,',
  '\t\t\tInputs = { Comments = Input { Value = "", }, }',
  '\t\t},',
  '\t\tMediaOut1 = Saver {',
  '\t\t\tInputs = { Input = Input { SourceOp = "MediaIn1", Source = "Output", }, }',
  '\t\t}',
  '\t}',
  '}',
].join('\n');

test('un squelette Loader/Saver est lu comme un squelette MediaIn/MediaOut', () => {
  const skeleton = readSkeleton(STANDALONE_SKELETON);
  assert.ok(skeleton, 'squelette illisible');
  assert.equal(skeleton.mediaIn, 'MediaIn1');
  assert.equal(skeleton.mediaOut, 'MediaOut1');
  assert.deepEqual(skeleton.upstream, { op: 'MediaIn1', source: 'Output' });
});

test('la greffe se pose sur un squelette au format autonome', () => {
  const clip = {
    srcWidth: 1920, srcHeight: 1080,
    video: { transform: { opacity: { value: 100, keyframes: [{ frame: 0, value: 0 }, { frame: 25, value: 100 }] } } },
  };
  const built = buildAnimatedComp(STANDALONE_SKELETON, clip, { width: 1920, height: 1080 });
  assert.equal(built.ok, true, built.reason);
  // La sortie doit pointer sur la greffe, sinon la comp rend l'image d'origine sans animation.
  const saver = built.text.slice(built.text.indexOf('Saver'));
  assert.match(saver, /SourceOp = "NR\w+"/);
  assert.match(built.text, /KeyFrames\s*=\s*\{/);
});
