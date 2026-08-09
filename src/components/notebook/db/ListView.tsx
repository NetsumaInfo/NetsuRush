// Vue Liste — lignes compactes en une colonne. Chaque ligne = champ
// primaire + chips des autres champs ; clic → détail de ligne. Bouton nouvelle ligne en pied.
import { useMemo } from "react";
import { Plus } from "lucide-react";
import { visibleRows } from "@/lib/notebookDb";
import { CellDisplay } from "./cellControls";
import { cellValueFor, primaryField, type Database, type DbView } from "../notebookShared";
import type { DatabaseOps } from "./useDatabaseOps";
import i18n from "@/i18n";

export function ListView({ db, view, ops, onOpenRow }: { db: Database; view: DbView; ops: DatabaseOps; onOpenRow: (id: string) => void }) {
  const rows = useMemo(() => visibleRows(db.rows, db.fields, view), [db.rows, db.fields, view]);
  const primary = primaryField(db);
  const rest = db.fields.filter((f) => f.id !== primary?.id);

  return (
    <div className="overflow-hidden rounded-md border border-border">
      {rows.map((r) => {
        const shown = rest.filter((f) => { const v = cellValueFor(f, r); return v != null && v !== "" && !(Array.isArray(v) && v.length === 0); });
        return (
          <button
            key={r.id}
            type="button"
            onClick={() => onOpenRow(r.id)}
            className="flex w-full items-center gap-3 border-b border-border px-3 py-2 text-left last:border-0 hover:bg-muted/40"
          >
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{String(primary ? r.cells[primary.id] ?? "" : "") || <span className="text-muted-foreground">{i18n.t("notebook:panel.untitled")}</span>}</span>
            <span className="flex shrink-0 flex-wrap items-center justify-end gap-1">
              {shown.slice(0, 4).map((f) => <span key={f.id} className="min-w-0"><CellDisplay field={f} value={cellValueFor(f, r)} /></span>)}
            </span>
          </button>
        );
      })}
      <button type="button" onClick={() => ops.addRow()} className="flex w-full items-center gap-1 px-3 py-2 text-left text-xs text-muted-foreground hover:bg-muted">
        <Plus className="h-3.5 w-3.5" /> {i18n.t("notebook:dbBasics.newRow")}
      </button>
    </div>
  );
}
