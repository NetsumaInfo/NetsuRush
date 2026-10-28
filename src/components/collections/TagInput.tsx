import { useState } from "react";
import { NetsuIcon } from "@/components/ui/netsu-icon";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

const MAX_SUGGESTIONS = 6;

// Éditeur de tags réutilisable (puces + saisie + autocomplétion). Partagé par l'inspecteur de plan
// et l'éditeur de collection → les tags saisis alimentent le registre global (recherche transversale).
// The suggestion list is an inline listbox (no portal) so the input keeps focus while arrow keys move
// the active option; a Popover would take focus away from the field being typed in.
export function TagInput({ value, onChange, suggestions = [], placeholder }: {
  value: string[];
  onChange: (tags: string[]) => void;
  suggestions?: string[];
  placeholder?: string;
}) {
  const { t: tr } = useTranslation("collections");
  const [input, setInput] = useState("");
  const [active, setActive] = useState(-1);
  const add = (raw: string) => {
    const t = raw.trim();
    setInput("");
    setActive(-1);
    if (!t || value.includes(t)) return;
    onChange([...value, t]);
  };
  const remove = (t: string) => onChange(value.filter((x) => x !== t));
  const q = input.trim().toLowerCase();
  const filtered = suggestions.filter((t) => !value.includes(t) && t.toLowerCase().includes(q)).slice(0, MAX_SUGGESTIONS);
  const open = !!input && filtered.length > 0;

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((a) => (a + step + filtered.length) % filtered.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      add(open && active >= 0 ? filtered[active] : input);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      setActive(-1);
      setInput("");
    } else if (e.key === "Backspace" && !input && value.length) {
      remove(value[value.length - 1]);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1">
      {value.map((t) => (
        <span key={t} className="inline-flex items-center gap-0.5 rounded bg-accent py-0.5 pl-1.5 pr-0.5 text-[11px]">
          {t}
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label={tr("tags.remove", { tag: t })} onClick={() => remove(t)} className="size-4 text-muted-foreground hover:text-destructive" />}>
              <NetsuIcon name="close" className="size-2.5" />
            </TooltipTrigger>
            <TooltipContent>{tr("tags.remove", { tag: t })}</TooltipContent>
          </Tooltip>
        </span>
      ))}
      <div className="relative">
        <Input value={input} onChange={(e) => { setInput(e.target.value); setActive(-1); }}
          role="combobox" aria-expanded={open} aria-autocomplete="list" aria-controls="tag-suggestions"
          onKeyDown={onKeyDown}
          placeholder={placeholder ?? tr("tags.addTag")} className="h-6 w-24 px-1.5 text-[11px]" />
        {open && (
          <div id="tag-suggestions" role="listbox" className="absolute bottom-7 left-0 z-20 flex w-40 flex-col overflow-hidden rounded-md border border-border bg-popover py-1 shadow-md">
            {filtered.map((t, i) => (
              <Button key={t} variant="ghost" size="xs" role="option" aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()} onClick={() => add(t)}
                className={"h-auto w-full justify-start rounded-none px-2 py-1 text-[11px] font-normal " + (i === active ? "bg-accent" : "")}>{t}</Button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
