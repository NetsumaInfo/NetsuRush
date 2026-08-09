// Mutations d'une database. Chaque op passe par `mutate((db) => nextDb)` (updater fonctionnel du
// store qui lit l'état FRAIS) → deux éditions enchaînées (ex. créer une option PUIS l'affecter à une
// cellule) composent sans s'écraser. Toujours un NOUVEL objet (jamais de mutation en place). Centralise
// toute l'édition pour garder DatabaseView/TableView/KanbanView minces.
import { useMemo } from "react";
import { nbId, VIEW_LABELS, type CalcType, type Database, type DbField, type DbRow, type DbView, type FieldType, type FilterCond, type SortRule, type ViewType } from "../notebookShared";
import { newOption } from "./cellControls";

export interface DatabaseOps {
  rename: (name: string) => void;
  addField: (type: FieldType) => void;
  addFieldAt: (fieldId: string, side: "left" | "right", type?: FieldType) => void;
  duplicateField: (fieldId: string) => void;
  clearFieldData: (fieldId: string) => void;
  toggleFieldHidden: (fieldId: string) => void;
  updateField: (fieldId: string, patch: Partial<DbField>) => void;
  removeField: (fieldId: string) => void;
  addOption: (fieldId: string, label: string) => string;
  updateOption: (fieldId: string, optionId: string, patch: { label?: string; color?: string }) => void;
  removeOption: (fieldId: string, optionId: string) => void;
  reorderField: (sourceId: string, targetId: string) => void;
  addRow: (preset?: Record<string, unknown>) => void;
  updateRow: (rowId: string, cells: Record<string, unknown>) => void;
  removeRow: (rowId: string) => void;
  duplicateRow: (rowId: string) => void;
  setActiveView: (viewId: string) => void;
  addView: (type: ViewType) => void;
  updateView: (viewId: string, patch: Partial<DbView>) => void;
  removeView: (viewId: string) => void;
  duplicateView: (viewId: string) => void;
  moveView: (viewId: string, dir: -1 | 1) => void;
  // Kanban : réordonner une carte (ordre global des lignes) / une colonne (ordre des options du champ groupé).
  moveRowBefore: (rowId: string, targetRowId: string | null) => void;
  reorderOption: (fieldId: string, optionId: string, dir: -1 | 1) => void;
  setFilters: (filters: FilterCond[]) => void;
  setSorts: (sorts: SortRule[]) => void;
  setCalc: (fieldId: string, calc: CalcType) => void;
}

type Mutate = (fn: (db: Database) => Database) => void;

export function useDatabaseOps(activeViewId: string | undefined, mutate: Mutate): DatabaseOps {
  return useMemo<DatabaseOps>(() => {
    const mapView = (viewId: string, fn: (v: DbView) => DbView) =>
      (d: Database): Database => ({ ...d, views: d.views.map((v) => (v.id === viewId ? fn(v) : v)) });

    return {
      rename: (name) => mutate((d) => ({ ...d, name })),

      addField: (type) => mutate((d) => {
        const base: DbField = { id: nbId(), name: `Champ ${d.fields.length + 1}`, type, width: 160 };
        if (type === "select" || type === "multiSelect") base.options = [];
        return { ...d, fields: [...d.fields, base] };
      }),

      addFieldAt: (fieldId, side, type = "text") => mutate((d) => {
        const idx = d.fields.findIndex((f) => f.id === fieldId);
        if (idx < 0) return d;
        const base: DbField = { id: nbId(), name: `Champ ${d.fields.length + 1}`, type, width: 160 };
        if (type === "select" || type === "multiSelect") base.options = [];
        const at = side === "left" ? idx : idx + 1;
        const fields = [...d.fields.slice(0, at), base, ...d.fields.slice(at)];
        return { ...d, fields };
      }),

      duplicateField: (fieldId) => mutate((d) => {
        const idx = d.fields.findIndex((f) => f.id === fieldId);
        if (idx < 0) return d;
        const src = d.fields[idx];
        const copy: DbField = { ...src, id: nbId(), name: `${src.name} (copie)`, options: src.options ? src.options.map((o) => ({ ...o })) : undefined };
        const fields = [...d.fields.slice(0, idx + 1), copy, ...d.fields.slice(idx + 1)];
        // Recopie les valeurs de la colonne source.
        const rows = d.rows.map((r) => (fieldId in r.cells ? { ...r, cells: { ...r.cells, [copy.id]: r.cells[fieldId] } } : r));
        return { ...d, fields, rows };
      }),

      clearFieldData: (fieldId) => mutate((d) => ({
        ...d,
        rows: d.rows.map((r) => { const { [fieldId]: _drop, ...cells } = r.cells; return { ...r, cells }; }),
      })),

      toggleFieldHidden: (fieldId) => { if (activeViewId) mutate(mapView(activeViewId, (v) => {
        const hidden = new Set(v.hiddenFieldIds || []);
        if (hidden.has(fieldId)) hidden.delete(fieldId); else hidden.add(fieldId);
        return { ...v, hiddenFieldIds: [...hidden] };
      })); },

      updateField: (fieldId, patch) => mutate((d) => {
        const cur = d.fields.find((f) => f.id === fieldId);
        const typeChanged = !!patch.type && !!cur && patch.type !== cur.type;
        const fields = d.fields.map((f) => {
          if (f.id !== fieldId) return f;
          const next: DbField = { ...f, ...patch };
          if (typeChanged) {
            // (dé)initialise les options selon le nouveau type (évite un select sans options / l'inverse).
            if (next.type === "select" || next.type === "multiSelect") next.options = f.options || [];
            else delete next.options;
          }
          return next;
        });
        // Changer de type rend les anciennes valeurs incohérentes (ex. optionId affiché comme texte/date)
        // → on vide la colonne concernée pour repartir propre.
        const rows = typeChanged
          ? d.rows.map((r) => { const { [fieldId]: _drop, ...cells } = r.cells; return { ...r, cells }; })
          : d.rows;
        return { ...d, fields, rows };
      }),

      removeField: (fieldId) => mutate((d) => ({
        ...d,
        fields: d.fields.filter((f) => f.id !== fieldId),
        rows: d.rows.map((r) => { const { [fieldId]: _drop, ...cells } = r.cells; return { ...r, cells }; }),
      })),

      addOption: (fieldId, label) => {
        // id généré AVANT la mutation → renvoyé sync ; l'option est ajoutée sur l'état frais.
        const opt = newOption(label, Math.floor(Math.random() * 8));
        opt.id = nbId();
        mutate((d) => ({ ...d, fields: d.fields.map((f) => (f.id === fieldId ? { ...f, options: [...(f.options || []), opt] } : f)) }));
        return opt.id;
      },

      updateOption: (fieldId, optionId, patch) => mutate((d) => ({
        ...d,
        fields: d.fields.map((f) => (f.id === fieldId ? { ...f, options: (f.options || []).map((o) => (o.id === optionId ? { ...o, ...patch } : o)) } : f)),
      })),

      removeOption: (fieldId, optionId) => mutate((d) => ({
        ...d,
        fields: d.fields.map((f) => (f.id === fieldId ? { ...f, options: (f.options || []).filter((o) => o.id !== optionId) } : f)),
        // Retire l'option des cellules (mono → vide ; multi → filtre).
        rows: d.rows.map((r) => {
          const v = r.cells[fieldId];
          if (Array.isArray(v)) return { ...r, cells: { ...r.cells, [fieldId]: v.filter((x) => x !== optionId) } };
          if (v === optionId) { const { [fieldId]: _drop, ...cells } = r.cells; return { ...r, cells }; }
          return r;
        }),
      })),

      reorderField: (sourceId, targetId) => mutate((d) => {
        const from = d.fields.findIndex((f) => f.id === sourceId);
        const to = d.fields.findIndex((f) => f.id === targetId);
        if (from < 0 || to < 0 || from === to) return d;
        if (d.fields[from].isPrimary) return d; // le primaire reste en tête
        const fields = [...d.fields];
        const [moved] = fields.splice(from, 1);
        fields.splice(to, 0, moved);
        const pIdx = fields.findIndex((f) => f.isPrimary);
        if (pIdx > 0) { const [p] = fields.splice(pIdx, 1); fields.unshift(p); }
        return { ...d, fields };
      }),

      addRow: (preset) => mutate((d) => {
        const now = Date.now();
        return { ...d, rows: [...d.rows, { id: nbId(), cells: { ...(preset || {}) }, createdAt: now, updatedAt: now }] };
      }),

      updateRow: (rowId, cells) => mutate((d) => ({ ...d, rows: d.rows.map((r) => (r.id === rowId ? { ...r, cells, updatedAt: Date.now() } : r)) })),

      removeRow: (rowId) => mutate((d) => ({ ...d, rows: d.rows.filter((r) => r.id !== rowId) })),

      duplicateRow: (rowId) => mutate((d) => {
        const idx = d.rows.findIndex((r) => r.id === rowId);
        if (idx < 0) return d;
        const now = Date.now();
        const copy: DbRow = { id: nbId(), cells: { ...d.rows[idx].cells }, createdAt: now, updatedAt: now };
        const rows = [...d.rows.slice(0, idx + 1), copy, ...d.rows.slice(idx + 1)];
        return { ...d, rows };
      }),

      setActiveView: (viewId) => mutate((d) => ({ ...d, activeViewId: viewId })),

      addView: (type) => mutate((d) => {
        const firstSelect = d.fields.find((f) => f.type === "select" || f.type === "multiSelect");
        const view: DbView = {
          id: nbId(), name: VIEW_LABELS[type], type,
          filters: [], sorts: [], groupFieldId: type === "kanban" ? firstSelect?.id ?? null : null,
        };
        return { ...d, views: [...d.views, view], activeViewId: view.id };
      }),

      updateView: (viewId, patch) => mutate(mapView(viewId, (v) => ({ ...v, ...patch }))),

      removeView: (viewId) => mutate((d) => {
        if (d.views.length <= 1) return d;
        const views = d.views.filter((v) => v.id !== viewId);
        return { ...d, views, activeViewId: d.activeViewId === viewId ? views[0].id : d.activeViewId };
      }),

      duplicateView: (viewId) => mutate((d) => {
        const idx = d.views.findIndex((v) => v.id === viewId);
        if (idx < 0) return d;
        const src = d.views[idx];
        const copy: DbView = {
          ...src, id: nbId(), name: `${src.name} (copie)`,
          filters: src.filters.map((f) => ({ ...f })), sorts: src.sorts.map((s) => ({ ...s })),
          hiddenFieldIds: src.hiddenFieldIds ? [...src.hiddenFieldIds] : undefined,
          calcs: src.calcs ? { ...src.calcs } : undefined,
        };
        const views = [...d.views.slice(0, idx + 1), copy, ...d.views.slice(idx + 1)];
        return { ...d, views, activeViewId: copy.id };
      }),

      moveView: (viewId, dir) => mutate((d) => {
        const from = d.views.findIndex((v) => v.id === viewId);
        const to = from + dir;
        if (from < 0 || to < 0 || to >= d.views.length) return d;
        const views = [...d.views];
        const [moved] = views.splice(from, 1);
        views.splice(to, 0, moved);
        return { ...d, views };
      }),

      moveRowBefore: (rowId, targetRowId) => mutate((d) => {
        const from = d.rows.findIndex((r) => r.id === rowId);
        if (from < 0 || rowId === targetRowId) return d;
        const rows = [...d.rows];
        const [moved] = rows.splice(from, 1);
        const to = targetRowId ? rows.findIndex((r) => r.id === targetRowId) : rows.length;
        rows.splice(to < 0 ? rows.length : to, 0, moved);
        return { ...d, rows };
      }),

      reorderOption: (fieldId, optionId, dir) => mutate((d) => ({
        ...d,
        fields: d.fields.map((f) => {
          if (f.id !== fieldId || !f.options) return f;
          const from = f.options.findIndex((o) => o.id === optionId);
          const to = from + dir;
          if (from < 0 || to < 0 || to >= f.options.length) return f;
          const options = [...f.options];
          const [moved] = options.splice(from, 1);
          options.splice(to, 0, moved);
          return { ...f, options };
        }),
      })),

      setFilters: (filters) => { if (activeViewId) mutate(mapView(activeViewId, (v) => ({ ...v, filters }))); },
      setSorts: (sorts) => { if (activeViewId) mutate(mapView(activeViewId, (v) => ({ ...v, sorts }))); },
      setCalc: (fieldId, calc) => { if (activeViewId) mutate(mapView(activeViewId, (v) => ({ ...v, calcs: { ...(v.calcs || {}), [fieldId]: calc } }))); },
    };
  }, [activeViewId, mutate]);
}
