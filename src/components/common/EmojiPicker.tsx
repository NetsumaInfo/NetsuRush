// Sélecteur d'emoji MAISON (pas le widget emoji-mart brut, qui jure avec la DA de l'app). Réutilise
// le JEU DE DONNÉES emoji-mart (@emoji-mart/data : jeu complet + mots-clés) mais avec NOTRE grille
// thémée sur les tokens de l'app : recherche, catégories, survol cohérent. Réutilisable partout.
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Search } from "lucide-react";
import emojiData from "@emoji-mart/data";
import { HoverLabel } from "@/components/common/HoverLabel";

type EmojiEntry = { id: string; name: string; keywords: string[]; skins: { native: string }[] };
type EmojiDataShape = {
  categories: { id: string; emojis: string[] }[];
  emojis: Record<string, EmojiEntry>;
};
const DATA = emojiData as unknown as EmojiDataShape;

// Catégories emoji-mart affichées (l'ordre suit data.categories). Le libellé est résolu via i18n
// (clé « emoji.cat.<id> ») au rendu.
const CAT_IDS = ["people", "nature", "foods", "activity", "places", "objects", "symbols", "flags"];

function native(id: string): string {
  return DATA.emojis[id]?.skins?.[0]?.native ?? "";
}

export function EmojiPicker({ onPick, className, heightClass = "max-h-56" }: { onPick: (ch: string) => void; className?: string; heightClass?: string }) {
  const { t } = useTranslation("shell");
  const [q, setQ] = useState("");
  // Le jeu complet fait ~1 800 cellules : une seule bulle partagée, ancrée sur la cellule survolée.
  const scrollRef = useRef<HTMLDivElement>(null);

  // Recherche : filtre par nom + mots-clés sur tout le jeu (aplati). Sinon on rend par catégories.
  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return null;
    const out: string[] = [];
    for (const id in DATA.emojis) {
      const e = DATA.emojis[id];
      if (e.id.includes(s) || e.name.toLowerCase().includes(s) || e.keywords?.some((k) => k.includes(s))) out.push(id);
      if (out.length >= 120) break;
    }
    return out;
  }, [q]);

  const cell = (id: string) => (
    <button
      key={id}
      type="button"
      aria-label={DATA.emojis[id]?.name}
      data-hover-label={DATA.emojis[id]?.name}
      onClick={() => { const ch = native(id); if (ch) onPick(ch); }}
      className="flex aspect-square items-center justify-center rounded-md text-xl leading-none transition-colors hover:bg-accent"
    >
      {native(id)}
    </button>
  );

  return (
    <div className={className}>
      <div className="mb-2 flex items-center gap-1.5 rounded-md border border-border bg-muted px-2">
        <Search className="h-3.5 w-3.5 text-muted-foreground" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("emoji.search")}
          className="w-full bg-transparent py-1.5 text-sm outline-none"
        />
      </div>
      <div ref={scrollRef} className={`${heightClass} overflow-y-auto pr-1`}>
        {results ? (
          results.length ? (
            <div className="grid grid-cols-8 gap-0.5">{results.map(cell)}</div>
          ) : (
            <p className="py-6 text-center text-xs text-muted-foreground">{t("emoji.none", { q })}</p>
          )
        ) : (
          DATA.categories
            .filter((c) => CAT_IDS.includes(c.id))
            .map((c) => (
              <div key={c.id} className="mb-2" style={{ contentVisibility: "auto" }}>
                <div className="sticky top-0 bg-popover py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t(`emoji.cat.${c.id}`)}</div>
                <div className="grid grid-cols-8 gap-0.5">{c.emojis.map(cell)}</div>
              </div>
            ))
        )}
      </div>
      <HoverLabel containerRef={scrollRef} />
    </div>
  );
}
