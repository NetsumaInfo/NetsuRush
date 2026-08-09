// @ts-check
// Pipeline ORDONNÉ : une chaîne de transforms sur UNE source → UNE sortie. Exécution séquentielle
// fichier→fichier — la sortie de l'op i devient l'entrée de l'op i+1. Les intermédiaires vivent dans un
// dossier temporaire (jamais importés) ; seule la dernière op écrit dans `outDir` et importe si demandé.
//
// On réutilise les orchestrateurs existants op par op (runUpscale / runShaderUpscale / runInterpolate)
// → frame-math, codecs et daemons chauds restent intacts. L'optimisation decode-once→ops→encode-once
// (un seul flux rawvideo traversant toutes les ops) est une amélioration FUTURE : ici chaque op
// décode/encode son propre fichier, ce qui est correct et simple (au prix d'I/O intermédiaires).
//
// Ops chaînables (transforms vidéo→vidéo) : upscale, interpolate. Les sorties DÉRIVÉES (depth, matte)
// ne se chaînent pas (décision produit) → elles restent sur le chemin single-op.

const path = require('path');
const os = require('os');
const { fsp } = require('./config');
const sidecars = require('./sidecars');
const shaderUpscale = require('./shaderUpscale');
const { t } = require('./i18n');

const CHAINABLE = new Set(['upscale', 'interpolate']);

/**
 * @param {any} event  shim SSE ({ sender: { send } })
 * @param {{ input:string, ops:{kind:string,settings?:any}[], outDir:string, importBack?:boolean, baseName?:string, outputName?:string }} opts
 */
async function runPipeline(event, opts) {
  const { input, ops = [], outDir, importBack, baseName, outputName } = opts || {};
  if (!input) return { ok: false, error: t('sourceMissing') };
  if (!outDir) return { ok: false, error: t('outputFolderMissing') };
  if (!Array.isArray(ops) || !ops.length) return { ok: false, error: t('emptyPipeline') };
  for (const op of ops) if (!CHAINABLE.has(op && op.kind)) return { ok: false, error: `${t('unsupportedSource')}: ${op && op.kind}` };

  const tmpDir = path.join(os.tmpdir(), 'netsurush-pipeline', String(Date.now()));
  try { await fsp.mkdir(tmpDir, { recursive: true }); } catch (_) {}

  const total = ops.length;
  let cur = input;
  const intermediates = [];
  let finalOut = null;

  try {
    for (let i = 0; i < total; i++) {
      const op = ops[i];
      const last = i === total - 1;
      const dir = last ? outDir : tmpDir;
      const base = (baseName || path.basename(cur).replace(/\.[^.]+$/, ''));
      // Relaie le progress de l'op vers un flux unifié `pipeline:progress` (phase = kind + index/total).
      const sub = { sender: { send: (_ch, p) => {
        if (event && event.sender) event.sender.send('pipeline:progress',
          Object.assign({}, p, { done: i, total, phase: op.kind, opIndex: i, opCount: total }));
      } } };

      let r;
      const common = { input: cur, outDir: dir, importBack: last ? !!importBack : false,
        baseName: base, outputName: last ? outputName : undefined, whole: true };
      if (op.kind === 'upscale') {
        const s = op.settings || {};
        const routedModel = s.engine === 'turbo' && shaderUpscale.modelForShader(s.shader);
        r = routedModel
          ? await sidecars.runUpscale(sub, Object.assign({}, s, common, { model: routedModel }))
          : s.engine === 'turbo'
            ? await shaderUpscale.runShaderUpscale(sub, Object.assign({}, s, common))
            : await sidecars.runUpscale(sub, Object.assign({}, s, common));
      } else {
        r = await sidecars.runInterpolate(sub, Object.assign({}, op.settings || {}, common));
      }

      if (!r || !r.ok || !Array.isArray(r.outputs) || !r.outputs.length) {
        return { ok: false, error: (r && r.error) || `échec de l'op ${op.kind}`, total, failed: 1 };
      }
      cur = r.outputs[0]; // chaîne sur la 1re sortie (source unique, clip entier)
      if (last) finalOut = cur; else intermediates.push(cur);
    }
    return { ok: true, outputs: finalOut ? [finalOut] : [], imported: importBack ? 1 : 0, total, failed: 0, error: null };
  } catch (e) {
    return { ok: false, error: String(e), total, failed: 1 };
  } finally {
    for (const f of intermediates) { try { await fsp.rm(f, { force: true }); } catch (_) {} }
    try { await fsp.rm(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports = { runPipeline, CHAINABLE };
