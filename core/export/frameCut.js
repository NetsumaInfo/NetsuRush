// @ts-check
// Frame-exact cut bounds. A re-encode cuts to the frame with them directly. A stream copy into
// MP4/MOV uses the same seek and then hides its keyframe head and open-GOP tail behind the edit list
// (`editList.js`). A copy into MKV, which has no edit list, still starts on the previous keyframe
// (measured 24-70 extra frames on BluRay rips) and drags 1-2 frames of open GOP; the UI warns about
// it (`export:workflow.remuxWarning`).
//
// Two traps of a naive `-ss start -t duration`:
//  - mkv 1/1000 timebase: the stored pts sometimes rounds BELOW `start`, and the seek then drops the
//    first frame (measured: a 2-frame shot came out with 1);
//  - an end bound in duration lands on the rounding of the last packet → one extra frame.

/**
 * Bornes frame-exactes d'un ré-encodage : seek à −¼ de frame (la frame visée reste au-dessus, la
 * précédente reste en dessous) et fin bornée en NOMBRE DE FRAMES, seule limite exacte d'un
 * encodeur — `-t` ne borne que l'audio.
 * @param {number} start @param {number} end @param {number} fps
 * @returns {{ ss: number, duration: number, vframes: number }|null}  null si fps inconnu
 */
function encodeCutBounds(start, end, fps) {
  if (!(fps > 0) || !(end > start)) return null;
  const ss = Math.max(0, start - 0.25 / fps);
  return { ss, duration: end - ss, vframes: Math.max(1, Math.round((end - start) * fps)) };
}

module.exports = { encodeCutBounds };
