// Sélecteur de destination de montage (timeline ouverte / existante / nouvelle), piloté par
// useTimelineTarget. MÊME présentation que le picker de « Découper une timeline » (CutTimelineView) :
// déclencheur compact → Popover avec barre de recherche + liste scrollable de lignes (icône Film,
// nom, badge « ouverte », sélection = bg-primary). Pas de <select> natif ni de dropdown shadcn.
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Popover } from "@base-ui/react/popover";
import { Clapperboard, Film, Search, Plus, FolderOpen, ChevronDown } from "lucide-react";
import { type TimelineTargetView } from "./useTimelineTarget";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

export function TimelineTargetSelect({ target, className }: { target: TimelineTargetView; className?: string }) {
  const { t } = useTranslation("derush");
  const { timelines, current, value, setValue } = target;
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");

  const others = useMemo(() => timelines.filter((tl) => tl.name !== current), [timelines, current]);
  const visible = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? others.filter((tl) => tl.name.toLowerCase().includes(s)) : others;
  }, [others, q]);

  // Libellé du déclencheur d'après la valeur courante. « Timeline ouverte » alors qu'AUCUNE ne l'est
  // annonce « nouvelle timeline » : c'est ce que le montage fera réellement (repli de build()).
  const label = value === "new" || (value === "open" && !current) ? t("target.newTimeline")
    : value === "open" ? t("target.openedNamed", { name: current })
    : value.startsWith("tl:") ? value.slice(3)
    : t("target.choose");

  function pick(v: string) { setValue(v); setOpen(false); }

  const rowCls = (active: boolean) =>
    `flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors ${
      active ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        className={`inline-flex h-8 max-w-[240px] items-center gap-1.5 rounded-md border border-border bg-card pl-2 pr-2 text-xs text-muted-foreground outline-none transition-colors hover:bg-accent data-[popup-open]:border-ring ${className || ""}`}
      >
        <Clapperboard className="h-3.5 w-3.5 shrink-0" />
        <span className="shrink-0">{t("target.to")}</span>
        <span className="min-w-0 flex-1 truncate text-foreground">{label}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={6} className="z-50 outline-none">
          <Popover.Popup className="w-72 origin-[var(--transform-origin)] rounded-xl border border-border bg-popover p-2 text-popover-foreground shadow-xl outline-none transition-[transform,opacity] data-[starting-style]:scale-98 data-[starting-style]:opacity-0">
            {/* destinations fixes */}
            <div className="space-y-1">
              {current && (
                <button type="button" onClick={() => pick("open")} className={rowCls(value === "open")}>
                  <FolderOpen className="h-3.5 w-3.5 shrink-0 opacity-70" />
                  <span className="min-w-0 flex-1 truncate">{t("target.openedTimeline")}</span>
                  <Badge variant={value === "open" ? "secondary" : "outline"} className="shrink-0 text-[10px]">{current}</Badge>
                </button>
              )}
              <button type="button" onClick={() => pick("new")} className={rowCls(value === "new")}>
                <Plus className="h-3.5 w-3.5 shrink-0 opacity-70" />
                <span className="min-w-0 flex-1 truncate">{t("target.newTimeline")}</span>
              </button>
            </div>

            {others.length > 0 && (
              <>
                <div className="mt-2 mb-1.5 px-1 text-[10px] font-semibold text-muted-foreground">{t("target.existing")}</div>
                <div className="relative mb-1.5">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("shared.searchTimeline")} className="h-8 pl-8 text-xs" />
                </div>
                <div className="max-h-52 space-y-1 overflow-y-auto">
                  {visible.length === 0 ? (
                    <p className="px-2.5 py-3 text-center text-xs text-muted-foreground">{t("shared.noTimelineFor", { q })}</p>
                  ) : visible.map((tl) => {
                    const v = `tl:${tl.name}`;
                    return (
                      <button key={tl.name} type="button" onClick={() => pick(v)} className={rowCls(value === v)}>
                        <Film className="h-3.5 w-3.5 shrink-0 opacity-70" />
                        <span className="min-w-0 flex-1 truncate">{tl.name}</span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
