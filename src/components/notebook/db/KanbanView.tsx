// Vue Kanban de la database — colonnes = options du champ de regroupement (select), cartes = lignes.
// dnd-kit sortable : réordonner les cartes DANS une colonne (ordre global des lignes) et déplacer
// entre colonnes (écrit la valeur du champ groupé). Colonnes : menu par en-tête (masquer / déplacer
// ← → / renommer) + « Ajouter une colonne » (nouvelle option). Zéro anim JS (transforms GPU dnd-kit).
import { useState } from "react";
import i18n from "@/i18n";
import { DndContext, PointerSensor, closestCorners, useSensor, useSensors, useDroppable, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { Plus, MoreHorizontal, EyeOff, Eye, ArrowLeft, ArrowRight, Pencil } from "lucide-react";
import { visibleRows, groupForKanban, type KanbanColumn } from "@/lib/notebookDb";
import { CellDisplay } from "./cellControls";
import { cellValueFor, colorOf, type Database, type DbField, type DbRow, type DbView } from "../notebookShared";
import type { DatabaseOps } from "./useDatabaseOps";

function Card({ row, fields, primaryId, onOpen }: { row: DbRow; fields: DbField[]; primaryId: string; onOpen: (id: string) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: row.id });
  const rest = fields.filter((f) => { if (f.id === primaryId) return false; const v = cellValueFor(f, row); return v != null && v !== "" && !(Array.isArray(v) && v.length === 0); });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={() => onOpen(row.id)}
      style={{ transform: CSS.Translate.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }}
      className="cursor-pointer touch-none rounded-md border border-border bg-card p-2.5 text-sm shadow-sm hover:border-primary/50"
    >
      <div className="mb-1 truncate font-medium">{String(row.cells[primaryId] ?? "") || <span className="text-muted-foreground">{i18n.t("notebook:panel.untitled")}</span>}</div>
      {rest.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {rest.map((f) => <span key={f.id} className="min-w-0"><CellDisplay field={f} value={cellValueFor(f, row)} /></span>)}
        </div>
      )}
    </div>
  );
}

function Column({ col, fields, groupField, primaryId, tall, ops, onAdd, onOpen, onHide }: {
  col: KanbanColumn;
  fields: DbField[];
  groupField: DbField;
  primaryId: string;
  tall: boolean;
  ops: DatabaseOps;
  onAdd: () => void;
  onOpen: (id: string) => void;
  onHide: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${col.key}` });
  const [renaming, setRenaming] = useState(false);
  const tint = col.color ? colorOf(col.color) : null;
  const isOption = col.key !== "__none__" && col.key !== "__all__";
  return (
    <div ref={setNodeRef} className={`flex ${tall ? "max-h-full" : "max-h-[540px]"} w-64 shrink-0 flex-col rounded-lg border border-border bg-muted/40 ${isOver ? "ring-1 ring-primary" : ""}`}>
      <div className="group/col flex items-center justify-between gap-1 px-3 py-2">
        {renaming && isOption ? (
          <input
            aria-label={col.label}
            defaultValue={col.label}
            onBlur={(e) => { const v = e.target.value.trim(); if (v) ops.updateOption(groupField.id, col.key, { label: v }); setRenaming(false); }}
            onKeyDown={(e) => { if (e.nativeEvent.isComposing) return; if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setRenaming(false); }}
            className="w-28 rounded bg-card px-1.5 py-0.5 text-xs outline-none ring-1 ring-primary"
          />
        ) : (
          <span className="truncate rounded px-1.5 py-0.5 text-xs font-medium" style={tint ? { backgroundColor: tint.bg, color: tint.fg } : undefined}>
            {col.label} <span className="opacity-60">{col.rows.length}</span>
          </span>
        )}
        <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/col:opacity-100">
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger render={<DropdownMenuTrigger render={<button type="button" className="text-muted-foreground hover:text-foreground"><MoreHorizontal className="h-3.5 w-3.5" /></button>} />} />
              <TooltipContent>{i18n.t("notebook:dbFields.columnOptions")}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent>
              {isOption && <DropdownMenuItem onClick={() => setRenaming(true)}><Pencil className="mr-1.5 h-3.5 w-3.5" /> {i18n.t("notebook:tree.rename")}</DropdownMenuItem>}
              {isOption && <DropdownMenuItem onClick={() => ops.reorderOption(groupField.id, col.key, -1)}><ArrowLeft className="mr-1.5 h-3.5 w-3.5" /> {i18n.t("notebook:dbView.moveLeft")}</DropdownMenuItem>}
              {isOption && <DropdownMenuItem onClick={() => ops.reorderOption(groupField.id, col.key, 1)}><ArrowRight className="mr-1.5 h-3.5 w-3.5" /> {i18n.t("notebook:dbView.moveRight")}</DropdownMenuItem>}
              {isOption && <DropdownMenuSeparator />}
              <DropdownMenuItem onClick={onHide}><EyeOff className="mr-1.5 h-3.5 w-3.5" /> {i18n.t("notebook:dbFields.hideColumn")}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Tooltip>
            <TooltipTrigger render={<button type="button" onClick={onAdd} className="text-muted-foreground hover:text-foreground"><Plus className="h-4 w-4" /></button>} />
            <TooltipContent>{i18n.t("notebook:dbFields.addCard")}</TooltipContent>
          </Tooltip>
        </span>
      </div>
      <SortableContext items={col.rows.map((r) => r.id)} strategy={verticalListSortingStrategy}>
        <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
          {col.rows.map((r) => <Card key={r.id} row={r} fields={fields} primaryId={primaryId} onOpen={onOpen} />)}
        </div>
      </SortableContext>
    </div>
  );
}

export function KanbanView({ db, view, ops, onOpenRow, tall }: { db: Database; view: DbView; ops: DatabaseOps; onOpenRow: (id: string) => void; tall?: boolean }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const groupField = db.fields.find((f) => f.id === view.groupFieldId);
  const primaryId = db.fields[0]?.id ?? "";

  if (!groupField || (groupField.type !== "select" && groupField.type !== "multiSelect")) {
    return <div className="rounded-md border border-border p-6 text-center text-sm text-muted-foreground">{i18n.t("notebook:dbFields.groupHint")}</div>;
  }

  const rows = visibleRows(db.rows, db.fields, view);
  const hidden = new Set(view.hiddenGroupKeys || []);
  const allColumns = groupForKanban(rows, groupField);
  const columns = allColumns.filter((c) => !hidden.has(c.key));
  const hiddenCols = allColumns.filter((c) => hidden.has(c.key));

  // Colonne d'une carte (par id de ligne) pour router le drop.
  const columnOfRow = (rowId: string) => allColumns.find((c) => c.rows.some((r) => r.id === rowId));

  const onDragEnd = (e: DragEndEvent) => {
    const rowId = String(e.active.id);
    if (!e.over) return;
    const overId = String(e.over.id);
    const row = db.rows.find((r) => r.id === rowId);
    if (!row) return;
    // Cible : une carte (tri fin) ou une colonne (dépôt en fin de colonne).
    const targetCol = overId.startsWith("col:") ? allColumns.find((c) => `col:${c.key}` === overId) : columnOfRow(overId);
    if (!targetCol) return;
    const sourceCol = columnOfRow(rowId);
    if (targetCol.key !== sourceCol?.key) {
      const value = targetCol.key === "__none__" ? (groupField.type === "multiSelect" ? [] : "") : (groupField.type === "multiSelect" ? [targetCol.key] : targetCol.key);
      ops.updateRow(rowId, { ...row.cells, [groupField.id]: value });
    }
    // Tri : posé sur une carte → juste avant elle ; posé sur la colonne → en fin.
    if (!overId.startsWith("col:") && overId !== rowId) ops.moveRowBefore(rowId, overId);
    else if (overId.startsWith("col:")) ops.moveRowBefore(rowId, null);
  };

  const toggleHideColumn = (key: string) => {
    const next = new Set(view.hiddenGroupKeys || []);
    if (next.has(key)) next.delete(key); else next.add(key);
    ops.updateView(view.id, { hiddenGroupKeys: [...next] });
  };

  const addColumn = () => {
    const label = `Option ${(groupField.options?.length ?? 0) + 1}`;
    ops.addOption(groupField.id, label);
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={onDragEnd}>
      <div className={`flex ${tall ? "h-full" : "max-h-[540px]"} gap-3 overflow-x-auto pb-2`}>
        {columns.map((col) => (
          <Column
            key={col.key}
            col={col}
            fields={db.fields}
            groupField={groupField}
            primaryId={primaryId}
            tall={!!tall}
            ops={ops}
            onOpen={onOpenRow}
            onHide={() => toggleHideColumn(col.key)}
            onAdd={() => ops.addRow(col.key === "__none__" || col.key === "__all__" ? {} : { [groupField.id]: groupField.type === "multiSelect" ? [col.key] : col.key })}
          />
        ))}
        {/* Ajouter une colonne (nouvelle option du champ groupé) + colonnes masquées */}
        <div className="flex w-48 shrink-0 flex-col gap-1.5">
          <button type="button" onClick={addColumn} className="flex items-center gap-1.5 rounded-lg border-2 border-dashed border-border px-3 py-2 text-xs text-muted-foreground hover:border-primary hover:text-primary">
            <Plus className="h-3.5 w-3.5" /> {i18n.t("notebook:dbFields.addColumn")}
          </button>
          {hiddenCols.map((c) => (
            <Tooltip key={c.key}>
              <TooltipTrigger
                render={
                  <button type="button" onClick={() => toggleHideColumn(c.key)} className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground">
                    <Eye className="h-3.5 w-3.5" /> <span className="truncate">{c.label}</span> <span className="opacity-60">{c.rows.length}</span>
                  </button>
                }
              />
              <TooltipContent>{i18n.t("notebook:dbFields.showColumn")}</TooltipContent>
            </Tooltip>
          ))}
        </div>
      </div>
    </DndContext>
  );
}
