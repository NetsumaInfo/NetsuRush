// Navigateur de timelines façon Media Pool (PARTAGÉ par la page « Timeline » et Timeline Live) :
// dossiers (bins) repliables imbriqués + grille de vignettes compactes, comme le Media Pool de Resolve.
// Deux modes : `onOpen` (clic ouvre) OU `selected`+`onToggle` (multi-sélection à cases).
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Folder, Check, Clapperboard, CheckSquare, FolderOpen } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn, thumbTime } from "@/lib/utils";
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } from "@/components/ui/context-menu";
import { LazyThumb } from "./LazyThumb";
import { warmGenerateThumbs, warmResolveThumbs } from "@/lib/thumbCache";

type TLItem = { name: string; current: boolean };
type Thumb = { path: string; in: number };
type TLNode = { path: string; name: string; children: TLNode[]; items: TLItem[] };

function countAll(n: TLNode): number { return n.items.length + n.children.reduce((s, c) => s + countAll(c), 0); }

export function TimelineFolders({
  timelines, bins, thumbs, sortDir = "az", onOpen, selected, onToggle, busy,
}: {
  timelines: TLItem[];
  bins: Map<string, string>;
  thumbs: Map<string, Thumb>;
  sortDir?: "az" | "za";
  onOpen?: (name: string) => void;
  selected?: Set<string>;
  onToggle?: (name: string) => void;
  busy?: boolean;
}) {
  const { t: tr } = useTranslation("derush");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleFolder = (p: string) => setCollapsed((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; });
  const cmp = (a: string, b: string) => sortDir === "az"
    ? a.localeCompare(b, "fr", { numeric: true })
    : b.localeCompare(a, "fr", { numeric: true });

  const tree = useMemo(() => {
    const root: TLNode = { path: "", name: "", children: [], items: [] };
    const child = (node: TLNode, seg: string, full: string) => {
      let c = node.children.find((x) => x.name === seg);
      if (!c) { c = { path: full, name: seg, children: [], items: [] }; node.children.push(c); }
      return c;
    };
    for (const t of timelines) {
      const parts = (bins.get(t.name) ?? "").split("/").filter(Boolean);
      let node = root, acc = "";
      for (const seg of parts) { acc = acc ? `${acc}/${seg}` : seg; node = child(node, seg, acc); }
      node.items.push(t);
    }
    return root;
  }, [timelines, bins]);

  useEffect(() => {
    const items = [...thumbs.values()].map((thumb) => ({ path: thumb.path, time: thumbTime(thumb.in) }));
    if (!items.length) return;
    void warmResolveThumbs(items);
    warmGenerateThumbs(items);
  }, [thumbs]);

  const card = (t: TLItem) => {
    const on = !!selected?.has(t.name);
    const thumb = thumbs.get(t.name);
    return (
      <ContextMenu key={t.name}>
        <ContextMenuTrigger render={
          <button
            type="button"
            disabled={busy}
            onClick={() => (onToggle ? onToggle(t.name) : onOpen?.(t.name))}
            className={cn(
              "group relative flex flex-col overflow-hidden rounded-lg border text-left transition-all disabled:opacity-60",
              on ? "border-primary ring-1 ring-primary" : "border-border hover:border-primary/50 hover:-translate-y-0.5",
            )} />
        }>
          <LazyThumb path={thumb?.path} at={thumb ? thumb.in : 0} className="aspect-video w-full" />
          {onToggle && (
            <span className={cn(
              "absolute right-1.5 top-1.5 flex size-5 items-center justify-center rounded-full border transition-colors",
              on ? "border-primary bg-primary text-primary-foreground" : "border-white/40 bg-black/40 text-transparent",
            )}>
              <Check className="size-3" />
            </span>
          )}
          {t.current && <Badge variant="secondary" className="absolute left-1.5 top-1.5 text-[9px]">{tr("timelineFolders.open")}</Badge>}
          <div className="min-w-0 bg-card px-2 py-1.5">
            <div className="truncate text-xs font-medium">{t.name}</div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-44">
          {onOpen && <ContextMenuItem onClick={() => onOpen(t.name)}><Clapperboard /> {tr("timelineFolders.openTimeline")}</ContextMenuItem>}
          {onToggle && (
            <ContextMenuItem onClick={() => onToggle(t.name)}>
              <CheckSquare /> {on ? tr("shared.deselect") : tr("shared.select")}
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>
    );
  };

  const grid = (items: TLItem[]) => (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {[...items].sort((a, b) => cmp(a.name, b.name)).map(card)}
    </div>
  );

  // Rendu récursif d'un dossier (en-tête repliable indenté + sous-dossiers + vignettes de ce dossier).
  const renderNode = (node: TLNode, depth: number) => {
    const isRoot = node.path === "";
    const isCol = collapsed.has(node.path);
    const kids = [...node.children].sort((a, b) => cmp(a.name, b.name));
    return (
      <div key={node.path || "__root__"}>
        {!isRoot && (
          <ContextMenu>
            <ContextMenuTrigger render={
              <button type="button" onClick={() => toggleFolder(node.path)}
                style={{ paddingLeft: (depth - 1) * 16 }}
                className="flex w-full items-center gap-1.5 rounded-md py-1.5 pr-2 text-sm text-foreground transition-colors hover:bg-accent/60" />
            }>
              <ChevronRight className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", !isCol && "rotate-90")} />
              <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="truncate font-medium">{node.name}</span>
              <span className="text-xs text-muted-foreground">{countAll(node)}</span>
            </ContextMenuTrigger>
            <ContextMenuContent className="min-w-44">
              <ContextMenuItem onClick={() => toggleFolder(node.path)}>
                <FolderOpen /> {isCol ? tr("shared.expandFolder") : tr("shared.collapseFolder")}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        )}
        {!isCol && (
          <div className={isRoot ? "space-y-2.5" : "space-y-2.5 pt-1.5"}>
            {kids.map((c) => renderNode(c, depth + 1))}
            {node.items.length > 0 && (
              <div style={{ paddingLeft: isRoot ? 0 : depth * 16 }}>{grid(node.items)}</div>
            )}
          </div>
        )}
      </div>
    );
  };

  return renderNode(tree, 0);
}
