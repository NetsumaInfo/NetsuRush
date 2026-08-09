// Affichage + édition des cellules de la database, par type de champ. Partagé entre TableView (grille)
// et KanbanView (cartes). Les sélecteurs d'option utilisent le DropdownMenu shadcn (Base UI) ; date =
// input natif ; case = checkbox natif stylé. Aucune anim JS (respecte l'interdit perf des grilles).
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Plus, X, Pencil, Check, Trash2 } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { colorOf, formatNumber, formatDate, formatTimestamp, DB_COLORS, type ChecklistItem, type DbField, type SelectOption } from "../notebookShared";
import { MiniCalendar } from "../blocks/MiniCalendar";

// ---- Case à cocher harmonisée (remplace le <input type="checkbox"> natif partout dans la db) ------
// Bouton stylé sur les tokens : coché = aplat primary + ✓ ; décoché = contour discret. Pas de natif.
export function NbCheck({ checked, onChange, title }: { checked: boolean; onChange: (v: boolean) => void; title?: string }) {
  const btn = (
    <button
      type="button"
      role="checkbox"
      aria-label={title || "Checkbox"}
      aria-checked={checked}
      onClick={(e) => { e.stopPropagation(); onChange(!checked); }}
      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors ${
        checked ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40 bg-transparent hover:border-primary/70"
      }`}
    >
      {checked && <Check className="h-3 w-3" strokeWidth={3} />}
    </button>
  );
  if (!title) return btn;
  return (
    <Tooltip>
      <TooltipTrigger render={btn} />
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  );
}

// ---- Étiquette d'option (select / multiSelect) -----------------------------------------------
export function OptionBadge({ option }: { option: SelectOption }) {
  const { bg, fg } = colorOf(option.color);
  return (
    <span className="inline-block max-w-full truncate rounded px-1.5 py-0.5 text-xs" style={{ backgroundColor: bg, color: fg }}>
      {option.label}
    </span>
  );
}

// Éditeur d'une option : renommer + palette de couleur + supprimer.
function OptionEditRow({ option, onUpdate, onRemove, onDone }: {
  option: SelectOption;
  onUpdate: (patch: { label?: string; color?: string }) => void;
  onRemove: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation("notebook");
  const [label, setLabel] = useState(option.label);
  const commit = () => { if (label.trim() && label !== option.label) onUpdate({ label: label.trim() }); };
  return (
    <div className="rounded-md bg-muted/60 p-1.5">
      <input
        aria-label={option.label}
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.nativeEvent.isComposing) return; if (e.key === "Enter") { e.preventDefault(); commit(); onDone(); } }}
        className="mb-1.5 w-full rounded border border-border bg-background px-2 py-1 text-xs outline-none"
      />
      <div className="mb-1.5 flex flex-wrap gap-1">
        {DB_COLORS.map((c) => (
          <Tooltip key={c.key}>
            <TooltipTrigger
              render={
                <button type="button" onClick={() => onUpdate({ color: c.key })} style={{ background: c.bg }}
                  className={`h-5 w-5 rounded-full ${option.color === c.key ? "ring-2 ring-primary ring-offset-1 ring-offset-card" : ""}`} />
              }
            />
            <TooltipContent>{c.label}</TooltipContent>
          </Tooltip>
        ))}
      </div>
      <div className="flex items-center justify-between">
        <button type="button" onClick={onRemove} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-destructive"><Trash2 className="h-3 w-3" /> {t("common:action.delete")}</button>
        <button type="button" onClick={() => { commit(); onDone(); }} className="rounded px-2 py-0.5 text-xs text-primary hover:bg-primary/10">{t("common:status.ok")}</button>
      </div>
    </div>
  );
}

// ---- Sélecteur d'option (mono ou multi) — recherche/création + édition riche (couleur/renommer/suppr) ---
export function OptionPicker({
  field, value, multi, onChange, onCreateOption, onUpdateOption, onRemoveOption, trigger,
}: {
  field: DbField;
  value: unknown;
  multi: boolean;
  onChange: (value: unknown) => void;
  onCreateOption: (label: string) => string;
  onUpdateOption?: (optionId: string, patch: { label?: string; color?: string }) => void;
  onRemoveOption?: (optionId: string) => void;
  trigger: React.ReactNode;
}) {
  const { t } = useTranslation("notebook");
  const [q, setQ] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const options = field.options || [];
  const selected = multi ? (Array.isArray(value) ? value.map(String) : []) : value != null && value !== "" ? [String(value)] : [];
  const toggle = (id: string) => {
    if (multi) {
      const set = new Set(selected);
      if (set.has(id)) set.delete(id); else set.add(id);
      onChange([...set]);
    } else {
      onChange(selected[0] === id ? "" : id);
    }
  };
  const filtered = options.filter((o) => o.label.toLowerCase().includes(q.toLowerCase()));
  const canCreate = q.trim() && !options.some((o) => o.label.toLowerCase() === q.trim().toLowerCase());
  const canEdit = !!(onUpdateOption && onRemoveOption);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={trigger as React.ReactElement} />
      <DropdownMenuContent className="w-64">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("db.option.searchOrCreate")}
          className="mb-1 w-full rounded bg-muted px-2 py-1 text-xs outline-none"
        />
        {filtered.map((o) => (
          editingId === o.id && canEdit ? (
            <OptionEditRow
              key={o.id}
              option={o}
              onUpdate={(patch) => onUpdateOption!(o.id, patch)}
              onRemove={() => { onRemoveOption!(o.id); setEditingId(null); }}
              onDone={() => setEditingId(null)}
            />
          ) : (
            <div key={o.id} className="group flex items-center gap-1 rounded px-1 py-0.5 hover:bg-muted">
              <button type="button" aria-label={o.label} onClick={() => toggle(o.id)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                <span className="flex w-4 shrink-0 justify-center">{selected.includes(o.id) && <Check className="h-3.5 w-3.5 text-primary" />}</span>
                <OptionBadge option={o} />
              </button>
              {canEdit && (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button type="button" aria-label="Edit option" onClick={() => setEditingId(o.id)} className="shrink-0 rounded p-1 text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100">
                        <Pencil className="h-3 w-3" />
                      </button>
                    }
                  />
                  <TooltipContent>{t("common:action.edit")}</TooltipContent>
                </Tooltip>
              )}
            </div>
          )
        ))}
        {canCreate && (
          <>
            {filtered.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem onClick={() => { const id = onCreateOption(q.trim()); setQ(""); toggle(id); }}>
              <Plus className="mr-1 h-3.5 w-3.5" /> {t("db.option.create", { label: q.trim() })}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---- Liste de tâches (checklist) : éditeur en dropdown (cases + libellé + ajout/suppression) -----
function asChecklist(value: unknown): ChecklistItem[] {
  return Array.isArray(value) ? (value as ChecklistItem[]).filter((x) => x && typeof x === "object") : [];
}

export function ChecklistPicker({ value, onChange, trigger }: {
  value: unknown;
  onChange: (value: ChecklistItem[]) => void;
  trigger: React.ReactNode;
}) {
  const { t } = useTranslation("notebook");
  const [q, setQ] = useState("");
  const items = asChecklist(value);
  const set = (next: ChecklistItem[]) => onChange(next);
  const add = () => {
    if (!q.trim()) return;
    set([...items, { id: Math.random().toString(36).slice(2, 9), label: q.trim(), done: false }]);
    setQ("");
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={trigger as React.ReactElement} />
      <DropdownMenuContent className="w-64">
        {items.map((it) => (
          <div key={it.id} className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-muted">
            <NbCheck checked={it.done} onChange={() => set(items.map((x) => (x.id === it.id ? { ...x, done: !x.done } : x)))} />
            <input
              aria-label={it.label || t("db.checklist.addTask")}
              value={it.label}
              onChange={(e) => set(items.map((x) => (x.id === it.id ? { ...x, label: e.target.value } : x)))}
              className={`min-w-0 flex-1 bg-transparent text-sm outline-none ${it.done ? "text-muted-foreground line-through" : ""}`}
            />
            <button type="button" aria-label="Remove task" onClick={() => set(items.filter((x) => x.id !== it.id))} className="text-muted-foreground hover:text-destructive"><X className="h-3.5 w-3.5" /></button>
          </div>
        ))}
        <div className="mt-1 flex items-center gap-1 border-t border-border px-1 pt-1.5">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.nativeEvent.isComposing) return; if (e.key === "Enter") { e.preventDefault(); add(); } }}
            placeholder={t("db.checklist.addTask")}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <button type="button" aria-label="Add task" onClick={add} className="text-muted-foreground hover:text-foreground"><Plus className="h-3.5 w-3.5" /></button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---- Cellule Date : édition via MiniCalendar (PAS l'edit-mode rdg — le calendrier natif ouvrait un
// popup hors cellule qui refermait l'éditeur avant la sélection → la date ne se sauvait jamais). -------
export function DatePickerCell({ field, value, onChange }: { field: DbField; value: unknown; onChange: (v: unknown) => void }) {
  const { t } = useTranslation("notebook");
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger render={
        <button type="button" className="flex h-full w-full items-center px-1.5 text-left text-sm">
          {formatDate(value, field.dateFormat, field.includeTime) || <span className="text-muted-foreground/50">{t("db.field.empty")}</span>}
        </button>
      } />
      <DropdownMenuContent className="w-auto border-0 bg-transparent p-0 shadow-none ring-0">
        {field.includeTime ? (
          <input
            type="datetime-local"
            aria-label={field.name}
            value={/^\d{4}-\d{2}-\d{2}/.test(String(value ?? "")) ? String(value) : ""}
            onChange={(e) => onChange(e.target.value)}
            className="m-2 rounded border border-border bg-muted px-2 py-1 text-sm outline-none"
          />
        ) : (
          <MiniCalendar value={/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? "")) ? String(value) : ""} onPick={(iso) => { onChange(iso); setOpen(false); }} />
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---- Affichage lecture d'une cellule (renderCell) --------------------------------------------
export function CellDisplay({ field, value }: { field: DbField; value: unknown }) {
  switch (field.type) {
    case "checkbox":
      return <span className="text-sm">{value === true ? "☑" : "☐"}</span>;
    case "url": {
      const s = String(value ?? "");
      if (!s) return null;
      return (
        <a href={s} target="_blank" rel="noreferrer" className="truncate text-primary underline" onClick={(e) => e.stopPropagation()}>
          {s}
        </a>
      );
    }
    case "select": {
      const o = (field.options || []).find((x) => x.id === value);
      return o ? <OptionBadge option={o} /> : null;
    }
    case "multiSelect": {
      const ids = Array.isArray(value) ? value.map(String) : [];
      const opts = (field.options || []).filter((x) => ids.includes(x.id));
      return <span className="flex flex-wrap gap-1">{opts.map((o) => <OptionBadge key={o.id} option={o} />)}</span>;
    }
    case "checklist": {
      const items = asChecklist(value);
      const done = items.filter((i) => i.done).length;
      const pct = items.length ? (done / items.length) * 100 : 0;
      return (
        <span className="flex w-full items-center gap-1.5">
          <span className="h-1.5 min-w-8 flex-1 overflow-hidden rounded-full bg-muted">
            <span className="block h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
          </span>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{done}/{items.length}</span>
        </span>
      );
    }
    case "date": {
      // Une valeur orpheline (ex. optionId après changement de type) ne s'affiche pas → seulement une
      // vraie date, au format choisi du champ (Friendly/ISO/US/DMY + heure optionnelle).
      const out = formatDate(value, field.dateFormat, field.includeTime);
      return out ? <span className="text-sm">{out}</span> : null;
    }
    case "createdTime":
    case "lastEditedTime": {
      const out = formatTimestamp(value);
      return out ? <span className="text-sm text-muted-foreground">{out}</span> : null;
    }
    case "number": {
      const out = formatNumber(value, field.numberFormat);
      return out ? <span className="text-sm tabular-nums">{out}</span> : null;
    }
    default:
      return <span className="truncate text-sm">{String(value ?? "")}</span>;
  }
}

// ---- Éditeur inline « texte/nombre/lien » pour rdg renderEditCell ----------------------------
export function InputEditCell({
  value, type, onCommit, onClose,
}: {
  value: unknown;
  type: "text" | "number" | "url" | "date";
  onCommit: (v: unknown) => void;
  onClose: () => void;
}) {
  // Nettoie une valeur incohérente au départ (ex. optionId orphelin dans un champ date/nombre après
  // changement de type) → l'éditeur ne réécrit pas le charabia.
  const initial = (() => {
    const s = value == null ? "" : String(value);
    if (type === "date") return /^\d{4}-\d{2}-\d{2}/.test(s) ? s : "";
    if (type === "number") return s !== "" && !isNaN(Number(s)) ? s : "";
    return s;
  })();
  const [v, setV] = useState(initial);
  const commit = () => { onCommit(type === "number" ? (v === "" ? "" : Number(v)) : v); onClose(); };
  return (
    <input
      aria-label={type}
      type={type === "number" ? "number" : type === "date" ? "date" : "text"}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        else if (e.key === "Escape") onClose();
      }}
      className="h-full w-full bg-transparent px-2 text-sm outline-none"
    />
  );
}

export function newOption(label: string, colorIdx: number): SelectOption {
  const palette = ["gray", "blue", "green", "yellow", "orange", "red", "purple", "pink"];
  return { id: Math.random().toString(36).slice(2, 9), label, color: palette[colorIdx % palette.length] };
}
