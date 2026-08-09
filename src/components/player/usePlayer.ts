import { useCallback, useRef } from "react";

// Mémoire partagée entre les instances de lecteur : le bouton muet peut être utilisé depuis
// n'importe quel lecteur et la réactivation restaure le dernier volume global audible.
let globalLastVolume = 0.2;

// Hooks partagés par les lecteurs `<video>` faits main (ScenePlayer, UpscalePlayer).
// On factorise ICI la mécanique commune — état de volume/muet et scrub par pointer-capture —
// sans toucher au montage du `<video>` ni aux spécificités (proxy HEVC muet par défaut,
// plage in/out, flux remux). Les bornes et la frame-math restent paramétrables par appelant.

/**
 * État de volume + bascule muet (mémorise le dernier volume non nul pour le restaurer).
 * `volume`/`setVolume` peuvent venir d'un parent (persistance d'un clip à l'autre) ou être locaux.
 */
export function useVolumeState(volume: number, setVolume: (v: number) => void) {
  const lastVol = useRef(1); // dernier volume non nul, pour la bascule muet

  const toggleMute = useCallback(() => {
    if (volume > 0) { lastVol.current = volume; globalLastVolume = volume; setVolume(0); }
    else setVolume(globalLastVolume || lastVol.current || 0.2);
  }, [volume, setVolume]);

  // À câbler sur l'onChange du slider : garde la mémoire du dernier volume audible.
  const onVolumeChange = useCallback((v: number) => {
    if (v > 0) { lastVol.current = v; globalLastVolume = v; }
    setVolume(v);
  }, [setVolume]);

  return { toggleMute, onVolumeChange };
}

/**
 * Scrub interactif sur une barre (div à largeur) : pointer-capture + clamp [0,1] → temps.
 * `barRef` = la barre cliquable ; `seekToRatio(r)` reçoit la position 0..1 et applique le seek.
 * `onActiveChange` (optionnel) suit l'état « en cours de scrub » pour l'UI (ex. afficher la barre).
 * Pause pendant le drag et reprise après si la vidéo jouait — géré par l'appelant via les
 * callbacks `onStart`/`onEnd` (qui reçoivent l'état lecture mémorisé).
 */
export function useVideoScrubber(opts: {
  barRef: React.RefObject<HTMLDivElement | null>;
  seekToRatio: (r: number) => void;
  isPlaying: () => boolean;
  onPause: () => void;
  onResume: () => void;
  onActiveChange?: (active: boolean) => void;
}) {
  const { barRef, seekToRatio, isPlaying, onPause, onResume, onActiveChange } = opts;
  const dragging = useRef(false);
  const wasPlaying = useRef(false);

  const seekToX = useCallback((clientX: number) => {
    const bar = barRef.current;
    if (!bar) return;
    const rect = bar.getBoundingClientRect();
    const r = rect.width > 0 ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) : 0;
    seekToRatio(r);
  }, [barRef, seekToRatio]);

  const onScrubDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId); // suit le pointeur même hors de la barre
    wasPlaying.current = isPlaying();
    onPause();
    dragging.current = true;
    onActiveChange?.(true);
    seekToX(e.clientX);
  }, [isPlaying, onPause, onActiveChange, seekToX]);

  const onScrubMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (dragging.current) seekToX(e.clientX);
  }, [seekToX]);

  const onScrubUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    dragging.current = false;
    onActiveChange?.(false);
    if (wasPlaying.current) onResume();
  }, [onActiveChange, onResume]);

  return { onScrubDown, onScrubMove, onScrubUp };
}
