// Pas d'UNE image sur un lecteur du board (vidéo locale, vidéo en ligne, flux YouTube relayé).
//
// Un pas d'image se lit à l'arrêt : la lecture reprendrait la main avant qu'on ait vu l'image. Le pas
// met donc l'item en pause (`playMode: "off"`) puis déplace la tête de lecture d'exactement 1/fps.
//
// La cadence vient de ffprobe, par le core (`playInfo`) : elle vaut 23,976 et non 24, et HTML5 ne
// l'expose pas. Elle est mémorisée par SOURCE — deux items du même fichier la partagent — hors du
// document, parce que c'est une mesure du fichier et pas un réglage de la planche.

import { nr } from "@/lib/bridge";
import type { BoardItem } from "./referenceShared";
import { playerSeek, playerTime } from "./playhead";
import { useBoard } from "./useReferenceBoard";

const fpsByRef = new Map<string, number>();
// Cadence supposée le temps que la mesure arrive, et cadence définitive d'une source non mesurable
// (lien distant, flux relayé) : le pas reste utilisable, il n'est simplement pas exact.
const FALLBACK_FPS = 25;

// Une source mesurable = un fichier sur disque. Un lien distant ou un blob n'a pas de chemin à sonder.
function measurable(item: BoardItem): boolean {
  return item.kind === "video" && !/^(https?|blob|data):/i.test(item.ref);
}

function fpsFor(item: BoardItem): number {
  const known = fpsByRef.get(item.ref);
  if (known) return known;
  if (measurable(item) && nr.reference?.playInfo) {
    // Mesure lancée sans attendre : ce pas-ci utilise le repli, les suivants la cadence exacte.
    void nr.reference.playInfo(item.ref)
      .then((info) => { if (info && info.fps > 0) fpsByRef.set(item.ref, info.fps); })
      .catch(() => { /* source illisible : le repli reste en vigueur */ });
  }
  return FALLBACK_FPS;
}

/** Avance (`dir` = 1) ou recule (`dir` = -1) d'une image le lecteur de `item`. */
export function stepFrame(item: BoardItem, dir: 1 | -1): void {
  const st = useBoard.getState();
  if ((item.playMode ?? "loop") !== "off") st.patchItem(item.id, { playMode: "off" }, false);
  const at = playerTime(item.id);
  if (at == null) return; // lecteur pas encore monté (item hors écran) : rien à déplacer
  playerSeek(item.id, at + dir / fpsFor(item), false);
}

/** Cadence connue d'une source, ou 0. Sert aux affichages qui veulent la dire, jamais au pas. */
export function knownFps(ref: string): number {
  return fpsByRef.get(ref) ?? 0;
}
