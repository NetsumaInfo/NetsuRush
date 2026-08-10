// Destination d'un montage : timeline OUVERTE (append), une timeline EXISTANTE choisie (append),
// ou une NOUVELLE timeline. Partagé par Collections et Timeline Live (bouton « ajouter à la
// timeline » des cartes + actions groupées). Encodage de la valeur : "open" | "new" | "tl:<nom>".
//
// La valeur vit dans le PROFIL D'EXPORT ACTIF, comme dans le Découpage (ExportTimelineTarget) : un
// état local ici donnait à Collections/Timeline Live une destination privée, que régler dans les
// réglages d'export ne changeait pas — et inversement.
import { useTranslation } from "react-i18next";
import { nr } from "@/lib/bridge";
import { useTimelineList } from "./useTimelineList";
import { hostBuildTimeline, isAdobeHost } from "@/lib/host";
import { useApp } from "@/store";
import { coerceTimelineTarget, getActiveExportProfile } from "@/features/export/profiles";

type TargetValue = string;

/** Bloc de montage : un plan d'une source, borné en frames (`outFrame` absent = jusqu'à la fin). */
interface TimelineBlock {
  filePath: string;
  inFrame?: number;
  outFrame?: number | null;
  fps?: number;
}

// Le job du panneau Adobe monte en SECONDES : on convertit ici, et on complète les blocs sans borne
// de sortie par la durée réelle du média (le jsx écarterait un segment sans plage valide).
async function adobeSegments(blocks: TimelineBlock[]) {
  const segments: { in: number; out: number; inFrame?: number; outFrame?: number; path: string }[] = [];
  for (const block of blocks) {
    const fps = block.fps || 0;
    const inSec = fps && block.inFrame != null ? block.inFrame / fps : 0;
    let outSec = fps && block.outFrame != null ? (block.outFrame + 1) / fps : null;
    if (outSec == null) outSec = await nr.probe(block.filePath).then((i) => i.duration).catch(() => null);
    if (outSec == null || outSec <= inSec) continue;
    segments.push({
      in: inSec, out: outSec, path: block.filePath,
      inFrame: block.inFrame, outFrame: block.outFrame ?? undefined,
    });
  }
  return segments;
}

// Ce que lit le sélecteur : une liste, une valeur, de quoi la changer. L'origine de la valeur
// (état local ici, profil d'export ailleurs) ne le regarde pas.
export interface TimelineTargetView {
  timelines: { name: string; current: boolean }[];
  current: string | null;
  value: TargetValue;
  setValue: (v: TargetValue) => void;
}

export interface TimelineTarget extends TimelineTargetView {
  loading: boolean;        // scan des timelines en cours (1er chargement ou refresh)
  refresh: () => Promise<void>;
  // Monte des blocs vers la destination choisie. name = nom si nouvelle timeline.
  build: (name: string, blocks: { filePath: string; inFrame?: number; outFrame?: number | null; fps?: number }[]) =>
    Promise<{ ok: boolean; timeline?: string; count?: number; error?: string }>;
}

export function useTimelineTarget(enabled = true): TimelineTarget {
  const { t } = useTranslation("derush");
  const { timelines, current, loading, refresh } = useTimelineList(enabled);
  const profiles = useApp((state) => state.exportProfiles);
  const activeProfileId = useApp((state) => state.activeExportProfileId);
  const updateProfile = useApp((state) => state.updateExportProfile);
  const activeHost = useApp((state) => state.activeHost);
  const insertion = useApp((state) => state.timelineInsertions[activeHost]);

  const profile = getActiveExportProfile(profiles, activeProfileId);
  const value = coerceTimelineTarget(profile.timelineTarget);
  const setValue = (next: TargetValue) => updateProfile(profile.id, { timelineTarget: coerceTimelineTarget(next) });

  async function build(name: string, blocks: TimelineBlock[]) {
    if (!blocks.length) return { ok: false, error: t("shared.noShots") };
    // « Timeline ouverte » alors qu'aucune ne l'est → nouvelle timeline. Repli calculé au montage et
    // NON écrit dans le profil : ouvrir la vue hôte déconnecté ne doit pas réécrire le réglage.
    const target = value === "open" && !current ? "new" : value;
    const mode: "new" | "append" = target === "new" ? "new" : "append";
    const timelineName = target.startsWith("tl:") ? target.slice(3) : undefined;

    // Adobe : même route que le Derush et la Recherche (job du panneau, segments en secondes).
    // `nr.script.buildTimeline` est le monteur NATIF Resolve — il ne sait pas parler à Premiere/AE.
    if (isAdobeHost(activeHost)) {
      const segments = await adobeSegments(blocks);
      if (!segments.length) return { ok: false, error: t("shared.noShots") };
      const r = await hostBuildTimeline(activeHost, {
        name, input: segments[0].path, mode, timelineName, insertion,
        fps: blocks[0].fps, segments,
      });
      return { ok: r.ok, timeline: r.timeline, count: r.count, error: r.error };
    }

    const r = await nr.script?.buildTimeline({ name, mode, timelineName, insertion, blocks });
    return { ok: !!r?.ok, timeline: r?.timeline, count: r?.count, error: r?.error };
  }

  return { timelines, current, loading, value, setValue, refresh, build };
}
