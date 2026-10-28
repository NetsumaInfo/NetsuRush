// En-tête de colonne (renommer / changer le type / supprimer) et bouton « + colonne » de la database.
import { Button } from "@/components/ui/button";
import { createElement } from "react";
import i18n from "@/i18n";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuCheckboxItem, DropdownMenuGroup } from "@/components/ui/dropdown-menu";
import { NetsuIcon } from "@/components/ui/netsu-icon";
import { netsuIconOf, type IconComponent } from "@/components/NetsuIconOf";
import { FIELD_TYPE_LABELS, NUMBER_FORMAT_LABELS, DATE_FORMAT_LABELS, type DbField, type FieldType, type NumberFormat, type DateFormat } from "../notebookShared";
import type { DatabaseOps } from "./useDatabaseOps";

const TYPES = Object.keys(FIELD_TYPE_LABELS) as FieldType[];

// Icône par type de champ (repère visuel dans l'en-tête + les menus).
export const FIELD_ICON: Record<FieldType, IconComponent> = {
  text: netsuIconOf("type"), number: netsuIconOf("hash"), select: netsuIconOf("circle-dot"), multiSelect: netsuIconOf("tags"),
  date: netsuIconOf("calendar"), checkbox: netsuIconOf("checkbox-on"), url: netsuIconOf("link"), checklist: netsuIconOf("task-list"),
  createdTime: netsuIconOf("clock"), lastEditedTime: netsuIconOf("history"),
};

// `primary` = champ titre (1re colonne). Son TYPE est verrouillé (toujours texte, c'est le titre de la ligne) et il ne peut être ni supprimé ni dupliqué
// ni masqué. Empêche exactement le bug « Nom devenu Case à cocher → base cassée ».
export function FieldHeader({ field, ops, primary = false }: { field: DbField; ops: DatabaseOps; primary?: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" type="button" className="h-auto gap-0 rounded-none px-0 py-0 text-[length:inherit] font-normal whitespace-normal hover:bg-transparent dark:hover:bg-transparent flex h-full w-full items-center gap-1.5 px-1.5 text-left text-xs font-medium">
            {createElement(FIELD_ICON[field.type], { className: "size-3.5 shrink-0 text-muted-foreground" })}
            <span className="truncate">{field.name}</span>
            <NetsuIcon name="chevron-down" className="ml-auto size-3 shrink-0 text-muted-foreground" />
          </Button>
        }
      />
      <DropdownMenuContent className="w-56">
        <input autoComplete="off"
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
                  {createElement(FIELD_ICON[t], { className: "mr-1.5 size-3.5 text-muted-foreground" })}{FIELD_TYPE_LABELS[t]}
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
          <DropdownMenuItem onClick={() => ops.addFieldAt(field.id, "left")}><NetsuIcon name="in-point" className="mr-1.5 size-3.5" /> {i18n.t("notebook:dbFields.insertLeft")}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => ops.addFieldAt(field.id, "right")}><NetsuIcon name="out-point" className="mr-1.5 size-3.5" /> {i18n.t("notebook:dbFields.insertRight")}</DropdownMenuItem>
          {!primary && <DropdownMenuItem onClick={() => ops.duplicateField(field.id)}><NetsuIcon name="copy" className="mr-1.5 size-3.5" /> {i18n.t("notebook:actions.duplicate")}</DropdownMenuItem>}
          {!primary && <DropdownMenuItem onClick={() => ops.toggleFieldHidden(field.id)}><NetsuIcon name="eye-off" className="mr-1.5 size-3.5" /> {i18n.t("notebook:dbFields.hide")}</DropdownMenuItem>}
          <DropdownMenuItem onClick={() => ops.clearFieldData(field.id)}><NetsuIcon name="erase" className="mr-1.5 size-3.5" /> {i18n.t("notebook:dbFields.clearValues")}</DropdownMenuItem>
        </DropdownMenuGroup>
        {!primary && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => ops.removeField(field.id)} className="text-destructive">
              <NetsuIcon name="trash" className="mr-1 size-3.5" /> {i18n.t("notebook:finalPass.deleteColumn")}
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
        <TooltipTrigger render={<DropdownMenuTrigger render={<Button variant="ghost" type="button" className="h-auto gap-0 rounded-none px-0 py-0 text-[length:inherit] font-normal whitespace-normal hover:bg-transparent dark:hover:bg-transparent flex h-full w-full items-center justify-center text-muted-foreground hover:text-foreground"><NetsuIcon name="add" className="size-4" /></Button>} />} />
        <TooltipContent>{i18n.t("notebook:dbFields.addColumn")}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent>
        <DropdownMenuGroup>
          <DropdownMenuLabel>{i18n.t("notebook:dbFields.newColumn")}</DropdownMenuLabel>
          {TYPES.map((t) => (
            <DropdownMenuItem key={t} onClick={() => ops.addField(t)}>
              {createElement(FIELD_ICON[t], { className: "mr-1.5 size-3.5 text-muted-foreground" })}{FIELD_TYPE_LABELS[t]}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
