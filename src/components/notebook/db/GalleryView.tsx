// Vue Galerie — cartes en grille. Chaque carte = champ primaire + champs
// non vides (chips). Clic → ouvre le détail de ligne. Aucune anim JS, content-visibility pour le paint.
import { useMemo } from "react";
import { Plus } from "lucide-react";
import { visibleRows } from "@/lib/notebookDb";
import { CellDisplay } from "./cellControls";
import { cellValueFor, primaryField, type Database, type DbView } from "../notebookShared";
import type { DatabaseOps } from "./useDatabaseOps";
import i18n from "@/i18n";

export function GalleryView({ db, view, ops, onOpenRow }: { db: Database; view: DbView; ops: DatabaseOps; onOpenRow: (id: string) => void }) {
  const rows = useMemo(() => visibleRows(db.rows, db.fields, view), [db.rows, db.fields, view]);
  const primary = primaryField(db);
  const rest = db.fields.filter((f) => f.id !== primary?.id);

  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-2.5">
      {rows.map((r) => {
        const shown = rest.filter((f) => { const v = cellValueFor(f, r); return v != null && v !== "" && !(Array.isArray(v) && v.length === 0); });
        return (
          <button
            key={r.id}
            type="button"
            onClick={() => onOpenRow(r.id)}
            style={{ contentVisibility: "auto" }}
            className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:border-primary/60 hover:bg-muted/40"
          >
            <span className="truncate text-sm font-medium">{String(primary ? r.cells[primary.id] ?? "" : "") || <span className="text-muted-foreground">{i18n.t("notebook:panel.untitled")}</span>}</span>
            {shown.length > 0 && (
              <span className="flex flex-wrap items-center gap-1">
                {shown.slice(0, 4).map((f) => <span key={f.id} className="min-w-0"><CellDisplay field={f} value={cellValueFor(f, r)} /></span>)}
              </span>
            )}
          </button>
        );
      })}
      <button type="button" onClick={() => ops.addRow()} className="flex min-h-20 items-center justify-center gap-1 rounded-lg border-2 border-dashed border-border text-sm text-muted-foreground hover:border-primary hover:text-primary">
        <Plus className="h-4 w-4" /> {i18n.t("notebook:dbFields.addCard")}
      </button>
    </div>
  );
}
