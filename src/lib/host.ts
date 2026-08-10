// Abstraction d'hôte : NetsuRush pilote DaVinci Resolve (flux natif) OU une app Adobe via le
// panneau CEP. Fonctions PURES (aucun import du store → pas de cycle) : métadonnées d'hôte,
// mapping snapshot→Clip, et routage de la construction de timeline vers le bon canal.
import { nr, type Clip, type AdobeApp, type AdobeSnapshot, type AdobeClip, type TimelineCut } from "@/lib/bridge";
import type { HostId } from "@/store/types";

export const HOSTS: { id: HostId; label: string; short: string }[] = [
  { id: "resolve", label: "DaVinci Resolve", short: "Resolve" },
  { id: "ppro", label: "Premiere Pro", short: "Premiere" },
  { id: "aeft", label: "After Effects", short: "After Effects" },
];

export function hostLabel(id: HostId): string {
  return HOSTS.find((h) => h.id === id)?.label ?? id;
}
export function hostShort(id: HostId): string {
  return HOSTS.find((h) => h.id === id)?.short ?? id;
}
export function isAdobeHost(id: HostId): id is AdobeApp {
  return id === "ppro" || id === "aeft";
}

// Indice d'action contextualisé : Resolve = pont natif + Media Pool ; Adobe = panneau CEP.
export function hostOfflineHint(id: HostId): string {
  return id === "resolve"
    ? "Ouvre un projet avec des rush et recharge, ou importe des vidéos du disque."
    : `Ouvre ${hostShort(id)} puis le panneau NetsuRush (Fenêtre ▸ Extensions), ou importe des vidéos du disque.`;
}

// Rushs d'un snapshot Adobe → forme Clip du Derush (source "mediapool" = éligible timeline).
export function rushesToClips(snap: AdobeSnapshot | null | undefined): Clip[] {
  if (!snap) return [];
  return snap.rushes.map((r) => ({
    name: r.name,
    path: r.path,
    duration: r.dur != null ? String(r.dur) : null,
    fps: r.fps != null ? String(r.fps) : null,
    resolution: r.w && r.h ? `${r.w}x${r.h}` : null,
    format: null,
    bin: null,
    source: "mediapool" as const,
  }));
}

// ---- Timeline Live sur hôte Adobe --------------------------------------------------------------
// Les plans montés d'une séquence Premiere / comp AE sont DÉJÀ dans le snapshot poussé par le
// panneau CEP (`sequences[].tracks[].clips[]`) : aucun canal supplémentaire n'est nécessaire, la
// vue lit le même objet que le reste de l'onglet Adobe.

/** Séquence Premiere / comp AE ouverte au moment du scan (équivalent de la timeline courante). */
export function hostCurrentTimeline(snap: AdobeSnapshot | null | undefined): string | null {
  const name = snap?.activeSequence ?? null;
  return name && snap?.sequences.some((s) => s.name === name) ? name : null;
}

/** Séquences (Premiere) / compositions (AE) d'un snapshot, au format du navigateur de timelines. */
export function hostTimelineNames(snap: AdobeSnapshot | null | undefined): { name: string; current: boolean }[] {
  if (!snap) return [];
  const current = hostCurrentTimeline(snap);
  return snap.sequences.map((s) => ({ name: s.name, current: s.name === current }));
}

/** fps de la source d'un plan ; repli sur la cadence de la séquence quand l'hôte ne la donne pas. */
function clipFps(clip: AdobeClip, sequenceFps: number | null): number {
  return clip.srcFps || sequenceFps || 0;
}

// Les frames viennent de l'hôte quand il les a calculées depuis ses ticks (Premiere) — c'est la
// seule voie exacte sur cadence non entière. Le repli secondes×fps ne sert qu'aux snapshots émis
// par un panneau antérieur à ces champs.
function inFrameOf(clip: AdobeClip, fps: number): number {
  if (clip.srcInFrame != null) return clip.srcInFrame;
  return fps && clip.srcIn != null ? Math.round(clip.srcIn * fps) : 0;
}
function outFrameOf(clip: AdobeClip, fps: number): number {
  if (clip.srcOutFrame != null) return clip.srcOutFrame;
  return fps && clip.srcOut != null ? Math.round(clip.srcOut * fps) - 1 : 0;
}

/**
 * Plans montés d'une séquence/comp, dans l'ordre de la timeline. Pistes VIDÉO seulement, et
 * uniquement les items adossés à un fichier : un titre ou un solide n'a pas de média à prévisualiser.
 */
export function hostTimelineCuts(snap: AdobeSnapshot | null | undefined, name: string): TimelineCut[] {
  const sequence = snap?.sequences.find((s) => s.name === name);
  if (!sequence) return [];
  const cuts: TimelineCut[] = [];
  for (const track of sequence.tracks) {
    if (track.kind !== "video") continue;
    track.clips.forEach((clip, index) => {
      if (!clip.path) return;
      const fps = clipFps(clip, sequence.fps);
      const inFrame = inFrameOf(clip, fps);
      cuts.push({
        // Même clé que côté Resolve : stable tant que le plan garde sa piste, son rang et son in.
        id: `${track.index}:${index}:${inFrame}`,
        path: clip.path,
        name: clip.name,
        track: track.index,
        trackName: track.name || "",
        in: clip.srcIn ?? 0,
        out: clip.srcOut ?? 0,
        inFrame,
        outFrame: outFrameOf(clip, fps),
        // 0 = longueur de source inconnue (Premiere ne l'expose pas). Aucun consommateur du flux
        // Adobe n'en dépend : le montage retour y travaille en secondes.
        srcFrames: clip.srcFrames ?? 0,
        fps,
        tlStart: clip.tlStart ?? 0,
      });
    });
  }
  return cuts.sort((a, b) => a.tlStart - b.tlStart);
}

export interface HostBuildOpts {
  name: string;
  input: string;
  srcFrames?: number;
  mode?: "new" | "append";
  timelineName?: string;        // Timeline / séquence / comp visée en mode append (défaut : celle ouverte)
  fps?: number;
  whole?: boolean;
  colors?: string[];            // Resolve uniquement (couleurs de clip) ; ignoré côté Adobe
  dest?: "timeline" | "bin";    // Resolve uniquement : range la nouvelle timeline dans un dossier Media Pool
  binName?: string;
  videoOnly?: boolean;          // Tous les hôtes : ne pose que la vidéo, sans réactiver l'audio source
  insertion?: "insert" | "overwrite" | "replace" | "fit" | "above" | "end" | "ripple_overwrite";
  // `path` par segment (Adobe) : un montage multi-sources, comme celui issu de Timeline Live.
  // Ignoré côté Resolve, dont `buildTimeline` monte depuis le MediaPoolItem de `input`.
  segments: { in: number; out: number; inFrame?: number; outFrame?: number; path?: string }[];
}
export interface HostBuildResult {
  ok: boolean;
  timeline?: string;
  count?: number;
  created?: boolean;
  fpsMismatch?: boolean;
  colored?: number;
  error?: string;
}

// Route la construction de timeline vers l'hôte actif. Resolve = nr.buildTimeline (frame-math
// native, 3 invariants, couleurs) ; Adobe = nr.adobeBuildTimeline (aller-retour job via le panneau CEP).
export async function hostBuildTimeline(host: HostId, opts: HostBuildOpts): Promise<HostBuildResult> {
  if (host === "resolve") {
    return nr.buildTimeline({
      name: opts.name, input: opts.input, srcFrames: opts.srcFrames,
      mode: opts.mode, timelineName: opts.timelineName, whole: opts.whole, colors: opts.colors,
      dest: opts.dest, binName: opts.binName, videoOnly: opts.videoOnly, insertion: opts.insertion, segments: opts.segments,
    });
  }
  return nr.adobeBuildTimeline({
    app: host, name: opts.name, input: opts.input, mode: opts.mode, timelineName: opts.timelineName,
    fps: opts.fps, whole: opts.whole, segments: opts.segments, videoOnly: opts.videoOnly, insertion: opts.insertion,
  });
}

// Importe des fichiers dans le projet de l'hôte actif : Resolve = Media Pool, Adobe = bins projet.
export async function hostImport(host: HostId, paths: string[]): Promise<{ ok: boolean; count?: number; error?: string }> {
  if (!paths.length) return { ok: true, count: 0 };
  if (host === "resolve") return nr.importToMediaPool(paths);
  return nr.adobeImport(host, paths);
}
