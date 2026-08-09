// Orchestrateur de la database (monté par le bloc /database). Barre d'outils :
// onglets de vue à gauche (renommer inline / dupliquer / déplacer / supprimer via menu), réglages
// unifiés à droite (Champs, Hauteur, Grouper), Filtres/Tris, menu ⋯ (pleine page, supprimer).
// « Ouvrir en pleine page » = Dialog plein écran rendant la même carte (édition confortable).
import { createElement, useCallback, useEffect, useState } from "react";
import i18n from "@/i18n";
import { useApp } from "@/store";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuGroup, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Table, Kanban, Plus, Trash2, LayoutGrid, CalendarDays, List, Eye, EyeOff, Settings2,
  MoreHorizontal, Maximize2, Minimize2, Pencil, Copy, ArrowLeft, ArrowRight, ChevronDown,
  type LucideIcon,
} from "lucide-react";
import { makeEmptyDatabase, ROW_HEIGHT_LABELS, VIEW_LABELS, type Database, type RowHeight, type ViewType } from "../notebookShared";
import { useDatabaseOps, type DatabaseOps } from "./useDatabaseOps";
import { TableView } from "./TableView";
import { KanbanView } from "./KanbanView";
import { GalleryView } from "./GalleryView";
import { CalendarView } from "./CalendarView";
import { ListView } from "./ListView";
import { RowDetail } from "./RowDetail";
import { FilterMenu, SortMenu } from "./FilterSort";

const VIEW_ICON: Record<ViewType, LucideIcon> = {
  table: Table, kanban: Kanban, gallery: LayoutGrid, calendar: CalendarDays, list: List,
};
const VIEW_ORDER: ViewType[] = ["table", "kanban", "gallery", "calendar", "list"];

// Onglet de vue : clic = activer ; sur l'onglet ACTIF, chevron → menu (renommer/dupliquer/déplacer/supprimer).
function ViewTab({ view, active, canDelete, ops }: {
  view: Database["views"][number];
  active: boolean;
  canDelete: boolean;
  ops: DatabaseOps;
}) {
  const [renaming, setRenaming] = useState(false);
  if (renaming) {
    return (
      <input
        aria-label="Rename view"
        defaultValue={view.name}
        onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== view.name) ops.updateView(view.id, { name: v }); setRenaming(false); }}
        onKeyDown={(e) => { if (e.nativeEvent.isComposing) return; if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setRenaming(false); }}
        className="w-24 rounded bg-card px-1.5 py-1 text-xs outline-none ring-1 ring-primary"
      />
    );
  }
  return (
    <span className={`flex items-center rounded ${active ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
      <button
        type="button"
        onClick={() => ops.setActiveView(view.id)}
        onDoubleClick={() => { if (active) setRenaming(true); }}
        className="flex items-center gap-1 px-2 py-1 text-xs"
      >
        {createElement(VIEW_ICON[view.type], { className: "h-3.5 w-3.5" })}
        {view.name}
      </button>
      {active && (
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger render={<DropdownMenuTrigger render={<button type="button" className="pr-1.5 text-muted-foreground hover:text-foreground"><ChevronDown className="h-3 w-3" /></button>} />} />
            <TooltipContent>{i18n.t("notebook:dbView.viewOptions")}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent>
            <DropdownMenuItem onClick={() => setRenaming(true)}><Pencil className="mr-1.5 h-3.5 w-3.5" /> {i18n.t("notebook:tree.rename")}</DropdownMenuItem>
            <DropdownMenuItem onClick={() => ops.duplicateView(view.id)}><Copy className="mr-1.5 h-3.5 w-3.5" /> {i18n.t("notebook:actions.duplicate")}</DropdownMenuItem>
            <DropdownMenuItem onClick={() => ops.moveView(view.id, -1)}><ArrowLeft className="mr-1.5 h-3.5 w-3.5" /> {i18n.t("notebook:dbView.moveLeft")}</DropdownMenuItem>
            <DropdownMenuItem onClick={() => ops.moveView(view.id, 1)}><ArrowRight className="mr-1.5 h-3.5 w-3.5" /> {i18n.t("notebook:dbView.moveRight")}</DropdownMenuItem>
            {canDelete && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => ops.removeView(view.id)} className="text-destructive"><Trash2 className="mr-1.5 h-3.5 w-3.5" /> {i18n.t("notebook:dbView.deleteView")}</DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </span>
  );
}

// Menu « Réglages » unifié : champs visibles (toutes vues), hauteur (table), regroupement (kanban).
function ViewSettingsMenu({ db, view, ops }: { db: Database; view: Database["views"][number]; ops: DatabaseOps }) {
  const hidden = new Set(view.hiddenFieldIds || []);
  const selectFields = db.fields.filter((f) => f.type === "select" || f.type === "multiSelect");
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger render={<DropdownMenuTrigger render={<button type="button" className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"><Settings2 className="h-3.5 w-3.5" /> {i18n.t("notebook:dbView.settings")}</button>} />} />
        <TooltipContent>{i18n.t("notebook:dbView.viewSettings")}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="max-h-96 w-56 overflow-y-auto">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{i18n.t("notebook:dbView.fields")}</DropdownMenuLabel>
          {db.fields.map((f, i) => (
            <DropdownMenuItem
              key={f.id}
              closeOnClick={false}
              onClick={() => { if (i !== 0) ops.toggleFieldHidden(f.id); }}
              className={i === 0 ? "opacity-50" : ""}
            >
              {hidden.has(f.id) ? <EyeOff className="mr-1.5 h-3.5 w-3.5 opacity-50" /> : <Eye className="mr-1.5 h-3.5 w-3.5" />}
              <span className="min-w-0 flex-1 truncate">{f.name}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        {view.type === "table" && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>{i18n.t("notebook:dbView.rowHeight")}</DropdownMenuLabel>
              {(Object.keys(ROW_HEIGHT_LABELS) as RowHeight[]).map((h) => (
                <DropdownMenuItem key={h} onClick={() => ops.updateView(view.id, { rowHeight: h })}>
                  {ROW_HEIGHT_LABELS[h]}{(view.rowHeight ?? "medium") === h ? " ✓" : ""}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </>
        )}
        {view.type === "kanban" && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>{i18n.t("notebook:dbView.groupBy")}</DropdownMenuLabel>
              {selectFields.length === 0 && <DropdownMenuItem disabled>{i18n.t("notebook:dbView.noSelectField")}</DropdownMenuItem>}
              {selectFields.map((f) => (
                <DropdownMenuItem key={f.id} onClick={() => ops.updateView(view.id, { groupFieldId: f.id })}>
                  {f.name}{view.groupFieldId === f.id ? " ✓" : ""}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Carte database (toolbar + corps + détail de ligne) — rendue dans le bloc ET dans la pleine page.
function DatabaseCard({ db, ops, tall, onRemove, onToggleFull, full }: {
  db: Database;
  ops: DatabaseOps;
  tall: boolean;
  full: boolean;
  onRemove: () => void;
  onToggleFull: () => void;
}) {
  const [openRow, setOpenRow] = useState<string | null>(null);
  const view = db.views.find((v) => v.id === db.activeViewId) || db.views[0];

  return (
    <div className={`flex min-h-0 flex-col rounded-lg border border-border bg-card/40 ${tall ? "h-full" : ""}`}>
      {/* Barre d'outils : nom + onglets de vue | réglages, filtres, tris, ⋯ */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-2 py-1.5">
        <input
          aria-label="Database name"
          defaultValue={db.name}
          key={db.name}
          onBlur={(e) => { if (e.target.value.trim() && e.target.value !== db.name) ops.rename(e.target.value.trim()); }}
          className="w-36 rounded bg-transparent px-1 text-sm font-medium outline-none hover:bg-muted focus:bg-muted"
        />
        <div className="flex items-center gap-0.5 rounded-md bg-muted/60 p-0.5">
          {db.views.map((v) => (
            <ViewTab key={v.id} view={v} active={v.id === view.id} canDelete={db.views.length > 1} ops={ops} />
          ))}
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger render={<DropdownMenuTrigger render={<button type="button" className="rounded px-1.5 py-1 text-muted-foreground hover:text-foreground"><Plus className="h-3.5 w-3.5" /></button>} />} />
              <TooltipContent>{i18n.t("notebook:dbView.addView")}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent>
              <DropdownMenuGroup>
                <DropdownMenuLabel>{i18n.t("notebook:dbView.newView")}</DropdownMenuLabel>
                {VIEW_ORDER.map((t) => (
                  <DropdownMenuItem key={t} onClick={() => ops.addView(t)}>
                    {createElement(VIEW_ICON[t], { className: "mr-1.5 h-3.5 w-3.5" })}{VIEW_LABELS[t]}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="ml-auto flex items-center gap-1">
          <FilterMenu fields={db.fields} view={view} onChange={ops.setFilters} />
          <SortMenu fields={db.fields} view={view} onChange={ops.setSorts} />
          <ViewSettingsMenu db={db} view={view} ops={ops} />
          <Tooltip>
            <TooltipTrigger render={<button type="button" onClick={onToggleFull} className="rounded p-1 text-muted-foreground hover:text-foreground">{full ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}</button>} />
            <TooltipContent>{full ? i18n.t("notebook:finalPass.exitFullscreen") : i18n.t("notebook:finalPass.openFullscreen")}</TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger render={<DropdownMenuTrigger render={<button type="button" className="rounded p-1 text-muted-foreground hover:text-foreground"><MoreHorizontal className="h-3.5 w-3.5" /></button>} />} />
              <TooltipContent>{i18n.t("notebook:dbView.databaseActions")}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onRemove} className="text-destructive"><Trash2 className="mr-1.5 h-3.5 w-3.5" /> {i18n.t("notebook:dbView.deleteDatabase")}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Corps */}
      <div className={`p-2 ${tall ? "min-h-0 flex-1 overflow-y-auto" : ""}`}>
        {view.type === "table" && <TableView db={db} view={view} ops={ops} onOpenRow={setOpenRow} tall={tall} />}
        {view.type === "kanban" && <KanbanView db={db} view={view} ops={ops} onOpenRow={setOpenRow} tall={tall} />}
        {view.type === "gallery" && <GalleryView db={db} view={view} ops={ops} onOpenRow={setOpenRow} />}
        {view.type === "calendar" && <CalendarView db={db} view={view} ops={ops} onOpenRow={setOpenRow} />}
        {view.type === "list" && <ListView db={db} view={view} ops={ops} onOpenRow={setOpenRow} />}
      </div>
      {openRow && <RowDetail db={db} rowId={openRow} view={view} ops={ops} onClose={() => setOpenRow(null)} onNavigate={setOpenRow} />}
    </div>
  );
}

export function DatabaseView({ dbId }: { dbId: string }) {
  const db = useApp((s) => s.nbDatabases[dbId]) as Database | undefined;
  const update = useApp((s) => s.nbUpdateDatabase);
  const save = useApp((s) => s.nbSaveDatabase);
  const remove = useApp((s) => s.nbDeleteDatabase);
  const [full, setFull] = useState(false);

  const mutate = useCallback((fn: (d: Database) => Database) => update(dbId, fn), [update, dbId]);
  const ops = useDatabaseOps(db?.activeViewId, mutate);

  // Auto-réparation : le champ PRIMAIRE (titre de la ligne) doit rester un texte. Une
  // base cassée (Nom passé en Case/Date via un ancien build) est remise d'aplomb : type→texte + colonne
  // vidée des valeurs incohérentes. S'exécute une fois (après quoi le type est « text » → no-op).
  const primaryType = db?.fields[0]?.type;
  useEffect(() => {
    if (!db || !db.fields[0] || db.fields[0].type === "text") return;
    mutate((d) => {
      if (!d.fields[0] || d.fields[0].type === "text") return d;
      const [p, ...rest] = d.fields;
      const fixed: Database["fields"][number] = { ...p, type: "text", isPrimary: true };
      delete fixed.options;
      const rows = d.rows.map((r) => { const { [p.id]: _drop, ...cells } = r.cells; return { ...r, cells }; });
      return { ...d, fields: [fixed, ...rest], rows };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbId, primaryType]);

  if (!db) {
    return (
      <div className="flex items-center justify-between rounded-md border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
        <span>{i18n.t("notebook:dbView.missingDatabase")}</span>
        <Button size="sm" onClick={() => void save(makeEmptyDatabase(dbId))}>{i18n.t("notebook:dbView.recreate")}</Button>
      </div>
    );
  }

  return (
    <>
      <DatabaseCard db={db} ops={ops} tall={false} full={false} onRemove={() => void remove(dbId)} onToggleFull={() => setFull(true)} />
      {full && (
        <Dialog open onOpenChange={(o) => { if (!o) setFull(false); }}>
          <DialogContent className="flex h-[94vh] w-[96vw] max-w-none flex-col gap-0 p-3 sm:max-w-none">
            <DialogTitle className="sr-only">{db.name}</DialogTitle>
            <DatabaseCard db={db} ops={ops} tall full onRemove={() => { void remove(dbId); setFull(false); }} onToggleFull={() => setFull(false)} />
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
