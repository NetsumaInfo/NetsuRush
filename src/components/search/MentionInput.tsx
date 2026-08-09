import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Search, ScanFace } from "lucide-react";
import { cn } from "@/lib/utils";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { detectMentionQuery, insertMention, type MentionChar } from "@/components/search/mentions";

type Props = {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;         // Entrée hors sélecteur = lancer la recherche
  roster: MentionChar[];        // personnages proposés (déjà filtrés « prêts »)
  placeholder?: string;
  bare?: boolean;               // sans cadre : le champ vit DANS la barre d'en-tête, qui porte le fond
};

// Champ de recherche avec mentions @perso : taper « @ » ouvre un sélecteur de personnages ;
// choisir insère « @Nom » dans le texte. Le texte reste la source de vérité (cf. mentions.ts).
export function MentionInput({ value, onChange, onSubmit, roster, placeholder, bare = false }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);
  const pendingCaret = useRef<number | null>(null);

  // Personnages du sélecteur : filtrés sur ce qui suit le @, préfixe d'abord, plafonné.
  const matches = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.trim().toLowerCase();
    return roster
      .filter((c) => c.name && (!q || c.name.toLowerCase().includes(q)))
      .sort((a, b) => {
        const ap = a.name.toLowerCase().startsWith(q) ? 0 : 1;
        const bp = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        return ap - bp || a.name.localeCompare(b.name);
      })
      .slice(0, 8);
  }, [mention, roster]);

  const open = !!mention && matches.length > 0;

  // Repositionne le curseur après une insertion (le state a changé la valeur → on recale).
  useLayoutEffect(() => {
    if (pendingCaret.current != null && inputRef.current) {
      inputRef.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  });

  function refresh(text: string, caret: number) {
    const m = detectMentionQuery(text, caret);
    setMention(m);
    setActive(0);
  }

  function pick(c: MentionChar) {
    if (!mention) return;
    const caret = inputRef.current?.selectionStart ?? value.length;
    const r = insertMention(value, mention.start, caret, c.name);
    pendingCaret.current = r.caret;
    setMention(null);
    onChange(r.text);
    inputRef.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (open) {
      if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => (i + 1) % matches.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => (i - 1 + matches.length) % matches.length); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(matches[active]); return; }
      if (e.key === "Escape") { e.preventDefault(); setMention(null); return; }
    }
    if (e.key === "Enter") onSubmit();
  }

  // Les mêmes handlers servent les deux rendus (encadré ou nu) : seule l'enveloppe change.
  const fieldProps = {
    ref: inputRef,
    value,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      onChange(e.target.value);
      refresh(e.target.value, e.target.selectionStart ?? e.target.value.length);
    },
    onKeyDown,
    onKeyUp: (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"].includes(e.key)) return;
      refresh(e.currentTarget.value, e.currentTarget.selectionStart ?? e.currentTarget.value.length);
    },
    onClick: (e: React.MouseEvent<HTMLInputElement>) =>
      refresh(e.currentTarget.value, e.currentTarget.selectionStart ?? e.currentTarget.value.length),
    onBlur: () => setTimeout(() => setMention(null), 120),   // laisse le temps au clic sur une option
    placeholder,
  };

  if (bare) {
    return (
      <div className="relative flex flex-1 items-center gap-2">
        <Search className="size-4 shrink-0 text-muted-foreground" />
        <input
          {...fieldProps}
          className="h-9 w-full min-w-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
        />
        {open && <MentionList matches={matches} active={active} setActive={setActive} pick={pick} />}
      </div>
    );
  }

  return (
    <div className="relative flex-1">
      <InputGroup>
        <InputGroupAddon><Search /></InputGroupAddon>
        <InputGroupInput
          ref={inputRef}
          value={value}
          onChange={(e) => { onChange(e.target.value); refresh(e.target.value, e.target.selectionStart ?? e.target.value.length); }}
          onKeyDown={onKeyDown}
          // Recalcule la mention au déplacement du curseur (flèches ←/→, Début/Fin), MAIS jamais
          // pour les touches pilotant le popover : sinon ↑/↓ remet la sélection à 0 (navigation
          // cassée) et Entrée/Tab rouvrent le sélecteur sur le perso qu'on vient d'insérer.
          onKeyUp={(e) => {
            if (["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"].includes(e.key)) return;
            refresh(e.currentTarget.value, e.currentTarget.selectionStart ?? e.currentTarget.value.length);
          }}
          onClick={(e) => refresh(e.currentTarget.value, e.currentTarget.selectionStart ?? e.currentTarget.value.length)}
          onBlur={() => setTimeout(() => setMention(null), 120)}   // laisse le temps au clic sur une option
          placeholder={placeholder}
        />
      </InputGroup>
      {open && <MentionList matches={matches} active={active} setActive={setActive} pick={pick} />}
    </div>
  );
}

// Liste des personnages proposés après « @ » — partagée par les deux rendus du champ (encadré et nu).
function MentionList({ matches, active, setActive, pick }: {
  matches: MentionChar[];
  active: number;
  setActive: (i: number) => void;
  pick: (c: MentionChar) => void;
}) {
  return (
    <ul
      role="listbox"
      className="absolute left-0 right-0 top-full z-50 mt-1 max-h-64 overflow-auto rounded-md border border-border bg-popover p-1 shadow-lg animate-in fade-in-0 zoom-in-98 duration-150 motion-reduce:animate-none"
    >
      {matches.map((c, i) => (
        <li key={c.id}>
          <button
            type="button"
            role="option"
            aria-selected={i === active}
            onMouseEnter={() => setActive(i)}
            onMouseDown={(e) => { e.preventDefault(); pick(c); }}
            className={cn(
              "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none",
              i === active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
            )}
          >
            <span
              className="h-6 w-6 shrink-0 overflow-hidden rounded-full bg-muted"
              style={c.color ? { boxShadow: `inset 0 0 0 1.5px ${c.color}` } : undefined}
            >
              {c.avatar
                ? <img src={c.avatar} alt="" className="h-full w-full object-cover" />
                : <ScanFace className="m-1 h-4 w-4 text-muted-foreground" />}
            </span>
            <span className="truncate">{c.name}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
