// @ts-check
// Moteur d'upscale « RTX VSR » : NVIDIA RTX Video Super Resolution, piloté par le CLI
// RTXVideoProcessor (MIT) qui embarque le RTX Video SDK. Même panier que le moteur Turbo
// (shaders GLSL) : GPU, quasi temps réel, aucun python. Décodage NVDEC → VSR → NVENC sans
// aller-retour CPU ; la sortie est donc TOUJOURS du HEVC 10-bit, quel que soit le codec demandé
// ailleurs dans l'app (le CLI n'expose pas d'autre encodeur).

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { rtxBin, RTX_DIR, RTX_DLLS } = require('./config');
const { importToMediaPool } = require('./resolve');
const { sanitizeName } = require('./utils');
const { playInfo, probeMedia } = require('./ffmpeg');
const { t } = require('./i18n');

// VSR agrandit exactement ×2 : aucun autre facteur n'existe dans le SDK.
const RTX_SCALE = 2;
// Au-delà de cette hauteur le CLI désactive VSR de lui-même (limite du SDK) et se contente de
// réencoder — on refuse en amont plutôt que de rendre un fichier qui n'a pas été agrandi.
const RTX_MAX_INPUT_HEIGHT = 1440;
// Qualité VSR du SDK (1 = le plus rapide, 4 = le meilleur).
const RTX_QUALITY_MAX = 4;
// Libellés de vitesse x264 → paliers NVENC pX, même table que shaderUpscale/upscaler.codecs.
const NVENC_PRESET = {
  ultrafast: 'p1', superfast: 'p1', veryfast: 'p2', faster: 'p3',
  fast: 'p4', medium: 'p4', slow: 'p6', slower: 'p7', veryslow: 'p7',
};
// CRF x264/x265 → QP NVENC. Les deux échelles sont assez proches pour être reprises telles quelles ;
// on borne simplement sur la plage acceptée par NVENC.
const clampQp = (crf) => Math.min(51, Math.max(1, crf | 0 || 21));

// Ce qui manque pour lancer un job, nommé précisément (le CLI et les DLL s'installent séparément :
// l'un se télécharge, les autres se déposent à la main).
function missingRuntime() {
  const exe = rtxBin();
  if (!exe) return t('rtxCliMissing');
  const absent = RTX_DLLS.filter((dll) => {
    try { return !fs.existsSync(path.join(path.dirname(exe), dll)); } catch (_) { return true; }
  });
  return absent.length ? `${t('rtxDllMissing')} : ${absent.join(', ')} → ${RTX_DIR}` : null;
}

function audioArgs(mode, abr) {
  if (mode === 'none') return ['-an'];
  if (mode === 'aac')  return ['-codec:a', 'aac', '-ab', `${abr | 0}k`];
  if (mode === 'ac3')  return ['-codec:a', 'ac3', '-ab', `${abr | 0}k`];
  return ['-codec:a', 'copy'];
}

// Mode « compatible ffmpeg » du CLI : c'est le seul qui accepte -ss/-t, donc le seul utilisable pour
// une plage ou une liste de plans. `quality` = QP constant, `preset` = palier NVENC.
function buildArgs({ input, out, start, end, quality, preset, audio, abr, vsrQuality, hdr }) {
  const args = ['-y', '-i', input];
  if (start != null) args.push('-ss', String(start));
  if (start != null && end != null) args.push('-t', String(Math.max(0, end - start)));
  args.push('--vsr-quality', String(vsrQuality));
  // TrueHDR est actif PAR DÉFAUT dans le CLI : sans opt-in explicite, un upscale changerait la
  // colorimétrie du rush sans qu'on l'ait demandé. Le SDK ignore de lui-même une source déjà HDR.
  if (!hdr) args.push('--no-thdr');
  else {
    args.push('--thdr-contrast', String(hdr.contrast), '--thdr-saturation', String(hdr.saturation));
    args.push('--thdr-middle-gray', String(hdr.midGray), '--thdr-max-luminance', String(hdr.nits));
  }
  args.push('--nvenc-rc', 'constqp', '--nvenc-qp', String(quality), '--nvenc-preset', preset);
  args.push(...audioArgs(audio, abr));
  args.push(out);
  return args;
}

// Nombre de frames d'un job → barre de progression réelle (même calcul que shaderUpscale).
async function clipFrames(input, start, end) {
  const info = await playInfo(input).catch(() => ({ fps: 0, duration: 0 }));
  const fps = info.fps || 0;
  const dur = (start != null && end != null) ? Math.max(0, end - start) : (info.duration || 0);
  return Math.max(1, Math.round(dur * fps));
}

// Lance UN job. Le CLI journalise à la manière de ffmpeg (`frame=N`) sans offrir `-progress` : on lit
// donc les DEUX flux, la ligne d'avancement pouvant partir sur l'un ou l'autre selon le mode.
function runOne(event, bin, jobArgs, fileLabel, i, total, frames) {
  const send = (pct, phase) => { if (event?.sender) event.sender.send('upscale:progress', { file: fileLabel, pct, done: i, total, phase }); };
  send(1, 'model');
  return new Promise((resolve) => {
    const cp = spawn(bin, jobArgs, { cwd: path.dirname(bin) });
    let errTail = '';
    const onChunk = (chunk) => {
      const text = chunk.toString();
      errTail = (errTail + text).slice(-800);
      let m; const re = /frame=\s*(\d+)/g;
      while ((m = re.exec(text))) send(Math.min(99, Math.round((parseInt(m[1], 10) / frames) * 100)), 'upscale');
    };
    cp.stdout.on('data', onChunk);
    cp.stderr.on('data', onChunk);
    cp.on('error', (e) => resolve({ ok: false, error: `${path.basename(bin)} : ${e.message}` }));
    cp.on('close', (code) => {
      if (code === 0) { send(100, 'upscale'); resolve({ ok: true }); }
      else resolve({ ok: false, error: errTail.trim() || `${path.basename(bin)} code ${code}` });
    });
  });
}

async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit | 0), items.length) }, worker));
  return results;
}

// Upscale RTX d'un clip : 1 job (rush entier ou plage) ou N jobs (plans sélectionnés). Contrat de
// retour IDENTIQUE à runShaderUpscale — l'appelant ne distingue pas les deux moteurs temps réel.
async function runRtxUpscale(event, opts) {
  const { input, scale = RTX_SCALE, quality = 21, preset = 'slow', audio = 'copy', abr = 192,
    vsrQuality = RTX_QUALITY_MAX, hdr = false, hdrContrast = 125, hdrSaturation = 100,
    hdrMidGray = 25, hdrNits = 1000, outDir, segments, whole, importBack, baseName, outputName,
    parallel = false, concurrency = 2 } = opts || {};
  if (!input) return { ok: false, error: t('sourceMissing') };
  if (!outDir) return { ok: false, error: t('outputFolderMissing') };
  const missing = missingRuntime();
  if (missing) return { ok: false, error: missing };
  if ((scale | 0) !== RTX_SCALE) return { ok: false, error: t('rtxScaleFixed') };

  let dims;
  try { dims = await probeMedia(input); } catch (e) { return { ok: false, error: `source illisible : ${String(e)}` }; }
  if (!dims.width || !dims.height) return { ok: false, error: t('videoDimensionsMissing') };
  if (dims.height >= RTX_MAX_INPUT_HEIGHT) return { ok: false, error: t('rtxInputTooLarge') };

  const bin = /** @type {string} */ (rtxBin());
  const customName = typeof outputName === 'string' && outputName.trim();
  const base = sanitizeName(customName || baseName || path.basename(input).replace(/\.[^.]+$/, ''));
  const jobs = (whole || !Array.isArray(segments) || !segments.length)
    ? [{ start: undefined, end: undefined, tag: '' }]
    : segments.map((seg, i) => ({ start: seg.in, end: seg.out, tag: `_plan${i + 1}` }));
  const total = jobs.length;
  const qp = clampQp(quality);
  const nvPreset = NVENC_PRESET[String(preset)] || 'p6';
  const vsr = Math.min(RTX_QUALITY_MAX, Math.max(1, vsrQuality | 0 || RTX_QUALITY_MAX));
  // `false` = TrueHDR coupé ; sinon le bloc de réglages passé tel quel au CLI.
  const trueHdr = hdr && {
    contrast: hdrContrast | 0, saturation: hdrSaturation | 0,
    midGray: hdrMidGray | 0, nits: hdrNits | 0,
  };

  const results = await mapConcurrent(jobs, parallel ? Math.min(4, Math.max(2, concurrency | 0)) : 1, async (j, i) => {
    // Le CLI n'écrit que du HEVC : l'extension suit la réalité du fichier, pas le codec demandé.
    // Le suffixe HDR est porté par le NOM : un master HDR10 mélangé à des SDR se repère à l'œil.
    const suffix = customName ? '' : `_rtx_${RTX_SCALE}x${trueHdr ? '_hdr' : ''}`;
    const out = path.join(outDir, `${base}${suffix}${j.tag}.mp4`);
    if (path.resolve(out).toLowerCase() === path.resolve(input).toLowerCase()) {
      return { ok: false, error: 'le nom de sortie écraserait le fichier source', out };
    }
    const frames = await clipFrames(input, j.start, j.end);
    const args = buildArgs({
      input, out, start: j.start != null ? j.start : null, end: j.end != null ? j.end : null,
      quality: qp, preset: nvPreset, audio: String(audio), abr, vsrQuality: vsr, hdr: trueHdr,
    });
    const r = await runOne(event, bin, args, path.basename(out), i, total, frames);
    return Object.assign({}, r, { out });
  });

  const outputs = [];
  let lastErr = null;
  for (const r of results) {
    if (r.ok) outputs.push(r.out);
    else lastErr = r.error;
  }

  let imported = 0;
  if (importBack && outputs.length) {
    try { const res = await importToMediaPool(outputs); imported = res && res.count ? res.count : 0; } catch (e) {
      console.warn(`[rtx] import Media Pool échoué : ${String(e)}`);
    }
  }
  return { ok: outputs.length > 0, outputs, imported, total, failed: total - outputs.length, encoder: 'hevc_nvenc',
    error: outputs.length ? null : lastErr };
}

module.exports = { runRtxUpscale, missingRuntime, buildArgs, RTX_SCALE, RTX_MAX_INPUT_HEIGHT };
