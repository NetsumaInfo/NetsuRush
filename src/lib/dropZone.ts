// Zones de dépôt : le liseré s'allume au survol d'un glissé, et surtout il S'ÉTEINT.
//
// Chaque zone gérait son état à la main, avec `dragleave` pour l'éteindre. Or `dragleave` ne dit pas
// « le glissé est parti » : il tire à CHAQUE passage d'un élément à un autre, y compris vers un
// enfant de la zone. D'où le garde habituel — n'éteindre que si l'événement vise la zone elle-même —
// qui laisse passer tous les cas où le glissé s'achève AILLEURS :
//
//   · le curseur quitte la fenêtre alors qu'il survolait une carte (le `dragleave` vise la carte) ;
//   · l'utilisateur lâche au-dessus d'une autre application, ou annule avec Échap ;
//   · `dragend` ne tire que sur la SOURCE du glissé — pour des fichiers de l'Explorateur, elle est
//     hors de la page, donc il ne tire jamais ici.
//
// Résultat : un liseré allumé pour toujours, comme si un dépôt était en cours. Ici, la fin du glissé
// est décidée par un observateur unique, à l'échelle du document :
//
//   · `drop` ou `dragend` n'importe où → fini, tout de suite ;
//   · `dragleave` sans destination (`relatedTarget` nul) → le curseur a quitté le document → fini ;
//   · faute de `dragover` pendant un instant → fini (filet pour Échap et les cas exotiques : tant
//     qu'un glissé survole la page, le navigateur en émet en continu).
import { useCallback, useEffect, useRef, useState } from "react";

/** Délai sans le moindre `dragover` au-delà duquel on considère le glissé terminé. Large : un glissé
 *  immobile n'émet que quelques `dragover` par seconde, et ce filet ne sert que si tous les signaux
 *  francs ont manqué. */
const IDLE_MS = 800;

type Listener = () => void;
const listeners = new Set<Listener>();
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function endDrag() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  for (const notify of [...listeners]) notify();
}

function onWindowDragOver() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(endDrag, IDLE_MS);
}

function onWindowDragLeave(event: DragEvent) {
  // `relatedTarget` nul = plus aucun élément sous le curseur : le glissé a quitté le document.
  if (!event.relatedTarget) endDrag();
}

// Écouteurs posés une seule fois pour toute l'application, tant qu'une zone est montée. En capture :
// une zone qui arrête la propagation (une rangée de dossier qui garde le dépôt pour elle) ne doit pas
// priver les autres du signal de fin.
function subscribe(listener: Listener): () => void {
  if (!listeners.size) {
    window.addEventListener("dragover", onWindowDragOver, true);
    window.addEventListener("dragleave", onWindowDragLeave, true);
    window.addEventListener("drop", endDrag, true);
    window.addEventListener("dragend", endDrag, true);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    window.removeEventListener("dragover", onWindowDragOver, true);
    window.removeEventListener("dragleave", onWindowDragLeave, true);
    window.removeEventListener("drop", endDrag, true);
    window.removeEventListener("dragend", endDrag, true);
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  };
}

/** Éteint un état de survol quand le glissé se termine, OÙ QU'IL SE TERMINE. Pour les zones qui
 *  gardent leurs propres gestionnaires (logique de dépôt trop particulière pour `useDropZone`) : une
 *  ligne suffit à leur retirer le liseré fantôme, sans rien changer à leur façon de recevoir. */
export function useDragEndReset(clear: () => void): void {
  const clearRef = useRef(clear);
  clearRef.current = clear;
  useEffect(() => subscribe(() => clearRef.current()), []);
}

export interface DropZoneOptions {
  /** Ce glissé concerne-t-il cette zone ? Un glissé interne sans fichier ne doit pas allumer une
   *  zone d'import, sinon elle vole le survol aux cibles qui, elles, savent le recevoir. */
  accept: (dataTransfer: DataTransfer) => boolean;
  /** Curseur montré au survol : « copie » pour un ajout, « déplacement » pour un rangement. */
  effect?: (dataTransfer: DataTransfer) => "copy" | "move";
  onDrop: (event: React.DragEvent) => void;
  /** La zone GARDE le dépôt pour elle (rangée de dossier) : les zones englobantes ne le voient pas. */
  stopPropagation?: boolean;
}

export interface DropZone {
  /** Un glissé recevable survole la zone → à peindre. */
  over: boolean;
  /** À étaler sur l'élément : `<div {...zone.dropProps}>`. */
  dropProps: {
    onDragOver: (event: React.DragEvent) => void;
    onDrop: (event: React.DragEvent) => void;
  };
}

export function useDropZone({ accept, effect, onDrop, stopPropagation = false }: DropZoneOptions): DropZone {
  const [over, setOver] = useState(false);
  // Les trois rappels sont recréés à chaque rendu de l'appelant ; lus par ref, l'abonnement au
  // glissé n'est posé qu'une fois et le survol ne rerend pas le document entier.
  const optsRef = useRef({ accept, effect, onDrop, stopPropagation });
  optsRef.current = { accept, effect, onDrop, stopPropagation };

  useEffect(() => subscribe(() => setOver(false)), []);

  const onDragOver = useCallback((event: React.DragEvent) => {
    const { accept: take, effect: pick, stopPropagation: stop } = optsRef.current;
    if (!take(event.dataTransfer)) return;
    event.preventDefault();
    if (stop) event.stopPropagation();
    event.dataTransfer.dropEffect = pick ? pick(event.dataTransfer) : "copy";
    setOver(true);
  }, []);

  const handleDrop = useCallback((event: React.DragEvent) => {
    const { accept: take, onDrop: drop, stopPropagation: stop } = optsRef.current;
    setOver(false);
    if (!take(event.dataTransfer)) return;
    event.preventDefault();
    if (stop) event.stopPropagation();
    drop(event);
  }, []);

  return { over, dropProps: { onDragOver, onDrop: handleDrop } };
}
