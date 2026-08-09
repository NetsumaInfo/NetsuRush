import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Database, Check, X, Zap, Layers } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { nr, type Clip, type IndexedInfo } from "@/lib/bridge";
import { useApp } from "@/store";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { DetectionModelSelect } from "@/components/rushes/DetectionControls";
import { DetectionAdvancedSettings } from "@/components/rushes/DetectionAdvancedSettings";
import { cn } from "@/lib/utils";
import { isMedia } from "@/components/search/searchHelpers";
import { SearchPerfMenu } from "@/components/search/SearchPerfMenu";
import { FRAME_CHOICES, framesOfMode, framesSatisfied, type SamplingFrames } from "@/lib/sampling";

type Props = {
  open: boolean;
  onClose: () => void;
  onIndex: (paths: string[], force: boolean, frames: SamplingFrames) => void;
};

type ClipState = "new" | "partial" | "failed" | "stale" | "detail" | "unknown" | "done";

// L'ordre des tests compte : un rush interrompu, périmé ou en échec passe AVANT le détail, sinon un
// index à refaire s'afficherait comme un simple écart de finesse.
function clipState(info: IndexedInfo | undefined, frames: SamplingFrames): ClipState {
  if (!info) return "new";
  if (!info.complete) return "partial";   // interrompu (app fermée avant la fin) → à re-traiter
  if (info.failed > 0) return "failed";   // traité mais N plans échoués → réessai MANUEL (pas auto)
  if (info.stale) return "stale";
  if (info.legacy) return "unknown";      // index antérieur au marqueur : son détail est indéchiffrable
  // Le détail demandé est la référence : en dessous, l'index existe mais ne répond pas à la demande.
  return framesSatisfied(info.mode, frames) ? "done" : "detail";
}

// Pré-cochés à l'ouverture comme sous le bouton « À faire » — une seule définition, sinon les deux
// dérivent. En sont exclus les états dont on ne peut pas déduire qu'un nouveau passage apporterait
// quelque chose : un rush qui a déjà résisté (échec) rejouerait le même mur à chaque ouverture, et
// un index au détail indéchiffrable est peut-être déjà au niveau demandé.
const NEEDS_INDEX: ClipState[] = ["new", "partial", "stale", "detail"];

// Sélecteur de rush à indexer : charge le Media Pool, confronte chaque rush au détail demandé et
// pré-coche ce qui n'y répond pas encore.
export function IndexPicker({ open, onClose, onIndex }: Props) {
  const { t } = useTranslation(["search", "common", "derush"]);
  const { loadClips, localClips, indexParallel, setIndexParallel, searchCutModel, setSearchCutModel, frames, setFrames } = useApp(
    useShallow((s) => ({
      loadClips: s.loadClips,
      localClips: s.localClips,
      indexParallel: s.indexParallel,
      setIndexParallel: s.setIndexParallel,
      searchCutModel: s.searchCutModel,
      setSearchCutModel: s.setSearchCutModel,
      frames: s.searchFrames,
      setFrames: s.setSearchFrames,
    })),
  );
  const [clips, setClips] = useState<Clip[] | null>(null);       // null = fermé
  const [pick, setPick] = useState<Set<string>>(new Set());      // sélection du picker
  const [idxMap, setIdxMap] = useState<Record<string, IndexedInfo>>({});  // état d'indexation par chemin

  useEffect(() => {
    if (!open) { setClips(null); return; }
    let cancelled = false;
    (async () => {
      if (useApp.getState().clips.length === 0) await loadClips();
      const media = [...useApp.getState().clips, ...localClips].filter((c) => isMedia(c.path));
      const r = await nr.searchIndexed();
      if (cancelled) return;
      setIdxMap(r.indexed || {});
      // Détail lu au store et non aux props du rendu : en dépendre relancerait ce chargement à
      // chaque changement de détail, et la sélection en cours serait écrasée sous les doigts.
      setPick(new Set(media.flatMap((c) =>
        NEEDS_INDEX.includes(clipState((r.indexed || {})[c.path], useApp.getState().searchFrames)) ? [c.path] : [])));
      setClips(media);
    })();
    return () => { cancelled = true; };
  }, [open, loadClips, localClips]);

  if (!clips) return null;

  const todo = (c: Clip) => NEEDS_INDEX.includes(clipState(idxMap[c.path], frames));

  const confirmIndex = (force = false) => {
    const paths = [...pick];
    onClose();
    if (paths.length) onIndex(paths, force, frames);
  };

  const pill = "rounded-md border border-border px-2 py-0.5 text-muted-foreground hover:border-foreground/40 hover:text-foreground";
  const nTodo = clips.filter(todo).length;

  return (
    <Card className="block overflow-hidden p-0">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs">
        <span className="font-medium">{t("indexPicker.title")}</span>
        <div className="flex-1" />
        <div className="flex items-center gap-1">
          <button type="button" className={pill} disabled={!nTodo} onClick={() => setPick(new Set(clips.flatMap((c) => todo(c) ? [c.path] : [])))}>{t("indexPicker.todo")}{nTodo ? ` (${nTodo})` : ""}</button>
          <button type="button" className={pill} onClick={() => setPick(new Set(clips.map((c) => c.path)))}>{t("indexPicker.all")}</button>
          <button type="button" className={pill} onClick={() => setPick(new Set())}>{t("indexPicker.deselect")}</button>
        </div>
      </div>
      {clips.length === 0 ? (
        <div className="p-6 text-center text-xs text-muted-foreground">{t("indexPicker.empty")}</div>
      ) : (
        <div className="max-h-72 overflow-auto p-1.5">
          {clips.map((c) => {
            const on = pick.has(c.path);
            const info = idxMap[c.path];
            const st = clipState(info, frames);
            const fc = info?.failed ?? 0;
            const tag = st === "done" ? { t: t("indexPicker.status.done"), cls: "text-[var(--color-ok)]", dot: "bg-[var(--color-ok)]" }
              : st === "detail" ? { t: t("indexPicker.status.detail", { n: framesOfMode(info?.mode) }), cls: "text-primary", dot: "bg-primary" }
              : st === "unknown" ? { t: t("indexPicker.status.detailUnknown"), cls: "text-muted-foreground", dot: "bg-muted-foreground/40" }
              : st === "failed" ? { t: t("indexPicker.status.failed", { count: fc }), cls: "text-[var(--color-warn)]", dot: "bg-[var(--color-warn)]" }
              : st === "partial" ? { t: t("indexPicker.status.partial"), cls: "text-[var(--color-warn)]", dot: "bg-[var(--color-warn)]" }
              : st === "stale" ? { t: t("indexPicker.status.stale"), cls: "text-[var(--color-warn)]", dot: "bg-[var(--color-warn)]" }
              : { t: "", cls: "", dot: "bg-muted-foreground/40" };
            return (
              <button
                key={c.path}
                type="button"
                onClick={() => setPick((s) => { const n = new Set(s); n.has(c.path) ? n.delete(c.path) : n.add(c.path); return n; })}
                className={cn("flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-left text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary",
                  on ? "bg-accent" : "hover:bg-accent/50",
                  st === "done" && !on && "opacity-50")}
              >
                <span className={cn("flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                  on ? "border-primary bg-primary text-white" : "border-border")}>
                  {on && <Check className="h-3 w-3" />}
                </span>
                {/* Un rush jamais indexé n'a que sa pastille : elle porte alors seule l'état. */}
                {tag.t ? <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", tag.dot)} /> : (
                  <Tooltip>
                    <TooltipTrigger render={<span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", tag.dot)} />} />
                    <TooltipContent>{t("indexPicker.status.none")}</TooltipContent>
                  </Tooltip>
                )}
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                {c.bin && <span className="shrink-0 text-[11px] text-muted-foreground">{c.bin}</span>}
                {tag.t && <span className={cn("shrink-0 text-[11px] font-medium", tag.cls)}>{tag.t}</span>}
              </button>
            );
          })}
        </div>
      )}
      <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">{t("derush:shared.cutModel")}</span>
          <DetectionModelSelect model={searchCutModel} onChange={setSearchCutModel} className="w-36" />
          <DetectionAdvancedSettings model={searchCutModel} compact />
          <span className="mx-0.5 h-5 border-l border-border" />
          <span className="text-[11px] text-muted-foreground">{t("indexPicker.detail")}</span>
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex" />}>
              <ToggleGroup value={[String(frames)]} spacing={0} variant="outline" size="sm"
                onValueChange={(v) => { const picked = Number(v[0]); if (picked) setFrames(picked as SamplingFrames); }}>
                {FRAME_CHOICES.map((count) => (
                  <ToggleGroupItem key={count} value={String(count)} className="px-2.5 text-xs text-muted-foreground aria-pressed:bg-foreground/10 aria-pressed:text-foreground aria-pressed:font-medium aria-pressed:hover:bg-foreground/10">{count}</ToggleGroupItem>
                ))}
              </ToggleGroup>
            </TooltipTrigger>
            <TooltipContent className="max-w-64">{t("indexPicker.detailHint")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={
              <Toggle size="sm" variant="outline" pressed={indexParallel} onPressedChange={setIndexParallel}
                className="px-2.5 text-xs text-muted-foreground aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:hover:bg-primary" />
            }>
              <Layers className="h-3.5 w-3.5" /> {t("indexPicker.parallel")}
            </TooltipTrigger>
            <TooltipContent>{t("indexPicker.parallelHint")}</TooltipContent>
          </Tooltip>
          <SearchPerfMenu />
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}><X className="h-3.5 w-3.5" /> {t("common:action.cancel")}</Button>
          <Tooltip>
            <TooltipTrigger render={<Button variant="outline" size="sm" disabled={pick.size === 0} onClick={() => confirmIndex(true)} />}>
              <Zap className="h-3.5 w-3.5" /> {t("indexPicker.reindex")} ({pick.size})
            </TooltipTrigger>
            <TooltipContent>{t("indexPicker.reindexHint")}</TooltipContent>
          </Tooltip>
          <Button size="sm" disabled={pick.size === 0} onClick={() => confirmIndex(false)}>
            <Database className="h-3.5 w-3.5" /> {t("indexPicker.index")} ({pick.size})
          </Button>
        </div>
      </div>
    </Card>
  );
}
