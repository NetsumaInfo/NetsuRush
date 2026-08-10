import { useState } from "react";
import { useTranslation } from "react-i18next";
import { nr } from "@/lib/bridge";
import { useApp } from "@/store";
import { hostBuildTimeline, hostImport } from "@/lib/host";
import { getActiveExportProfile } from "@/features/export/profiles";
import { timelineBuildOptsFromProfile, type TimelineBuildOpts } from "@/features/export/timelineTarget";
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

interface CutExportOpts {
  clipPath: string;
  clipName: string;
  srcFrames: number;
  targetList: () => Segment[];
  hasSelection?: () => boolean;
  setErr: (m: string | null) => void;
}

interface CutExport {
  busy: string | null;
  exported: string[];
  tlName: string;
  setTlName: React.Dispatch<React.SetStateAction<string>>;
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
  clipPath, clipName, srcFrames, targetList, hasSelection, setErr,
}: CutExportOpts): CutExport {
  const { t } = useTranslation("derush");
  const [busy, setBusy] = useState<string | null>(null);
  const [exported, setExported] = useState<string[]>([]);
  const [tlName, setTlName] = useState("");

  async function extract() {
    if (hasSelection && !hasSelection()) return;
    const list = targetList();
    if (!list.length) return;
    const dir = await nr.chooseDir();
    if (!dir) return;
    const sep = dir.includes("\\") ? "\\" : "/";
    const base = clipName.replace(/\.[^.]+$/, "");
    // Extraction en masse = tâche lourde (ffmpeg) → propose de fermer le logiciel de montage.
    if (list.length >= 5) useApp.getState().offerCloseForRam();
    setBusy(t("export.extracting")); setErr(null);
    const done: string[] = [];
    for (let i = 0; i < list.length; i++) {
      const out = `${dir}${sep}${base}_${String(i + 1).padStart(3, "0")}.mp4`;
      const r = await nr.exportClip({ input: clipPath, start: list[i].in, end: list[i].out, output: out });
      if (r.ok && r.output) done.push(r.output);
      else { setErr(t("export.clipError", { index: i + 1, error: r.error })); break; }
      setBusy(t("export.extractingN", { done: done.length, total: list.length }));
    }
    setBusy(null);
    setExported((e) => [...e, ...done]);
    toast.ok(t("export.extracted", { count: done.length, dir }));
  }

  async function createTimeline() {
    if (hasSelection && !hasSelection()) return;
    const list = targetList();
    if (!list.length) return;
    const name = tlName.trim() || t("shared.defaultDerushName", { name: clipName.replace(/\.[^.]+$/, "") });
    setBusy(t("export.creatingTimeline")); setErr(null);
    const host = useApp.getState().activeHost;
    // Action explicite « Créer une timeline » → toujours une nouvelle, quelle que soit la cible du profil.
    const r = await hostBuildTimeline(host, {
      name, input: clipPath, srcFrames, ...activeTimelineOpts(), mode: "new",
      segments: list.map((s) => ({ in: s.in, out: s.out, inFrame: s.inFrame, outFrame: s.outFrame })),
    });
    setBusy(null);
    r.ok ? toast.ok(t("export.timelineCreated", { name: r.timeline, count: r.count })) : setErr(r.error || t("shared.failedTimeline"));
  }

  // Envoie la SÉLECTION vers la timeline visée par le profil en un seul appel (frame-accurate).
  // L'action est volontairement inerte si aucune vignette n'est sélectionnée.
  async function appendSelection() {
    if (hasSelection && !hasSelection()) return;
    const list = targetList();
    if (!list.length) return;
    const name = tlName.trim() || t("shared.defaultDerushName", { name: clipName.replace(/\.[^.]+$/, "") });
    setBusy(t("export.sendingTimeline")); setErr(null);
    const host = useApp.getState().activeHost;
    const r = await hostBuildTimeline(host, {
      name, input: clipPath, srcFrames, ...activeTimelineOpts(),
      segments: list.map((s) => ({ in: s.in, out: s.out, inFrame: s.inFrame, outFrame: s.outFrame })),
    });
    setBusy(null);
    if (r.ok) toast.ok(`${t("export.sentTimeline", { count: r.count ?? list.length, name: r.timeline })}${r.created ? t("export.createdSuffix") : ""}${r.fpsMismatch ? t("export.fpsSuffix") : ""}`);
    else setErr(r.error || t("export.sendFailed"));
  }

  // Ajoute UN plan à la timeline visée par le profil : AppendToTimeline le pose à la suite du dernier
  // clip. Toujours 'append' — une cible « nouvelle timeline » créerait une timeline par plan.
  async function addToTimeline(s: Segment): Promise<{ ok: boolean; error?: string }> {
    const name = tlName.trim() || t("shared.defaultDerushName", { name: clipName.replace(/\.[^.]+$/, "") });
    setErr(null);
    const host = useApp.getState().activeHost;
    const r = await hostBuildTimeline(host, {
      name, input: clipPath, srcFrames, ...activeTimelineOpts(), mode: "append",
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

  return { busy, exported, tlName, setTlName, extract, createTimeline, appendSelection, addToTimeline, importBack };
}
