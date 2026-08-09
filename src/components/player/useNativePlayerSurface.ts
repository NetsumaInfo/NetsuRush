import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { isTauriRuntime, nativePlayer, type NativePlayerStatus } from "@/lib/nativePlayer";

export interface NativePlayerSurfaceApi {
  play: () => Promise<void>;
  pause: () => Promise<void>;
  toggle: () => Promise<void>;
  seek: (position: number) => Promise<void>;
  frameStep: () => Promise<void>;
  frameBackStep: () => Promise<void>;
  setSpeed: (speed: number) => Promise<void>;
}

interface Options {
  path?: string;
  autoPlay?: boolean;
  loop?: boolean;
  volume: number;
  startAt?: number;
  onTime?: (time: number) => void;
  onDuration?: (duration: number) => void;
  onPlayingChange?: (playing: boolean) => void;
  onEnded?: () => void;
  onError?: () => void;
}

// mpv est une fenêtre native UNIQUE par WebView. Une promesse de géométrie appartenant à une
// ancienne surface ne doit jamais pouvoir la réafficher après que React a démonté cette surface.
let nativeSurfaceLease = 0;

// Frames de stabilisation après activation d'une surface : le temps qu'une entrée de modale
// (~100 ms d'animation) pose sa géométrie définitive, sans jamais installer de boucle permanente.
const SETTLE_FRAMES = 12;

/**
 * Garde la fenêtre mpv alignée sur sa surface DOM, y compris quand la fenêtre
 * Tauri se déplace ou quand un conteneur parent défile sans changer de taille.
 */
export function useNativePlayerGeometry(surfaceRef: RefObject<HTMLDivElement | null>, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const surface = surfaceRef.current;
    if (!surface) return;
    const lease = ++nativeSurfaceLease;
    let raf = 0;
    let alive = true;
    const unlisten: Array<() => void> = [];
    const ownsSurface = () => alive && lease === nativeSurfaceLease;

    const updateGeometry = () => {
      raf = 0;
      if (!ownsSurface()) return;
      const rect = surface.getBoundingClientRect();
      const style = getComputedStyle(surface);
      const visible = surface.isConnected
        && style.display !== "none"
        && style.visibility !== "hidden"
        && rect.width > 1
        && rect.height > 1
        && rect.bottom > 0
        && rect.right > 0
        && rect.top < window.innerHeight
        && rect.left < window.innerWidth;
      if (!visible) {
        nativePlayer.pause().catch(() => {});
        nativePlayer.hide().catch(() => {});
        return;
      }
      const dpr = window.devicePixelRatio || 1;
      nativePlayer.setGeometry(
        Math.round(rect.left * dpr), Math.round(rect.top * dpr),
        Math.round(rect.width * dpr), Math.round(rect.height * dpr),
      ).then(() => {
        if (ownsSurface()) return nativePlayer.show();
      }).catch(() => {});
    };
    const schedule = () => { if (ownsSurface() && !raf) raf = requestAnimationFrame(updateGeometry); };
    // Remesure sur QUELQUES frames après l'activation. Une surface qui apparaît dans une modale est
    // mesurée avant sa mise en page : `rect` vaut alors 0 × 0, `updateGeometry` masque mpv, et plus
    // rien ne le rallume — un ResizeObserver ne voit pas une boîte qui n'a jamais changé de taille.
    // C'était le lecteur NOIR du rognage. Bornée (SETTLE_FRAMES) : jamais de boucle rAF permanente.
    let settle = 0;
    const settleTick = () => {
      if (!ownsSurface() || settle >= SETTLE_FRAMES) return;
      settle++;
      schedule();
      requestAnimationFrame(settleTick);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(surface);
    // La surface entre/sort du champ visible : c'est EXACTEMENT le test de `updateGeometry`, et
    // l'observer le signale sans rien scruter.
    const intersection = new IntersectionObserver(schedule);
    intersection.observe(surface);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    document.addEventListener("visibilitychange", schedule);
    document.addEventListener("transitionrun", schedule, true);
    document.addEventListener("transitionend", schedule, true);
    // Les entrées de modale/menu sont des ANIMATIONS (`animate-in zoom-in-98`), pas des transitions :
    // sans ces trois-là, la géométrie restait celle de l'image intermédiaire de l'animation.
    document.addEventListener("animationstart", schedule, true);
    document.addEventListener("animationend", schedule, true);
    document.addEventListener("animationcancel", schedule, true);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    settleTick();

    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const win = getCurrentWindow();
      const listeners = await Promise.all([win.onMoved(schedule), win.onResized(schedule)]);
      if (!ownsSurface()) listeners.forEach((off) => off());
      else unlisten.push(...listeners);
    }).catch(() => {});

    return () => {
      const shouldHide = ownsSurface();
      alive = false;
      if (shouldHide) nativeSurfaceLease++;
      observer.disconnect();
      intersection.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      document.removeEventListener("visibilitychange", schedule);
      document.removeEventListener("transitionrun", schedule, true);
      document.removeEventListener("transitionend", schedule, true);
      document.removeEventListener("animationstart", schedule, true);
      document.removeEventListener("animationend", schedule, true);
      document.removeEventListener("animationcancel", schedule, true);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
      unlisten.forEach((off) => off());
      if (raf) cancelAnimationFrame(raf);
      if (shouldHide) {
        nativePlayer.pause().catch(() => {});
        nativePlayer.hide().catch(() => {});
      }
    };
  }, [active, surfaceRef]);
}

function isNativeDiskPath(path?: string): boolean {
  if (!path) return false;
  return !/^(https?|nrmedia|blob|data):/i.test(path);
}

/**
 * Surface mpv native partagée par les lecteurs principaux.
 *
 * mpv ne doit pas être monté dans les cartes de grille : il n'existe qu'une
 * surface native par fenêtre Tauri. Les écrans de lecture directe peuvent en
 * revanche la piloter ici tout en conservant un repli HTML dans le navigateur
 * ou quand mpv n'est pas disponible.
 */
export function useNativePlayerSurface({
  path,
  autoPlay = false,
  loop = false,
  volume,
  startAt = 0,
  onTime,
  onDuration,
  onPlayingChange,
  onEnded,
  onError,
}: Options) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<boolean | null>(() => (isNativeDiskPath(path) && isTauriRuntime ? null : false));
  const endedRef = useRef(false);
  const loadingSinceRef = useRef<number | null>(null);
  const callbacksRef = useRef({ onTime, onDuration, onPlayingChange, onEnded, onError });
  const transportOptionsRef = useRef({ startAt, autoPlay });
  // Les lecteurs passent souvent des callbacks inline. On garde leur dernière version après chaque
  // commit sans réabonner les effets de transport ni dépendre de références recréées au rendu.
  useEffect(() => { callbacksRef.current = { onTime, onDuration, onPlayingChange, onEnded, onError }; });
  useEffect(() => { transportOptionsRef.current = { startAt, autoPlay }; }, [startAt, autoPlay]);

  useEffect(() => {
    if (!isNativeDiskPath(path) || !isTauriRuntime) {
      setMode(false);
      return;
    }
    let active = true;
    setMode(null);
    nativePlayer.available()
      .then((available) => { if (active) setMode(available); })
      .catch(() => { if (active) setMode(false); });
    return () => { active = false; };
  }, [path]);

  useNativePlayerGeometry(surfaceRef, mode === true);

  useEffect(() => {
    if (mode !== true || !path) return;
    let active = true;
    endedRef.current = false;
    loadingSinceRef.current = performance.now();
    nativePlayer.pause()
      .then(() => nativePlayer.load(path))
      .then(() => transportOptionsRef.current.startAt > 0 ? nativePlayer.seek(transportOptionsRef.current.startAt) : undefined)
      .then(() => transportOptionsRef.current.autoPlay ? nativePlayer.play() : nativePlayer.pause())
      .catch(() => {
        if (active) {
          setMode(false);
          callbacksRef.current.onError?.();
        }
      });
    return () => { active = false; };
  }, [mode, path]); // options de transport appliquées par les effets dédiés ci-dessous

  useEffect(() => {
    if (mode === true) nativePlayer.setVolume(volume * 100).catch(() => {});
  }, [mode, volume]);

  useEffect(() => {
    if (mode === true) nativePlayer.setLoopFile(loop).catch(() => {});
  }, [mode, loop]);

  useEffect(() => {
    if (mode !== true) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const status: NativePlayerStatus = await nativePlayer.status();
        if (!active) return;
        const time = Number.isFinite(status.current_time) ? Math.max(0, status.current_time) : 0;
        const duration = Number.isFinite(status.duration) ? Math.max(0, status.duration) : 0;
        if (duration > 0 || time > 0) loadingSinceRef.current = null;
        else if (loadingSinceRef.current != null && performance.now() - loadingSinceRef.current > 20_000) {
          loadingSinceRef.current = null;
          setMode(false);
          callbacksRef.current.onError?.();
          return;
        }
        callbacksRef.current.onTime?.(time);
        if (duration > 0) callbacksRef.current.onDuration?.(duration);
        callbacksRef.current.onPlayingChange?.(status.is_playing);
        if (duration > 0 && time >= duration - 0.05 && !status.is_playing) {
          if (!loop && !endedRef.current) {
            endedRef.current = true;
            callbacksRef.current.onEnded?.();
          }
        } else if (time < duration - 0.15 || status.is_playing) {
          endedRef.current = false;
        }
      } catch {
        if (active) {
          setMode(false);
          callbacksRef.current.onError?.();
        }
      }
      if (active) timer = setTimeout(poll, 100);
    };
    void poll();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [mode, loop]);

  const play = useCallback(() => nativePlayer.play(), []);
  const pause = useCallback(() => nativePlayer.pause(), []);
  const toggle = useCallback(() => nativePlayer.togglePause(), []);
  const seek = useCallback((position: number) => nativePlayer.seek(Math.max(0, position)), []);
  const frameStep = useCallback(() => nativePlayer.frameStep(), []);
  const frameBackStep = useCallback(() => nativePlayer.frameBackStep(), []);
  const setSpeed = useCallback((speed: number) => nativePlayer.setSpeed(speed), []);

  return {
    mode,
    surfaceRef,
    player: { play, pause, toggle, seek, frameStep, frameBackStep, setSpeed } satisfies NativePlayerSurfaceApi,
  };
}
