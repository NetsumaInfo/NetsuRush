import { useEffect, useRef, useState } from "react";
import { nr, nextProxyToken } from "@/lib/bridge";
import { PREVIEW_SETTINGS_EVENT } from "@/lib/previewSettings";
import { observeViewport } from "@/lib/viewportObserver";
import { acquirePrefetchSlot } from "@/lib/previewPrefetch";
import { usePreviewActivity } from "@/lib/usePreviewActivity";
import { useGranted } from "@/lib/useGranted";
import { getThumb, setThumb as setThumbCache, subscribeThumbs } from "@/lib/thumbCache";
import { claimHoverPreview } from "@/lib/hoverPreview";

const THUMB_MARGIN_PX = 1600;
// Une carte doit rester dans la bande ce temps-là avant qu'on encode son proxy : un défilement
// rapide la traverse en bien moins, donc n'émet aucune demande (cf. useSceneCardMedia).
const PREFETCH_SETTLE_MS = 220;

// Search thumbnail/proxy loading. The same usePreviewActivity hook as shot cards
// owns visibility, playback starts and decoder retention.
export function useResultPreview(opts: {
  filePath: string;
  /** Instant de la vignette, donné par `thumbTime(in, out)` — la MÊME clé de cache que la grille de
   *  plans, donc le même fichier sur le disque plutôt qu'un second encodage au milieu du plan. */
  thumbAt: number;
  index: number;
  play: boolean;
  getProxy: (height?: number, token?: number, priority?: "high" | "low") => Promise<string | null>;
  bustProxy: () => void;
  /** Lecture SYNCHRONE du cache d'URL de la vue (rempli en un appel par `nr.proxyResolve`), relue à
   *  chaque rendu : la carte monte sa <video> sans repasser par une promesse. Cf. useSceneCardMedia. */
  peekProxy?: () => string | null;
}) {
  const { filePath, thumbAt, index, play, getProxy, bustProxy, peekProxy } = opts;

  const rootRef = useRef<HTMLDivElement>(null);

  const [thumb, setThumb] = useState<string | null>(() => getThumb(filePath, thumbAt));
  const [thumbErr, setThumbErr] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [nearThumb, setNearThumb] = useState(false);
  const [fetchedUrl, setFetchedUrl] = useState<string | null>(null);
  // Le cache de la vue prime : quand il connaît déjà le proxy, la carte n'a RIEN à demander et monte
  // sa <video> dans ce rendu-ci. `bustProxy` vide l'entrée → repli sur le chemin asynchrone.
  const url = fetchedUrl ?? peekProxy?.() ?? null;
  const [tries, setTries] = useState(0);

  // getProxy est une closure recréée à chaque rendu du parent : on la lit via une ref
  // pour garder la dernière version sans relancer l'effet de récupération.
  const getProxyRef = useRef(getProxy);
  const bustProxyRef = useRef(bustProxy);
  useEffect(() => { getProxyRef.current = getProxy; }, [getProxy]);
  useEffect(() => { bustProxyRef.current = bustProxy; }, [bustProxy]);

  useEffect(() => {
    const reset = () => {
      bustProxyRef.current();
      setFetchedUrl(null);
      setTries(0);
    };
    window.addEventListener(PREVIEW_SETTINGS_EVENT, reset);
    return () => window.removeEventListener(PREVIEW_SETTINGS_EVENT, reset);
  }, []);

  // Hauteur d'encodage proxy = hauteur RÉELLE de la zone vidéo (largeur carte × 9/16 × DPR, la
  // vignette est aspect-video pleine largeur) → jamais plus de pixels que ce qui s'affiche.
  const proxyHRef = useRef(0);

  // Thumbnail observation is separate from the shared playback activity.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    proxyHRef.current = Math.round((el.clientWidth * 9 / 16) * (window.devicePixelRatio || 1));
    const stopThumb = observeViewport(el, THUMB_MARGIN_PX, setNearThumb);
    return stopThumb;
  }, []);

  const { nearVideo, visible, wantVideo, showVideo, videoPaused } = usePreviewActivity({
    rootRef, index, play, hovered, url,
  });

  // Priorité lue via ref : la faire entrer dans les dépendances relancerait l'effet au moment PRÉCIS
  // où la carte entre à l'écran, c'est-à-dire abandonnerait la demande qu'on attend.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  // Cache renderer d'abord (resservi SYNCHRONEMENT au re-montage, aucun aller-retour), puis le core
  // quand la carte approche. Le cache est celui de la grille de plans : un rush déjà découpé affiche
  // donc ses résultats sans un seul ffmpeg de plus.
  useEffect(() => {
    if (thumb || thumbErr || !nearThumb) return;
    let alive = true;
    nr.thumbnail(filePath, thumbAt, visibleRef.current ? "high" : "low").then((r) => {
      if (!alive) return;
      // nr.thumbnail renvoie un CHEMIN disque → assetUrl() pour une URL servie par la coquille
      // (sinon <img src="C:\…"> ne charge pas hors Electron). Cf. useSceneCardMedia (rush).
      if (typeof r !== "string") { setThumbErr(true); return; }
      const url = nr.assetUrl(r);
      setThumb(url);
      setThumbCache(filePath, url, thumbAt);
    });
    return () => { alive = false; };
  }, [nearThumb, thumb, thumbErr, filePath, thumbAt]);

  // Amorçage par LOT (warmResolveThumbs après une recherche) : la carte déjà montée capte l'arrivée
  // sans émettre sa propre requête — c'est ce qui évite une rafale de ~1 appel par carte.
  useEffect(() => {
    if (thumb) return;
    return subscribeThumbs(() => {
      const cached = getThumb(filePath, thumbAt);
      if (cached) { setThumb(cached); setThumbErr(false); }
    });
  }, [thumb, filePath, thumbAt]);

  // Génère/récupère le proxy en HAUTE priorité (la carte est dans le focus). Démontage / perte de
  // focus → proxyCancel (kill encode / sort de la file) → le créneau NVENC repart aux visibles.
  useEffect(() => {
    if (!wantVideo || url) return;
    let alive = true;
    // Une demande DÉJÀ résolue n'a plus rien à annuler : `proxyCancel` coûtait sinon un RPC par carte
    // au moment précis où l'aperçu démarre. Cf. useSceneCardMedia.
    let settled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const token = nextProxyToken();
    // Mesure la hauteur À LA DEMANDE : sous content-visibility:auto une carte hors-écran peut avoir
    // clientWidth=0 au montage → proxy demandé en height 0 → encode ffmpeg échoue (jamais d'aperçu).
    // Au moment du fetch (survol/lecture) la carte est rendue → largeur réelle ; fallback de sûreté.
    const el = rootRef.current;
    const measured = el ? Math.round((el.clientWidth * 9 / 16) * (window.devicePixelRatio || 1)) : 0;
    const height = measured || proxyHRef.current || 360;
    getProxyRef.current(height, token, "high").then((u) => {
      settled = true;
      if (!alive) return;
      if (u) setFetchedUrl(u);
      else if (tries < 4) retryTimer = setTimeout(() => alive && setTries((t) => t + 1), 600);
    });
    return () => { alive = false; if (retryTimer) clearTimeout(retryTimer); if (!settled) nr.proxyCancel(token); };
  }, [wantVideo, url, tries]);

  // ANTICIPATION : en lecture auto, une carte de la bande jouera à coup sûr en arrivant à l'écran →
  // on encode son proxy MAINTENANT, en priorité basse. Bandé + retardé + plafonné, exactement comme
  // la grille de derush (cf. useSceneCardMedia pour le détail des trois garde-fous).
  const prefetchReady = useGranted(play && nearVideo, (settled) => {
    const timer = setTimeout(settled, PREFETCH_SETTLE_MS);
    return () => clearTimeout(timer);
  });

  // La préchauffe qui s'arrête parce que la carte passe en LECTURE ne doit PAS annuler sa demande en
  // vol : c'est exactement celle qu'on attend. Seule une vraie sortie de bande tue l'encode.
  const nearVideoRef = useRef(nearVideo);
  nearVideoRef.current = nearVideo;

  useEffect(() => {
    if (!prefetchReady || wantVideo || url) return;
    let alive = true;
    let token: number | null = null;
    let release: (() => void) | null = null;
    const releaseSlot = () => { const done = release; release = null; done?.(); };
    release = acquirePrefetchSlot(() => {
      token = nextProxyToken();
      const el = rootRef.current;
      const measured = el ? Math.round((el.clientWidth * 9 / 16) * (window.devicePixelRatio || 1)) : 0;
      void getProxyRef.current(measured || proxyHRef.current || 360, token, "low")
        .then((u) => { if (alive && u) setFetchedUrl(u); })
        .finally(releaseSlot);
    });
    return () => {
      alive = false;
      if (token != null && !nearVideoRef.current) nr.proxyCancel(token);
      releaseSlot();
    };
  }, [prefetchReady, wantVideo, url]);

  function resetUrl() { setFetchedUrl(null); }

  // Survol arbitré GLOBALEMENT (cf. lib/hoverPreview) : une seule carte de l'app peut être sous le
  // pointeur, et le jeton se rend aussi au défilement — un `mouseleave` manqué laissait sinon
  // l'aperçu jouer (avec son) derrière le pointeur. Même mécanique que la grille de plans.
  const dropClaim = useRef<(() => void) | null>(null);
  const hoverOff = useRef(() => { dropClaim.current = null; setHovered(false); }).current;
  useEffect(() => () => { dropClaim.current?.(); dropClaim.current = null; }, []);

  function enter() {
    dropClaim.current = claimHoverPreview(rootRef.current, hoverOff);
    setHovered(true);
  }
  function leave() {
    dropClaim.current?.();
    hoverOff();
  }

  // `near` : assez proche de l'écran pour mériter son habillage (voir ResultCard). Loin, la carte ne
  // rend que sa vignette.
  return { rootRef, thumb, thumbErr, hovered, enter, leave, url, showVideo, videoPaused, near: nearThumb || hovered, resetUrl };
}
