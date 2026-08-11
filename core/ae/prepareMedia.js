// @ts-check
// Préparation des médias avant import AE : transcode/remux/réencode frame-exact, extraction de freeze
// frame en still, bake de vitesse (setpts/atempo), extraction audio. Renvoie les calques prêts à poser.

const fs = require('fs');
const path = require('path');
const { sanitizeName: sanitize } = require('../utils');
const {
  atempoChain, uniquePath, isImagePath, aeFormat, audioOutExt, outAudioCodec, videoOutExt,
  streamCodecName,
} = require('./codecs');
const { bakeGraph, carriesAlpha } = require('./bakeTransform');

/**
 * @param {{ run: (bin: string, args: string[]) => Promise<any> }} deps
 * @param {any} event
 * @param {import('./types').EditOk} edit
 * @param {any} opts
 * @returns {Promise<import('./types').PreparedClip[]>}
 */
async function prepareMedia(deps, event, edit, opts) {
  const { run } = deps;
  const { videoMode, audio, abr, handleSec, outDir, bake, fps, upscale } = opts;
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
  const notes = Array.isArray(opts.notes) ? opts.notes : [];
  const baseName = (c) => sanitize(path.parse(c.name || path.basename(c.path)).name);

  // Ce que porte RÉELLEMENT la source : codecs (le remux ne convertit rien, c'est ce couple-là qui
  // doit entrer dans le conteneur) et dimensions (la cuisson du cadrage en dépend, et Resolve ne
  // rend pas toujours la propriété « Resolution »). Sondé une fois par fichier ; une sonde muette
  // n'impose aucune contrainte, plutôt que d'en déduire une d'une lecture ratée.
  const probes = new Map();
  async function sourceCodecs(file) {
    if (probes.has(file)) return probes.get(file);
    let found = { video: null, audio: null, width: 0, height: 0 };
    try {
      const raw = await run('ffprobe', ['-v', 'error',
        '-show_entries', 'stream=codec_type,codec_name,width,height', '-of', 'json', file]);
      for (const stream of (JSON.parse(String(raw)).streams || [])) {
        if (stream.codec_type === 'video' && !found.video) {
          found.video = String(stream.codec_name || '');
          found.width = Number(stream.width) || 0;
          found.height = Number(stream.height) || 0;
        }
        if (stream.codec_type === 'audio' && !found.audio) found.audio = String(stream.codec_name || '');
      }
    } catch (_) { found = { video: null, audio: null, width: 0, height: 0 }; }
    probes.set(file, found);
    return found;
  }

  function noteContainer(clip, wanted, used) {
    if (wanted === used) return;
    notes.push({ clip: clip.name || path.basename(clip.path), wanted, used });
    console.warn(`[ae] conteneur ${String(wanted).toUpperCase()} impossible pour ${clip.name || clip.path} → ${used.toUpperCase()}`);
  }

  // Un ffmpeg qui échoue laisse un fichier TRONQUÉ, qu'un `uniquePath` suivant compte comme pris
  // et qu'un import prendrait pour le média préparé.
  function discard(file) {
    try { if (file && fs.existsSync(file)) fs.unlinkSync(file); } catch (_) {}
  }

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
    // Le PCM d'un rush ProRes n'entre pas en M4A : il sort en WAV, sans transcode inutile.
    const src = await sourceCodecs(c.path);
    const ext = audioOutExt(fmt.audioOnly.ext, outAudioCodec(audio, src.audio));
    noteContainer(c, fmt.audioOnly.ext, ext);
    const key = `audio|${c.path}|${audio}|${ext}`;
    let file = cache.get(key);
    if (!file) {
      file = uniquePath(outDir, baseName(c), ext);
      try { await runAudioSafe(['-y', '-i', c.path, '-vn'], fmt.audioOnly.args, [file], audio); }
      catch (e) { discard(file); throw e; }
      cache.set(key, file);
    }
    return { ...c, file, fileInFrame: c.srcIn };
  }

  /**
   * Upscale d'un plan par le moteur de NetsuLab. Il REMPLACE le réencode : il découpe et encode
   * lui-même, alors un réencode ffmpeg avant lui ne ferait que perdre une génération.
   * `whole` = le fichier d'entrée EST déjà le plan (cuisson de cadrage en amont, ou timeline
   * imbriquée rendue) : plus rien à découper.
   */
  async function upscaleClip(c, input, whole) {
    const file = uniquePath(outDir, baseName(c), upscale.ext || 'mp4');
    const segments = whole ? [] : [{ in: c.srcIn / c.fpsClip, out: (c.srcOut + 1) / c.fpsClip }];
    let result = null;
    try {
      result = await upscale.run({
        ...upscale.args, ...upscale.encoding,
        input, savePath: file, outDir, baseName: baseName(c),
        whole: !!whole, segments, importBack: false,
      });
    } catch (e) { discard(file); throw e; }
    if (!result || !result.ok) {
      discard(file);
      throw new Error(`upscale : ${(result && result.error) || 'échec'}`);
    }
    const out = (Array.isArray(result.outputs) && result.outputs[0]) || file;
    // Le fichier produit est le plan entier, à sa propre longueur : les bornes repartent de zéro.
    return { ...c, file: out, fileInFrame: 0 };
  }

  async function prepVideo(c) {
    // Images : jamais transcodées (elles resteraient des vidéos) → liées telles quelles.
    if (isImagePath(c.path)) return { ...c, file: c.path, fileInFrame: c.srcIn };
    // Plans déjà rendus (timeline imbriquée, cuisson Resolve) : le fichier EST le plan. Rien à
    // retoucher — sauf l'upscale, qui s'applique sur l'image finale.
    if (c.rendered) {
      return upscale ? upscaleClip(c, c.path, true) : { ...c, file: c.path, fileInFrame: c.srcIn };
    }

    // Freeze frame (Resolve : 1 frame source tenue) → extrait CETTE frame en image, AE la tient en
    // still sur toute l'occupation. Sinon on lirait N frames mobiles au lieu de figer.
    if (c.freeze && outDir) {
      const file = uniquePath(outDir, baseName(c), 'png');
      await run('ffmpeg', ['-y', '-ss', String((c.srcIn + 0.5) / c.fpsClip), '-i', c.path, '-frames:v', '1', file]);
      return { ...c, file, fileInFrame: 0, freezeStill: true };
    }

    const map = ['-map', '0:v:0', '-map', '0:a?'];   // exclut sous-titres / data (incompatibles mov)

    // Conteneur décidé sur les flux RÉELLEMENT écrits : le codec SOURCE en remux (rien n'est
    // converti), le codec choisi en réencode/bake. Un ProRes réencapsulé en MP4 est refusé au
    // muxage. Sondé seulement quand un fichier est produit.
    async function extFor(copied) {
      const src = await sourceCodecs(c.path);
      const written = copied ? src.video : streamCodecName(opts.codec);
      const ext = videoOutExt(fmt.ext, written, outAudioCodec(audio, src.audio));
      noteContainer(c, fmt.ext, ext);
      return ext;
    }

    // bake : réencode trimmé au CUT exact, vitesse ET cadrage cuits dans le fichier. Le plan joue à
    // la vitesse timeline et arrive déjà cadré → AE le pose 1:1, sans time-remap ni transform.
    // Une propriété ANIMÉE n'est pas cuite : une image clé rendue en valeur fixe figerait le
    // mouvement. Elle reste alors sur le calque AE, avec le reste du transform.
    if (bake) {
      const srcDur = (c.srcOut - c.srcIn + 1) / c.fpsClip;
      const occ = (c.tlEnd - c.tlStart) / fps;
      const K = (srcDur > 0 && occ > 0) ? occ / srcDur : 1;          // facteur PTS (>1 = ralenti)
      const changed = Math.abs(K - 1) > 1e-3;
      const setpts = changed ? `${K.toFixed(6)}*PTS` : null;
      // Dimensions de la source : celles lues sur le Media Pool, sinon celles du FICHIER. Resolve
      // ne rend pas toujours sa propriété « Resolution » (mesuré à vide sur des rushs valides), et
      // sans elles il n'y a pas de cadrage à calculer.
      const probed = await sourceCodecs(c.path);
      const srcW = c.srcWidth || probed.width;
      const srcH = c.srcHeight || probed.height;
      const graph = c.anim ? null : bakeGraph({
        srcW, srcH, compW: opts.compW, compH: opts.compH,
        xf: c.xf, alpha: carriesAlpha(opts.codec), setpts,
      });
      if (c.xf && !graph) {
        // Un cadrage non cuit se retrouve posé dans AE : indiscernable d'un mode ignoré.
        console.warn(`[ae] cadrage non cuit pour ${c.name || c.path} :`,
          c.anim ? 'propriétés animées' : (srcW && srcH ? 'transform identité' : 'dimensions source inconnues'));
      }
      const vf = graph ? [] : (setpts ? ['-vf', `setpts=${setpts}`] : []);
      const aArgs = audio === 'none' ? ['-an']
        : changed ? ['-filter:a', atempoChain(1 / K), '-c:a', 'aac', '-b:a', `${abr || 192}k`]
        : fmt.audioArgs;
      const file = uniquePath(outDir, baseName(c), await extFor(false));
      const pre = ['-y', '-ss', String(c.srcIn / c.fpsClip), '-i', c.path,
        ...(graph ? graph.inputs : []), '-t', String(srcDur),
        ...(graph ? [...graph.filter, ...graph.map] : [...map, ...vf]), ...fmt.videoArgs];
      try { await runAudioSafe(pre, aArgs, [file], audio); }
      catch (e) { discard(file); throw e; }
      const cooked = { ...c, file, fileInFrame: 0, baked: true, bakedDur: occ, xfBaked: !!graph };
      // Upscale APRÈS la cuisson : le cadrage doit être dans l'image avant qu'on en refasse les
      // pixels, sinon le modèle travaille sur un cadre qui n'est pas celui du rendu.
      if (!upscale) return cooked;
      const grown = await upscaleClip(cooked, file, true);
      discard(file);
      return { ...grown, baked: true, bakedDur: occ, xfBaked: !!graph };
    }

    // L'upscale découpe et encode lui-même : il tient lieu de réencode, pour tout le reste.
    if (upscale) return upscaleClip(c, c.path, false);

    // Copie simple : lien du fichier source entier, découpe dans AE.
    if (videoMode === 'copy') return { ...c, file: c.path, fileInFrame: c.srcIn };

    // Pas de remux pour les plans issus d'une timeline imbriquée → liés tels quels (source).
    if (videoMode === 'remux' && c.nested) return { ...c, file: c.path, fileInFrame: c.srcIn };

    if (videoMode === 'remux') {
      const ext = await extFor(true);
      const key = `video|${c.path}|${audio}|${ext}`;
      let file = cache.get(key);
      if (!file) {
        file = uniquePath(outDir, baseName(c), ext);
        try {
          await runAudioSafe(['-y', '-i', c.path, ...map, '-c:v', 'copy'], fmt.audioArgs, ['-movflags', '+faststart', file], audio);
        } catch (e) { discard(file); throw e; }
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
    const file = uniquePath(outDir, baseName(c), await extFor(false));
    try {
      await runAudioSafe(['-y', '-ss', String(ss), '-i', c.path, '-t', String(dur), ...map, ...fmt.videoArgs], fmt.audioArgs, [file], audio);
    } catch (e) { discard(file); throw e; }
    return { ...c, file, fileInFrame: c.srcIn - startF };
  }

  for (const c of items) {
    out.push(c.kind === 'audio' ? await prepAudio(c) : await prepVideo(c));
    done++; emit(videoMode === 'reencode' ? 'Réencode' : videoMode === 'remux' ? 'Remux' : 'Préparation');
  }
  return out;
}

module.exports = { prepareMedia };
