// @ts-check
// Préparation des médias avant import AE : transcode/remux/réencode frame-exact, extraction de freeze
// frame en still, bake de vitesse (setpts/atempo), extraction audio. Renvoie les calques prêts à poser.

const path = require('path');
const { sanitizeName: sanitize } = require('../utils');
const { atempoChain, uniquePath, isImagePath, aeFormat } = require('./codecs');

/**
 * @param {{ run: (bin: string, args: string[]) => Promise<any> }} deps
 * @param {any} event
 * @param {import('./types').EditOk} edit
 * @param {any} opts
 * @returns {Promise<import('./types').PreparedClip[]>}
 */
async function prepareMedia(deps, event, edit, opts) {
  const { run } = deps;
  const { videoMode, audio, abr, handleSec, outDir, bake, fps } = opts;
  // Vocabulaire de codecs injectable : AE par défaut, profils d'export pour NetsuBridge.
  const fmt = opts.format || aeFormat(opts);
  const items = audio === 'none' ? edit.items.filter((c) => c.kind !== 'audio') : edit.items;
  const total = items.length;
  let done = 0;
  const emit = (label) => {
    if (event && event.sender) {
      event.sender.send('ae:progress', { phase: label, done, total, pct: total ? Math.round((done / total) * 100) : 100 });
    }
  };

  const cache = new Map();
  const out = [];
  const baseName = (c) => sanitize(path.parse(c.name || path.basename(c.path)).name);

  // Lance ffmpeg ; si le conteneur refuse le codec audio source (-c:a copy d'un flac dans .mov →
  // « flac only supported in MP4 »), retombe sur un réencode AAC. `pre`/`aArgs`/`post` séparent
  // l'audio pour pouvoir le remplacer au retry. aMode 'none' → pas de retry (pas d'audio).
  async function runAudioSafe(pre, aArgs, post, aMode) {
    try { await run('ffmpeg', [...pre, ...aArgs, ...post]); }
    catch (e) {
      if (aMode === 'none' || !/copy/.test(aArgs.join(' '))) throw e;
      await run('ffmpeg', [...pre, '-c:a', 'aac', '-b:a', `${abr || 192}k`, ...post]);
    }
  }

  // Format audio choisi (timeline imbriquée audio seule) → conteneur importable AE, extrait fiable.
  const A_FMT = {
    wav:  ['wav',  ['-c:a', 'pcm_s16le']],
    aiff: ['aiff', ['-c:a', 'pcm_s16be']],
    aac:  ['m4a',  ['-c:a', 'aac', '-b:a', `${abr || 192}k`]],
  };

  async function prepAudio(c) {
    if (c.aFmt) {
      const [ext, args] = A_FMT[c.aFmt] || A_FMT.wav;
      const key = `afmt|${c.path}|${c.srcIn}|${c.srcOut}|${c.aFmt}`;
      let file = cache.get(key);
      if (!file) {
        file = uniquePath(outDir, baseName(c), ext);
        const ss = c.srcIn / c.fpsClip;
        const dur = (c.srcOut - c.srcIn + 1) / c.fpsClip;
        await run('ffmpeg', ['-y', '-ss', String(ss), '-i', c.path, '-t', String(dur), '-vn', ...args, file]);
        cache.set(key, file);
      }
      return { ...c, file, fileInFrame: 0 };
    }
    if (c.rendered || !fmt.producesAudio) return { ...c, file: c.path, fileInFrame: c.srcIn };
    const key = `audio|${c.path}|${audio}|${fmt.audioOnly.ext}`;
    let file = cache.get(key);
    if (!file) {
      file = uniquePath(outDir, baseName(c), fmt.audioOnly.ext);
      await runAudioSafe(['-y', '-i', c.path, '-vn'], fmt.audioOnly.args, [file], audio);
      cache.set(key, file);
    }
    return { ...c, file, fileInFrame: c.srcIn };
  }

  async function prepVideo(c) {
    // Images / plans rendus (timeline imbriquée) : jamais retouchés → liés tels quels.
    if (c.rendered || isImagePath(c.path)) return { ...c, file: c.path, fileInFrame: c.srcIn };

    // Freeze frame (Resolve : 1 frame source tenue) → extrait CETTE frame en image, AE la tient en
    // still sur toute l'occupation. Sinon on lirait N frames mobiles au lieu de figer.
    if (c.freeze && outDir) {
      const file = uniquePath(outDir, baseName(c), 'png');
      await run('ffmpeg', ['-y', '-ss', String((c.srcIn + 0.5) / c.fpsClip), '-i', c.path, '-frames:v', '1', file]);
      return { ...c, file, fileInFrame: 0, freezeStill: true };
    }

    const vExt = fmt.ext;
    const map = ['-map', '0:v:0', '-map', '0:a?'];   // exclut sous-titres / data (incompatibles mov)

    // bake : réencode trimmé au CUT exact + vitesse cuite (setpts). Le fichier joue à la vitesse
    // timeline → AE le pose 1:1 (pas de time-remap). Les transforms spatiales restent posées dans AE.
    if (bake) {
      const srcDur = (c.srcOut - c.srcIn + 1) / c.fpsClip;
      const occ = (c.tlEnd - c.tlStart) / fps;
      const K = (srcDur > 0 && occ > 0) ? occ / srcDur : 1;          // facteur PTS (>1 = ralenti)
      const changed = Math.abs(K - 1) > 1e-3;
      const vf = changed ? ['-vf', `setpts=${K.toFixed(6)}*PTS`] : [];
      const aArgs = audio === 'none' ? ['-an']
        : changed ? ['-filter:a', atempoChain(1 / K), '-c:a', 'aac', '-b:a', `${abr || 192}k`]
        : fmt.audioArgs;
      const file = uniquePath(outDir, baseName(c), vExt);
      await runAudioSafe(['-y', '-ss', String(c.srcIn / c.fpsClip), '-i', c.path, '-t', String(srcDur), ...map, ...vf, ...fmt.videoArgs], aArgs, [file], audio);
      return { ...c, file, fileInFrame: 0, baked: true, bakedDur: occ };
    }

    // Copie simple : lien du fichier source entier, découpe dans AE.
    if (videoMode === 'copy') return { ...c, file: c.path, fileInFrame: c.srcIn };

    // Pas de remux pour les plans issus d'une timeline imbriquée → liés tels quels (source).
    if (videoMode === 'remux' && c.nested) return { ...c, file: c.path, fileInFrame: c.srcIn };

    if (videoMode === 'remux') {
      const key = `video|${c.path}|${audio}|${vExt}`;
      let file = cache.get(key);
      if (!file) {
        file = uniquePath(outDir, baseName(c), vExt);
        await runAudioSafe(['-y', '-i', c.path, ...map, '-c:v', 'copy'], fmt.audioArgs, ['-movflags', '+faststart', file], audio);
        cache.set(key, file);
      }
      return { ...c, file, fileInFrame: c.srcIn };
    }

    // Réencode frame-exact. `-ss` AVANT `-i` = seek rapide sur keyframe puis l'encodeur démarre PILE
    // à l'in (frame-accurate, cf. limite ffmpeg : seul le réencode coupe à la frame). Le seek vise le
    // MILIEU de la frame de départ (+0.5/fps) → immunise contre l'arrondi du fps (ex 23.976 vs 24000/1001).
    const handleF = Math.round((handleSec || 0) * c.fpsClip);
    const maxF = c.srcFrames > 0 ? c.srcFrames - 1 : c.srcOut + handleF;
    const startF = Math.max(0, c.srcIn - handleF);
    const endF = Math.min(maxF, c.srcOut + handleF);
    const ss = (startF + 0.5) / c.fpsClip;
    const dur = (endF - startF + 1) / c.fpsClip;
    const file = uniquePath(outDir, baseName(c), vExt);
    await runAudioSafe(['-y', '-ss', String(ss), '-i', c.path, '-t', String(dur), ...map, ...fmt.videoArgs], fmt.audioArgs, [file], audio);
    return { ...c, file, fileInFrame: c.srcIn - startF };
  }

  for (const c of items) {
    out.push(c.kind === 'audio' ? await prepAudio(c) : await prepVideo(c));
    done++; emit(videoMode === 'reencode' ? 'Réencode' : videoMode === 'remux' ? 'Remux' : 'Préparation');
  }
  return out;
}

module.exports = { prepareMedia };
