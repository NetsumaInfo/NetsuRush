// Panneau « détail de ligne » — ouvre une ligne en modale : titre = champ
// primaire, navigation ‹ › entre lignes (ordre de la vue active), chaque champ en colonne (icône + nom
// + éditeur), + ajout de propriété, dupliquer, supprimer. Toute mutation passe par les ops.
import { createElement } from "react";
import i18n from "@/i18n";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Trash2, Copy, ChevronUp, ChevronDown } from "lucide-react";
import { visibleRows } from "@/lib/notebookDb";
import { FIELD_ICON, AddFieldButton } from "./FieldMenu";
import { FieldEditor } from "./FieldEditor";
import { cellValueFor, type Database, type DbView } from "../notebookShared";
import type { DatabaseOps } from "./useDatabaseOps";

export function RowDetail({ db, rowId, view, ops, onClose, onNavigate }: {
  db: Database;
  rowId: string;
  view: DbView;
  ops: DatabaseOps;
  onClose: () => void;
  onNavigate: (id: string) => void;
}) {
  const row = db.rows.find((r) => r.id === rowId);
  if (!row) return null;
  const [primary, ...rest] = db.fields;
  const setCell = (fieldId: string, v: unknown) => ops.updateRow(rowId, { ...row.cells, [fieldId]: v });

  // Navigation ligne précédente / suivante dans l'ORDRE DE LA VUE (filtres + tris appliqués).
  const ordered = visibleRows(db.rows, db.fields, view);
  const pos = ordered.findIndex((r) => r.id === rowId);
  const prev = pos > 0 ? ordered[pos - 1] : null;
  const next = pos >= 0 && pos < ordered.length - 1 ? ordered[pos + 1] : null;

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
        <DialogTitle className="sr-only">{i18n.t("notebook:dbBasics.rowDetail")}</DialogTitle>
        {/* Navigation + position */}
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Tooltip>
            <TooltipTrigger render={<button type="button" disabled={!prev} onClick={() => prev && onNavigate(prev.id)} className="rounded p-1 hover:bg-muted hover:text-foreground disabled:opacity-30"><ChevronUp className="h-4 w-4" /></button>} />
            <TooltipContent>{i18n.t("notebook:dbBasics.previousRow")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={<button type="button" disabled={!next} onClick={() => next && onNavigate(next.id)} className="rounded p-1 hover:bg-muted hover:text-foreground disabled:opacity-30"><ChevronDown className="h-4 w-4" /></button>} />
            <TooltipContent>{i18n.t("notebook:dbBasics.nextRow")}</TooltipContent>
          </Tooltip>
          {pos >= 0 && <span className="tabular-nums">{pos + 1} / {ordered.length}</span>}
        </div>
        {/* Titre = champ primaire */}
        {primary && (
          <input
            value={String(row.cells[primary.id] ?? "")}
            onChange={(e) => setCell(primary.id, e.target.value)}
            placeholder={i18n.t("notebook:panel.untitled")}
            className="mb-3 w-full bg-transparent text-xl font-semibold outline-none placeholder:text-muted-foreground"
          />
        )}
        {/* Champs (hors primaire) : libellé icône + éditeur */}
        <div className="flex flex-col gap-2.5">
          {rest.map((f) => (
            <div key={f.id} className="grid grid-cols-[150px_1fr] items-start gap-2">
              <div className="flex items-center gap-1.5 pt-1.5 text-sm text-muted-foreground">
                {createElement(FIELD_ICON[f.type], { className: "h-3.5 w-3.5 shrink-0" })}
                <span className="truncate">{f.name}</span>
              </div>
              <FieldEditor field={f} value={cellValueFor(f, row)} onChange={(v) => setCell(f.id, v)} ops={ops} />
            </div>
          ))}
        </div>
        {/* Pied : ajouter une propriété + dupliquer + supprimer */}
        <div className="mt-4 flex items-center justify-between border-t border-border pt-3">
          <div className="flex items-center gap-1 text-sm text-muted-foreground">
            <span className="flex h-6 w-6 items-center justify-center"><AddFieldButton ops={ops} /></span>
            <span>{i18n.t("notebook:dbBasics.newProperty")}</span>
          </div>
          <div className="flex items-center gap-1">
            <button type="button" onClick={() => { ops.duplicateRow(rowId); onClose(); }} className="flex items-center gap-1 rounded px-2 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground">
              <Copy className="h-3.5 w-3.5" /> {i18n.t("notebook:actions.duplicate")}
            </button>
            <button type="button" onClick={() => { ops.removeRow(rowId); onClose(); }} className="flex items-center gap-1 rounded px-2 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-destructive">
              <Trash2 className="h-3.5 w-3.5" /> {i18n.t("notebook:dbBasics.delete")}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
