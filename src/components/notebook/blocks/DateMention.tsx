// Inline « @date » (dateMention) — puce de date au fil du texte.
// Clic → mini-calendrier maison (MiniCalendar) qui met à jour la props `date` (ISO). Affichage FR.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createReactInlineContentSpec } from "@blocknote/react";
import { CalendarDays } from "lucide-react";
import { MiniCalendar } from "./MiniCalendar";
import { useViewportAnchor } from "@/lib/useViewportAnchor";

// ISO (YYYY-MM-DD) → libellé FR lisible ; vide → « date ».
function formatFr(iso: string): string {
  const d = iso ? new Date(iso + "T00:00:00") : null;
  if (!d || isNaN(d.getTime())) return "date";
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });
}

function DateMentionView({ date, onChange }: { date: string; onChange: (iso: string) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const popup = useRef<HTMLSpanElement>(null);
  const getRect = useCallback(() => root.current?.getBoundingClientRect() ?? null, []);
  const position = useViewportAnchor(open, getRect, { width: 280, height: 320 });
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!root.current?.contains(target) && !popup.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <span ref={root} className="nb-date-mention" contentEditable={false}>
      <button type="button" className="nb-date-mention-btn" onClick={() => setOpen((v) => !v)}>
        <CalendarDays className="nb-link-mention-ico" />
        {formatFr(date)}
      </button>
      {open && createPortal(
        <span ref={popup} className="fixed z-50 overflow-y-auto" style={{ left: position.left, top: position.top, maxHeight: position.maxHeight }}>
          <MiniCalendar value={date} onPick={(iso) => { onChange(iso); setOpen(false); }} />
        </span>,
        document.body,
      )}
    </span>
  );
}

export const dateMentionSpec = createReactInlineContentSpec(
  {
    type: "dateMention",
    propSchema: { date: { default: "" } },
    content: "none",
  },
  {
    render: ({ inlineContent, updateInlineContent }) => (
      <DateMentionView
        date={String(inlineContent.props.date)}
        onChange={(iso) => updateInlineContent({ type: "dateMention", props: { date: iso } } as never)}
      />
    ),
  },
);
