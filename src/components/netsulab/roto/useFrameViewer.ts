import { useCallback, useEffect, useRef, useState } from "react";
import { nr } from "@/lib/bridge";

// Visionneuse de frames extraites (JPEG servies en /media). Cache LRU d'images DÉCODÉES → un scrub
// aller-retour réutilise l'image déjà décodée (instantané, zéro re-décodage). Préchargement large en
// AVANT (lecture fluide) + court en arrière. Lecture pilotée par le temps réel (rAF, cadence = fps).
// L'extraction tourne EN THREAD côté python : une frame pas encore écrite renvoie une erreur de
// chargement → re-tentée (400 ms) tant qu'elle est dans la plage. Lecture J/K/L : sens ± et vitesse
// cumulée (rappuyer J/L accélère ×2, jusqu'à ×8).
const CACHE_MAX = 200;
const AHEAD = 16;   // frames préchargées devant (couvre la lecture)
const BEHIND = 4;
const RETRY_MS = 400;

const frameUrl = (dir: string, f: number) => nr.mediaUrl(`${dir}/${String(f).padStart(5, "0")}.jpg`);

export function useFrameViewer(
  dir: string | null, frame: number, setFrame: (f: number) => void, nbFrames: number, fps: number,
) {
  const [shown, setShown] = useState<string | null>(null);   // dernière image décodée (double-buffer)
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(0);                     // 0 = arrêt ; ±1, ±2, ±4, ±8 (J/K/L)
  const cache = useRef<Map<number, HTMLImageElement>>(new Map());
  const frameRef = useRef(frame);
  useEffect(() => { frameRef.current = frame; }, [frame]);
  const playRef = useRef(0);      // vitesse signée en cours (0 = stop)
  const raf = useRef(0);
  const last = useRef(0);
  const acc = useRef(0);
  const retry = useRef(0);

  // Change de source → vide le cache et coupe la lecture.
  useEffect(() => {
    cache.current.clear(); setShown(null); setPlaying(false); setSpeed(0); playRef.current = 0;
    clearTimeout(retry.current);
  }, [dir]);

  // Charge (ou récupère du cache) l'image d'une frame ; met à jour l'ordre LRU. Une frame pas
  // encore extraite (404) est retirée du cache → le prochain ensure() la retente.
  const ensure = useCallback((f: number): HTMLImageElement | null => {
    if (!dir || f < 0 || f >= nbFrames) return null;
    const c = cache.current;
    const hit = c.get(f);
    if (hit) { c.delete(f); c.set(f, hit); return hit; }   // touch LRU
    const im = new Image();
    im.onerror = () => { if (cache.current.get(f) === im) cache.current.delete(f); };
    im.src = frameUrl(dir, f);
    c.set(f, im);
    if (c.size > CACHE_MAX) { const oldest = c.keys().next().value; if (oldest !== undefined) c.delete(oldest); }
    return im;
  }, [dir, nbFrames]);

  // Affiche la frame courante dès qu'elle est décodée + précharge la fenêtre autour.
  useEffect(() => {
    if (!dir) return;
    clearTimeout(retry.current);
    const cleanups: Array<() => void> = [];
    const attempt = () => {
      const im = ensure(frame);
      if (!im) return;
      const apply = () => { if (frameRef.current === frame) setShown(im.src); };
      if (im.complete && im.naturalWidth) apply();
      else {
        im.addEventListener("load", apply, { once: true });
        cleanups.push(() => im.removeEventListener("load", apply));
        // Extraction en cours : la frame n'existe pas encore → nouvelle tentative dans 400 ms.
        const onError = () => {
          retry.current = window.setTimeout(() => { if (frameRef.current === frame) attempt(); }, RETRY_MS);
        };
        im.addEventListener("error", onError, { once: true });
        cleanups.push(() => im.removeEventListener("error", onError));
      }
      for (let d = 1; d <= AHEAD; d++) ensure(frame + d);
      for (let d = 1; d <= BEHIND; d++) ensure(frame - d);
    };
    attempt();
    return () => { clearTimeout(retry.current); cleanups.forEach((fn) => fn()); };
  }, [dir, frame, ensure]);

  const stop = useCallback(() => {
    playRef.current = 0; setPlaying(false); setSpeed(0);
    cancelAnimationFrame(raf.current); last.current = 0; acc.current = 0;
  }, []);

  const tick = useCallback((t: number) => {
    const sp = playRef.current;
    if (!sp) return;
    if (!last.current) last.current = t;
    acc.current += ((t - last.current) / 1000) * (fps || 24) * sp;
    last.current = t;
    const whole = acc.current >= 0 ? Math.floor(acc.current) : Math.ceil(acc.current);
    if (whole !== 0) {
      acc.current -= whole;
      const next = frameRef.current + whole;
      if (next >= nbFrames - 1) { setFrame(nbFrames - 1); stop(); return; }
      if (next <= 0) { setFrame(0); stop(); return; }
      setFrame(next);
    }
    raf.current = requestAnimationFrame(tick);
  }, [fps, nbFrames, setFrame, stop]);

  // Lance/cumule la lecture dans un sens (L = avant, J = arrière) : rappuyer double la vitesse.
  const playDir = useCallback((dir1: 1 | -1) => {
    if (nbFrames < 2) return;
    const cur = playRef.current;
    const next = Math.sign(cur) === dir1 ? Math.min(8, Math.abs(cur) * 2) * dir1 : dir1;
    if (dir1 > 0 && frameRef.current >= nbFrames - 1) setFrame(0);
    if (dir1 < 0 && frameRef.current <= 0) setFrame(nbFrames - 1);
    playRef.current = next; setPlaying(true); setSpeed(next);
    cancelAnimationFrame(raf.current); last.current = 0; acc.current = 0;
    raf.current = requestAnimationFrame(tick);
  }, [nbFrames, tick, setFrame]);

  const play = useCallback(() => playDir(1), [playDir]);
  const togglePlay = useCallback(() => { if (playRef.current) stop(); else play(); }, [play, stop]);

  useEffect(() => () => { cancelAnimationFrame(raf.current); clearTimeout(retry.current); }, []);

  return { shown, playing, speed, togglePlay, playDir, stop };
}
