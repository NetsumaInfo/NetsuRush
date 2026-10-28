import { useEffect, useRef, useState } from "react";
import { nr, nextProxyToken } from "@/lib/bridge";
import { getThumb, setThumb as cacheThumb, subscribeThumbs } from "@/lib/thumbCache";
import { PREVIEW_SETTINGS_EVENT } from "@/lib/previewSettings";
import { observeViewport } from "@/lib/viewportObserver";
import { acquirePrefetchSlot } from "@/lib/previewPrefetch";
import { usePreviewActivity } from "@/lib/usePreviewActivity";
import { useGranted } from "@/lib/useGranted";
import { claimHoverPreview } from "@/lib/hoverPreview";
import { IS_REMOTE } from "@/lib/remote";

// Thumbnail, preview proxy and hover state of ONE card of a preview grid. Shot grids (Découpage,
// Timeline Live, Collections) and search results ran two copies of this logic, and they drifted:
// the search copy had no thumbnail retry (one failed seek left a film icon for good, an unhandled
// rejection a skeleton for good), no cap on <video> error retries, no hover delay (a wheel scroll
// under the pointer started every card it crossed, with sound) and mounted its hover chrome for the
// whole thumbnail band. One implementation now; the cards only differ by what they render.

// Bandes d'anticipation, en PIXELS FIXES. Elles étaient dérivées de la hauteur de cellule, donc un
// cran de densité changeait la marge de chaque carte : trois désabonnements + trois abonnements par
// vignette, soit quelques milliers d'opérations d'observateur sur un rush de plusieurs centaines de
// plans — c'est ce qui figeait le +/-. En pixels, les abonnements survivent au changement.
const THUMB_MIN_MARGIN_PX = 1200;
// Une carte doit rester dans la bande ce temps-là avant qu'on encode son proxy. Un défilement rapide
// traverse la bande en bien moins : aucune demande n'est émise pendant un flick, donc le pont /rpc
// reste libre pour les vignettes, qui sont ce qu'on regarde en défilant.
const PREFETCH_SETTLE_MS = 220;
// Encode-ahead band while autoplay is on: about three screens. Wider than the band that MOUNTS
// paused <video> elements (usePreviewActivity), because encoding is the slow part (~0.5 s per shot)
// while mounting a ready file is not. Slots are capped and served nearest-first (previewPrefetch).
const PREFETCH_MARGIN_PX = 2400;
const HOVER_DELAY_MS = 180;
const THUMB_RETRIES = 3;
const PROXY_RETRIES = 4;

export interface CardMediaOpts {
  clipPath: string;
  /** Thumbnail instant, from `thumbTime(in, out)`: the same cache key in every grid. */
  thumbAt: number;
  index: number;
  play: boolean;
  getProxy: (height?: number, token?: number, priority?: "high" | "low") => Promise<string | null>;
  bustProxy: () => void;
  /** Lecture SYNCHRONE du cache d'URL de la grille (cf. warmProxies), consultée à chaque rendu.
   *  Sans elle, la carte devait passer par `getProxy` — une promesse, donc un rendu de plus après le
   *  créneau de lecture, pour une réponse déjà en mémoire. La grille n'est pas virtualisée : toutes
   *  les cartes sont montées AVANT que la résolution en lot ne revienne. En la relisant au rendu, la
   *  carte trouve son URL au moment précis où elle en a besoin. */
  peekProxy?: () => string | null;
  /** Height of the video area in CSS pixels. Defaults to the card's own height (shot cards are the
   *  video area); a result card adds a footer, so it measures its width instead. */
  measure?: (el: HTMLDivElement) => number;
}

export interface CardMedia {
  rootRef: React.RefObject<HTMLDivElement | null>;
  thumb: string | null;
  /** Every thumbnail attempt failed: show a placeholder, not a skeleton that never resolves. */
  thumbFailed: boolean;
  url: string | null;
  /** L'élément <video> est MONTÉ (il peut être en pause : cf. `videoPaused`). */
  showVideo: boolean;
  /** Monté mais à l'arrêt → masqué derrière la vignette. */
  videoPaused: boolean;
  /** La carte est assez proche de l'écran pour mériter son habillage en remote. */
  near: boolean;
  /** Le pointeur ou le clavier est SUR la carte → son habillage de survol mérite d'exister. */
  interactive: boolean;
  hovered: boolean;
  onVideoError: () => void;
  enter: () => void;
  leave: () => void;
  focusEnter: () => void;
  focusLeave: () => void;
}

export function useCardMedia({
  clipPath, thumbAt, index, play, getProxy, bustProxy, peekProxy, measure,
}: CardMediaOpts): CardMedia {
  const rootRef = useRef<HTMLDivElement>(null);

  const [thumb, setThumb] = useState<string | null>(() => getThumb(clipPath, thumbAt));
  const [thumbFailed, setThumbFailed] = useState(false);
  const [fetchedUrl, setFetchedUrl] = useState<string | null>(null);
  // Le cache de la grille prime : quand il connaît déjà le proxy, la carte n'a RIEN à demander et
  // monte sa <video> dans ce rendu-ci. `bustProxy` vide l'entrée, donc un proxy invalide fait
  // retomber sur le chemin asynchrone au rendu suivant.
  const url = fetchedUrl ?? peekProxy?.() ?? null;
  const [hovered, setHovered] = useState(false);
  // Présence du pointeur / du clavier sur la carte, SANS le délai de survol (celui-ci ne retient que
  // la LECTURE). Sert à monter l'habillage révélé au survol — infobulles, popover « Ranger », menu
  // contextuel : une racine Base UI chacun. Cet habillage suivait la bande vignette (±1200 px, soit
  // des dizaines de cartes de chaque côté) : traîner le curseur de la barre de défilement montait
  // puis démontait ces racines pour CHAQUE carte traversée.
  const [pointerOn, setPointerOn] = useState(false);
  const [focusOn, setFocusOn] = useState(false);
  const [nearThumb, setNearThumb] = useState(false); // vignette (légère) : précharge loin
  const [tries, setTries] = useState(0);
  const [thumbTries, setThumbTries] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mesurée au moment de la demande : sous content-visibility une carte hors écran peut mesurer 0 au
  // montage, et un changement de densité ne doit pas réinstaller les observateurs.
  const measureRef = useRef(measure);
  measureRef.current = measure;
  const proxyHeight = () => {
    const el = rootRef.current;
    const css = el ? (measureRef.current ? measureRef.current(el) : el.clientHeight) : 0;
    return Math.round((css || 180) * (window.devicePixelRatio || 1));
  };

  // getProxy/bustProxy sont recréés à chaque rendu du parent ; on les lit via ref pour ne pas
  // relancer le chargement du proxy / l'invalidation à chaque rendu (deps stables).
  const getProxyRef = useRef(getProxy);
  useEffect(() => { getProxyRef.current = getProxy; }, [getProxy]);
  const bustProxyRef = useRef(bustProxy);
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

  const { nearVideo, visible, wantVideo, showVideo, videoPaused } = usePreviewActivity({
    rootRef, index, play, hovered, url,
  });

  // Vignette : bande LARGE. Le fichier est déjà encodé (cache disque, servi en HTTP avec ETag) →
  // le demander loin devant ne coûte qu'une requête. Observateur RENDU dès que la vignette est posée
  // (ou abandonnée) : il n'a plus rien à déclencher, et son va-et-vient rerendait la carte à chaque
  // traversée. En remote, l'habillage suit cette bande faute de survol fiable : on la garde.
  const thumbBandDone = (!!thumb || thumbFailed) && !IS_REMOTE;
  useEffect(() => {
    const el = rootRef.current;
    if (!el || thumbBandDone) return;
    return observeViewport(el, THUMB_MIN_MARGIN_PX, setNearThumb);
  }, [thumbBandDone]);

  // Amorçage en LOT : la grille prime le cache pour toutes les cartes en UN RPC. Une carte déjà montée
  // (sans vignette) se réveille ici et lit le cache → affiche son <img> SANS émettre son propre RPC.
  useEffect(() => {
    if (thumb) return;
    return subscribeThumbs(() => {
      const cached = getThumb(clipPath, thumbAt);
      if (cached) { setThumb(cached); setThumbFailed(false); }
    });
  }, [thumb, clipPath, thumbAt]);

  // Priorité lue via ref : la faire entrer dans les dépendances relancerait l'effet au moment PRÉCIS
  // où la carte entre à l'écran, c'est-à-dire abandonnerait la demande qu'on attend.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  // Vignette en lazy, quand la carte approche. ffmpeg échoue parfois sous charge : quelques essais
  // espacés, puis un échec AFFICHÉ plutôt qu'un squelette éternel.
  useEffect(() => {
    if (!nearThumb || thumb || thumbFailed) return;
    const cached = getThumb(clipPath, thumbAt);
    if (cached) { setThumb(cached); return; }   // cache renderer → instantané, pas d'IPC
    let alive = true;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const retry = () => {
      if (!alive) return;
      if (thumbTries < THUMB_RETRIES) retryTimer = setTimeout(() => alive && setThumbTries((n) => n + 1), 500);
      else setThumbFailed(true);
    };
    nr.thumbnail(clipPath, thumbAt, visibleRef.current ? "high" : "low").then((r) => {
      if (!alive) return;
      if (typeof r === "string") { const u = nr.assetUrl(r); cacheThumb(clipPath, u, thumbAt); setThumb(u); } else retry();
    }).catch(retry);
    return () => { alive = false; if (retryTimer) clearTimeout(retryTimer); };
  }, [nearThumb, clipPath, thumbAt, thumb, thumbFailed, thumbTries]);

  // Génère/récupère le proxy en HAUTE priorité (la carte est dans le focus). Perte de focus /
  // démontage → proxyCancel (kill l'encode / jette de la file) → le créneau NVENC repart aux visibles.
  useEffect(() => {
    if (!wantVideo || url || tries > PROXY_RETRIES) return;
    let alive = true;
    // Une demande DÉJÀ résolue n'a plus rien à annuler : envoyer quand même `proxyCancel` coûtait un
    // RPC par carte au moment précis où l'aperçu démarre.
    let settled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const token = nextProxyToken();
    getProxyRef.current(proxyHeight(), token, "high").then((u) => {
      settled = true;
      if (!alive) return;
      if (u) setFetchedUrl(u);
      else retryTimer = setTimeout(() => alive && setTries((n) => n + 1), 600);
    });
    return () => { alive = false; if (retryTimer) clearTimeout(retryTimer); if (!settled) nr.proxyCancel(token); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantVideo, url, tries]);

  // ANTICIPATION. En lecture auto, une carte de la bande jouera à coup sûr en arrivant à l'écran :
  // on encode son proxy MAINTENANT, en priorité basse. Trois garde-fous : la BANDE (pré-encoder toute
  // la grille noyait NVENC), le DÉLAI DE STABILISATION (un flick n'émet rien), le PLAFOND de créneaux
  // (`previewPrefetch` : le pont /rpc reste libre pour les vignettes).
  const [nearPrefetch, setNearPrefetch] = useState(false);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || !play) { setNearPrefetch(false); return; }
    return observeViewport(el, PREFETCH_MARGIN_PX, setNearPrefetch);
  }, [play]);
  const prefetchReady = useGranted(play && (nearPrefetch || nearVideo), (settled) => {
    const t = setTimeout(settled, PREFETCH_SETTLE_MS);
    return () => clearTimeout(t);
  });

  // Sortie de bande = la carte est repartie → on tue l'encode. Mais quand la préchauffe s'arrête
  // parce que la carte vient de passer en LECTURE, la demande en vol est exactement celle qu'on
  // attend : l'annuler relancerait un ffmpeg de zéro au pire moment. D'où la lecture par ref.
  const nearVideoRef = useRef(nearVideo);
  nearVideoRef.current = nearVideo || nearPrefetch;

  useEffect(() => {
    if (!prefetchReady || wantVideo || url) return;
    let alive = true;
    let token: number | null = null;
    let release: (() => void) | null = null;
    const releaseSlot = () => { const done = release; release = null; done?.(); };
    release = acquirePrefetchSlot(() => {
      token = nextProxyToken();
      void getProxyRef.current(proxyHeight(), token, "low")
        .then((u) => { if (alive && u) setFetchedUrl(u); })
        .finally(releaseSlot);
    }, rootRef.current);
    return () => {
      alive = false;
      if (token != null && !nearVideoRef.current) nr.proxyCancel(token);
      releaseSlot();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefetchReady, wantVideo, url]);

  // <video> qui plante (décodage) → invalide le cache et recharge, un nombre BORNÉ de fois : un
  // fichier que le décodeur refuse renvoyait sinon la même URL, et la carte bouclait sans fin.
  function onVideoError() {
    bustProxyRef.current();
    setFetchedUrl(null);
    setTries((n) => Math.min(n + 1, PROXY_RETRIES + 1));
  }

  // Survol arbitré GLOBALEMENT (cf. lib/hoverPreview) : une seule carte de l'app peut être sous le
  // pointeur. Sans ça, un défilement à la molette laissait la carte quittée en lecture (Chromium
  // n'émet `mouseleave` qu'au mouvement suivant) — plusieurs aperçus finissaient par jouer en fond.
  const dropClaim = useRef<(() => void) | null>(null);
  const hoverOff = useRef(() => {
    dropClaim.current = null;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    setPointerOn(false);
    setHovered(false);
  }).current;
  // Le jeton doit repartir au démontage : une carte détruite en plein survol le garderait sinon, et
  // la carte suivante ne pourrait plus le prendre.
  useEffect(() => () => {
    dropClaim.current?.();
    dropClaim.current = null;
    if (timer.current) clearTimeout(timer.current);
  }, []);

  function enter() {
    setPointerOn(true);
    dropClaim.current = claimHoverPreview(rootRef.current, hoverOff);
    // A second `enter` without a `leave` (React re-enters a card through its own portals) must not
    // orphan the first timer: `leave` only clears the current one, and the orphan would switch the
    // hover back on after the pointer left — the preview then played on, with sound, behind it.
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      // The delay outlives the pointer if the global arbiter dropped this card meanwhile.
      if (dropClaim.current) setHovered(true);
    }, HOVER_DELAY_MS);
  }
  function leave() {
    dropClaim.current?.();
    hoverOff();
  }
  function focusEnter() { setFocusOn(true); }
  function focusLeave() { setFocusOn(false); }

  return {
    rootRef, thumb, thumbFailed, url, showVideo, videoPaused,
    near: nearThumb || hovered, interactive: pointerOn || focusOn, hovered,
    onVideoError, enter, leave, focusEnter, focusLeave,
  };
}
