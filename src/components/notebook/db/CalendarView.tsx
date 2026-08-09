// Vue Calendrier — grille mensuelle. Les lignes se placent sur leur champ
// date ; clic sur une puce → détail de ligne ; clic sur un jour → nouvelle ligne à cette date. Sans
// champ date → invite à en créer un. Zéro dépendance date (calcul natif).
import { useMemo, useState } from "react";
import i18n from "@/i18n";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { visibleRows } from "@/lib/notebookDb";
import { firstDateField, primaryField, type Database, type DbView } from "../notebookShared";
import type { DatabaseOps } from "./useDatabaseOps";

const weekdays = () => Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(i18n.language, { weekday: "short" }).format(new Date(2024, 0, i + 1)));
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const firstWd = (y: number, m: number) => (new Date(y, m, 1).getDay() + 6) % 7;

export function CalendarView({ db, view, ops, onOpenRow }: { db: Database; view: DbView; ops: DatabaseOps; onOpenRow: (id: string) => void }) {
  const dateField = firstDateField(db.fields);
  const primary = primaryField(db);
  const [cursor, setCursor] = useState(() => new Date());
  const y = cursor.getFullYear(), m = cursor.getMonth();

  const byDay = useMemo(() => {
    const map = new Map<string, { id: string; label: string }[]>();
    if (!dateField) return map;
    for (const r of visibleRows(db.rows, db.fields, view)) {
      const d = String(r.cells[dateField.id] ?? "");
      if (!d) continue;
      const arr = map.get(d) || [];
      arr.push({ id: r.id, label: String(primary ? r.cells[primary.id] ?? "" : "") || i18n.t("notebook:panel.untitled") });
      map.set(d, arr);
    }
    return map;
  }, [db.rows, db.fields, view, dateField, primary]);

  if (!dateField) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-md border border-border p-6 text-center text-sm text-muted-foreground">
        <span>{i18n.t("notebook:dbBasics.noDateField")}</span>
        <Button size="sm" onClick={() => ops.addField("date")}>{i18n.t("notebook:dbBasics.addDateField")}</Button>
      </div>
    );
  }

  const days = new Date(y, m + 1, 0).getDate();
  const pad = firstWd(y, m);
  const today = iso(new Date());
  const cells: (number | null)[] = [...Array(pad).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <button type="button" aria-label="Previous month" onClick={() => setCursor(new Date(y, m - 1, 1))} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><ChevronLeft className="h-4 w-4" /></button>
        <span className="text-sm font-medium capitalize">{new Intl.DateTimeFormat(i18n.language, { month: "long", year: "numeric" }).format(new Date(y, m, 1))}</span>
        <button type="button" aria-label="Next month" onClick={() => setCursor(new Date(y, m + 1, 1))} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><ChevronRight className="h-4 w-4" /></button>
        <button type="button" onClick={() => setCursor(new Date())} className="ml-auto rounded px-2 py-1 text-xs text-primary hover:bg-primary/10">{i18n.t("notebook:blocksUi.today")}</button>
      </div>
      <div className="grid grid-cols-7 overflow-hidden rounded-md border border-border">
        {weekdays().map((w) => <div key={w} className="border-b border-border bg-muted/40 py-1 text-center text-[11px] font-semibold text-muted-foreground">{w}</div>)}
        {cells.map((d, i) => {
          if (d == null) return <div key={i} className="min-h-20 border-b border-r border-border bg-muted/10" />;
          const day = iso(new Date(y, m, d));
          const items = byDay.get(day) || [];
          return (
            <div key={i} className="group min-h-20 border-b border-r border-border p-1 last:border-r-0">
              <div className="flex items-center justify-between">
                <span className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-xs ${day === today ? "bg-primary font-semibold text-primary-foreground" : "text-muted-foreground"}`}>{d}</span>
                <Tooltip>
                  <TooltipTrigger render={<button type="button" onClick={() => ops.addRow({ [dateField.id]: day })} className="opacity-0 transition-opacity hover:text-primary group-hover:opacity-100"><Plus className="h-3.5 w-3.5" /></button>} />
                  <TooltipContent>{i18n.t("notebook:gallery.add")}</TooltipContent>
                </Tooltip>
              </div>
              <div className="mt-0.5 flex flex-col gap-0.5">
                {items.slice(0, 3).map((it) => (
                  <button key={it.id} type="button" onClick={() => onOpenRow(it.id)} className="truncate rounded bg-primary/15 px-1.5 py-0.5 text-left text-[11px] text-foreground hover:bg-primary/25">{it.label}</button>
                ))}
                {items.length > 3 && <span className="px-1 text-[10px] text-muted-foreground">+{items.length - 3}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
