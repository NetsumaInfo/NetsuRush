import { useEffect, useRef, useState } from "react";
import { nr, nextProxyToken } from "@/lib/bridge";
import { acquirePlaySlot } from "@/components/rushes/cutStudioShared";
import { PREVIEW_SETTINGS_EVENT } from "@/lib/previewSettings";
import { observeViewport } from "@/lib/viewportObserver";
import { acquirePrefetchSlot } from "@/lib/previewPrefetch";
import { getThumb, setThumb as setThumbCache, subscribeThumbs } from "@/lib/thumbCache";

const THUMB_MARGIN_PX = 1600;
const VIDEO_MARGIN_PX = 900;
// Une carte doit rester dans la bande ce temps-là avant qu'on encode son proxy : un défilement
// rapide la traverse en bien moins, donc n'émet aucune demande (cf. useSceneCardMedia).
const PREFETCH_SETTLE_MS = 220;

// État + chargement paresseux d'une carte de résultat : vignette du cache PARTAGÉ (celui du
// découpage — cf. `thumbTime`), montage différé de la <video> proxy via deux IntersectionObservers,
// créneau de lecture (« Tout lire » échelonné, survol hors quota) et nouvelle tentative de proxy.
export function useResultPreview(opts: {
  filePath: string;
  /** Instant de la vignette, donné par `thumbTime(in, out)` — la MÊME clé de cache que la grille de
   *  plans, donc le même fichier sur le disque plutôt qu'un second encodage au milieu du plan. */
  thumbAt: number;
  index: number;
  play: boolean;
  getProxy: (height?: number, token?: number, priority?: "high" | "low") => Promise<string | null>;
  bustProxy: () => void;
}) {
  const { filePath, thumbAt, index, play, getProxy, bustProxy } = opts;

  const rootRef = useRef<HTMLDivElement>(null);

  const [thumb, setThumb] = useState<string | null>(() => getThumb(filePath, thumbAt));
  const [thumbErr, setThumbErr] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [nearThumb, setNearThumb] = useState(false);
  const [nearVideo, setNearVideo] = useState(false);   // ±lookahead : pré-encode le proxy en avance
  const [visible, setVisible] = useState(false);       // vraiment à l'écran : proxy en priorité 'high'
  const [staggerReady, setStaggerReady] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
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
      setUrl(null);
      setTries(0);
    };
    window.addEventListener(PREVIEW_SETTINGS_EVENT, reset);
    return () => window.removeEventListener(PREVIEW_SETTINGS_EVENT, reset);
  }, []);

  // Hauteur d'encodage proxy = hauteur RÉELLE de la zone vidéo (largeur carte × 9/16 × DPR, la
  // vignette est aspect-video pleine largeur) → jamais plus de pixels que ce qui s'affiche.
  const proxyHRef = useRef(0);

  // Trois bandes, servies par des observateurs PARTAGÉS (un par marge pour toute la grille, cf.
  // `viewportObserver`) : une paire d'observateurs par carte saccadait le défilement dès quelques
  // centaines de résultats.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    proxyHRef.current = Math.round((el.clientWidth * 9 / 16) * (window.devicePixelRatio || 1));
    const stopThumb = observeViewport(el, THUMB_MARGIN_PX, setNearThumb);
    // Marge large → proxy pré-encodé EN AVANCE (priorité 'low') avant d'arriver à l'écran.
    const stopVideo = observeViewport(el, VIDEO_MARGIN_PX, setNearVideo);
    // Strict (marge 0) → carte VRAIMENT visible : proxy en 'high' (joue vite) + pilote le créneau.
    const stopVisible = observeViewport(el, 0, setVisible);
    return () => { stopThumb(); stopVideo(); stopVisible(); };
  }, []);

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
      // nr.thumbnail renvoie un CHEMIN disque → mediaUrl() pour une URL HTTP servie par le core
      // (sinon <img src="C:\…"> ne charge pas hors Electron). Cf. useSceneCardMedia (rush).
      if (typeof r !== "string") { setThumbErr(true); return; }
      const url = nr.mediaUrl(r);
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

  // « Tout lire » : créneau de lecture (échelonné, quota) — seulement pour les cartes VISIBLES
  // (la marge lookahead ne vole pas de créneau). Le survol joue hors quota.
  useEffect(() => {
    if (!(play && visible) || hovered) { setStaggerReady(false); return; }
    const release = acquirePlaySlot(index, () => setStaggerReady(true));
    return () => { release(); setStaggerReady(false); };
  }, [play, visible, hovered, index]);

  // On encode le proxy UNIQUEMENT quand la carte joue vraiment : survol (immédiat) ou créneau de
  // lecture accordé (staggerReady, échelonné). PAS de pré-encode spéculatif de tout l'écran : « Tout
  // lire » demandait sinon un proxy pour CHAQUE carte visible d'un coup → NVENC noyé (PROXY_MAX) →
  // la plupart échouaient → la lecture ne démarrait pas. Le créneau pace les demandes (cf. derush).
  const wantVideo = nearVideo && (hovered || (play && staggerReady));
  const showVideo = wantVideo && !!url;

  // Génère/récupère le proxy en HAUTE priorité (la carte est dans le focus). Démontage / perte de
  // focus → proxyCancel (kill encode / sort de la file) → le créneau NVENC repart aux visibles.
  useEffect(() => {
    if (!wantVideo || url) return;
    let alive = true;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const token = nextProxyToken();
    // Mesure la hauteur À LA DEMANDE : sous content-visibility:auto une carte hors-écran peut avoir
    // clientWidth=0 au montage → proxy demandé en height 0 → encode ffmpeg échoue (jamais d'aperçu).
    // Au moment du fetch (survol/lecture) la carte est rendue → largeur réelle ; fallback de sûreté.
    const el = rootRef.current;
    const measured = el ? Math.round((el.clientWidth * 9 / 16) * (window.devicePixelRatio || 1)) : 0;
    const height = measured || proxyHRef.current || 360;
    getProxyRef.current(height, token, "high").then((u) => {
      if (!alive) return;
      if (u) setUrl(u);
      else if (tries < 4) retryTimer = setTimeout(() => alive && setTries((t) => t + 1), 600);
    });
    return () => { alive = false; if (retryTimer) clearTimeout(retryTimer); nr.proxyCancel(token); };
  }, [wantVideo, url, tries]);

  // ANTICIPATION : en lecture auto, une carte de la bande jouera à coup sûr en arrivant à l'écran →
  // on encode son proxy MAINTENANT, en priorité basse. Bandé + retardé + plafonné, exactement comme
  // la grille de derush (cf. useSceneCardMedia pour le détail des trois garde-fous).
  const [prefetchReady, setPrefetchReady] = useState(false);
  useEffect(() => {
    if (!(play && nearVideo)) { setPrefetchReady(false); return; }
    const timer = setTimeout(() => setPrefetchReady(true), PREFETCH_SETTLE_MS);
    return () => { clearTimeout(timer); setPrefetchReady(false); };
  }, [play, nearVideo]);

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
        .then((u) => { if (alive && u) setUrl(u); })
        .finally(releaseSlot);
    });
    return () => {
      alive = false;
      if (token != null && !nearVideoRef.current) nr.proxyCancel(token);
      releaseSlot();
    };
  }, [prefetchReady, wantVideo, url]);

  function resetUrl() { setUrl(null); }

  return { rootRef, thumb, thumbErr, hovered, setHovered, url, showVideo, resetUrl };
}
