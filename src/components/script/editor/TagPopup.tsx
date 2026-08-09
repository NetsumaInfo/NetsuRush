// Popup « Ajouter un tag » ancrée au caret (déclenchée par /tag, comme le menu slash) : champ de
// saisie + suggestions (tags déjà présents dans le doc, favoris en tête). Entrée = ajoute le tag au
// bloc courant via l'éditeur (source de vérité).

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Hash } from "lucide-react";
import { Input } from "@/components/ui/input";

interface TagPopupProps {
  left: number;
  top: number;
  suggestions: string[]; // dédupliquées, favoris en tête
  onPick: (tag: string) => void;
  onClose: () => void;
}

export function TagPopup({ left, top, suggestions, onPick, onClose }: TagPopupProps) {
  const { t } = useTranslation("script");
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q ? suggestions.filter((t) => t.toLowerCase().includes(q)) : suggestions;
    return base.slice(0, 8);
  }, [query, suggestions]);

  const commit = (tag: string) => {
    const t = tag.trim().replace(/^#/, "");
    if (t) onPick(t);
    onClose();
  };

  return (
    <>
      <button type="button" aria-label={t("common:action.close")} className="fixed inset-0 z-40" onMouseDown={onClose} />
      <div className="fixed z-50 w-56 rounded-md bg-popover p-1.5 text-popover-foreground shadow-md ring-1 ring-foreground/10" style={{ left, top }}>
        <Input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("editor.tagPlaceholder")}
          className="h-7 text-sm"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); commit(query || list[0] || ""); }
            if (e.key === "Escape") { e.preventDefault(); onClose(); }
          }}
        />
        {list.length > 0 && (
          <div className="mt-1 flex flex-col">
            {list.map((t) => (
              <button
                key={t}
                type="button"
                className="flex items-center gap-1.5 rounded-sm px-2 py-1 text-left text-sm hover:bg-accent"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => commit(t)}
              >
                <Hash className="size-3.5 text-muted-foreground" /> {t}
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
