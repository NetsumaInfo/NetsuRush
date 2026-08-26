import { useState } from "react";
import { useTranslation } from "react-i18next";
import { nr } from "@/lib/bridge";
import { useApp } from "@/store";
import { hostBuildTimeline, hostImport } from "@/lib/host";
import { getActiveExportProfile } from "@/features/export/profiles";
import { timelineBuildOptsFromProfile, newTimelineName, type TimelineBuildOpts } from "@/features/export/timelineTarget";
import { type Segment } from "./cutStudioShared";
import { toast } from "@/components/ui/toast";

// Montage piloté par le profil d'export ACTIF : timeline visée, dossier de rangement, vidéo seule.
// Les TROIS chemins (créer / envoyer la sélection / ajouter un plan) passent par ici — sinon le
// bouton du panneau ignore silencieusement les réglages du profil.
function activeTimelineOpts(): TimelineBuildOpts {
  const st = useApp.getState();
  return {
    ...timelineBuildOptsFromProfile(getActiveExportProfile(st.exportProfiles, st.activeExportProfileId)),
    insertion: st.timelineInsertions[st.activeHost],
  };
}

// Nom de la timeline créée : celui saisi dans le sélecteur de destination, sinon « <rush> — Derush ».
function timelineName(fallback: string): string {
  const st = useApp.getState();
  return newTimelineName(getActiveExportProfile(st.exportProfiles, st.activeExportProfileId), fallback);
}

// Regroupe les plans PAR RUSH en gardant l'ordre du flux : le montage sort dans l'ordre où la grille
// les montre. Un appel de montage porte un seul fichier source (l'API de l'hôte en prend un), donc
// un flux de quatre rushs = quatre appels enchaînés sur la même timeline.
function groupByPath(list: Segment[], pathOf: (s: Segment) => string): { path: string; shots: Segment[] }[] {
  const out: { path: string; shots: Segment[] }[] = [];
  for (const s of list) {
    const path = pathOf(s);
    const last = out[out.length - 1];
    if (last && last.path === path) last.shots.push(s);
    else out.push({ path, shots: [s] });
  }
  return out;
}

const asSegments = (shots: Segment[]) => shots.map((s) => ({ in: s.in, out: s.out, inFrame: s.inFrame, outFrame: s.outFrame }));

interface CutExportOpts {
  /** Fichier source d'un plan (un flux en enchaîne plusieurs). */
  pathOf: (s: Segment) => string;
  /** Nombre d'images du rush — la frame-accuracy est propre à chaque source. */
  srcFramesOf: (path: string) => number;
  /** Nom de fichier d'un rush, pour nommer les extraits. */
  nameOf: (path: string) => string;
  /** Nom de base du flux : celui du premier rush, utilisé pour la timeline créée. */
  baseName: string;
  targetList: () => Segment[];
  hasSelection?: () => boolean;
  setErr: (m: string | null) => void;
}

interface CutExport {
  busy: string | null;
  exported: string[];
  extract: () => Promise<void>;
  createTimeline: () => Promise<void>;
  appendSelection: () => Promise<void>;
  addToTimeline: (s: Segment) => Promise<{ ok: boolean; error?: string }>;
  importBack: () => Promise<void>;
}

// Actions de sortie (toutes lossless / API Resolve) : extraction -c copy, création/ajout de
// timeline frame-accurate, import retour au Media Pool. La gestion des caches vit dans
// Paramètres › Stockage (purge ciblée par rush) — plus de purge globale depuis ici.
export function useCutExport({
  pathOf, srcFramesOf, nameOf, baseName, targetList, hasSelection, setErr,
}: CutExportOpts): CutExport {
  const { t } = useTranslation("derush");
  // Le libellé part AUSSI dans le store : c'est lui que lit la pastille d'export (cf.
  // ExportStatusToast), pour que « ça monte la timeline » s'affiche au même endroit que son résultat
  // plutôt qu'en pied de panneau. L'état local reste, il sert à éteindre les boutons.
  const setExportBusy = useApp((s) => s.setExportBusy);
  const setExportProgress = useApp((s) => s.setExportProgress);
  const [busy, setBusyLocal] = useState<string | null>(null);
  const setBusy = (label: string | null) => {
    setBusyLocal(label);
    // Progression remise à zéro à l'ENTRÉE d'une phase : un montage de timeline ne se mesure pas, et
    // la pastille afficherait sinon le pourcentage d'un export de fichiers terminé depuis longtemps.
    if (label) setExportProgress(0);
    setExportBusy(label);
  };
  const [exported, setExported] = useState<string[]>([]);

  const stem = (name: string) => name.replace(/\.[^.]+$/, "");

  async function extract() {
    if (hasSelection && !hasSelection()) return;
    const list = targetList();
    if (!list.length) return;
    const dir = await nr.chooseDir();
    if (!dir) return;
    const sep = dir.includes("\\") ? "\\" : "/";
    // Extraction en masse = tâche lourde (ffmpeg) → propose de fermer le logiciel de montage.
    if (list.length >= 5) useApp.getState().offerCloseForRam();
    setBusy(t("export.extracting")); setErr(null);
    const done: string[] = [];
    // Numérotation PAR RUSH : dans un flux, `rushA_001` puis `rushB_001` se lisent tout de suite,
    // là où un compteur global écrirait `rushB_014` sans dire d'où vient le 14.
    const nth = new Map<string, number>();
    for (let i = 0; i < list.length; i++) {
      const input = pathOf(list[i]);
      const n = (nth.get(input) ?? 0) + 1;
      nth.set(input, n);
      const out = `${dir}${sep}${stem(nameOf(input))}_${String(n).padStart(3, "0")}.mp4`;
      const r = await nr.exportClip({ input, start: list[i].in, end: list[i].out, output: out });
      if (r.ok && r.output) done.push(r.output);
      else { setErr(t("export.clipError", { index: i + 1, error: r.error })); break; }
      setBusy(t("export.extractingN", { done: done.length, total: list.length }));
    }
    setBusy(null);
    setExported((e) => [...e, ...done]);
    toast.ok(t("export.extracted", { count: done.length, dir }));
  }

  // Envoie une liste de plans vers UNE timeline, rush par rush. Le premier groupe porte le mode
  // demandé (nouvelle timeline, ou la cible du profil) ; les suivants s'ajoutent à la timeline que
  // ce premier appel a désignée — sinon un flux de quatre rushs créerait quatre timelines.
  async function buildFlow(list: Segment[], name: string, mode?: "new" | "append") {
    const host = useApp.getState().activeHost;
    const groups = groupByPath(list, pathOf);
    let timeline: string | undefined;
    let created = false;
    let count = 0;
    let fpsMismatch = false;
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const r = await hostBuildTimeline(host, {
        name, input: g.path, srcFrames: srcFramesOf(g.path), ...activeTimelineOpts(),
        ...(i === 0 ? (mode ? { mode } : {}) : { mode: "append" as const, timelineName: timeline }),
        segments: asSegments(g.shots),
      });
      if (!r.ok) return { ok: false as const, error: r.error, timeline, count, created, fpsMismatch };
      timeline = r.timeline || timeline;
      created = created || !!r.created;
      count += r.count ?? g.shots.length;
      fpsMismatch = fpsMismatch || !!r.fpsMismatch;
    }
    return { ok: true as const, error: undefined, timeline, count, created, fpsMismatch };
  }

  async function createTimeline() {
    if (hasSelection && !hasSelection()) return;
    const list = targetList();
    if (!list.length) return;
    const name = timelineName(t("shared.defaultDerushName", { name: stem(baseName) }));
    setBusy(t("export.creatingTimeline")); setErr(null);
    // Action explicite « Créer une timeline » → toujours une nouvelle, quelle que soit la cible du profil.
    const r = await buildFlow(list, name, "new");
    setBusy(null);
    r.ok ? toast.ok(t("export.timelineCreated", { name: r.timeline, count: r.count })) : setErr(r.error || t("shared.failedTimeline"));
  }

  // Envoie la SÉLECTION vers la timeline visée par le profil (frame-accurate, un appel par rush).
  // L'action est volontairement inerte si aucune vignette n'est sélectionnée.
  async function appendSelection() {
    if (hasSelection && !hasSelection()) return;
    const list = targetList();
    if (!list.length) return;
    const name = timelineName(t("shared.defaultDerushName", { name: stem(baseName) }));
    setBusy(t("export.sendingTimeline")); setErr(null);
    const r = await buildFlow(list, name);
    setBusy(null);
    if (r.ok) toast.ok(`${t("export.sentTimeline", { count: r.count ?? list.length, name: r.timeline })}${r.created ? t("export.createdSuffix") : ""}${r.fpsMismatch ? t("export.fpsSuffix") : ""}`);
    else setErr(r.error || t("export.sendFailed"));
  }

  // Ajoute UN plan à la timeline visée par le profil : AppendToTimeline le pose à la suite du dernier
  // clip. Toujours 'append' — une cible « nouvelle timeline » créerait une timeline par plan.
  async function addToTimeline(s: Segment): Promise<{ ok: boolean; error?: string }> {
    const name = timelineName(t("shared.defaultDerushName", { name: stem(baseName) }));
    setErr(null);
    const host = useApp.getState().activeHost;
    const input = pathOf(s);
    const r = await hostBuildTimeline(host, {
      name, input, srcFrames: srcFramesOf(input), ...activeTimelineOpts(), mode: "append",
      segments: [{ in: s.in, out: s.out, inFrame: s.inFrame, outFrame: s.outFrame }],
    });
    if (r.ok) toast.ok(`${t("export.shotAdded", { name: r.timeline })}${r.created ? t("export.createdSuffix") : ""}${r.fpsMismatch ? t("export.fpsSuffix") : ""}`);
    else setErr(r.error || t("export.addFailed"));
    return r;
  }

  async function importBack() {
    if (!exported.length) return;
    setBusy(t("export.importing"));
    const host = useApp.getState().activeHost;
    const r = await hostImport(host, exported);
    setBusy(null);
    const dest = host === "resolve" ? "Media Pool" : t("export.destProject");
    r.ok ? toast.ok(t("export.imported", { count: r.count ?? exported.length, dest })) : setErr(r.error || t("shared.failedImport"));
  }

  return { busy, exported, extract, createTimeline, appendSelection, addToTimeline, importBack };
}
