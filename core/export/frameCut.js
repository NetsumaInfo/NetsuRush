// @ts-check
// Découpe frame-exacte pour les chemins « remux ». Un `-ss/-t` en copie de flux n'est pas précis :
// le début recule à la keyframe précédente (mesuré : 24 à 70 frames en trop sur des rips BluRay) et
// la fin traîne le GOP ouvert (1-2 frames en trop). Ici on ne copie QUE quand on peut PROUVER
// l'exactitude sur les paquets réels du fichier :
//   1. sonde des paquets vidéo autour de [start, end] (ffprobe -read_intervals, fenêtre bornée —
//      jamais le scan complet du fichier, cf. docs/invariants.md) ;
//   2. copie seulement si une keyframe tombe à ±½ frame du début ET que la fenêtre de sortie ne
//      contient ni frame d'avance (leading pictures d'un GOP ouvert) ni frame de dépassement
//      (ancre B au-delà de la fin) — la fin est bornée en NOMBRE DE PAQUETS (`-frames:v`), pas en
//      durée ;
//   3. sinon → null, et l'appelant ré-encode (seule découpe exacte possible hors keyframe — même
//      arbitrage qu'AMVerge, qui ré-encode aussi dans ce cas).
// La planification (`planPreciseCopy`) est pure et testée unitairement sur des listes de paquets.

const { execFile } = require('node:child_process');
const { ffBin } = require('../config');
const { videoEncodeArgs, containerTagArgs } = require('./encodeArgs');

// Marge de sonde autour du plan : assez pour attraper la keyframe de départ et l'ancre de fin.
const PROBE_MARGIN_S = 1.0;

/**
 * @typedef {{ pts: number, key: boolean }} PacketInfo  paquet vidéo en ORDRE DE DÉCODAGE
 * @typedef {{ snapStart: number, frames: number, duration: number }} PreciseCopyPlan
 */

/**
 * Paquets vidéo (pts + keyframe) d'une fenêtre du fichier, en ordre de décodage.
 * @param {string} input @param {number} from @param {number} to
 * @returns {Promise<PacketInfo[]>}
 */
function probeWindow(input, from, to) {
  const lo = Math.max(0, from);
  const span = Math.max(0.1, to - lo);
  return new Promise((resolve, reject) => {
    execFile(ffBin('ffprobe'), [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0',
      '-read_intervals', `${lo}%+${span}`,
      input,
    ], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      /** @type {PacketInfo[]} */
      const packets = [];
      for (const line of String(stdout).split(/\r?\n/)) {
        const [pts, flags] = line.split(',');
        if (!pts || pts === 'N/A') continue;
        packets.push({ pts: parseFloat(pts), key: (flags || '').includes('K') });
      }
      resolve(packets);
    });
  });
}

/**
 * Plan de copie exacte, ou null si la copie ne PEUT PAS être exacte (→ ré-encoder).
 * Pure : ne touche pas au disque, testée sur des listes de paquets synthétiques.
 * @param {PacketInfo[]} packets  ordre de décodage (sortie de probeWindow)
 * @param {number} start @param {number} end  bornes du plan en secondes
 * @param {number} fps
 * @returns {PreciseCopyPlan|null}
 */
function planPreciseCopy(packets, start, end, fps) {
  if (!Array.isArray(packets) || !packets.length || !(fps > 0) || !(end > start)) return null;
  const tol = 0.5 / fps; // ± ½ frame : immunise l'arrondi pts (timebase mkv 1/1000) et le fps fractionnaire

  // Keyframe la plus proche du début, à ±½ frame. Au-delà, la copie démarrerait sur la mauvaise frame.
  let kIdx = -1;
  let best = tol;
  for (let i = 0; i < packets.length; i++) {
    if (!packets[i].key) continue;
    const d = Math.abs(packets[i].pts - start);
    if (d <= best) { best = d; kIdx = i; }
  }
  if (kIdx < 0) return null;
  const snapStart = packets[kIdx].pts;

  // Dernier paquet voulu : pts < end − ½ frame, en ordre de décodage à partir de la keyframe.
  let lastIdx = -1;
  for (let i = kIdx; i < packets.length; i++) {
    if (packets[i].pts < end - tol) lastIdx = i;
  }
  if (lastIdx < kIdx) return null;

  // La fenêtre gardée [kIdx..lastIdx] doit être EXACTEMENT le plan :
  //  - un paquet pts < snapStart − ½ frame = leading picture d'un GOP ouvert → s'afficherait AVANT ;
  //  - un paquet pts ≥ end − ½ frame = ancre au-delà de la fin → s'afficherait APRÈS ;
  //  - le compte doit être le nombre de frames attendu (VFR, drop frames → on ne promet rien).
  let count = 0;
  for (let i = kIdx; i <= lastIdx; i++) {
    const p = packets[i].pts;
    if (p < snapStart - tol || p >= end - tol) return null;
    count++;
  }
  if (count !== Math.round((end - snapStart) * fps)) return null;

  return { snapStart, frames: count, duration: end - snapStart };
}

/**
 * Plan de copie exacte d'un plan d'un fichier, ou null (→ l'appelant ré-encode).
 * Toute erreur de sonde vaut null : le repli ré-encode est toujours correct.
 * @param {string} input @param {number} start @param {number} end @param {number} fps
 * @returns {Promise<PreciseCopyPlan|null>}
 */
async function planClip(input, start, end, fps) {
  if (!(fps > 0) || !(end > start)) return null;
  try {
    const packets = await probeWindow(input, start - PROBE_MARGIN_S, end + PROBE_MARGIN_S);
    return planPreciseCopy(packets, start, end, fps);
  } catch (_) {
    return null;
  }
}

/**
 * Args ffmpeg d'une copie planifiée. La vidéo est bornée par `-frames:v` (au paquet près) ; `-t`
 * reste pour l'audio (précision ~une trame audio, comme avant).
 * @param {string} input @param {PreciseCopyPlan} plan @param {string[]} map  args -map (vide = défaut ffmpeg)
 * @param {string} out
 * @returns {string[]}
 */
function copyArgs(input, plan, map, out) {
  return [
    '-y', '-ss', String(plan.snapStart), '-i', input, ...map,
    '-c', 'copy', '-frames:v', String(plan.frames), '-t', String(plan.duration),
    '-avoid_negative_ts', 'make_zero', out,
  ];
}

/**
 * Bornes d'un RÉ-ENCODAGE frame-exact. Deux pièges d'un `-ss start -t durée` naïf :
 *  - timebase mkv 1/1000 : le pts stocké s'arrondit parfois SOUS `start` → la première frame est
 *    jetée par le seek (mesuré : plan de 2 frames sorti à 1). Seek à −¼ de frame : la frame visée
 *    reste au-dessus, la précédente (à −1 frame) reste en dessous ;
 *  - la borne de fin en durée retombe sur l'arrondi du paquet limite → la vidéo est bornée en
 *    NOMBRE DE FRAMES (`-frames:v`), seule limite exacte d'un encodeur ; `-t` ne borne que l'audio.
 * @param {number} start @param {number} end @param {number} fps
 * @returns {{ ss: number, duration: number, vframes: number }|null}  null si fps inconnu
 */
function encodeCutBounds(start, end, fps) {
  if (!(fps > 0) || !(end > start)) return null;
  const ss = Math.max(0, start - 0.25 / fps);
  return { ss, duration: end - ss, vframes: Math.max(1, Math.round((end - start) * fps)) };
}

// ---------------------------------------------------------------------------------------------
// Réencapsulage « remux » : quand la copie pure est impossible, ré-encodage complet en restant
// dans le CODEC DE LA SOURCE (pix_fmt et drapeaux couleur recopiés). Le codec du PROFIL ne sert
// jamais ici : un remux ne change pas de codec.
// ---------------------------------------------------------------------------------------------

/** exec ffmpeg local (frameCut ne peut pas requérir ../ffmpeg : cycle via capabilities). */
function runFf(args) {
  return new Promise((resolve, reject) => {
    execFile(ffBin('ffmpeg'), args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; return reject(err); }
      resolve(stdout);
    });
  });
}

/**
 * Flux vidéo de la source : codec, pix_fmt et drapeaux couleur (à recopier sur tout ré-encodage —
 * invariant colorspace : un bt709 non re-signalé sort plus foncé chez certains lecteurs).
 * @param {string} input
 * @returns {Promise<{ codec: string, pixFmt: string, colorSpace: string, colorPrimaries: string, colorTrc: string }>}
 */
function probeSourceVideo(input) {
  return new Promise((resolve, reject) => {
    execFile(ffBin('ffprobe'), [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,pix_fmt,color_space,color_primaries,color_transfer',
      '-of', 'default=nw=1', input,
    ], { maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      /** @type {Record<string, string>} */
      const kv = {};
      for (const line of String(stdout).split(/\r?\n/)) {
        const i = line.indexOf('=');
        if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1);
      }
      const clean = (v) => (v && v !== 'unknown' && v !== 'N/A' ? v : '');
      resolve({
        codec: clean(kv.codec_name), pixFmt: clean(kv.pix_fmt),
        colorSpace: clean(kv.color_space), colorPrimaries: clean(kv.color_primaries), colorTrc: clean(kv.color_transfer),
      });
    });
  });
}

/**
 * Codec id du vocabulaire d'export (encodeArgs) équivalent au flux source, ou null (codec sans
 * ré-encodage same-codec — le remux retombe alors sur l'encodage au codec du profil).
 * @param {string} codec @param {string} pixFmt @returns {string|null}
 */
function matchSourceCodecId(codec, pixFmt) {
  const is10 = /10[lb]e$/.test(pixFmt);
  const is12 = /12[lb]e$/.test(pixFmt);
  const sub = /444/.test(pixFmt) ? '444' : /422/.test(pixFmt) ? '422' : '420';
  if (codec === 'h264') {
    if (sub === '444') return 'h264_high444';
    if (sub === '422') return 'h264_high422';
    return is10 ? 'h264_high10' : 'h264_high';
  }
  if (codec === 'hevc') {
    if (sub === '444') return is10 ? 'h265_main444_10' : 'h265_main444';
    if (sub === '422') return 'h265_main422_10';
    if (is12) return 'h265_main12';
    return is10 ? 'h265_main10' : 'h265_main';
  }
  if (codec === 'av1') return is10 ? 'av1_main10' : 'av1_main';
  if (codec === 'vp9') return is10 ? 'vp9_10' : 'vp9';
  return null; // prores/dnxhd/ffv1… : intra-only, la copie pure suffit toujours
}

/** Drapeaux couleur à recopier sur un ré-encodage (vides si la source ne les signale pas). */
function colorArgs(src) {
  const args = [];
  if (src.colorSpace) args.push('-colorspace', src.colorSpace);
  if (src.colorPrimaries) args.push('-color_primaries', src.colorPrimaries);
  if (src.colorTrc) args.push('-color_trc', src.colorTrc);
  return args;
}

/**
 * Réencapsulage frame-exact d'un plan, au CODEC DE LA SOURCE : copie pure prouvée, sinon
 * ré-encodage complet same-codec. Rend le mode utilisé, ou null si le same-codec est impossible
 * (pas d'encodeur pour ce codec — ex. HEVC sans encodeur matériel : libx265 ne se déclenche
 * jamais automatiquement) : l'appelant décide de son propre repli (codec du profil).
 * @param {string} input @param {number} start @param {number} end @param {string} out
 * @param {{ fps: number, audioMap?: string[], faststart?: boolean,
 *           pickEncoder?: (codecId: string) => Promise<string|null> }} opts
 * @returns {Promise<'copy'|'encode'|null>}
 */
async function cutRemux(input, start, end, out, opts) {
  const fps = opts.fps;
  if (!(fps > 0) || !(end > start)) return null;
  const audioMap = opts.audioMap || [];
  const packets = await probeWindow(input, start - PROBE_MARGIN_S, end + PROBE_MARGIN_S).catch(() => []);

  // 1. Copie pure prouvée exacte : le vrai remux, zéro pixel touché.
  const full = planPreciseCopy(packets, start, end, fps);
  if (full) {
    await runFf(copyArgs(input, full, audioMap, out));
    return 'copy';
  }

  // Ré-encodage same-codec requis : codec id + encodeur.
  const src = await probeSourceVideo(input).catch(() => null);
  const codecId = src ? matchSourceCodecId(src.codec, src.pixFmt) : null;
  if (!codecId) return null;
  const encoder = opts.pickEncoder ? await opts.pickEncoder(codecId).catch(() => null) : null;
  if (src.codec === 'hevc' && !encoder) return null; // jamais libx265 automatiquement (invariant)
  const vArgs = [...videoEncodeArgs(codecId, encoder, 'quality'), ...colorArgs(src)];

  // Le smart cut « tête ré-encodée + copie concaténée » (AMVerge) a été ESSAYÉ et retiré : mesuré
  // corrompu sur flux réels — SPS/PPS de l'encodeur incompatibles avec le flux copié, et la
  // « keyframe » de reprise est souvent un I de récupération open-GOP (pas un IDR), donc le
  // décodeur traîne l'état de la tête (« Missing reference picture », POC en vrac). La voie annexB
  // (SPS in-band) corrompt pareil. Ne pas re-tenter sans un vrai outil bitstream.

  // 2. Ré-encodage complet, toujours au codec de la source (un remux ne change pas de codec).
  const b = encodeCutBounds(start, end, fps);
  const ext = (out.split('.').pop() || '').toLowerCase();
  const cut = (audioArgs) => runFf(['-y', '-ss', String(b.ss), '-i', input,
    '-t', String(b.duration), '-frames:v', String(b.vframes),
    ...audioMap, ...vArgs, ...audioArgs, ...containerTagArgs(codecId, ext),
    ...(opts.faststart ? ['-movflags', '+faststart'] : []),
    '-avoid_negative_ts', 'make_zero', out]);
  try { await cut(['-c:a', 'copy']); }
  catch (_) { await cut(['-c:a', 'aac', '-b:a', '192k']); } // le conteneur refuse la piste copiée
  return 'encode';
}

module.exports = {
  planClip, planPreciseCopy, copyArgs, encodeCutBounds, probeWindow,
  cutRemux, matchSourceCodecId, probeSourceVideo,
};
