// État vide partagé des blocs média (YouTube / Intégration / Signet) : encart discret avec icône,
// champ de collage et validation Entrée. SOURCE UNIQUE du look « déposer un lien ici ».
import { useState, type ReactNode } from "react";

export function EmptyLinkInput({
  icon, placeholder, onSubmit,
}: { icon: ReactNode; placeholder: string; onSubmit: (v: string) => void }) {
  const [val, setVal] = useState("");
  const submit = () => { const s = val.trim(); if (/^https?:\/\//i.test(s)) onSubmit(s); };
  return (
    <div
      contentEditable={false}
      className="my-1.5 flex items-center gap-2.5 rounded-xl border border-dashed border-border bg-muted/30 px-3.5 py-3 transition-colors focus-within:border-primary/50 hover:bg-muted/50"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-background text-primary shadow-sm">{icon}</span>
      <input
        aria-label={placeholder}
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { if (e.nativeEvent.isComposing) return; e.preventDefault(); submit(); } }}
        onBlur={submit}
        placeholder={placeholder}
        className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}
