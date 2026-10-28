// Menus Filtres (popover) et Tris (dropdown shadcn) de la vue active. Les règles vivent dans la vue (partagées
// par table/kanban) ; l'application est faite en dérivé par lib/notebookDb (pur). V1 : conditions en AND.
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuGroup } from "@/components/ui/dropdown-menu";
import { NetsuIcon } from "@/components/ui/netsu-icon";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
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
  // A popover, not a menu: the rows hold selects and a text field, which a menu would hijack (typeahead).
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button type="button" className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
            <NetsuIcon name="filter" className="h-3.5 w-3.5" /> {i18n.t("notebook:filterSort.filters")}{view.filters.length ? ` (${view.filters.length})` : ""}
          </button>
        }
      />
      <PopoverContent align="start" className="w-80 p-1">
        <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">{i18n.t("notebook:filterSort.filters")}</div>
        {view.filters.map((c) => {
          const field = fields.find((f) => f.id === c.fieldId);
          if (!field) return null;
          const valueOption = (field.options || []).find((o) => o.id === c.value);
          return (
            <div key={c.id} className="flex items-center gap-1 px-1 py-1">
              <Select value={c.fieldId} onValueChange={(v) => { const id = String(v); set(c.id, { fieldId: id, op: opsForField(fields.find((f) => f.id === id)!)[0] }); }}>
                <SelectTrigger size="sm" aria-label={i18n.t("notebook:a11y.filterField")} className="min-w-0 flex-1"><SelectValue>{field.name}</SelectValue></SelectTrigger>
                <SelectContent>{fields.map((f) => <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>)}</SelectContent>
              </Select>
              <Select value={c.op} onValueChange={(v) => set(c.id, { op: String(v) as FilterOp })}>
                <SelectTrigger size="sm" aria-label={i18n.t("notebook:a11y.filterOperator")} className="w-auto shrink-0"><SelectValue>{opLabel(c.op)}</SelectValue></SelectTrigger>
                <SelectContent>{opsForField(field).map((op) => <SelectItem key={op} value={op}>{opLabel(op)}</SelectItem>)}</SelectContent>
              </Select>
              {needsValue(c.op) && (
                field.type === "select" ? (
                  <Select value={String(c.value ?? "")} onValueChange={(v) => set(c.id, { value: String(v) })}>
                    <SelectTrigger size="sm" aria-label={i18n.t("notebook:a11y.filterValue")} className="min-w-0 flex-1"><SelectValue>{valueOption?.label ?? "—"}</SelectValue></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">—</SelectItem>
                      {(field.options || []).map((o) => <SelectItem key={o.id} value={o.id}>{o.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                ) : (
                  <input autoComplete="off" aria-label={i18n.t("notebook:a11y.filterValue")} value={String(c.value ?? "")} onChange={(e) => set(c.id, { value: e.target.value })} className="w-20 min-w-0 flex-1 rounded border border-border bg-[var(--color-surface-2)] px-1.5 py-0.5 text-xs outline-none focus:border-primary" />
                )
              )}
              <button type="button" aria-label={i18n.t("notebook:a11y.removeFilter")} onClick={() => remove(c.id)} className="text-muted-foreground hover:text-destructive"><NetsuIcon name="close" className="h-3.5 w-3.5" /></button>
            </div>
          );
        })}
        <div className="my-1 h-px bg-border" />
        <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">{i18n.t("notebook:filterSort.add")}</div>
        {fields.map((f) => (
          <button key={f.id} type="button" onClick={() => add(f.id)} className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground">
            <NetsuIcon name="add" className="h-3.5 w-3.5" />{f.name}
          </button>
        ))}
      </PopoverContent>
    </Popover>
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
            <NetsuIcon name="sort" className="h-3.5 w-3.5" /> {i18n.t("notebook:filterSort.sort")}{view.sorts.length ? ` (${view.sorts.length})` : ""}
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
