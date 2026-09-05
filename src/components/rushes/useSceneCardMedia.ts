import { useEffect, useRef, useState } from "react";
import { nr, nextProxyToken } from "@/lib/bridge";
import { getThumb, setThumb as cacheThumb, subscribeThumbs } from "@/lib/thumbCache";
import { thumbTime } from "@/lib/utils";
import { type Segment } from "./cutStudioShared";
import { PREVIEW_SETTINGS_EVENT } from "@/lib/previewSettings";
import { observeViewport } from "@/lib/viewportObserver";
import { acquirePrefetchSlot } from "@/lib/previewPrefetch";
import { usePreviewActivity } from "@/lib/usePreviewActivity";
import { useGranted } from "@/lib/useGranted";
import { claimHoverPreview } from "@/lib/hoverPreview";
import { IS_REMOTE } from "@/lib/remote";

// Bandes d'anticipation, en PIXELS FIXES. Elles étaient dérivées de la hauteur de cellule, donc un
// cran de densité changeait la marge de chaque carte : trois désabonnements + trois abonnements par
// vignette, soit quelques milliers d'opérations d'observateur sur un rush de plusieurs centaines de
// plans — c'est ce qui figeait le +/-. En pixels, les abonnements survivent au changement.
const THUMB_MIN_MARGIN_PX = 1200;
// Une carte doit rester dans la bande ce temps-là avant qu'on encode son proxy. Un défilement rapide
// traverse la bande en bien moins : aucune demande n'est émise pendant un flick, donc le pont /rpc
// reste libre pour les vignettes, qui sont ce qu'on regarde en défilant.
const PREFETCH_SETTLE_MS = 220;

interface SceneCardMediaOpts {
  seg: Segment;
  index: number;
  clipPath: string;
  play: boolean;
  getProxy: (height?: number, token?: number, priority?: "high" | "low") => Promise<string | null>;
  bustProxy: () => void;
  /** Lecture SYNCHRONE du cache d'URL de la grille (cf. warmProxies), consultée à chaque rendu.
   *  Sans elle, la carte devait passer par `getProxy` — une promesse, donc un rendu de plus après le
   *  créneau de lecture, pour une réponse déjà en mémoire. Un état initial ne suffirait pas : la
   *  grille n'est pas virtualisée, toutes les cartes sont montées AVANT que la résolution en lot ne
   *  revienne. En la relisant au rendu, la carte trouve son URL au moment précis où elle en a besoin
   *  — les rendus déclenchés par l'entrée dans les bandes suffisent, rien à réveiller. */
  peekProxy?: () => string | null;
}

interface SceneCardMedia {
  rootRef: React.RefObject<HTMLDivElement | null>;
  thumb: string | null;
  url: string | null;
  /** L'élément <video> est MONTÉ (il peut être en pause : cf. `videoPaused`). */
  showVideo: boolean;
  /** Monté mais à l'arrêt → masqué derrière la vignette. */
  videoPaused: boolean;
  /** La carte est assez proche de l'écran pour mériter son habillage (boutons, menus, pastilles).
   *  Loin de l'écran, une carte ne rend QUE sa vignette : cf. le commentaire dans SceneCard. */
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

// Shot thumbnail/proxy loading and hover interaction. Playback and decoder
// retention are shared with search through usePreviewActivity.
export function useSceneCardMedia({
  seg, index, clipPath, play, getProxy, bustProxy, peekProxy,
}: SceneCardMediaOpts): SceneCardMedia {
  const rootRef = useRef<HTMLDivElement>(null);

  const [thumb, setThumb] = useState<string | null>(() => getThumb(clipPath, thumbTime(seg.in, seg.out)));
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
  // puis démontait ces racines pour CHAQUE carte traversée. Un défilement traîné à la souris avance
  // sur le thread principal — celui-là même que ces montages saturaient, d'où le tremblement.
  const [pointerOn, setPointerOn] = useState(false);
  const [focusOn, setFocusOn] = useState(false);
  const [nearThumb, setNearThumb] = useState(false); // vignette (légère) : précharge loin
  const [tries, setTries] = useState(0);
  const [thumbTries, setThumbTries] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mesurée au moment de la demande : un changement de densité ne doit pas réinstaller les
  // observateurs, mais le proxy conserve la résolution réellement affichée.
  const proxyHeight = () => Math.round((rootRef.current?.clientHeight || 180) * (window.devicePixelRatio || 1));

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
  // le demander loin devant ne coûte qu'une requête, et l'image est posée bien avant l'arrivée à
  // l'écran. Hors viewport la demande part en priorité BASSE : le core réserve ainsi ses derniers
  // ouvriers aux cartes réellement visibles.
  //
  // Observateur RENDU dès que la vignette est posée : il n'a plus rien à déclencher, et son
  // va-et-vient rerendait la carte à chaque traversée. Sur une grille réchauffée (le batch d'ouverture
  // pose toutes les vignettes d'un coup), traîner le curseur de la barre ne réveille donc plus qu'une
  // bande par carte au lieu de trois. En remote, l'habillage suit cette bande faute de survol fiable
  // (cf. SceneCard) : on la garde.
  const thumbBandDone = !!thumb && !IS_REMOTE;
  useEffect(() => {
    const el = rootRef.current;
    if (!el || thumbBandDone) return;
    return observeViewport(el, THUMB_MIN_MARGIN_PX, setNearThumb);
  }, [thumbBandDone]);

  // Amorçage en LOT : à l'ouverture de la grille, warmResolveThumbs prime le cache pour toutes les
  // cartes en UN RPC. Une carte déjà montée (sans vignette) se réveille ici et lit le cache → affiche
  // son <img> SANS émettre son propre RPC. C'est ce qui élimine la rafale ~1 RPC/carte (sockets HTTP
  // saturés → scroll figé). Effet inerte dès que la vignette est posée (deps [thumb]).
  useEffect(() => {
    if (thumb) return;
    return subscribeThumbs(() => {
      const c = getThumb(clipPath, thumbTime(seg.in, seg.out));
      if (c) setThumb(c);
    });
  }, [thumb, clipPath, seg.in, seg.out]);

  // Priorité lue via ref : la faire entrer dans les dépendances relancerait l'effet au moment PRÉCIS
  // où la carte entre à l'écran, c'est-à-dire abandonnerait la demande qu'on attend.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  // Vignette en lazy : générée quand la carte approche (marge large). Retry si ffmpeg échoue.
  useEffect(() => {
    if (!nearThumb || thumb) return;
    const t = thumbTime(seg.in, seg.out);
    const cached = getThumb(clipPath, t);
    if (cached) { setThumb(cached); return; }   // cache renderer → instantané, pas d'IPC
    let alive = true;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const retry = () => { if (alive && thumbTries < 3) retryTimer = setTimeout(() => alive && setThumbTries((t) => t + 1), 500); };
    nr.thumbnail(clipPath, t, visibleRef.current ? "high" : "low").then((r) => {
      if (!alive) return;
      if (typeof r === "string") { const u = nr.assetUrl(r); cacheThumb(clipPath, u, t); setThumb(u); } else retry();
    }).catch(retry);
    return () => { alive = false; if (retryTimer) clearTimeout(retryTimer); };
  }, [nearThumb, clipPath, seg.in, seg.out, thumb, thumbTries]);

  // Génère/récupère le proxy (cache) en HAUTE priorité (la carte est dans le focus). Perte de focus /
  // démontage → proxyCancel (kill l'encode / jette de la file) → le créneau NVENC repart aux visibles.
  useEffect(() => {
    if (!wantVideo || url) return;
    let alive = true;
    // Une demande DÉJÀ résolue n'a plus rien à annuler : envoyer quand même `proxyCancel` coûtait un
    // RPC par carte au moment précis où l'aperçu démarre — donc une rafale d'annulations inutiles
    // pendant tout le défilement, sur le même pont que les vignettes.
    let settled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const token = nextProxyToken();
    getProxyRef.current(proxyHeight(), token, "high").then((u) => {
      settled = true;
      if (!alive) return;
      if (u) setFetchedUrl(u);
      else if (tries < 4) retryTimer = setTimeout(() => alive && setTries((t) => t + 1), 600);
    });
    return () => { alive = false; if (retryTimer) clearTimeout(retryTimer); if (!settled) nr.proxyCancel(token); };
  }, [wantVideo, url, tries]);

  // ANTICIPATION. En lecture auto, une carte de la bande jouera à coup sûr en arrivant à l'écran :
  // on encode son proxy MAINTENANT, en priorité basse. Sans ça l'encode ne démarrait qu'une fois la
  // carte visible, et chaque nouvelle rangée attendait un ffmpeg complet — c'est ce qui donnait des
  // aperçus « en retard » sur le défilement.
  //
  // Trois garde-fous, chacun ciblant un échec déjà constaté :
  // 1. la BANDE de usePreviewActivity — pré-encoder toute la grille noyait NVENC et laissait une grille noire ;
  // 2. le DÉLAI DE STABILISATION — un flick traverse la bande en moins que ça, donc n'émet rien ;
  // 3. le PLAFOND de créneaux (`previewPrefetch`) — le pont /rpc reste libre pour les vignettes.
  const prefetchReady = useGranted(play && nearVideo, (settled) => {
    const timer = setTimeout(settled, PREFETCH_SETTLE_MS);
    return () => clearTimeout(timer);
  });

  // Sortie de bande = la carte est repartie → on tue l'encode. Mais quand la préchauffe s'arrête
  // parce que la carte vient de passer en LECTURE, la demande en vol est exactement celle qu'on
  // attend : l'annuler relancerait un ffmpeg de zéro au pire moment. D'où la lecture par ref.
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
      void getProxyRef.current(proxyHeight(), token, "low")
        .then((u) => { if (alive && u) setFetchedUrl(u); })
        .finally(releaseSlot);
    });
    return () => {
      alive = false;
      if (token != null && !nearVideoRef.current) nr.proxyCancel(token);
      releaseSlot();
    };
  }, [prefetchReady, wantVideo, url]);

  // <video> qui plante (décodage) → invalide le cache et recharge.
  function onVideoError() {
    bustProxyRef.current();
    setFetchedUrl(null);
    setTries((t) => Math.min(t + 1, 4));
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
    timer.current = setTimeout(() => setHovered(true), 180);
  }
  function leave() {
    dropClaim.current?.();
    hoverOff();
  }
  function focusEnter() { setFocusOn(true); }
  function focusLeave() { setFocusOn(false); }

  return {
    rootRef, thumb, url, showVideo, videoPaused,
    near: nearThumb || hovered, interactive: pointerOn || focusOn, hovered,
    onVideoError, enter, leave, focusEnter, focusLeave,
  };
}
