// Infobulle de correction orthographique — le chaînon qui manquait : la WebView souligne les fautes
// mais ses suggestions ne vivent que dans son menu contextuel natif, supprimé partout dans l'app.
// Clic droit sur un mot souligné → ce panneau. Clavier : ↑↓ parcourt, Entrée applique, Échap ferme.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { BookPlus, EyeOff, Replace, SpellCheck2 } from "lucide-react";
import { spell } from "@/lib/spell/spellClient";
import { applyCorrection, occurrencesOf, type SpellTarget } from "@/lib/spell/spellPlugin";
import { useViewportAnchor } from "@/lib/useViewportAnchor";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const PANEL = { width: 264, height: 296, gap: 4 };

export function SpellPopover({ target, onClose }: { target: SpellTarget | null; onClose: () => void }) {
  const { t } = useTranslation("common");
  const [suggestions, setSuggestions] = useState<string[] | null>(null);
  const [index, setIndex] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  const word = target?.word ?? "";

  const getRect = useCallback(() => target?.getRect() ?? null, [target]);
  const position = useViewportAnchor(!!target, getRect, PANEL);
  // Le comptage parcourt tout le document : figé sur la cible, pas recalculé à chaque flèche du clavier.
  const occurrences = useMemo(() => (target ? occurrencesOf(target.view.state.doc, target.word).length : 0), [target]);

  // Suggestions du dictionnaire (worker) — le mot change ⇒ on repart de zéro.
  useEffect(() => {
    if (!target) { setSuggestions(null); return; }
    let live = true;
    setSuggestions(null);
    setIndex(0);
    void spell.suggest(target.lang, target.word).then((list) => { if (live) setSuggestions(list.slice(0, 8)); });
    return () => { live = false; };
  }, [target]);

  const replaceOne = useCallback((replacement: string) => {
    if (!target) return;
    applyCorrection(target.view, target.from, target.to, replacement);
    onClose();
  }, [target, onClose]);

  // Toutes les occurrences du mot : remplacées de la fin vers le début pour que les positions
  // déjà calculées restent valides pendant la boucle.
  const replaceEvery = useCallback((replacement: string) => {
    if (!target) return;
    const { view } = target;
    const hits = occurrencesOf(view.state.doc, target.word);
    if (!hits.length) { onClose(); return; }
    const tr = view.state.tr;
    for (const hit of hits) tr.insertText(replacement, hit.from, hit.to);
    view.dispatch(tr);
    view.focus();
    onClose();
  }, [target, onClose]);

  const learn = useCallback(() => {
    if (!target) return;
    spell.learn(target.lang, target.word);
    target.view.focus();
    onClose();
  }, [target, onClose]);

  const ignore = useCallback(() => {
    if (!target) return;
    spell.ignore(target.word);
    target.view.focus();
    onClose();
  }, [target, onClose]);

  // Clavier + clic extérieur. Capture : l'éditeur ne doit pas recevoir ces frappes.
  useEffect(() => {
    if (!target) return;
    const list = suggestions ?? [];
    const onKey = (e: KeyboardEvent) => {
      const stop = () => { e.preventDefault(); e.stopPropagation(); };
      if (e.key === "Escape") { stop(); onClose(); }
      else if (e.key === "ArrowDown" && list.length) { stop(); setIndex((i) => (i + 1) % list.length); }
      else if (e.key === "ArrowUp" && list.length) { stop(); setIndex((i) => (i - 1 + list.length) % list.length); }
      else if (e.key === "Enter" && list[index]) { stop(); replaceOne(list[index]); }
    };
    const onDown = (e: MouseEvent) => { if (panel.current && !panel.current.contains(e.target as Node)) onClose(); };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [target, suggestions, index, onClose, replaceOne]);

  if (!target) return null;

  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-label={t("spell.title")}
      className="fixed z-50 flex w-66 flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-xl"
      style={{ top: position.top, left: position.left, maxHeight: position.maxHeight }}
    >
      <div className="flex items-center gap-1.5 border-b border-border px-2.5 py-1.5">
        <SpellCheck2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-xs text-muted-foreground">{t("spell.unknownWord")}</span>
        <span className="ml-auto max-w-28 truncate font-medium text-foreground">{word}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {suggestions === null && <p className="px-2 py-2 text-sm text-muted-foreground">{t("spell.searching")}</p>}
        {suggestions?.length === 0 && <p className="px-2 py-2 text-sm text-muted-foreground">{t("spell.noSuggestion")}</p>}
        {suggestions?.map((suggestion, i) => (
          <button
            key={suggestion}
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => setIndex(i)}
            onClick={() => replaceOne(suggestion)}
            className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors ${
              i === index ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-accent"
            }`}
          >
            <span className="min-w-0 flex-1 truncate">{suggestion}</span>
            {i === index && occurrences > 1 && (
              <Tooltip>
                <TooltipTrigger render={<span
                  role="button"
                  tabIndex={-1}
                  aria-label={t("spell.replaceAll", { count: occurrences })}
                  onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
                  onClick={(e) => { e.stopPropagation(); replaceEvery(suggestion); }}
                  className="flex shrink-0 items-center gap-1 rounded px-1 text-[11px] opacity-80 hover:opacity-100"
                />}>
                  <Replace className="h-3 w-3" /> {occurrences}
                </TooltipTrigger>
                <TooltipContent>{t("spell.replaceAll", { count: occurrences })}</TooltipContent>
              </Tooltip>
            )}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-px border-t border-border p-1">
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={learn}
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <BookPlus className="h-3.5 w-3.5 shrink-0" /> {t("spell.addToDictionary")}
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={ignore}
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <EyeOff className="h-3.5 w-3.5 shrink-0" /> {t("spell.ignoreOnce")}
        </button>
      </div>
    </div>,
    document.body,
  );
}
