// En-tête de colonne (renommer / changer le type / supprimer) et bouton « + colonne » de la database.
import { createElement } from "react";
import i18n from "@/i18n";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuCheckboxItem, DropdownMenuGroup } from "@/components/ui/dropdown-menu";
import { Plus, Trash2, ChevronDown, Type, Hash, CircleDot, Tags, CalendarDays, CheckSquare, Link2, ListChecks, Clock, History, ArrowLeftToLine, ArrowRightToLine, Copy, EyeOff, Eraser, type LucideIcon } from "lucide-react";
import { FIELD_TYPE_LABELS, NUMBER_FORMAT_LABELS, DATE_FORMAT_LABELS, type DbField, type FieldType, type NumberFormat, type DateFormat } from "../notebookShared";
import type { DatabaseOps } from "./useDatabaseOps";

const TYPES = Object.keys(FIELD_TYPE_LABELS) as FieldType[];

// Icône par type de champ (repère visuel dans l'en-tête + les menus).
export const FIELD_ICON: Record<FieldType, LucideIcon> = {
  text: Type, number: Hash, select: CircleDot, multiSelect: Tags,
  date: CalendarDays, checkbox: CheckSquare, url: Link2, checklist: ListChecks,
  createdTime: Clock, lastEditedTime: History,
};

// `primary` = champ titre (1re colonne). Son TYPE est verrouillé (toujours texte, c'est le titre de la ligne) et il ne peut être ni supprimé ni dupliqué
// ni masqué. Empêche exactement le bug « Nom devenu Case à cocher → base cassée ».
export function FieldHeader({ field, ops, primary = false }: { field: DbField; ops: DatabaseOps; primary?: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button type="button" className="flex h-full w-full items-center gap-1.5 px-1.5 text-left text-xs font-medium">
            {createElement(FIELD_ICON[field.type], { className: "h-3.5 w-3.5 shrink-0 text-muted-foreground" })}
            <span className="truncate">{field.name}</span>
            <ChevronDown className="ml-auto h-3 w-3 shrink-0 text-muted-foreground" />
          </button>
        }
      />
      <DropdownMenuContent className="w-56">
        <input
          aria-label={field.name}
          defaultValue={field.name}
          onBlur={(e) => { if (e.target.value.trim() && e.target.value !== field.name) ops.updateField(field.id, { name: e.target.value.trim() }); }}
          onKeyDown={(e) => { if (e.nativeEvent.isComposing) return; if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          className="mb-1 w-full rounded bg-muted px-2 py-1 text-sm outline-none"
        />
        {!primary && (
          <>
            <DropdownMenuGroup><DropdownMenuLabel>{i18n.t("notebook:dbFields.type")}</DropdownMenuLabel></DropdownMenuGroup>
            <DropdownMenuRadioGroup value={field.type} onValueChange={(v) => ops.updateField(field.id, { type: v as FieldType })}>
              {TYPES.map((t) => (
                <DropdownMenuRadioItem key={t} value={t}>
                  {createElement(FIELD_ICON[t], { className: "mr-1.5 h-3.5 w-3.5 text-muted-foreground" })}{FIELD_TYPE_LABELS[t]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            {field.type === "number" && (
              <>
                <DropdownMenuGroup><DropdownMenuLabel>{i18n.t("notebook:dbFields.numberFormat")}</DropdownMenuLabel></DropdownMenuGroup>
                <DropdownMenuRadioGroup value={field.numberFormat || "plain"} onValueChange={(v) => ops.updateField(field.id, { numberFormat: v as NumberFormat })}>
                  {(Object.keys(NUMBER_FORMAT_LABELS) as NumberFormat[]).map((f) => (
                    <DropdownMenuRadioItem key={f} value={f}>{NUMBER_FORMAT_LABELS[f]}</DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </>
            )}
            {field.type === "date" && (
              <>
                <DropdownMenuGroup><DropdownMenuLabel>{i18n.t("notebook:dbFields.dateFormat")}</DropdownMenuLabel></DropdownMenuGroup>
                <DropdownMenuRadioGroup value={field.dateFormat || "friendly"} onValueChange={(v) => ops.updateField(field.id, { dateFormat: v as DateFormat })}>
                  {(Object.keys(DATE_FORMAT_LABELS) as DateFormat[]).map((f) => (
                    <DropdownMenuRadioItem key={f} value={f}>{DATE_FORMAT_LABELS[f]}</DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
                <DropdownMenuCheckboxItem checked={!!field.includeTime} onCheckedChange={(c) => ops.updateField(field.id, { includeTime: !!c })}>{i18n.t("notebook:dbFields.includeTime")}</DropdownMenuCheckboxItem>
              </>
            )}
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => ops.addFieldAt(field.id, "left")}><ArrowLeftToLine className="mr-1.5 h-3.5 w-3.5" /> {i18n.t("notebook:dbFields.insertLeft")}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => ops.addFieldAt(field.id, "right")}><ArrowRightToLine className="mr-1.5 h-3.5 w-3.5" /> {i18n.t("notebook:dbFields.insertRight")}</DropdownMenuItem>
          {!primary && <DropdownMenuItem onClick={() => ops.duplicateField(field.id)}><Copy className="mr-1.5 h-3.5 w-3.5" /> {i18n.t("notebook:actions.duplicate")}</DropdownMenuItem>}
          {!primary && <DropdownMenuItem onClick={() => ops.toggleFieldHidden(field.id)}><EyeOff className="mr-1.5 h-3.5 w-3.5" /> {i18n.t("notebook:dbFields.hide")}</DropdownMenuItem>}
          <DropdownMenuItem onClick={() => ops.clearFieldData(field.id)}><Eraser className="mr-1.5 h-3.5 w-3.5" /> {i18n.t("notebook:dbFields.clearValues")}</DropdownMenuItem>
        </DropdownMenuGroup>
        {!primary && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => ops.removeField(field.id)} className="text-destructive">
              <Trash2 className="mr-1 h-3.5 w-3.5" /> {i18n.t("notebook:finalPass.deleteColumn")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AddFieldButton({ ops }: { ops: DatabaseOps }) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger render={<DropdownMenuTrigger render={<button type="button" className="flex h-full w-full items-center justify-center text-muted-foreground hover:text-foreground"><Plus className="h-4 w-4" /></button>} />} />
        <TooltipContent>{i18n.t("notebook:dbFields.addColumn")}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent>
        <DropdownMenuGroup>
          <DropdownMenuLabel>{i18n.t("notebook:dbFields.newColumn")}</DropdownMenuLabel>
          {TYPES.map((t) => (
            <DropdownMenuItem key={t} onClick={() => ops.addField(t)}>
              {createElement(FIELD_ICON[t], { className: "mr-1.5 h-3.5 w-3.5 text-muted-foreground" })}{FIELD_TYPE_LABELS[t]}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
