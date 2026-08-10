import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { isTauriRuntime, nativePlayer, type NativePlayerStatus } from "@/lib/nativePlayer";

interface NativePlayerSurfaceApi {
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
// (~100 ms d'animation) pose sa géométrie définitive.
const SETTLE_FRAMES = 12;
// Veille pendant toute la vie de la surface. Ni ResizeObserver ni IntersectionObserver ne voient
// une boîte qui se DÉPLACE sans changer de taille (modale recentrée quand son contenu grandit,
// panneau qui glisse) : la fenêtre mpv restait alors sur ses anciennes coordonnées, donc invisible
// ou à côté de sa surface. Une mesure toutes les 400 ms coûte un getBoundingClientRect.
const WATCH_MS = 400;

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
    let shown = false;      // mpv affiché pour CETTE surface (repli à false dès qu'on le masque)
    let lastKey = "";       // dernière géométrie appliquée ("" = à réappliquer)
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
        // Masquage UNIQUEMENT si mpv était affiché ici : une surface mesurée à 0 × 0 avant sa mise
        // en page (entrée de modale) ne doit pas éteindre le lecteur d'une autre vue.
        if (shown) {
          shown = false;
          lastKey = "";
          nativePlayer.pause().catch(() => {});
          nativePlayer.hide().catch(() => {});
        }
        return;
      }
      const dpr = window.devicePixelRatio || 1;
      const x = Math.round(rect.left * dpr), y = Math.round(rect.top * dpr);
      const w = Math.round(rect.width * dpr), h = Math.round(rect.height * dpr);
      const key = `${x}:${y}:${w}:${h}`;
      // IDEMPOTENCE OBLIGATOIRE : chaque `setGeometry`/`show` fait un SetWindowPos sur la fenêtre
      // parente de mpv, que mpv suit (hook sur le parent) en redimensionnant sa propre fenêtre de
      // sortie vidéo. En PAUSE, ce reconfigure vide l'image et mpv ne redessine qu'à la frame
      // suivante — donc un écran NOIR. Les anciens déclencheurs (animations de modale, défilement,
      // veille périodique) rejouaient la même géométrie en boucle et noircissaient le lecteur.
      // On ne touche donc à la fenêtre native que si le rectangle a VRAIMENT changé.
      if (shown && key === lastKey) return;
      lastKey = key;
      nativePlayer.setGeometry(x, y, w, h).then(() => {
        if (!ownsSurface()) return;
        shown = true;
        return nativePlayer.show();
      }).catch(() => { lastKey = ""; });
    };
    const schedule = () => { if (ownsSurface() && !raf) raf = requestAnimationFrame(updateGeometry); };
    // Remesure sur QUELQUES frames après l'activation : une surface qui apparaît dans une modale est
    // mesurée avant sa mise en page, `rect` vaut alors 0 × 0 et le premier calcul ne vaut rien. Ces
    // passes ne REJOUENT rien : `updateGeometry` n'agit que si le rectangle a réellement changé.
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
    // Veille : rattrape les DÉPLACEMENTS de surface, invisibles pour les deux observers. Elle ne
    // fait que MESURER — repositionner mpv « au cas où » est exactement ce qu'il ne faut pas faire
    // (cf. le commentaire de `updateGeometry` sur le reconfigure de mpv).
    const watch = setInterval(schedule, WATCH_MS);
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
      clearInterval(watch);
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

// Comparaison de chemins tolérante : mpv rend ses séparateurs en avant, et la casse d'un chemin
// Windows n'est pas significative.
function samePath(a: string, b: string): boolean {
  const norm = (v: string) => v.split("\\").join("/").toLowerCase();
  return norm(a) === norm(b);
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
  const claimRef = useRef<number | null>(null);        // jeton de possession du lecteur unique
  const lastReloadRef = useRef(0);                     // anti-boucle du rattrapage de fichier
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
    // Position d'ouverture passée AU CHARGEMENT (`start`) : `loadfile` est asynchrone, donc un
    // `seek` envoyé dans la foulée s'appliquait au fichier encore chargé — la surface montrait une
    // image sans rapport avec le plan, figée jusqu'au premier vrai seek de l'utilisateur.
    const startPos = transportOptionsRef.current.startAt;
    // On PREND possession avant de charger : le lecteur mpv est unique pour toute l'application et
    // plusieurs surfaces peuvent être montées en même temps (autres panneaux, autres fenêtres, donc
    // autres contextes JS). Sans jeton partagé, la dernière surface à réagir gardait SON média sous
    // la surface d'une autre — le rognage lisait la vidéo ouverte ailleurs.
    nativePlayer.claim()
      .then((id) => { if (active) claimRef.current = id; })
      .catch(() => {})
      .then(() => nativePlayer.pause())
      // Repli sur `load` + `seek` quand la commande manque : le binaire Tauri en cours d'exécution
      // peut précéder ce code (le renderer est rechargé à chaud, pas la coquille Rust). Sans lui,
      // l'échec de la commande éteignait la surface native entière.
      .then(() => nativePlayer.loadAt(path, startPos).catch(() => nativePlayer.load(path)
        .then(() => (startPos > 0 ? nativePlayer.seek(startPos) : undefined))))
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
    if (mode !== true || !path) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const status: NativePlayerStatus = await nativePlayer.status();
        if (!active) return;
        // Le lecteur est-il encore à NOUS ? Une surface dépossédée ne rapporte plus le temps d'un
        // média qui n'est pas le sien et ne touche plus au transport.
        if (status.claim != null && claimRef.current != null && status.claim !== claimRef.current) {
          if (active) timer = setTimeout(poll, 250);
          return;
        }
        // mpv a-t-il bien NOTRE fichier ? Une commande de chargement perdue (ou écrasée par une
        // autre fenêtre) laissait la surface afficher un autre média, sans que rien ne le rattrape.
        if (status.path && !samePath(status.path, path)) {
          if (performance.now() - lastReloadRef.current > 1500) {
            lastReloadRef.current = performance.now();
            const startPos = transportOptionsRef.current.startAt;
            void nativePlayer.loadAt(path, startPos)
              .catch(() => nativePlayer.load(path).then(() => (startPos > 0 ? nativePlayer.seek(startPos) : undefined)))
              .then(() => (transportOptionsRef.current.autoPlay ? nativePlayer.play() : nativePlayer.pause()))
              .catch(() => {});
          }
          if (active) timer = setTimeout(poll, 100);
          return;
        }
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
  }, [mode, loop, path]);

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
