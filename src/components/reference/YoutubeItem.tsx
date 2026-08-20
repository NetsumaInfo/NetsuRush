// Item YouTube piloté par l'IFrame Player API (pas un simple embed) → vraie boucle sur [trimIn,
// trimOut] (un embed `end=` reboucle à 0, pas à `start`). Remonte aussi la durée (getDuration)
// pour borner le sélecteur de portée de l'inspecteur. iframe en pointer-events:none (drag préservé).

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ExternalLink, Download } from "lucide-react";
import { cn } from "@/lib/utils";
import { nr } from "@/lib/bridge";
import type { BoardItem } from "./referenceShared";
import { useBoard } from "./useReferenceBoard";
import { registerPlayer } from "./playhead";
import { downloadYoutube } from "./boardMediaActions";

// Typage minimal de l'API (chargée dynamiquement, sans @types).
interface YTPlayer {
  mute(): void;
  playVideo(): void;
  pauseVideo(): void;
  seekTo(s: number, allow: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  destroy(): void;
}
interface YTNamespace {
  Player: new (el: HTMLElement, opts: unknown) => YTPlayer;
  PlayerState: { ENDED: number; PLAYING: number };
}

// On reboucle AVANT que la vidéo atteigne son terme : sur l'état ENDED, YouTube affiche son écran
// de fin (gros bouton de lecture au centre) MÊME avec `controls:0` — c'était le « flash de pause »
// visible à chaque tour de boucle. La queue sacrifiée est inaudible sur un mood-board.
const LOOP_TAIL_S = 0.3;
const LOOP_POLL_MS = 100;
// Après un reseek, getCurrentTime() renvoie encore l'ancienne position pendant quelques frames →
// sans garde on redéclenche le seek en rafale (saccade + nouveau flash).
const SEEK_COOLDOWN_MS = 500;
// Délai après lequel une portée qu'on vient de modifier est considérée comme posée (cf. l'effet qui
// ramène la lecture dedans), et tolérance en deçà de la borne d'entrée pour ne pas resauter sur un
// écart de décodage de quelques dixièmes.
const RANGE_SETTLE_MS = 250;
const RANGE_SNAP_S = 0.5;
declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

// Chargement unique du script de l'API.
let ytReady: Promise<YTNamespace> | null = null;
function loadYT(): Promise<YTNamespace> {
  if (ytReady) return ytReady;
  ytReady = new Promise((resolve) => {
    if (window.YT?.Player) return resolve(window.YT);
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      if (window.YT) resolve(window.YT);
    };
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(s);
  });
  return ytReady;
}

// Les callbacks du player (onReady/onStateChange) survivent au rendu qui les a créés : ils lisent
// l'autorisation de jouer dans le store, pas dans une closure périmée.
function playAllowed(item: BoardItem) {
  const s = useBoard.getState();
  const suspended = s.frozen || (s.navigating && s.prefs.pauseMediaWhileNavigating);
  return !suspended && (item.playMode ?? "loop") !== "off";
}

export function YoutubeItem({ item, interactive, onReady }: { item: BoardItem; interactive?: boolean; onReady?: () => void }) {
  const { t } = useTranslation("reference");
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const patchItem = useBoard((s) => s.patchItem);
  // Suspension = gel GLOBAL (bouton Figer) OU gel transitoire de navigation, comme les vidéos
  // locales. Contrepartie assumée : YouTube affiche son habillage de pause (titre, gros ❚❚,
  // « Plus de vidéos ») pendant le geste — c'est le prix d'un pan/déplacement qui ne laisse plus
  // tourner les lecteurs. La préférence « Médias pendant la navigation » désactive le comportement.
  const suspended = useBoard((s) => s.frozen || (s.navigating && s.prefs.pauseMediaWhileNavigating));
  // Code d'erreur YouTube (2 id invalide, 5 lecteur, 100 introuvable/privée, 101/150 intégration
  // désactivée par l'auteur) → on bascule sur une superposition actionnable au lieu de l'écran mort.
  const [err, setErr] = useState<number | null>(null);
  // YouTube ne lit pas en arrière → "pingpong" se comporte comme "loop". Seul "off" empêche la lecture.
  const playing = !suspended && (item.playMode ?? "loop") !== "off";
  // Portée courante lue par le poll (mise à jour sans recréer le player).
  const loop = useRef<{ in: number; out: number | null }>({ in: 0, out: null });
  useEffect(() => {
    loop.current = {
      in: item.trimIn && item.trimIn > 0 ? item.trimIn : 0,
      out: item.trimOut != null && item.trimOut > (item.trimIn ?? 0) ? item.trimOut : null,
    };
    // Portée posée AILLEURS que là où joue la vidéo : on y saute. Le poll ci-dessous ne reboucle
    // qu'une fois la borne de sortie atteinte — une portée placée vers la fin laissait donc tourner
    // tout ce qui la précède avant de s'appliquer, plusieurs minutes durant, l'air figé.
    // Différé : les bornes changent à chaque pixel du curseur, et corriger à chaque événement
    // relancerait le chargement réseau qu'on vient justement d'éviter pendant le geste.
    const timer = setTimeout(() => {
      const p = playerRef.current;
      const now = p?.getCurrentTime?.();
      if (now == null) return;
      const { in: tin, out } = loop.current;
      if (now >= tin - RANGE_SNAP_S && (out == null || now <= out)) return;
      lastSeekRef.current = Date.now();
      p?.seekTo?.(tin, true);
    }, RANGE_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [item.trimIn, item.trimOut]);

  // Playhead + scrub for the inspector. A manual seek also arms the cooldown: without it the loop
  // poll sees a position past the out bound and yanks playback back while the bound is still moving.
  const lastSeekRef = useRef(0);
  useEffect(
    () =>
      registerPlayer(item.id, {
        time: () => playerRef.current?.getCurrentTime?.() ?? null,
        seek: (t, scrubbing) => {
          lastSeekRef.current = Date.now();
          // `allowSeekAhead` à FAUX tant que la borne bouge : le lecteur se contente alors de ce
          // qu'il a déjà en tampon. À vrai, chaque événement du curseur lui fait demander un nouveau
          // segment au réseau — poser un in/out vers le milieu ou la fin en lançait des dizaines, et
          // le lecteur restait figé le temps de toutes les honorer. Le seek final, lui, autorise le
          // chargement : c'est lui qui doit montrer la vraie image de la borne posée.
          playerRef.current?.seekTo?.(t, !scrubbing);
        },
      }),
    [item.id],
  );

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    setErr(null); // nouvelle vidéo → on repart sans erreur
    loadYT().then((YT) => {
      const host = hostRef.current;
      if (cancelled || !host) return;
      playerRef.current = new YT.Player(host, {
        videoId: item.ref,
        // nocookie : évite le stockage tiers bloqué par la Tracking Prevention de WebView2.
        host: "https://www.youtube-nocookie.com",
        width: "100%",
        height: "100%",
        playerVars: {
          autoplay: 1, mute: 1, controls: 0, modestbranding: 1, rel: 0, playsinline: 1, fs: 0,
          // Sous-titres et fiches JAMAIS imposés : sans `cc_load_policy: 0`, YouTube rallume les
          // sous-titres d'après le compte ou la langue du système et les grave sur la carte.
          cc_load_policy: 0, iv_load_policy: 3,
          // enablejsapi + origin : sinon postMessage de l'IFrame API échoue (« target origin
          // does not match ») dans la WebView2 (origine http://127.0.0.1:1420).
          enablejsapi: 1,
          origin: typeof window !== "undefined" ? window.location.origin : undefined,
          start: Math.floor(loop.current.in),
        },
        events: {
          onReady: (e: { target: YTPlayer }) => {
            e.target.mute();
            if (playAllowed(item)) e.target.playVideo();
            const d = e.target.getDuration();
            if (d && Math.abs(d - (item.dur ?? 0)) > 0.5) patchItem(item.id, { dur: d }, false);
            onReady?.();
          },
          onStateChange: (e: { data: number; target: YTPlayer }) => {
            // Filet de sécurité : le poll reboucle normalement avant ENDED (cf. LOOP_TAIL_S).
            if (e.data === YT.PlayerState.ENDED) {
              e.target.seekTo(loop.current.in, true);
              lastSeekRef.current = Date.now();
              if (playAllowed(item)) e.target.playVideo();
            }
          },
          // Une erreur est un état FINI : elle lève aussi le voile de chargement, sinon la
          // superposition « non intégrable » et ses deux boutons resteraient derrière un spinner.
          onError: (e: { data: number }) => { setErr(e.data); onReady?.(); },
        },
      });
      // Boucle sur [in, out], borne de fin toujours ramenée en deçà du terme de la vidéo.
      timer = setInterval(() => {
        const p = playerRef.current;
        if (!p?.getCurrentTime) return;
        if (p.getPlayerState?.() !== YT.PlayerState.PLAYING) return;
        if (Date.now() - lastSeekRef.current < SEEK_COOLDOWN_MS) return;
        const { in: tin, out } = loop.current;
        const dur = p.getDuration?.() || 0;
        const tail = dur > LOOP_TAIL_S ? dur - LOOP_TAIL_S : Infinity;
        const end = Math.min(out ?? Infinity, tail);
        if (!Number.isFinite(end) || p.getCurrentTime() < end) return;
        lastSeekRef.current = Date.now();
        p.seekTo(tin, true);
      }, LOOP_POLL_MS);
    });
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      try { playerRef.current?.destroy(); } catch { /* déjà détruit */ }
      playerRef.current = null;
    };
    // Recréé uniquement quand la vidéo change (pas au trim → géré par le poll).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.ref]);

  // Lecture / gel global — un item "off" reste figé même au Play global.
  useEffect(() => {
    const p = playerRef.current;
    if (!p?.playVideo) return;
    if (playing) p.playVideo();
    else p.pauseVideo();
  }, [playing]);

  // Wrapper en pointer-events:none : YT REMPLACE la div interne par une iframe (qui perdrait la
  // classe) → on neutralise les events sur le PARENT pour que le drag du board ne soit pas volé.
  return (
    // `block` + `[&>iframe]:block` : l'iframe injectée par YT est inline par défaut → un fin trait
    // horizontal (gap de ligne de base) apparaît sous la vidéo ; on la force en bloc + `border-0`
    // (certaines WebView dessinent une bordure d'iframe par défaut).
    <div className={cn("relative block h-full w-full overflow-hidden", interactive ? "pointer-events-auto" : "pointer-events-none")}>
      <div ref={hostRef} className="block h-full w-full [&>iframe]:block [&>iframe]:h-full [&>iframe]:w-full [&>iframe]:border-0" />
      {err != null && (
        // YouTube refuse la lecture intégrée (vidéo privée/supprimée ou intégration désactivée par
        // l'auteur) → on propose d'ouvrir sur YouTube ou de télécharger une copie locale jouable.
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-card/90 p-3 text-center backdrop-blur">
          <AlertTriangle className="size-6 text-muted-foreground" strokeWidth={1.5} />
          <p className="text-xs font-medium text-foreground">{t("youtube.notEmbeddable")}</p>
          <p className="max-w-[90%] text-[11px] text-muted-foreground">{t("youtube.blocked")}</p>
          <div className="pointer-events-auto mt-1 flex flex-wrap justify-center gap-2">
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => void nr.openExternal(`https://www.youtube.com/watch?v=${item.ref}`)}
              className="inline-flex items-center gap-1.5 rounded bg-muted px-2 py-1 text-[11px] font-medium text-foreground hover:bg-muted/70"
            >
              <ExternalLink className="size-3.5" /> {t("youtube.openOnYouTube")}
            </button>
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => void downloadYoutube(item.id)}
              className="inline-flex items-center gap-1.5 rounded bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90"
            >
              <Download className="size-3.5" /> {t("actions.download")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
