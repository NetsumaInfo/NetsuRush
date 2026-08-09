// Arbre dossier (≈ projet) → rush → types. C'est la raison d'être du module : vider ce qui appartient
// à un projet terminé sans toucher aux autres. Multi-sélection par cases, purge de la sélection.
import { useState, memo } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, FolderOpen, Trash2, HelpCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { CacheFolder, CacheRush, CacheTree as CacheTreeData } from "@/lib/bridge";
import { fmtBytes, KIND_ICON, KIND_TINT, type CacheKind } from "./storageShared";

interface Props {
  tree: CacheTreeData;
  selected: Set<string>;
  onToggle: (sources: string[], on: boolean) => void;
  onPurgeUnattributed: () => void;
}

// Répartition par type d'un rush. Purement indicative (pas de légende) : le détail chiffré est dans
// l'infobulle, la barre ne sert qu'à voir d'un coup d'œil ce qui pèse.
const KindBar = memo(function KindBar({ byKind, total }: { byKind: Partial<Record<CacheKind, number>>; total: number }) {
  const parts = Object.entries(byKind).filter(([, v]) => (v || 0) > 0) as [CacheKind, number][];
  if (!parts.length || total <= 0) return null;
  return (
    <div className="flex h-1 w-16 shrink-0 overflow-hidden rounded-full bg-muted">
      {parts.map(([k, v]) => (
        <div key={k} style={{ width: `${(v / total) * 100}%`, background: KIND_TINT[k] }} />
      ))}
    </div>
  );
});

function RushRow({ rush, on, onToggle }: { rush: CacheRush; on: boolean; onToggle: (s: string[], v: boolean) => void }) {
  const { t } = useTranslation("settings");
  const kinds = Object.entries(rush.byKind).filter(([, v]) => (v || 0) > 0) as [CacheKind, number][];
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded-md py-1 pl-7 pr-2 text-xs hover:bg-accent/50">
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => onToggle([rush.source], e.target.checked)}
        className="size-3.5 shrink-0 accent-[var(--color-primary)]"
      />
      <Tooltip>
        <TooltipTrigger render={<span className="min-w-0 flex-1 truncate text-foreground" />}>{rush.name}</TooltipTrigger>
        <TooltipContent>{rush.source}</TooltipContent>
      </Tooltip>
      <div className="flex shrink-0 items-center gap-1">
        {kinds.map(([k]) => {
          const Icon = KIND_ICON[k];
          return (
            <Tooltip key={k}>
              <TooltipTrigger render={<span className="text-muted-foreground" />}>
                <Icon className="size-3" />
              </TooltipTrigger>
              <TooltipContent>{`${t(`storage.kind.${k}`)} · ${fmtBytes(rush.byKind[k])}`}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
      <KindBar byKind={rush.byKind} total={rush.bytes} />
      <span className="w-14 shrink-0 text-right tabular-nums text-muted-foreground">{fmtBytes(rush.bytes)}</span>
    </label>
  );
}

function FolderRow({ folder, selected, onToggle }: { folder: CacheFolder; selected: Set<string>; onToggle: Props["onToggle"] }) {
  const { t } = useTranslation("settings");
  const [open, setOpen] = useState(false);
  const sources = folder.rushes.map((r) => r.source);
  const nSel = sources.filter((s) => selected.has(s)).length;
  const all = nSel === sources.length && nSel > 0;

  return (
    <div className="border-b border-border last:border-0">
      <div className="flex items-center gap-2 py-1.5 pr-2 text-xs">
        <input
          type="checkbox"
          aria-label={t("cache.selectFolder", { name: folder.folder.split(/[\\/]/).filter(Boolean).pop() || folder.folder })}
          checked={all}
          // Un dossier partiellement sélectionné : ni coché ni vide, sinon on ne distingue pas
          // « rien » de « quelques rushs » en repliant.
          ref={(el) => { if (el) el.indeterminate = nSel > 0 && !all; }}
          onChange={(e) => onToggle(sources, e.target.checked)}
          className="ml-2 size-3.5 shrink-0 accent-[var(--color-primary)]"
        />
        <button type="button" onClick={() => setOpen((v) => !v)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
          <Tooltip>
            <TooltipTrigger render={<span className="min-w-0 flex-1 truncate font-medium text-foreground" />}>
              {folder.folder.split(/[\\/]/).filter(Boolean).pop() || folder.folder}
            </TooltipTrigger>
            <TooltipContent>{folder.folder}</TooltipContent>
          </Tooltip>
          <span className="shrink-0 text-muted-foreground">{t("storage.tree.rushCount", { count: folder.rushes.length })}</span>
        </button>
        <span className="w-14 shrink-0 text-right tabular-nums font-medium text-foreground">{fmtBytes(folder.bytes)}</span>
      </div>
      {open && (
        <div className="pb-1">
          {folder.rushes.map((r) => (
            <RushRow key={r.source} rush={r} on={selected.has(r.source)} onToggle={onToggle} />
          ))}
        </div>
      )}
    </div>
  );
}

export function CacheTree({ tree, selected, onToggle, onPurgeUnattributed }: Props) {
  const { t } = useTranslation("settings");
  const un = tree.unattributed;

  return (
    <div className="rounded-lg border border-border">
      <div className="max-h-80 overflow-y-auto">
        {tree.folders.map((f) => (
          <FolderRow key={f.folder} folder={f} selected={selected} onToggle={onToggle} />
        ))}
      </div>
      {un.bytes > 0 && (
        <div className="flex items-center gap-2 border-t border-border bg-muted/30 px-2 py-1.5 text-xs">
          <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="text-foreground">{t("storage.tree.unattributed")}</span>
          <Tooltip>
            <TooltipTrigger render={<span className="text-muted-foreground" />}>
              <HelpCircle className="size-3" />
            </TooltipTrigger>
            <TooltipContent className="max-w-64">{t("storage.tree.unattributedHint")}</TooltipContent>
          </Tooltip>
          <span className="flex-1" />
          <span className="tabular-nums text-muted-foreground">{fmtBytes(un.bytes)}</span>
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={onPurgeUnattributed} />}>
              <Trash2 className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent>{t("storage.tree.purgeSelection")}</TooltipContent>
          </Tooltip>
        </div>
      )}
    </div>
  );
}
