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

module.exports = { planClip, planPreciseCopy, copyArgs, encodeCutBounds, probeWindow };
