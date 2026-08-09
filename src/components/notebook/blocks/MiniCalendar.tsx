// Mini-calendrier mensuel maison — grille de jours thémée sur la palette,
// navigation mois précédent/suivant, « Aujourd'hui », effacer. Zéro dépendance date (calcul natif Date).
import { useState } from "react";
import i18n from "@/i18n";
import { ChevronLeft, ChevronRight } from "lucide-react";

const weekdayLabels = () => Array.from({ length: 7 }, (_, i) =>
  new Intl.DateTimeFormat(i18n.language, { weekday: "narrow" }).format(new Date(2024, 0, i + 1)),
);

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
// Lundi=0 … Dimanche=6 (semaine FR).
function firstWeekday(y: number, m: number): number {
  return (new Date(y, m, 1).getDay() + 6) % 7;
}

export function MiniCalendar({ value, onPick }: { value: string; onPick: (iso: string) => void }) {
  const sel = value ? new Date(value + "T00:00:00") : null;
  const [cursor, setCursor] = useState(() => (sel && !isNaN(sel.getTime()) ? new Date(sel) : new Date()));
  const y = cursor.getFullYear(), m = cursor.getMonth();
  const days = new Date(y, m + 1, 0).getDate();
  const pad = firstWeekday(y, m);
  const today = iso(new Date());
  const cells: (number | null)[] = [...Array(pad).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];

  return (
    <div className="nb-cal w-60 select-none rounded-xl border border-border bg-card p-2.5 shadow-xl">
      <div className="mb-1.5 flex items-center justify-between px-1">
        <button type="button" aria-label="Previous month" onClick={() => setCursor(new Date(y, m - 1, 1))} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><ChevronLeft className="h-4 w-4" /></button>
        <span className="text-sm font-medium capitalize">{new Intl.DateTimeFormat(i18n.language, { month: "long", year: "numeric" }).format(new Date(y, m, 1))}</span>
        <button type="button" aria-label="Next month" onClick={() => setCursor(new Date(y, m + 1, 1))} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><ChevronRight className="h-4 w-4" /></button>
      </div>
      <div className="mb-1 grid grid-cols-7 gap-0.5">
        {weekdayLabels().map((w, i) => <span key={i} className="py-1 text-center text-[10px] font-semibold text-muted-foreground">{w}</span>)}
      </div>
      <div className="grid grid-cols-7 gap-0.5">
        {cells.map((d, i) => {
          if (d == null) return <span key={i} />;
          const cur = iso(new Date(y, m, d));
          const isSel = cur === value;
          const isToday = cur === today;
          return (
            <button
              key={i}
              type="button"
              onClick={() => onPick(cur)}
              className={`flex h-7 items-center justify-center rounded-md text-xs transition-colors ${
                isSel ? "bg-primary font-semibold text-primary-foreground" : isToday ? "bg-muted font-medium text-foreground" : "text-foreground hover:bg-muted"
              }`}
            >
              {d}
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex items-center justify-between border-t border-border pt-2">
        <button type="button" onClick={() => onPick(today)} className="rounded px-2 py-1 text-xs text-primary hover:bg-primary/10">{i18n.t("notebook:blocksUi.today")}</button>
        {value && <button type="button" onClick={() => onPick("")} className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">{i18n.t("notebook:blocksUi.clear")}</button>}
      </div>
    </div>
  );
}
