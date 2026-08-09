// Vue Table de la database — react-data-grid (MIT, virtualisé, zéro anim JS). Les lignes sont aplaties
// en { __id, [fieldId]: value } pour la grille ; on remappe en cells au commit. Édition inline par type
// (texte/nombre/lien/date = éditeur natif ; sélection = dropdown ; case = checkbox).
import { useMemo } from "react";
import i18n from "@/i18n";
import { DataGrid, type Column, type RenderCellProps, type RenderEditCellProps } from "react-data-grid";
import { Trash2, Copy, MoreHorizontal, Sigma, Maximize2 } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuGroup } from "@/components/ui/dropdown-menu";
import { visibleRows, computeCalc } from "@/lib/notebookDb";
import { CellDisplay, InputEditCell, OptionPicker, ChecklistPicker, DatePickerCell, NbCheck } from "./cellControls";
import { FieldHeader, AddFieldButton } from "./FieldMenu";
import { CALC_LABELS, calcsForField, ROW_HEIGHT_PX, type CalcType, type ChecklistItem, type Database, type DbField, type DbRow, type DbView } from "../notebookShared";
import type { DatabaseOps } from "./useDatabaseOps";

type GridRow = { __id: string } & Record<string, unknown>;
type SummaryRow = { __calc: boolean };
const SUMMARY_ROWS: SummaryRow[] = [{ __calc: true }]; // ligne de pied unique (agrégats par colonne)

const inputType = (f: DbField): "text" | "number" | "url" | "date" =>
  f.type === "number" ? "number" : f.type === "date" ? "date" : f.type === "url" ? "url" : "text";

// Pied de colonne : choix + valeur de l'agrégat (Nombre/Somme/Moyenne…).
function CalcCell({ field, calc, rows, onPick }: { field: DbField; calc: CalcType | undefined; rows: DbRow[]; onPick: (c: CalcType) => void }) {
  const allowed = calcsForField(field.type); // calculs pertinents pour ce type
  // Un calcul obsolète (choisi quand le champ était d'un autre type) est ignoré → pas de « Moyenne — ».
  const eff = calc && allowed.includes(calc) ? calc : undefined;
  const value = computeCalc(rows, field, eff);
  const active = eff && eff !== "none";
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger render={<DropdownMenuTrigger render={
          <button type="button" className="flex h-full w-full items-center justify-end gap-1 px-1.5 text-xs text-muted-foreground hover:text-foreground">
            {active ? <><span className="opacity-70">{CALC_LABELS[eff!]}</span> <span className="font-medium tabular-nums text-foreground">{value}</span></> : <Sigma className="h-3.5 w-3.5 opacity-40" />}
          </button>
        } />} />
        <TooltipContent>{i18n.t("notebook:dbBasics.calculation")}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{i18n.t("notebook:dbBasics.calculation")}</DropdownMenuLabel>
          {allowed.map((c) => (
            <DropdownMenuItem key={c} onClick={() => onPick(c)}>{CALC_LABELS[c]}{c === (eff || "none") ? " ✓" : ""}</DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DataCell({ field, p, ops }: { field: DbField; p: RenderCellProps<GridRow, SummaryRow>; ops: DatabaseOps }) {
  const value = p.row[field.id];
  if (field.type === "createdTime" || field.type === "lastEditedTime") {
    const ts = field.type === "createdTime" ? p.row.__createdAt : p.row.__updatedAt;
    return <div className="flex h-full items-center overflow-hidden px-1.5"><CellDisplay field={field} value={ts} /></div>;
  }
  if (field.type === "date") {
    return <DatePickerCell field={field} value={value} onChange={(v) => p.onRowChange({ ...p.row, [field.id]: v })} />;
  }
  if (field.type === "checklist") {
    return (
      <ChecklistPicker
        value={value}
        onChange={(v: ChecklistItem[]) => p.onRowChange({ ...p.row, [field.id]: v })}
        trigger={<button type="button" className="flex h-full w-full items-center px-1.5 text-left"><CellDisplay field={field} value={value} /></button>}
      />
    );
  }
  if (field.type === "checkbox") {
    return (
      <div className="flex h-full items-center justify-center">
        <NbCheck checked={value === true} onChange={(v) => p.onRowChange({ ...p.row, [field.id]: v })} />
      </div>
    );
  }
  if (field.type === "select" || field.type === "multiSelect") {
    return (
      <OptionPicker
        field={field}
        value={value}
        multi={field.type === "multiSelect"}
        onChange={(v) => p.onRowChange({ ...p.row, [field.id]: v })}
        onCreateOption={(l) => ops.addOption(field.id, l)}
        onUpdateOption={(oid, patch) => ops.updateOption(field.id, oid, patch)}
        onRemoveOption={(oid) => ops.removeOption(field.id, oid)}
        trigger={<button type="button" className="flex h-full w-full items-center gap-1 overflow-hidden px-1.5 text-left"><CellDisplay field={field} value={value} /></button>}
      />
    );
  }
  return <div className="flex h-full items-center overflow-hidden px-1.5"><CellDisplay field={field} value={value} /></div>;
}

export function TableView({ db, view, ops, onOpenRow, tall }: { db: Database; view: DbView; ops: DatabaseOps; onOpenRow: (id: string) => void; tall?: boolean }) {
  const vrows = useMemo<DbRow[]>(() => visibleRows(db.rows, db.fields, view), [db.rows, db.fields, view]);
  const rows = useMemo<GridRow[]>(() => vrows.map((r) => ({ __id: r.id, __createdAt: r.createdAt, __updatedAt: r.updatedAt, ...r.cells })), [vrows]);

  const columns = useMemo<Column<GridRow, SummaryRow>[]>(() => {
    const actions: Column<GridRow, SummaryRow> = {
      key: "__actions", name: "", width: 36, frozen: true, resizable: false,
      renderCell: (p) => (
        <div className="nb-row-actions flex h-full items-center justify-center">
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger render={<DropdownMenuTrigger render={<button type="button" className="text-muted-foreground hover:text-foreground"><MoreHorizontal className="h-3.5 w-3.5" /></button>} />} />
              <TooltipContent>{i18n.t("notebook:dbBasics.rowActions")}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={() => onOpenRow(p.row.__id)}><Maximize2 className="mr-1.5 h-3.5 w-3.5" /> {i18n.t("notebook:blocksUi.open")}</DropdownMenuItem>
              <DropdownMenuItem onClick={() => ops.duplicateRow(p.row.__id)}><Copy className="mr-1.5 h-3.5 w-3.5" /> {i18n.t("notebook:actions.duplicate")}</DropdownMenuItem>
              <DropdownMenuItem onClick={() => ops.removeRow(p.row.__id)} className="text-destructive"><Trash2 className="mr-1.5 h-3.5 w-3.5" /> {i18n.t("notebook:dbBasics.delete")}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ),
      renderSummaryCell: () => null,
    };
    const hidden = new Set(view.hiddenFieldIds || []);
    const visFields = db.fields.filter((f) => !hidden.has(f.id));
    const fieldCols = visFields.map((f, fi): Column<GridRow, SummaryRow> => {
      const editable = f.type === "text" || f.type === "number" || f.type === "url";
      return {
        key: f.id,
        name: f.name,
        width: f.width ?? 160,
        resizable: true,
        draggable: !f.isPrimary, // réordonnable par glisser (sauf le champ primaire, toujours 1er)
        editable,
        renderHeaderCell: () => <FieldHeader field={f} ops={ops} primary={f.id === db.fields[0]?.id} />,
        renderCell: (p) => <DataCell field={f} p={p} ops={ops} />,
        renderSummaryCell: () => (
          fi === 0
            ? <span className="px-1.5 text-xs text-muted-foreground tabular-nums">{i18n.t("notebook:dbBasics.rowCount", { count: vrows.length })}</span>
            : <CalcCell field={f} calc={view.calcs?.[f.id]} rows={vrows} onPick={(c) => ops.setCalc(f.id, c)} />
        ),
        renderEditCell: editable
          ? (p: RenderEditCellProps<GridRow, SummaryRow>) => (
              <InputEditCell
                value={p.row[f.id]}
                type={inputType(f)}
                onCommit={(v) => p.onRowChange({ ...p.row, [f.id]: v }, true)}
                onClose={() => p.onClose()}
              />
            )
          : undefined,
      };
    });
    const add: Column<GridRow, SummaryRow> = { key: "__add", name: "", width: 44, resizable: false, renderHeaderCell: () => <AddFieldButton ops={ops} />, renderCell: () => null, renderSummaryCell: () => null };
    return [actions, ...fieldCols, add];
  }, [db.fields, ops, view.calcs, view.hiddenFieldIds, vrows, onOpenRow]);

  const onRowsChange = (next: GridRow[], data: { indexes: number[] }) => {
    for (const i of data.indexes) {
      const gr = next[i];
      const cells: Record<string, unknown> = {};
      for (const f of db.fields) cells[f.id] = gr[f.id];
      ops.updateRow(gr.__id, cells);
    }
  };

  // Hauteur de ligne + hauteur totale plafonnée → la grille scrolle au-delà.
  // Pleine page (tall) : plafond relevé à la fenêtre.
  const rh = ROW_HEIGHT_PX[view.rowHeight ?? "medium"];
  const cap = tall ? Math.max(400, window.innerHeight - 220) : 600;
  const height = Math.min(cap, 42 + Math.max(rows.length, 1) * rh + 38 + 8);

  return (
    <div className="nb-db-table overflow-hidden rounded-lg border border-border">
      <div style={{ blockSize: height }}>
        <DataGrid
          columns={columns}
          rows={rows}
          rowKeyGetter={(r) => r.__id}
          onRowsChange={onRowsChange}
          onColumnResize={(col, width) => { if (typeof col.key === "string" && !col.key.startsWith("__")) ops.updateField(col.key, { width: Math.round(width) }); }}
          onColumnsReorder={(src, tgt) => { if (!src.startsWith("__") && !tgt.startsWith("__")) ops.reorderField(src, tgt); }}
          bottomSummaryRows={SUMMARY_ROWS}
          summaryRowHeight={38}
          className="rdg-dark h-full"
          rowHeight={rh}
          headerRowHeight={42}
        />
      </div>
      <button
        type="button"
        onClick={() => ops.addRow()}
        className="flex w-full items-center gap-1 border-t border-border px-3 py-2 text-left text-xs text-muted-foreground hover:bg-muted"
      >
        + {i18n.t("notebook:dbBasics.newRow")}
      </button>
    </div>
  );
}
