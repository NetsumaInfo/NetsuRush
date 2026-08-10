import { useEffect, useRef, useState } from "react";
import { nr, nextProxyToken } from "@/lib/bridge";
import { getThumb, setThumb as cacheThumb, subscribeThumbs } from "@/lib/thumbCache";
import { thumbTime } from "@/lib/utils";
import { acquirePlaySlot, type Segment } from "./cutStudioShared";
import { PREVIEW_SETTINGS_EVENT } from "@/lib/previewSettings";
import { observeViewport } from "@/lib/viewportObserver";
import { acquirePrefetchSlot } from "@/lib/previewPrefetch";
import { retainPausedVideo } from "@/lib/previewVideoPool";
import { IS_REMOTE } from "@/lib/remote";

// Bandes d'anticipation, en PIXELS FIXES. Elles étaient dérivées de la hauteur de cellule, donc un
// cran de densité changeait la marge de chaque carte : trois désabonnements + trois abonnements par
// vignette, soit quelques milliers d'opérations d'observateur sur un rush de plusieurs centaines de
// plans — c'est ce qui figeait le +/-. En pixels, les abonnements survivent au changement.
const THUMB_MIN_MARGIN_PX = 1200;
// INVARIANT : la bande proxy couvre la bande de LECTURE (sinon une carte réclamerait son créneau de
// lecture avant que son encode ait été lancé).
const VIDEO_MIN_MARGIN_PX = 420;
// AVANCE DE LECTURE. Une carte prend son créneau AVANT d'entrer dans le viewport : le temps qu'elle
// arrive à l'écran, son proxy est chargé et l'aperçu tourne déjà. Piloter la lecture sur la
// visibilité STRICTE (ce qui était fait) laissait voir une vignette figée le temps du créneau, du
// chargement et du premier décodage — la grille avait l'air arrêtée pendant qu'on défilait.
const PLAY_LEAD_PX = 320;
// Une carte doit rester dans la bande ce temps-là avant qu'on encode son proxy. Un défilement rapide
// traverse la bande en bien moins : aucune demande n'est émise pendant un flick, donc le pont /rpc
// reste libre pour les vignettes, qui sont ce qu'on regarde en défilant.
const PREFETCH_SETTLE_MS = 220;
// Délai avant de DÉMONTER la <video> d'une carte sortie de la bande : un aller-retour de molette la
// ramène en bien moins, et détruire/recréer un élément média coûte un chargement + une init de
// décodeur.
const VIDEO_RELEASE_MS = 400;

interface SceneCardMediaOpts {
  seg: Segment;
  index: number;
  clipPath: string;
  play: boolean;
  getProxy: (height?: number, token?: number, priority?: "high" | "low") => Promise<string | null>;
  bustProxy: () => void;
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

// État + effets « média/visibilité » d'une carte de plan : deux IntersectionObservers (vignette
// loin, <video> ±1 rangée), vignette en lazy avec retry, créneau de lecture « Lecture auto »
// échelonné, chargement du proxy à la demande avec retry, survol temporisé.
export function useSceneCardMedia({
  seg, index, clipPath, play, getProxy, bustProxy,
}: SceneCardMediaOpts): SceneCardMedia {
  const rootRef = useRef<HTMLDivElement>(null);

  const [thumb, setThumb] = useState<string | null>(() => getThumb(clipPath, thumbTime(seg.in, seg.out)));
  const [url, setUrl] = useState<string | null>(null);
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
  const [nearVideo, setNearVideo] = useState(false); // proxy HEVC : précharge visible ±1 rangée
  const [visible, setVisible] = useState(false);     // VRAIMENT à l'écran : pilote le créneau de lecture
  const [staggerReady, setStaggerReady] = useState(false);
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
      setUrl(null);
      setTries(0);
    };
    window.addEventListener(PREVIEW_SETTINGS_EVENT, reset);
    return () => window.removeEventListener(PREVIEW_SETTINGS_EVENT, reset);
  }, []);

  // Trois bandes distinctes, servies par des observateurs PARTAGÉS (un par marge pour toute la
  // grille, cf. `viewportObserver`) : une paire d'observateurs par carte suffisait à saccader le
  // défilement sur un rush de plusieurs centaines de plans.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    // Proxy : bande COURTE (l'encode coûte un ffmpeg), assez large pour que la préchauffe soit
    // terminée à l'arrivée à l'écran. Le côté qu'on quitte est annulé (proxyCancel).
    const stopVideo = observeViewport(el, VIDEO_MIN_MARGIN_PX, setNearVideo);
    // Bande de LECTURE : courte avance sur le viewport, pour que la carte joue déjà quand elle
    // apparaît. Le plafond de lecture auto compte cette avance (cf. autoplayCeiling).
    const stopVisible = observeViewport(el, PLAY_LEAD_PX, setVisible);
    return () => { stopVideo(); stopVisible(); };
  }, []);

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
      if (typeof r === "string") { const u = nr.mediaUrl(r); cacheThumb(clipPath, u, t); setThumb(u); } else retry();
    }).catch(retry);
    return () => { alive = false; if (retryTimer) clearTimeout(retryTimer); };
  }, [nearThumb, clipPath, seg.in, seg.out, thumb, thumbTries]);

  // « Lecture auto » : prend un créneau (cap + échelonné), seulement pour la rangée visible ±1.
  // Le survol joue hors quota.
  useEffect(() => {
    if (!(play && visible) || hovered) { setStaggerReady(false); return; }
    const release = acquirePlaySlot(index, () => setStaggerReady(true));
    return () => { release(); setStaggerReady(false); };
  }, [play, visible, hovered, index]);

  // La carte JOUE : survol (immédiat) ou créneau de lecture auto accordé (staggerReady, échelonné
  // HAUT D'ABORD).
  const wantVideo = nearVideo && (hovered || (play && staggerReady));

  // La <video> reste MONTÉE tant que la carte est dans la bande proxy, même quand elle cesse de
  // jouer. Elle était démontée dès la sortie d'écran (ou dès le créneau rendu) : au défilement, la
  // grille détruisait et recréait plusieurs dizaines d'éléments média par seconde — chacun un
  // chargement HTTP plus une init de décodeur sur le thread principal. C'est ce qui hachait le
  // défilement. Ici on met en PAUSE (l'élément s'efface derrière la vignette, cf. PreviewVideo) et
  // on ne démonte qu'à la vraie sortie de bande, après un court délai anti-aller-retour.
  const [held, setHeld] = useState(false);
  if (wantVideo && url && !held) setHeld(true);
  if (held && !url) setHeld(false);
  useEffect(() => {
    if (!held || nearVideo) return;
    const t = setTimeout(() => setHeld(false), VIDEO_RELEASE_MS);
    return () => clearTimeout(t);
  }, [held, nearVideo]);

  const showVideo = held && !!url;
  const videoPaused = !wantVideo;

  // Plafond global des <video> retenues en pause : Chromium cesse silencieusement de créer des
  // lecteurs média au-delà d'une certaine quantité par frame.
  useEffect(() => {
    if (!showVideo || !videoPaused) return;
    return retainPausedVideo(() => setHeld(false));
  }, [showVideo, videoPaused]);

  // Génère/récupère le proxy (cache) en HAUTE priorité (la carte est dans le focus). Perte de focus /
  // démontage → proxyCancel (kill l'encode / jette de la file) → le créneau NVENC repart aux visibles.
  useEffect(() => {
    if (!wantVideo || url) return;
    let alive = true;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const token = nextProxyToken();
    getProxyRef.current(proxyHeight(), token, "high").then((u) => {
      if (!alive) return;
      if (u) setUrl(u);
      else if (tries < 4) retryTimer = setTimeout(() => alive && setTries((t) => t + 1), 600);
    });
    return () => { alive = false; if (retryTimer) clearTimeout(retryTimer); nr.proxyCancel(token); };
  }, [wantVideo, url, tries]);

  // ANTICIPATION. En lecture auto, une carte de la bande jouera à coup sûr en arrivant à l'écran :
  // on encode son proxy MAINTENANT, en priorité basse. Sans ça l'encode ne démarrait qu'une fois la
  // carte visible, et chaque nouvelle rangée attendait un ffmpeg complet — c'est ce qui donnait des
  // aperçus « en retard » sur le défilement.
  //
  // Trois garde-fous, chacun ciblant un échec déjà constaté :
  // 1. la BANDE (VIDEO_MIN_MARGIN_PX) — pré-encoder toute la grille noyait NVENC et laissait une grille noire ;
  // 2. le DÉLAI DE STABILISATION — un flick traverse la bande en moins que ça, donc n'émet rien ;
  // 3. le PLAFOND de créneaux (`previewPrefetch`) — le pont /rpc reste libre pour les vignettes.
  const [prefetchReady, setPrefetchReady] = useState(false);
  useEffect(() => {
    if (!(play && nearVideo)) { setPrefetchReady(false); return; }
    const timer = setTimeout(() => setPrefetchReady(true), PREFETCH_SETTLE_MS);
    return () => { clearTimeout(timer); setPrefetchReady(false); };
  }, [play, nearVideo]);

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
        .then((u) => { if (alive && u) setUrl(u); })
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
    setUrl(null);
    setTries((t) => Math.min(t + 1, 4));
  }

  function enter() {
    setPointerOn(true);
    timer.current = setTimeout(() => setHovered(true), 180);
  }
  function leave() {
    setPointerOn(false);
    if (timer.current) clearTimeout(timer.current);
    setHovered(false);
  }
  function focusEnter() { setFocusOn(true); }
  function focusLeave() { setFocusOn(false); }

  return {
    rootRef, thumb, url, showVideo, videoPaused,
    near: nearThumb || hovered, interactive: pointerOn || focusOn, hovered,
    onVideoError, enter, leave, focusEnter, focusLeave,
  };
}
