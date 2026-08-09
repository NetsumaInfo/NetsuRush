// Carte d'un script sur l'accueil. Deux densités (grille / liste) qui montrent exactement les mêmes
// informations : titre, durée estimée du montage, chiffres du document, date relative, menu ⋯.

import { memo } from "react";
import { useTranslation } from "react-i18next";
import { Clapperboard, Copy, FileText, Film, Heading, MoreHorizontal, Pencil, Pilcrow, Trash2, Type } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ScriptDocMeta } from "@/lib/bridge";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { fmtDuration } from "../scriptShared";
import { relDate, type HomeView } from "./homeShared";

interface Props {
  doc: ScriptDocMeta;
  view: HomeView;
  onOpen: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

function Stat({ icon: Icon, value, label }: { icon: LucideIcon; value: number; label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex items-center gap-1 tabular-nums" />}>
        <Icon className="size-3.5 opacity-70" /> {value}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function DocMenu({ onOpen, onRename, onDuplicate, onDelete }: Omit<Props, "doc" | "view">) {
  const { t } = useTranslation("script");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={t("home.actions")}
            onClick={(e) => e.stopPropagation()}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
          />
        }
      >
        <MoreHorizontal className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onClick={onOpen}><FileText /> {t("home.open")}</DropdownMenuItem>
        <DropdownMenuItem onClick={onRename}><Pencil /> {t("home.rename")}</DropdownMenuItem>
        <DropdownMenuItem onClick={onDuplicate}><Copy /> {t("home.duplicate")}</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={onDelete}><Trash2 /> {t("common.delete")}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export const DocCard = memo(function DocCard({ doc, view, onOpen, onRename, onDuplicate, onDelete }: Props) {
  const { t } = useTranslation("script");
  const stats = doc.stats;
  const title = doc.title || t("common.untitled");
  const menu = <DocMenu onOpen={onOpen} onRename={onRename} onDuplicate={onDuplicate} onDelete={onDelete} />;

  // La durée est le chiffre qui compte pour un script (c'est le montage qu'il produira) : elle est
  // la seule mise en pastille, les autres chiffres restent des icônes discrètes.
  const duration = stats ? (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-accent px-1.5 py-0.5 text-[11px] font-medium text-primary tabular-nums">
      <Clapperboard className="size-3" /> {fmtDuration(stats.seconds)}
    </span>
  ) : null;

  const counters = stats && (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <Stat icon={Pilcrow} value={stats.blocks} label={t("home.stats.paragraphs")} />
      <Stat icon={Type} value={stats.words} label={t("home.stats.words")} />
      {stats.sections > 0 && <Stat icon={Heading} value={stats.sections} label={t("home.stats.sections")} />}
      {stats.media > 0 && <Stat icon={Film} value={stats.media} label={t("home.stats.media")} />}
    </div>
  );

  const open = { onClick: onOpen, onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } } };

  if (view === "list") {
    return (
      <div
        role="button"
        tabIndex={0}
        {...open}
        className="group flex cursor-pointer items-center gap-3 rounded-lg bg-card px-3 py-2.5 ring-1 ring-foreground/10 transition-colors outline-none hover:bg-muted hover:ring-primary/50 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <FileText className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
        {counters}
        {duration}
        <span className="w-28 shrink-0 truncate text-right text-xs text-muted-foreground">{relDate(doc.updatedAt)}</span>
        {menu}
      </div>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      {...open}
      className={cn(
        "group flex cursor-pointer flex-col gap-3 rounded-xl bg-card p-4 text-left shadow-xs ring-1 ring-foreground/10 transition-all outline-none",
        "hover:-translate-y-0.5 hover:ring-primary/60 focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      <div className="flex items-start gap-2.5">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
          <FileText className="size-4.5" />
        </div>
        <span className="mt-1 line-clamp-2 min-w-0 flex-1 text-sm leading-snug font-medium">{title}</span>
        {menu}
      </div>
      {counters}
      <div className="flex items-center justify-between gap-2 border-t border-border/60 pt-2.5">
        <span className="truncate text-xs text-muted-foreground">{relDate(doc.updatedAt)}</span>
        {duration}
      </div>
    </div>
  );
});
