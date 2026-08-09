// Liste des rushs de l'accueil NetsuTalk, RANGÉE PAR DOSSIER (mêmes bins que le navigateur du
// Derush : `buildClipTree` est la source unique). Rangées denses : case de sélection, nom, état
// d'analyse ou de rendu. Un dossier se replie et se sélectionne d'un bloc.
import { memo, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronRight, Folder, FileVideo, Sparkles, TriangleAlert, Download } from "lucide-react";
import type { Clip } from "@/lib/bridge";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem,
  ContextMenuCheckboxItem, ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { buildClipTree, countTreeClips, treeClips, type ClipTreeNode } from "@/components/rushes/libraryShared";
import type { VoiceBatchEntry, VoiceRenderEntry } from "@/store/voice";

export interface VoiceListProps {
  clips: Clip[];
  selected: Set<string>;
  batch: Record<string, VoiceBatchEntry>;
  render: Record<string, VoiceRenderEntry>;
  grouped: boolean;
  onToggle: (paths: string[], value: boolean) => void;
  onOpen: (clip: Clip) => void;
  onAnalyze: (clip: Clip) => void;
  onRender: (clip: Clip) => void;
  busy: boolean;
}

export function VoiceClipList(props: VoiceListProps) {
  const { clips, grouped } = props;
  const tree = useMemo(() => buildClipTree(clips), [clips]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleFolder = (path: string) =>
    setCollapsed((s) => { const n = new Set(s); if (n.has(path)) n.delete(path); else n.add(path); return n; });

  if (!grouped) {
    return (
      <div className="flex flex-col">
        {clips.map((c) => <Row key={c.path} clip={c} {...props} />)}
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {tree.clips.map((c) => <Row key={c.path} clip={c} {...props} />)}
      {[...tree.children.values()].map((node) => (
        <FolderBlock key={node.name} node={node} path={node.name} depth={0}
          collapsed={collapsed} toggleFolder={toggleFolder} {...props} />
      ))}
    </div>
  );
}

function FolderBlock({ node, path, depth, collapsed, toggleFolder, ...rest }: VoiceListProps & {
  node: ClipTreeNode; path: string; depth: number;
  collapsed: Set<string>; toggleFolder: (p: string) => void;
}) {
  const open = !collapsed.has(path);
  const inside = useMemo(() => treeClips(node), [node]);
  const picked = inside.filter((c) => rest.selected.has(c.path)).length;
  const all = picked === inside.length && inside.length > 0;

  return (
    <div>
      <div
        style={{ paddingLeft: depth * 14 }}
        className="flex items-center gap-1.5 rounded-md py-1 pr-1 text-sm transition-colors hover:bg-accent/40"
      >
        <SelectBox
          checked={all}
          partial={picked > 0 && !all}
          onClick={() => rest.onToggle(inside.map((c) => c.path), !all)}
        />
        <button type="button" onClick={() => toggleFolder(path)}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
          <Folder className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium">{node.name}</span>
          <span className="text-[11px] tabular-nums text-muted-foreground">{countTreeClips(node)}</span>
        </button>
      </div>
      {open && (
        <div style={{ paddingLeft: depth * 14 + 16 }}>
          {node.clips.map((c) => <Row key={c.path} clip={c} {...rest} />)}
          {[...node.children.values()].map((child) => (
            <FolderBlock key={child.name} node={child} path={`${path}/${child.name}`} depth={depth + 1}
              collapsed={collapsed} toggleFolder={toggleFolder} {...rest} />
          ))}
        </div>
      )}
    </div>
  );
}

// Case de sélection : carrée pleine quand cochée, barre quand le dossier est partiellement pris.
function SelectBox({ checked, partial, onClick }: {
  checked: boolean; partial?: boolean; onClick: () => void;
}) {
  const { t } = useTranslation("voice");
  return (
    <button type="button" onClick={onClick}
      aria-pressed={checked}
      aria-label={checked ? t("home.deselect") : t("home.select")}
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors",
        checked ? "border-primary bg-primary text-primary-foreground"
          : partial ? "border-primary/70 text-primary" : "border-foreground/30 hover:border-primary/70",
      )}>
      {checked ? <Check className="size-3" /> : partial ? <span className="h-0.5 w-2 rounded-full bg-primary" /> : null}
    </button>
  );
}

// `content-visibility` : un projet de plusieurs centaines de rushs ne paie que les rangées visibles
// (même levier que la grille de plans du Derush — aucune virtualisation, aucun saut de scroll).
const ROW_STYLE = { contentVisibility: "auto", containIntrinsicSize: "auto 32px" } as React.CSSProperties;

// Aiguillage de props : la rangée mémoïsée ne reçoit que des primitives + SON entrée. Une frame de
// progression (l'objet `render` change d'identité à chaque pourcentage) ne re-rend donc que la
// rangée concernée, pas les centaines d'autres.
function Row({ clip, selected, batch, render, onToggle, onOpen, onAnalyze, onRender, busy }: VoiceListProps & { clip: Clip }) {
  return (
    <ClipRow
      clip={clip}
      checked={selected.has(clip.path)}
      entry={batch[clip.path]}
      job={render[clip.path]}
      busy={busy}
      onToggle={onToggle}
      onOpen={onOpen}
      onAnalyze={onAnalyze}
      onRender={onRender}
    />
  );
}

interface ClipRowProps {
  clip: Clip;
  checked: boolean;
  entry?: VoiceBatchEntry;
  job?: VoiceRenderEntry;
  busy: boolean;
  onToggle: (paths: string[], value: boolean) => void;
  onOpen: (clip: Clip) => void;
  onAnalyze: (clip: Clip) => void;
  onRender: (clip: Clip) => void;
}

const ClipRow = memo(function ClipRow({ clip, checked, entry, job, onToggle, onOpen, onAnalyze, onRender, busy }: ClipRowProps) {
  const { t } = useTranslation("voice");
  const running = job?.status === "running";

  return (
    <ContextMenu>
      <ContextMenuTrigger render={
        <div style={ROW_STYLE} className={cn(
          "relative flex items-center gap-2 rounded-md py-1.5 pl-1.5 pr-2 transition-colors",
          checked ? "bg-primary/10" : "hover:bg-accent/40",
        )} />
      }>
        <SelectBox checked={checked} onClick={() => onToggle([clip.path], !checked)} />
        <button type="button" onClick={() => onOpen(clip)}
          className="min-w-0 flex-1 truncate text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {clip.name}
        </button>
        <RowState clip={clip} entry={entry} job={job} />
        {running && (
          <span className="absolute inset-x-1.5 bottom-0 h-0.5 overflow-hidden rounded-full bg-primary/20">
            <span className="block h-full bg-primary transition-[width] duration-200" style={{ width: `${job.pct}%` }} />
          </span>
        )}
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-48">
        <ContextMenuItem onClick={() => onOpen(clip)}><FileVideo /> {t("home.openEditor")}</ContextMenuItem>
        <ContextMenuItem onClick={() => onAnalyze(clip)} disabled={busy}><Sparkles /> {t("home.analyzeThisClip")}</ContextMenuItem>
        <ContextMenuItem onClick={() => onRender(clip)} disabled={busy}><Download /> {t("home.renderThisClip")}</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuCheckboxItem checked={checked} onClick={() => onToggle([clip.path], !checked)}>
          {t("home.select")}
        </ContextMenuCheckboxItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

// Une seule colonne d'état à droite : le rendu (s'il tourne) prime sur l'analyse, qui prime sur les
// métadonnées. Deux indicateurs concurrents sur la même rangée seraient illisibles.
function RowState({ clip, entry, job }: { clip: Clip; entry?: VoiceBatchEntry; job?: VoiceRenderEntry }) {
  const { t } = useTranslation("voice");
  const cls = "flex shrink-0 items-center gap-1 text-[11px] tabular-nums";

  if (job && job.status !== "queued") {
    if (job.status === "running") return <span className={cn(cls, "text-primary")}><Spinner className="size-3" />{job.pct}%</span>;
    if (job.status === "error") return <span className={cn(cls, "text-destructive")}><TriangleAlert className="size-3" />{t("home.renderFailed")}</span>;
    return <span className={cn(cls, "text-[color:var(--color-ok)]")}><Check className="size-3" />{t("home.rendered")}</span>;
  }
  if (job?.status === "queued") return <span className={cn(cls, "text-muted-foreground")}>{t("clipRow.queued")}</span>;

  if (entry?.status === "running") return <span className={cn(cls, "text-primary")}><Spinner className="size-3" />{t("clipRow.running")}</span>;
  if (entry?.status === "queued") return <span className={cn(cls, "text-muted-foreground")}>{t("clipRow.queued")}</span>;
  if (entry?.status === "error") {
    return (
      <Tooltip>
        <TooltipTrigger render={<span className={cn(cls, "max-w-40 truncate text-destructive")} />}>
          <TriangleAlert className="size-3 shrink-0" />{entry.error || t("clipRow.errorFallback")}
        </TooltipTrigger>
        <TooltipContent className="max-w-72">{entry.error || t("clipRow.errorFallback")}</TooltipContent>
      </Tooltip>
    );
  }
  if (entry?.status === "done") {
    return (
      <span className={cn(cls, "text-[color:var(--color-ok)]")}>
        <Check className="size-3" />
        {t("clipRow.statsShort", { words: entry.words?.length ?? 0, silences: entry.silence?.length ?? 0 })}
      </span>
    );
  }
  const meta = [clip.resolution, clip.fps].filter(Boolean).join(" · ");
  return <span className={cn(cls, "text-muted-foreground")}>{meta}</span>;
}
