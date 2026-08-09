// Logique PURE de la database du Carnet : filtrage, tri, regroupement kanban. Zéro dépendance, zéro
// état — testable et réutilisable par TableView + KanbanView. Les vues partagent les mêmes lignes ;
// seules les règles (filters/sorts/group) diffèrent, appliquées ici en dérivé (jamais en mutation).
import type { DbField, DbRow, DbView, FilterCond, SortRule } from "@/components/notebook/notebookShared";
import i18n from "@/i18n";

function cellValue(row: DbRow, fieldId: string): unknown {
  return row.cells[fieldId];
}

function asText(v: unknown): string {
  if (v == null) return "";
  if (Array.isArray(v)) return v.join(" ");
  return String(v);
}

function asNumber(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function isEmptyVal(v: unknown): boolean {
  if (v == null || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

// Un seul prédicat de filtre, tolérant aux types (le champ dicte la sémantique via l'opérateur choisi).
export function matchFilter(row: DbRow, _field: DbField | undefined, cond: FilterCond): boolean {
  const v = cellValue(row, cond.fieldId);
  switch (cond.op) {
    case "isEmpty": return isEmptyVal(v);
    case "notEmpty": return !isEmptyVal(v);
    case "checked": return v === true;
    case "unchecked": return v !== true;
    case "is": {
      if (Array.isArray(v)) return v.includes(cond.value);
      return asText(v) === asText(cond.value);
    }
    case "isNot": {
      if (Array.isArray(v)) return !v.includes(cond.value);
      return asText(v) !== asText(cond.value);
    }
    case "contains": return asText(v).toLowerCase().includes(asText(cond.value).toLowerCase());
    case "notContains": return !asText(v).toLowerCase().includes(asText(cond.value).toLowerCase());
    case "gt": { const a = asNumber(v), b = asNumber(cond.value); return a != null && b != null && a > b; }
    case "gte": { const a = asNumber(v), b = asNumber(cond.value); return a != null && b != null && a >= b; }
    case "lt": { const a = asNumber(v), b = asNumber(cond.value); return a != null && b != null && a < b; }
    case "lte": { const a = asNumber(v), b = asNumber(cond.value); return a != null && b != null && a <= b; }
    default: return true;
  }
}

export function applyFilters(rows: DbRow[], fields: DbField[], filters: FilterCond[]): DbRow[] {
  if (!filters.length) return rows;
  const fieldMap = new Map(fields.map((f) => [f.id, f]));
  // AND de toutes les conditions (V1 ; groupes OR différés).
  return rows.filter((r) => filters.every((c) => matchFilter(r, fieldMap.get(c.fieldId), c)));
}

function compare(a: unknown, b: unknown, field: DbField | undefined): number {
  if (field && (field.type === "number")) {
    const na = asNumber(a), nb = asNumber(b);
    if (na == null && nb == null) return 0;
    if (na == null) return 1;
    if (nb == null) return -1;
    return na - nb;
  }
  if (field && field.type === "checkbox") {
    return (a === true ? 1 : 0) - (b === true ? 1 : 0);
  }
  return asText(a).localeCompare(asText(b), "fr", { numeric: true });
}

export function applySorts(rows: DbRow[], fields: DbField[], sorts: SortRule[]): DbRow[] {
  if (!sorts.length) return rows;
  const fieldMap = new Map(fields.map((f) => [f.id, f]));
  // Copie avant tri (ne jamais muter le tableau du store).
  return [...rows].sort((ra, rb) => {
    for (const s of sorts) {
      const field = fieldMap.get(s.fieldId);
      const c = compare(cellValue(ra, s.fieldId), cellValue(rb, s.fieldId), field);
      if (c !== 0) return s.dir === "asc" ? c : -c;
    }
    return 0;
  });
}

// Lignes visibles d'une vue = filtres puis tris (dérivé, mémoïsable côté composant).
export function visibleRows(rows: DbRow[], fields: DbField[], view: DbView): DbRow[] {
  return applySorts(applyFilters(rows, fields, view.filters), fields, view.sorts);
}

// Regroupement kanban : une colonne par option du champ select + une colonne « Sans » (valeur vide).
export interface KanbanColumn {
  key: string;        // optionId, ou "__none__"
  label: string;
  color: string | null;
  rows: DbRow[];
}

export function groupForKanban(rows: DbRow[], field: DbField | undefined): KanbanColumn[] {
  if (!field || (field.type !== "select" && field.type !== "multiSelect")) {
    return [{ key: "__all__", label: i18n.t("notebook:dbUi.group.all"), color: null, rows }];
  }
  const cols: KanbanColumn[] = (field.options || []).map((o) => ({ key: o.id, label: o.label, color: o.color, rows: [] }));
  const none: KanbanColumn = { key: "__none__", label: i18n.t("notebook:dbUi.group.none"), color: null, rows: [] };
  const byKey = new Map(cols.map((c) => [c.key, c]));
  for (const r of rows) {
    const v = r.cells[field.id];
    const ids = Array.isArray(v) ? v : v != null && v !== "" ? [v] : [];
    if (!ids.length) { none.rows.push(r); continue; }
    // Pour multiSelect, la carte apparaît dans la 1re colonne connue (V1).
    const target = ids.map((id) => byKey.get(String(id))).find(Boolean);
    (target || none).rows.push(r);
  }
  return [...cols, none];
}

// Calcul d'agrégat de colonne (pied de table). count/empty/filled = comptages ;
// sum/avg/min/max = numériques (valeurs non parsables ignorées). Renvoie une chaîne prête à afficher.
import type { CalcType } from "@/components/notebook/notebookShared";

function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, "");
}

export function computeCalc(rows: DbRow[], field: DbField, type: CalcType | undefined): string {
  if (!type || type === "none") return "";
  const vals = rows.map((r) => r.cells[field.id]);
  if (type === "count") return String(rows.length);
  if (type === "empty") return String(vals.filter(isEmptyVal).length);
  if (type === "filled") return String(vals.filter((v) => !isEmptyVal(v)).length);
  const nums = vals.map(asNumber).filter((n): n is number => n != null);
  if (!nums.length) return "—";
  const sum = nums.reduce((a, b) => a + b, 0);
  switch (type) {
    case "sum": return fmtNum(sum);
    case "avg": return fmtNum(sum / nums.length);
    case "median": {
      const s = [...nums].sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      return fmtNum(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
    }
    case "min": return fmtNum(Math.min(...nums));
    case "max": return fmtNum(Math.max(...nums));
    default: return "";
  }
}
