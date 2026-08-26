// @ts-check
// Bornes de découpe d'un RÉ-ENCODAGE. Seul le ré-encodage coupe à la frame : une copie de flux
// (`-c copy`, flux « remux ») démarre à la keyframe précédente du conteneur — mesuré 24 à 70 frames
// en trop en tête sur des rips BluRay — et sa fin traîne les paquets du GOP ouvert (1-2 frames).
// C'est une limite de format, pas de ffmpeg : les frames entre la keyframe et le point de coupe ne
// se décodent pas sans elle. Arbitrage produit : le remux reste une copie pure et l'UI avertit
// (`export:workflow.remuxWarning`) ; qui veut la frame exacte prend un profil de ré-encodage.
//
// Le ré-encodage, lui, doit être exact — deux pièges d'un `-ss start -t durée` naïf :
//  - timebase mkv 1/1000 : le pts stocké s'arrondit parfois SOUS `start`, la première frame est
//    alors jetée par le seek (mesuré : plan de 2 frames sorti à 1) ;
//  - la borne de fin en durée retombe sur l'arrondi du paquet limite → une frame en trop.

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
