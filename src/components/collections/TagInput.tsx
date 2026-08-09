import { useState } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";

// Éditeur de tags réutilisable (puces + saisie + autocomplétion). Partagé par l'inspecteur de plan
// et l'éditeur de collection → les tags saisis alimentent le registre global (recherche transversale).
export function TagInput({ value, onChange, suggestions = [], placeholder }: {
  value: string[];
  onChange: (tags: string[]) => void;
  suggestions?: string[];
  placeholder?: string;
}) {
  const { t: tr } = useTranslation("collections");
  const [input, setInput] = useState("");
  const add = (raw: string) => {
    const t = raw.trim();
    if (!t || value.includes(t)) { setInput(""); return; }
    onChange([...value, t]);
    setInput("");
  };
  const remove = (t: string) => onChange(value.filter((x) => x !== t));
  const q = input.trim().toLowerCase();
  const filtered = suggestions.filter((t) => !value.includes(t) && t.toLowerCase().includes(q)).slice(0, 6);

  return (
    <div className="flex flex-wrap items-center gap-1">
      {value.map((t) => (
        <span key={t} className="inline-flex items-center gap-1 rounded bg-accent px-1.5 py-0.5 text-[11px]">
          {t}
          <button type="button" aria-label={tr("tags.remove", { tag: t })} onClick={() => remove(t)} className="text-muted-foreground hover:text-destructive"><X className="h-2.5 w-2.5" /></button>
        </span>
      ))}
      <div className="relative">
        <Input value={input} onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.nativeEvent.isComposing) return; if (e.key === "Enter") { e.preventDefault(); add(input); } else if (e.key === "Backspace" && !input && value.length) { remove(value[value.length - 1]); } }}
          placeholder={placeholder ?? tr("tags.addTag")} className="h-6 w-24 px-1.5 text-[11px]" />
        {input && filtered.length > 0 && (
          <div className="absolute bottom-7 left-0 z-20 w-40 overflow-hidden rounded-md border border-border bg-popover py-1 shadow-md">
            {filtered.map((t) => (
              <button key={t} type="button" onClick={() => add(t)} className="block w-full px-2 py-1 text-left text-[11px] hover:bg-accent">{t}</button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
