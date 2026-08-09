// Couche de rendu du fond d'écran. Montée UNE fois sous le shell, elle ne rend jamais l'interface :
// tous les réglages passent par des variables CSS posées sur <html> (cf. lib/wallpaper).
//
// Trois règles portent la performance :
//  1. Le média servi ici n'est JAMAIS flouté : le flou est posé en CSS sur la couche, donc continu et
//     immédiat. Les panneaux, eux, ont besoin d'une image déjà floutée (cf. setWallpaperSurfaceImage).
//  2. Un fond animé est une vidéo, jamais un GIF : décodage matériel, et surtout pausable.
//  3. Figer = DÉMONTER le <video>. `pause()` laisserait un décodeur et sa texture vivants ; le poster
//     statique le remplace, ce qui ramène le coût à celui d'une image.
import { useEffect, useState } from "react";
import { nr } from "@/lib/bridge";
import { fitStyle, setWallpaperSurfaceImage, surfaceBlurStep, wallpaperActive } from "@/lib/wallpaper";
import { IS_REMOTE } from "@/lib/remote";
import { subscribeHeavyJobs } from "@/lib/heavyJobs";
import { useApp } from "@/store";

/**
 * Le média joue-t-il ? Faux dès que la fenêtre n'est plus regardée, que l'OS demande moins de
 * mouvement, ou que l'application travaille — un encodage ou une inférence a meilleur usage du GPU.
 */
function useShouldAnimate(enabled: boolean, pauseUnfocused: boolean, pauseWhileBusy: boolean): boolean {
  const [visible, setVisible] = useState(true);
  const [focused, setFocused] = useState(true);
  const [reduced, setReduced] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!pauseWhileBusy) {
      setBusy(false);
      return;
    }
    return subscribeHeavyJobs(setBusy);
  }, [pauseWhileBusy]);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (!pauseUnfocused) {
      setVisible(true);
      setFocused(true);
      return;
    }
    const onVisibility = () => setVisible(!document.hidden);
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    // La fenêtre Tauri peut rester « visible » tout en passant derrière Resolve : seul l'évènement de
    // focus de la fenêtre le dit. Import paresseux (le mock navigateur n'a pas l'API).
    let stop: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        setFocused(await win.isFocused());
        const unlisten = await win.onFocusChanged(({ payload }) => setFocused(payload));
        if (cancelled) unlisten();
        else stop = unlisten;
      } catch { /* hors Tauri : la visibilité du document suffit */ }
    })();
    return () => {
      cancelled = true;
      stop?.();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [pauseUnfocused]);

  return enabled && !reduced && visible && focused && !busy;
}

/** Média affiché : son URL, et s'il s'agit d'une boucle vidéo ou d'une image. */
interface WallpaperMedia {
  url: string;
  /** Vient de la RÉPONSE du core, jamais de l'intention d'animer : lui seul sait ce qu'il a encodé. */
  loop: boolean;
}

/**
 * Résout la variante (marche de flou × animé ou figé) et la sert via /media.
 *
 * Deux pièges, tous deux vus à l'usage :
 *  - le type d'élément se lit sur la RÉPONSE. Vouloir animer ne rend pas un fond fixe animé : le core
 *    renvoie alors un poster `.webp`, qu'un `<video>` refuse (MEDIA_ERR_SRC_NOT_SUPPORTED).
 *  - la variante demandée peut ne pas être encore encodée (première fois qu'on demande cette marche
 *    de flou). On GARDE le média précédent pendant ce temps : le vider ferait disparaître le fond à
 *    chaque cran de curseur, et l'interface entière clignoterait.
 */
function useWallpaperMedia(id: string | null, blur: number, animated: boolean): WallpaperMedia | null {
  const [media, setMedia] = useState<WallpaperMedia | null>(null);
  useEffect(() => {
    if (!id) {
      setMedia(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const res = await nr.wallpaper?.variant(id, { blur, animated });
      if (cancelled || !res?.ok || !res.path) return; // échec : on garde ce qui est déjà à l'écran
      setMedia({ url: nr.mediaUrl(res.path), loop: Boolean(res.animated) });
    })();
    return () => { cancelled = true; };
  }, [id, blur, animated]);
  return media;
}

export function WallpaperLayer() {
  const theme = useApp((s) => s.theme);
  const config = useApp((s) => s.wallpaper);
  // `wallpaperActive` arbitre TOUT, fenêtre détachée comprise : dupliquer une partie de la condition
  // ici laissait la classe posée sans que la couche soit rendue.
  const active = wallpaperActive(config, theme);
  const animating = useShouldAnimate(active && config.animate, config.pauseUnfocused, config.pauseWhileBusy);
  // Marche 0 : le média de la couche principale est NET, son flou est posé en CSS. Lui servir une
  // variante déjà floutée reviendrait à flouter deux fois.
  const media = useWallpaperMedia(active ? config.id : null, 0, animating);
  // Image fixe DÉJÀ floutée pour les panneaux qui SURVOLENT le contenu (cf. setWallpaperSurfaceImage).
  // Le rayon est approché à la marche encodée la plus proche : c'est une bande de 240 px translucide,
  // et un fichier par pixel de rayon n'y ajouterait rien de visible.
  const still = useWallpaperMedia(active ? config.id : null, surfaceBlurStep(config.blur), false);
  useEffect(() => { setWallpaperSurfaceImage(active ? still?.url ?? null : null); }, [active, still]);
  const style = fitStyle(config);

  // Le panneau CEP Adobe tourne sur un moteur sans `color-mix` : la translucidité de l'interface n'y
  // fonctionnerait pas, donc le fond n'y est pas rendu du tout plutôt qu'à moitié.
  if (IS_REMOTE || !active || !media) return null;

  return (
    <div className="nr-wallpaper" aria-hidden="true">
      {media.loop ? (
        <video
          key={media.url}
          className="nr-wallpaper-media"
          src={media.url}
          style={{ transform: style.transform }}
          autoPlay
          loop
          muted
          playsInline
          preload="auto"
        />
      ) : (
        <img
          key={media.url}
          className="nr-wallpaper-media"
          src={media.url}
          alt=""
          decoding="async"
          style={{ transform: style.transform }}
        />
      )}
    </div>
  );
}
