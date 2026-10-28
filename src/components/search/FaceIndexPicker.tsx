import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { NetsuIcon } from "@/components/ui/netsu-icon";
import { useShallow } from "zustand/react/shallow";
import { nr, type Clip } from "@/lib/bridge";
import { useApp } from "@/store";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Toggle } from "@/components/ui/toggle";
import { cn } from "@/lib/utils";
import { isMedia } from "@/components/search/searchHelpers";
import { binLabel } from "@/components/rushes/libraryShared";

type FaceInfo = { faces: number; mtime: number };
type Props = {
  open: boolean;
  onClose: () => void;
  onIndex: (paths: string[], force: boolean) => void;
};

// Sélecteur de rush pour l'indexation des VISAGES — même système que l'IndexPicker de la recherche,
// simplifié (pas de mode rapide/précis : les visages échantillonnent 1 frame par plan). Marque les
// clips déjà indexés (visages) vs à faire ; auto-sélectionne ce qui manque.
export function FaceIndexPicker({ open, onClose, onIndex }: Props) {
  const { t } = useTranslation(["search", "common"]);
  const { loadClips, localClips, indexParallel, setIndexParallel } = useApp(
    useShallow((s) => ({ loadClips: s.loadClips, localClips: s.localClips, indexParallel: s.indexParallel, setIndexParallel: s.setIndexParallel })),
  );
  const [clips, setClips] = useState<Clip[] | null>(null);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [faceMap, setFaceMap] = useState<Record<string, FaceInfo>>({});

  useEffect(() => {
    if (!open) { setClips(null); return; }
    let cancelled = false;
    (async () => {
      if (useApp.getState().clips.length === 0) await loadClips();
      const media = [...useApp.getState().clips, ...localClips].filter((c) => isMedia(c.path));
      const r = await nr.faceIndexed();
      if (cancelled) return;
      setFaceMap(r.indexed || {});
      // auto-sélection : les clips SANS visages indexés (les autres restent décochés).
      setPick(new Set(media.flatMap((c) => (r.indexed || {})[c.path] ? [] : [c.path])));
      setClips(media);
    })();
    return () => { cancelled = true; };
  }, [open, loadClips, localClips]);

  if (!clips) return null;

  const done = (c: Clip) => !!faceMap[c.path];
  const nTodo = clips.filter((c) => !done(c)).length;
  const confirm = (force = false) => {
    const paths = [...pick];
    onClose();
    if (paths.length) onIndex(paths, force);
  };

  return (
    <Card className="block overflow-hidden p-0">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs">
        <NetsuIcon name="face" className="size-3.5 text-primary" />
        <span className="font-medium">{t("faceIndexPicker.title")}</span>
        <div className="flex-1" />
        <div className="flex items-center gap-1">
          <Button type="button" variant="outline" size="xs" disabled={!nTodo} onClick={() => setPick(new Set(clips.flatMap((c) => done(c) ? [] : [c.path])))}>{t("faceIndexPicker.todo")}{nTodo ? ` (${nTodo})` : ""}</Button>
          <Button type="button" variant="outline" size="xs" onClick={() => setPick(new Set(clips.map((c) => c.path)))}>{t("faceIndexPicker.all")}</Button>
          <Button type="button" variant="outline" size="xs" onClick={() => setPick(new Set())}>{t("faceIndexPicker.deselect")}</Button>
        </div>
      </div>
      {clips.length === 0 ? (
        <div className="p-6 text-center text-xs text-muted-foreground">{t("faceIndexPicker.empty")}</div>
      ) : (
        <div className="max-h-72 overflow-auto p-1.5">
          {clips.map((c) => {
            const on = pick.has(c.path);
            const info = faceMap[c.path];
            return (
              <Button variant="ghost"
                key={c.path}
                type="button"
                onClick={() => setPick((s) => { const n = new Set(s); n.has(c.path) ? n.delete(c.path) : n.add(c.path); return n; })}
                className={cn("h-auto justify-start whitespace-normal text-left font-normal border-0 p-0 gap-0 rounded-none hover:bg-transparent dark:hover:bg-transparent", "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary",
                  on ? "bg-accent" : "hover:bg-accent/50", info && !on && "opacity-50")}
              >
                <span className={cn("flex size-4 shrink-0 items-center justify-center rounded border",
                  on ? "border-primary bg-primary text-white" : "border-border")}>
                  {on && <NetsuIcon name="check" className="size-3" />}
                </span>
                <Tooltip>
                  <TooltipTrigger render={<span className={cn("size-1.5 shrink-0 rounded-full", info ? "bg-[var(--color-ok)]" : "bg-muted-foreground/40")} />} />
                  <TooltipContent>{info ? t("faceIndexPicker.facesIndexed", { count: info.faces }) : t("faceIndexPicker.notIndexed")}</TooltipContent>
                </Tooltip>
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                {info && <span className="shrink-0 text-[11px] font-medium text-[var(--color-ok)]">{t("faceIndexPicker.facesShort", { count: info.faces })}</span>}
                {c.bin && <span className="shrink-0 text-[11px] text-muted-foreground">{binLabel(c.bin)}</span>}
              </Button>
            );
          })}
        </div>
      )}
      <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
        <Tooltip>
          <TooltipTrigger render={
            <Toggle size="sm" variant="outline" pressed={indexParallel} onPressedChange={setIndexParallel}
              className="px-2.5 text-xs text-muted-foreground aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:hover:bg-primary" />
          }>
            <NetsuIcon name="layers" className="size-3.5" /> {t("faceIndexPicker.parallel")}
          </TooltipTrigger>
          <TooltipContent>{t("faceIndexPicker.parallelHint")}</TooltipContent>
        </Tooltip>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}><NetsuIcon name="close" className="size-3.5" /> {t("common:action.cancel")}</Button>
          <Tooltip>
            <TooltipTrigger render={<Button variant="outline" size="sm" disabled={pick.size === 0} onClick={() => confirm(true)} />}>
              <NetsuIcon name="zap" className="size-3.5" /> {t("faceIndexPicker.reindex")} ({pick.size})
            </TooltipTrigger>
            <TooltipContent>{t("faceIndexPicker.reindexHint")}</TooltipContent>
          </Tooltip>
          <Button size="sm" disabled={pick.size === 0} onClick={() => confirm(false)}>
            <NetsuIcon name="search-face" className="size-3.5" /> {t("faceIndexPicker.indexFaces")} ({pick.size})
          </Button>
        </div>
      </div>
    </Card>
  );
}
