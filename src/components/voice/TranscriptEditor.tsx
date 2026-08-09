// Éditeur de transcript : clic = positionne la lecture + sélectionne ; Maj+clic =
// étend la sélection ; Suppr = retire les mots sélectionnés (saute le passage au montage) ; clic sur
// un mot barré = le rétablit ; Ctrl+Z / Ctrl+Maj+Z = annuler/rétablir. Le mot en cours de lecture est
// surligné. Mots `<Word>` mémoïsés → seuls les mots dont une prop change se re-rendent (highlight
// fluide même sur un long transcript). Aucune anim JS ; content-visibility:auto.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/shallow";
import { Undo2, Redo2, Scissors, Play, RotateCcw, Strikethrough } from "lucide-react";
import { useApp } from "@/store";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { fillerIndices } from "./voiceFillers";

const Word = memo(function Word({
  index, text, removed, filler, active, selected, onPick,
}: {
  index: number; text: string; removed: boolean; filler: boolean; active: boolean; selected: boolean;
  onPick: (i: number, shift: boolean) => void;
}) {
  return (
    <span
      data-wi={index}
      role="option"
      aria-selected={selected}
      tabIndex={0}
      onMouseDown={(e) => { if (e.button !== 0) return; e.preventDefault(); onPick(index, e.shiftKey); }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(index, e.shiftKey); }
      }}
      className={cn(
        "cursor-pointer rounded px-0.5",
        selected && "bg-primary/45 text-primary-foreground",
        active && !removed && "bg-primary/65 text-primary-foreground",
        !active && !selected && "hover:bg-muted",
        filler && !removed && !active && "bg-amber-400/15 text-amber-500",
        removed && "text-muted-foreground/80 line-through",
      )}
    >
      {text}{" "}
    </span>
  );
});

export const TranscriptEditor = memo(function TranscriptEditor({
  currentIndex, onSeek,
}: {
  currentIndex: number;
  onSeek: (t: number) => void;
}) {
  const { t } = useTranslation("voice");
  const { words, removedWords, toggleWord, removeRange, restoreRange, undoRemoved, redoRemoved, canUndo, canRedo, hesitationParams } =
    useApp(useShallow((s) => ({
      words: s.words, removedWords: s.removedWords, toggleWord: s.toggleWord,
      removeRange: s.removeRange, restoreRange: s.restoreRange,
      undoRemoved: s.undoRemoved, redoRemoved: s.redoRemoved,
      canUndo: s.removedPast.length > 0, canRedo: s.removedFuture.length > 0,
      hesitationParams: s.hesitationParams,
    })));

  const [anchor, setAnchor] = useState<number | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const [ctxWord, setCtxWord] = useState<number | null>(null);   // mot visé par le clic droit
  const fillerSet = useMemo(() => new Set(fillerIndices(words, hesitationParams)), [words, hesitationParams]);

  // Karaoke : quand le mot lu change, le faire défiler dans la vue (block "nearest" → ne tire que
  // s'il sort de l'écran, ne combat pas le scroll manuel). Les spans = enfants directs 1:1 des mots.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (currentIndex < 0) return;
    const el = listRef.current?.children[currentIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [currentIndex]);

  const onPick = useCallback((i: number, shift: boolean) => {
    if (shift && anchor != null) { setFocus(i); }
    else {
      if (removedWords.has(i)) { toggleWord(i); return; } // clic sur un mot barré = rétablir
      setAnchor(i); setFocus(i); onSeek(words[i]?.start ?? 0);
    }
  }, [anchor, removedWords, toggleWord, onSeek, words]);

  const sel = useMemo(
    () => anchor != null && focus != null ? [Math.min(anchor, focus), Math.max(anchor, focus)] as const : null,
    [anchor, focus],
  );

  const cutSelection = useCallback(() => {
    if (!sel) return;
    removeRange(sel[0], sel[1]);
    setAnchor(null); setFocus(null);
  }, [sel, removeRange]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.key === "Delete" || e.key === "Backspace") && sel) { e.preventDefault(); cutSelection(); }
    else if (e.key === "Escape") { setAnchor(null); setFocus(null); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redoRemoved() : undoRemoved(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); redoRemoved(); }
  }, [sel, cutSelection, undoRemoved, redoRemoved]);

  const selCount = sel ? sel[1] - sel[0] + 1 : 0;
  const selAllRemoved = sel ? words.slice(sel[0], sel[1] + 1).every((_, k) => removedWords.has(sel[0] + k)) : false;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex shrink-0 items-center gap-1.5">
        <Button size="sm" variant="ghost" onClick={() => undoRemoved()} disabled={!canUndo} aria-label={t("transcript.undo")}><Undo2 className="size-4" /></Button>
        <Button size="sm" variant="ghost" onClick={() => redoRemoved()} disabled={!canRedo} aria-label={t("transcript.redo")}><Redo2 className="size-4" /></Button>
        {sel && (
          selAllRemoved
            ? <Button size="sm" variant="outline" onClick={() => { restoreRange(sel[0], sel[1]); setAnchor(null); setFocus(null); }}>{t("transcript.restoreCount", { count: selCount })}</Button>
            : <Button size="sm" variant="outline" onClick={cutSelection}><Scissors className="size-4" /> {t("transcript.cutCount", { count: selCount })}</Button>
        )}
        <span className="ml-auto text-[11px] text-muted-foreground">{t("transcript.hint")}</span>
      </div>

      <ContextMenu>
        <ContextMenuTrigger render={
          <div
            ref={listRef}
            role="listbox"
            aria-multiselectable="true"
            tabIndex={0}
            onKeyDown={onKeyDown}
            // Repère le mot sous le curseur avant l'ouverture du menu (un seul menu pour toute la liste).
            onContextMenuCapture={(e) => {
              const el = (e.target as HTMLElement).closest("[data-wi]") as HTMLElement | null;
              setCtxWord(el ? Number(el.dataset.wi) : null);
            }}
            className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border bg-card p-4 text-[15px] leading-relaxed outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        }>
          {words.map((w, i) => (
            <Word
              key={i}
              index={i}
              text={w.word}
              removed={removedWords.has(i)}
              filler={fillerSet.has(i)}
              active={i === currentIndex}
              selected={!!sel && i >= sel[0] && i <= sel[1]}
              onPick={onPick}
            />
          ))}
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-48">
          <ContextMenuItem disabled={ctxWord == null} onClick={() => { if (ctxWord != null) onSeek(words[ctxWord]?.start ?? 0); }}>
            <Play /> {t("transcript.playHere")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          {/* Menu adaptatif : sélection multiple → couper/rétablir le passage ; sinon → barrer le mot visé. */}
          {sel && selCount > 1 && ctxWord != null && ctxWord >= sel[0] && ctxWord <= sel[1] ? (
            selAllRemoved
              ? <ContextMenuItem onClick={() => { restoreRange(sel[0], sel[1]); setAnchor(null); setFocus(null); }}><RotateCcw /> {t("transcript.restoreSelection", { count: selCount })}</ContextMenuItem>
              : <ContextMenuItem variant="destructive" onClick={cutSelection}><Scissors /> {t("transcript.cutSelection", { count: selCount })}</ContextMenuItem>
          ) : ctxWord != null ? (
            removedWords.has(ctxWord)
              ? <ContextMenuItem onClick={() => toggleWord(ctxWord)}><RotateCcw /> {t("transcript.restoreWord")}</ContextMenuItem>
              : <ContextMenuItem variant="destructive" onClick={() => toggleWord(ctxWord)}><Strikethrough /> {t("transcript.strikeWord")}</ContextMenuItem>
          ) : null}
          <ContextMenuSeparator />
          <ContextMenuItem disabled={!canUndo} onClick={() => undoRemoved()}><Undo2 /> {t("transcript.contextUndo")}</ContextMenuItem>
          <ContextMenuItem disabled={!canRedo} onClick={() => redoRemoved()}><Redo2 /> {t("transcript.contextRedo")}</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
});
