// Export du script vers la timeline de l'HÔTE ACTIF — extrait de ScriptTopBar. Resolve = build
// natif multi-sources `nr.script.buildTimeline` (frame-accurate + commentaires → marqueurs) ;
// Premiere/AE = boucle `hostBuildTimeline` mono-source (1er appel "new"/"append" puis "append",
// pattern search.ts) — les marqueurs n'ont pas d'équivalent Adobe (notice).

import { useMemo, useState } from "react";
import i18n from "@/i18n";
import { nr } from "@/lib/bridge";
import { useApp } from "@/store";
import { hostBuildTimeline, hostShort } from "@/lib/host";
import { docSections, frameToSec, parseLinkedIds, stripHtml, type ScriptBlockMedia, type ScriptDoc } from "./scriptShared";
import { useScript } from "./useScript";

export type BuildState = { kind: "idle" } | { kind: "busy"; progress?: string } | { kind: "done"; text: string; warn?: boolean } | { kind: "error"; text: string };

interface ClipEntry { filePath: string; inFrame: number; outFrame: number | null; fps: number }
interface MarkerEntry { index: number; name: string; note: string; color: string }

// Blocs dans le périmètre d'export : sections cochées dans l'onglet Plan, sinon tout le document.
function scopedBlocks(doc: ScriptDoc, sectionSel: string[]) {
  if (!sectionSel.length) return doc.blocks;
  const keep = new Set(
    docSections(doc)
      .filter((s) => sectionSel.includes(s.id))
      .flatMap((s) => s.blockIds),
  );
  return doc.blocks.filter((b) => keep.has(b.id));
}

// Types de bloc qui ne PORTENT pas de narration (aucun trou « à illustrer » à signaler dessus).
const META_TYPES = new Set(["heading", "storyboard", "divider", "callout", "note", "todo"]);

// Ordre timeline = ordre des PLAGES DE TEXTE LIÉES dans le document (le passage surligné EST le
// plan). Un média jamais lié (pastille grise) n'est PAS monté. Une plage à cheval sur 2 blocs =
// UN clip (dédupe par id à la première apparition) ; le même fichier lié 2 fois = 2 instances
// (in/out indépendants). Marqueurs : bloc « note » → « Commentaire » sur le plan suivant ;
// paragraphe de narration SANS plage liée → « À illustrer » (UN marqueur par trou CONTIGU).
function buildPayload(blocks: ScriptDoc["blocks"]) {
  const mediaById = new Map<string, ScriptBlockMedia>();
  for (const b of blocks) for (const m of b.media) if (m.id) mediaById.set(m.id, m);

  const clips: ClipEntry[] = [];
  const markers: MarkerEntry[] = [];
  const seen = new Set<string>();
  let pending: string[] = [];
  let gapOpen = false;

  for (const b of blocks) {
    if (b.type === "note") {
      const t = stripHtml(b.text);
      if (t) pending.push(t);
      continue;
    }
    const linkedIds = parseLinkedIds(b.text);
    for (const id of linkedIds) {
      if (seen.has(id)) continue; // plage continuée depuis le bloc précédent
      seen.add(id);
      const m = mediaById.get(id);
      if (!m || m.kind !== "video") continue; // audio/storyboard lié = couverture, pas un clip
      if (pending.length) {
        markers.push({ index: clips.length, name: i18n.t("script:export.comment"), note: pending.join("\n"), color: "Cyan" });
        pending = [];
      }
      clips.push({ filePath: m.filePath, inFrame: m.inFrame, outFrame: m.outFrame, fps: m.fps });
    }
    if (linkedIds.length) { gapOpen = false; continue; }
    // Trou : de la narration sans aucune plage liée → marqueur « À illustrer » au début du plan
    // suivant (un seul par suite de blocs nus).
    if (!META_TYPES.has(b.type) && stripHtml(b.text) && !gapOpen) {
      const excerpt = stripHtml(b.text).split(/\s+/).slice(0, 24).join(" ");
      markers.push({ index: clips.length, name: i18n.t("script:export.toIllustrate"), note: excerpt, color: "Red" });
      gapOpen = true;
    }
  }
  if (pending.length && clips.length) {
    markers.push({ index: clips.length - 1, name: i18n.t("script:export.comment"), note: pending.join("\n"), color: "Cyan" });
  }
  // Marqueurs pointant APRÈS le dernier plan (trou/note en fin de script) → ancrés sur le dernier.
  const bounded = clips.length ? markers.map((m) => (m.index >= clips.length ? { ...m, index: clips.length - 1 } : m)) : [];
  return { clips, markers: bounded };
}

async function runResolve(name: string, mode: "new" | "append", clips: ClipEntry[], markers: MarkerEntry[] | undefined): Promise<BuildState> {
  const r = await nr.script?.buildTimeline({ name, mode, blocks: clips, markers });
  if (!r || !r.ok) return { kind: "error", text: r?.error || i18n.t("script:export.failed") };
  let text = i18n.t("script:export.resolveDone", { timeline: r.timeline, action: r.created ? i18n.t("script:export.created") : i18n.t("script:export.updated"), count: r.count });
  if (r.markersAdded) text += ` ${i18n.t("script:export.markersAdded", { count: r.markersAdded })}`;
  if (r.fpsMismatch) text += ` ${i18n.t("script:export.mixedFps")}`;
  if (r.missing?.length) text += ` ${i18n.t("script:export.missingSources", { count: r.missing.length })}`;
  return { kind: "done", text, warn: !!r.fpsMismatch || !!r.missing?.length };
}

async function runAdobe(
  host: "ppro" | "aeft",
  name: string,
  mode: "new" | "append",
  clips: ClipEntry[],
  markersRequested: boolean,
  onProgress: (text: string) => void,
): Promise<BuildState> {
  let timeline = name;
  let count = 0;
  for (let i = 0; i < clips.length; i++) {
    onProgress(i18n.t("script:export.shotProgress", { current: i + 1, total: clips.length }));
    const c = clips[i];
    const fps = c.fps || 24;
    const whole = c.outFrame == null;
    const r = await hostBuildTimeline(host, {
      name,
      input: c.filePath,
      mode: i === 0 ? mode : "append",
      fps,
      whole,
      segments: whole
        ? []
        : [{ in: frameToSec(c.inFrame, fps), out: frameToSec(c.outFrame! + 1, fps), inFrame: c.inFrame, outFrame: c.outFrame! }],
    });
    if (!r.ok) return { kind: "error", text: i18n.t("script:export.shotFailed", { current: i + 1, total: clips.length, error: r.error || i18n.t("script:export.failure") }) };
    if (r.timeline) timeline = r.timeline;
    count += r.count ?? 1;
  }
  let text = i18n.t("script:export.adobeDone", { timeline, host: hostShort(host), count });
  if (markersRequested) text += ` ${i18n.t("script:export.markersResolveOnly")}`;
  return { kind: "done", text, warn: markersRequested };
}

export function useScriptExport(save: () => Promise<void> | void) {
  const doc = useScript((s) => s.doc);
  const sectionSel = useScript((s) => s.sectionSel);
  const [build, setBuild] = useState<BuildState>({ kind: "idle" });

  const payload = useMemo(
    () => (doc ? buildPayload(scopedBlocks(doc, sectionSel)) : { clips: [], markers: [] }),
    [doc, sectionSel],
  );

  async function run(mode: "new" | "append", exportMarkers: boolean) {
    if (!doc) return;
    setBuild({ kind: "busy" });
    try {
      await save();
      const host = useApp.getState().activeHost;
      const name = doc.title || i18n.t("script:common.script");
      const { clips, markers } = payload;
      const result = host === "resolve"
        ? await runResolve(name, mode, clips, exportMarkers && markers.length ? markers : undefined)
        : await runAdobe(host, name, mode, clips, exportMarkers && markers.length > 0, (p) => setBuild({ kind: "busy", progress: p }));
      setBuild(result);
    } catch (e) {
      setBuild({ kind: "error", text: String(e) });
    }
  }

  return {
    clips: payload.clips,
    markers: payload.markers,
    partial: sectionSel.length > 0,
    sectionCount: sectionSel.length,
    build,
    resetBuild: () => setBuild({ kind: "idle" }),
    run,
  };
}
