// Éditeur d'une cellule EN COLONNE (panneau détail de ligne) — rend le bon
// contrôle selon le type de champ, pleine largeur. Réutilise les sélecteurs de cellControls (option,
// checklist) + inputs natifs pour texte/nombre/lien/date. Aucune anim JS.
import { useTranslation } from "react-i18next";
import { CellDisplay, OptionPicker, ChecklistPicker, NbCheck } from "./cellControls";
import { formatTimestamp, type ChecklistItem, type DbField } from "../notebookShared";
import type { DatabaseOps } from "./useDatabaseOps";

const inputCls = "w-full rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-sm outline-none focus:border-primary";

export function FieldEditor({ field, value, onChange, ops }: {
  field: DbField;
  value: unknown;
  onChange: (v: unknown) => void;
  ops: DatabaseOps;
}) {
  const { t } = useTranslation("notebook");
  switch (field.type) {
    case "createdTime":
    case "lastEditedTime":
      return <div className="px-1 py-1.5 text-sm text-muted-foreground">{formatTimestamp(value) || "—"}</div>;
    case "checkbox":
      return (
        <button type="button" onClick={() => onChange(value !== true)} className="flex items-center gap-2 py-1 text-sm text-muted-foreground">
          <NbCheck checked={value === true} onChange={(v) => onChange(v)} />
          {value === true ? t("db.field.checked") : t("db.field.unchecked")}
        </button>
      );
    case "number":
      return <input aria-label={field.name} type="number" value={value == null ? "" : String(value)} onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))} placeholder="0" className={inputCls} />;
    case "date":
      return <input aria-label={field.name} type={field.includeTime ? "datetime-local" : "date"} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} className={inputCls} />;
    case "url":
      return <input aria-label={field.name} type="url" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} placeholder="https://…" className={inputCls} />;
    case "select":
    case "multiSelect":
      return (
        <OptionPicker
          field={field}
          value={value}
          multi={field.type === "multiSelect"}
          onChange={onChange}
          onCreateOption={(l) => ops.addOption(field.id, l)}
          onUpdateOption={(oid, patch) => ops.updateOption(field.id, oid, patch)}
          onRemoveOption={(oid) => ops.removeOption(field.id, oid)}
          trigger={
            <button type="button" className={`${inputCls} flex min-h-9 flex-wrap items-center gap-1 text-left`}>
              {value != null && value !== "" && (!Array.isArray(value) || value.length) ? <CellDisplay field={field} value={value} /> : <span className="text-muted-foreground">{t("db.field.empty")}</span>}
            </button>
          }
        />
      );
    case "checklist":
      return (
        <ChecklistPicker
          value={value}
          onChange={(v: ChecklistItem[]) => onChange(v)}
          trigger={<button type="button" className={`${inputCls} flex min-h-9 items-center text-left`}><CellDisplay field={field} value={value} /></button>}
        />
      );
    default:
      return <input aria-label={field.name} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} placeholder={t("db.field.empty")} className={inputCls} />;
  }
}
