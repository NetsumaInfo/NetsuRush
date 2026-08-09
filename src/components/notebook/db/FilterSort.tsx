// Menus Filtres et Tris de la vue active (dropdowns shadcn). Les règles vivent dans la vue (partagées
// par table/kanban) ; l'application est faite en dérivé par lib/notebookDb (pur). V1 : conditions en AND.
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuGroup } from "@/components/ui/dropdown-menu";
import { Filter, ArrowUpDown, Plus, X } from "lucide-react";
import i18n from "@/i18n";
import { nbId, type DbField, type DbView, type FilterCond, type FilterOp, type SortRule } from "../notebookShared";

const opLabel = (op: FilterOp) => i18n.t(`notebook:filterSort.op.${op}`);

function opsForField(f: DbField): FilterOp[] {
  switch (f.type) {
    case "number": return ["is", "isNot", "gt", "gte", "lt", "lte", "isEmpty", "notEmpty"];
    case "select": case "multiSelect": return ["is", "isNot", "isEmpty", "notEmpty"];
    case "date": return ["is", "isEmpty", "notEmpty"];
    case "checkbox": return ["checked", "unchecked"];
    default: return ["contains", "notContains", "is", "isNot", "isEmpty", "notEmpty"];
  }
}
const needsValue = (op: FilterOp) => !["isEmpty", "notEmpty", "checked", "unchecked"].includes(op);

export function FilterMenu({ fields, view, onChange }: { fields: DbField[]; view: DbView; onChange: (f: FilterCond[]) => void }) {
  const set = (id: string, patch: Partial<FilterCond>) => onChange(view.filters.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const add = (fieldId: string) => onChange([...view.filters, { id: nbId(), fieldId, op: opsForField(fields.find((f) => f.id === fieldId)!)[0], value: "" }]);
  const remove = (id: string) => onChange(view.filters.filter((c) => c.id !== id));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button type="button" className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
            <Filter className="h-3.5 w-3.5" /> {i18n.t("notebook:filterSort.filters")}{view.filters.length ? ` (${view.filters.length})` : ""}
          </button>
        }
      />
      <DropdownMenuContent className="w-80">
        <DropdownMenuGroup><DropdownMenuLabel>{i18n.t("notebook:filterSort.filters")}</DropdownMenuLabel></DropdownMenuGroup>
        {view.filters.map((c) => {
          const field = fields.find((f) => f.id === c.fieldId);
          if (!field) return null;
          return (
            <div key={c.id} className="flex items-center gap-1 px-1 py-1">
              <select aria-label="Filter field" value={c.fieldId} onChange={(e) => set(c.id, { fieldId: e.target.value, op: opsForField(fields.find((f) => f.id === e.target.value)!)[0] })} className="nb-sel min-w-0 flex-1 text-xs">
                {fields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
              <select aria-label="Filter operator" value={c.op} onChange={(e) => set(c.id, { op: e.target.value as FilterOp })} className="nb-sel text-xs">
                {opsForField(field).map((op) => <option key={op} value={op}>{opLabel(op)}</option>)}
              </select>
              {needsValue(c.op) && (
                field.type === "select" ? (
                  <select aria-label="Filter value" value={String(c.value ?? "")} onChange={(e) => set(c.id, { value: e.target.value })} className="nb-sel min-w-0 flex-1 text-xs">
                    <option value="">—</option>
                    {(field.options || []).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </select>
                ) : (
                  <input aria-label="Filter value" value={String(c.value ?? "")} onChange={(e) => set(c.id, { value: e.target.value })} className="w-20 min-w-0 flex-1 rounded border border-border bg-[var(--color-surface-2)] px-1.5 py-0.5 text-xs outline-none focus:border-primary" />
                )
              )}
              <button type="button" aria-label="Remove filter" onClick={() => remove(c.id)} className="text-muted-foreground hover:text-destructive"><X className="h-3.5 w-3.5" /></button>
            </div>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>{i18n.t("notebook:filterSort.add")}</DropdownMenuLabel>
          {fields.map((f) => <DropdownMenuItem key={f.id} onClick={() => add(f.id)}><Plus className="mr-1 h-3.5 w-3.5" />{f.name}</DropdownMenuItem>)}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function SortMenu({ fields, view, onChange }: { fields: DbField[]; view: DbView; onChange: (s: SortRule[]) => void }) {
  const toggle = (fieldId: string) => {
    const cur = view.sorts.find((s) => s.fieldId === fieldId);
    if (!cur) onChange([...view.sorts, { fieldId, dir: "asc" }]);
    else if (cur.dir === "asc") onChange(view.sorts.map((s) => (s.fieldId === fieldId ? { ...s, dir: "desc" } : s)));
    else onChange(view.sorts.filter((s) => s.fieldId !== fieldId));
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button type="button" className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
            <ArrowUpDown className="h-3.5 w-3.5" /> {i18n.t("notebook:filterSort.sort")}{view.sorts.length ? ` (${view.sorts.length})` : ""}
          </button>
        }
      />
      <DropdownMenuContent className="w-56">
        <DropdownMenuGroup>
        <DropdownMenuLabel>{i18n.t("notebook:filterSort.sortBy")}</DropdownMenuLabel>
        {fields.map((f) => {
          const cur = view.sorts.find((s) => s.fieldId === f.id);
          return (
            <DropdownMenuItem key={f.id} onClick={(e) => { e.preventDefault(); toggle(f.id); }}>
              <span className="flex-1">{f.name}</span>
              <span className="text-xs text-muted-foreground">{cur ? (cur.dir === "asc" ? "↑" : "↓") : ""}</span>
            </DropdownMenuItem>
          );
        })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
