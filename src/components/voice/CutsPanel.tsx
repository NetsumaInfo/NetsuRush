// Panneau CUTS (droite) — bascule entre Silences / Hésitations / Répétitions. Minimaliste :
// chaque ligne = un intervalle ou un span, cliquable (seek) + un bouton pour l'inclure/exclure du
// montage. Silences = intervalles GARDÉS (× exclut) ; Hésitations/Répétitions = spans COUPÉS (× garde).
import { memo, useMemo } from "react";
import { usePersistedChoice } from "@/lib/persistedChoice";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/shallow";
import { X, RotateCcw, Scissors, Play } from "lucide-react";
import { useApp } from "@/store";
import { cn } from "@/lib/utils";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { fmtTime } from "./voiceShared";
import { repetitionSpans, combineFillerSpans } from "./voiceFillers";

type Mode = "silences" | "fillers" | "repeats";
// Couleur d'accent par type (alignée sur la waveform) → repérage visuel facile.
const ACCENT: Record<Mode, string> = { silences: "bg-primary", fillers: "bg-amber-400", repeats: "bg-sky-400" };

export const CutsPanel = memo(function CutsPanel({ playhead, onSeek }: { playhead: number; onSeek: (t: number) => void }) {
  const { t } = useTranslation("voice");
  const {
    speech, silence, offIntervals, toggleInterval, voiceFillerSpans, offFillers, toggleFillerSpan, words, offRepeats, toggleRepeatSpan, hesitationParams,
  } = useApp(useShallow((s) => ({
    speech: s.speech, silence: s.silence, offIntervals: s.offIntervals, toggleInterval: s.toggleInterval,
    voiceFillerSpans: s.voiceFillerSpans, offFillers: s.offFillers, toggleFillerSpan: s.toggleFillerSpan,
    words: s.words, offRepeats: s.offRepeats, toggleRepeatSpan: s.toggleRepeatSpan, hesitationParams: s.hesitationParams,
  })));
  const repeats = useMemo(() => repetitionSpans(words), [words]);
  const fillers = useMemo(() => combineFillerSpans(voiceFillerSpans, words, hesitationParams, silence), [voiceFillerSpans, words, hesitationParams, silence]);
  const [mode, setMode] = usePersistedChoice<Mode>("nr.voice.cutsview", ["silences", "fillers", "repeats"], "silences");

  const counts = { silences: speech.length, fillers: fillers.length, repeats: repeats.length };

  return (
    <div className="flex h-full min-h-0 flex-col rounded-xl border border-border bg-card">
      <div className="border-b border-border p-2">
        <ToggleGroup className="w-full" value={[mode]} onValueChange={(v) => v[0] && setMode(v[0] as Mode)}>
          <ToggleGroupItem className="flex-1 text-[11px]" value="silences">{t("cuts.tabSilences")}{counts.silences ? ` ${counts.silences}` : ""}</ToggleGroupItem>
          <ToggleGroupItem className="flex-1 text-[11px]" value="fillers">{t("cuts.tabFillers")}{counts.fillers ? ` ${counts.fillers}` : ""}</ToggleGroupItem>
          <ToggleGroupItem className="flex-1 text-[11px]" value="repeats">{t("cuts.tabRepeats")}{counts.repeats ? ` ${counts.repeats}` : ""}</ToggleGroupItem>
        </ToggleGroup>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {mode === "silences" && (
          speech.length === 0
            ? <Empty>{t("cuts.emptySilences")}</Empty>
            : speech.map((s, i) => (
              <Row key={i} idx={i} accent={ACCENT.silences} start={s.start} end={s.end} active={playhead >= s.start && playhead < s.end}
                excluded={offIntervals.has(i)} onSeek={() => onSeek(s.start)} onToggle={() => toggleInterval(i)} kind="keep" />
            ))
        )}
        {mode === "fillers" && (
          fillers.length === 0
            ? <Empty>{t("cuts.emptyFillers")}</Empty>
            : fillers.map((f, i) => (
              <Row key={i} idx={i} accent={ACCENT.fillers} start={f.start} end={f.end} conf={f.conf} active={playhead >= f.start && playhead < f.end}
                excluded={offFillers.has(i)} onSeek={() => onSeek(f.start)} onToggle={() => toggleFillerSpan(i)} kind="cut" />
            ))
        )}
        {mode === "repeats" && (
          repeats.length === 0
            ? <Empty>{t("cuts.emptyRepeats")}</Empty>
            : repeats.map((r, i) => (
              <Row key={i} idx={i} accent={ACCENT.repeats} start={r.start} end={r.end} text={r.text} active={playhead >= r.start && playhead < r.end}
                excluded={offRepeats.has(i)} onSeek={() => onSeek(r.start)} onToggle={() => toggleRepeatSpan(i)} kind="cut" />
            ))
        )}
      </div>
    </div>
  );
});

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center p-6 text-center text-[11px] text-muted-foreground">{children}</div>;
}

// kind="keep" : intervalle gardé (× l'exclut). kind="cut" : span coupé (× le garde).
// conf < 0.6 → badge « ? » (suggestion incertaine, à vérifier à l'écoute avant de laisser couper).
function Row({ idx, accent, start, end, text, conf, active, excluded, kind, onSeek, onToggle }: {
  idx: number; accent: string; start: number; end: number; text?: string; conf?: number; active: boolean; excluded: boolean;
  kind: "keep" | "cut"; onSeek: () => void; onToggle: () => void;
}) {
  const { t } = useTranslation("voice");
  // « in montage » = gardé non exclu (keep) OU coupé désélectionné (cut). Sinon il sort/est coupé.
  const dimmed = kind === "keep" ? excluded : !excluded; // visuellement atténué quand hors-montage / coupé
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSeek();
    }
  };

  // Libellé de bascule aligné sur le bouton de la ligne (garder ↔ exclure/couper).
  const toggleLabel = kind === "keep"
    ? (excluded ? t("cuts.reinclude") : t("cuts.exclude"))
    : (excluded ? t("cuts.cutPassage") : t("cuts.keepPassage"));

  return (
    <ContextMenu>
      <ContextMenuTrigger render={
        <div
          role="button"
          tabIndex={0}
          onKeyDown={handleKeyDown}
          onClick={onSeek}
          className={cn(
            "group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-[11px] transition-colors hover:bg-muted outline-none focus-visible:ring-1 focus-visible:ring-ring",
            active && "ring-1 ring-primary",
          )}
        />
      }>
      <span className={cn("h-3.5 w-1 shrink-0 rounded-full", accent, dimmed && "opacity-25")} />
      <span className="w-5 shrink-0 text-center text-[11px] tabular-nums text-muted-foreground">{String(idx + 1).padStart(2, "0")}</span>
      {text ? (
        <span className={cn("min-w-0 flex-1 truncate", dimmed && "text-muted-foreground line-through")}>« {text} »</span>
      ) : (
        <span className={cn("flex-1 tabular-nums", dimmed && "text-muted-foreground line-through")}>
          {fmtTime(start)} <span className="text-muted-foreground">→</span> {fmtTime(end)}
        </span>
      )}
      {conf != null && conf < 0.6 && (
        <Tooltip>
          <TooltipTrigger render={
            <span className="shrink-0 rounded bg-amber-400/15 px-1 text-[11px] leading-4 text-amber-500">?</span>
          } />
          <TooltipContent>{t("cuts.lowConfidence")}</TooltipContent>
        </Tooltip>
      )}
      <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">{(end - start).toFixed(2)}s</span>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onToggle(); }}
        aria-label={dimmed ? t("cuts.restore") : (kind === "keep" ? t("cuts.exclude") : t("cuts.keepPassage"))}
        className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
      >
        {dimmed ? <RotateCcw className="size-3" /> : (kind === "keep" ? <X className="size-3" /> : <Scissors className="size-3" />)}
      </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-44">
        <ContextMenuItem onClick={onSeek}><Play /> {t("cuts.play")}</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={onToggle}>
          {dimmed ? <RotateCcw /> : (kind === "keep" ? <X /> : <Scissors />)} {toggleLabel}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
