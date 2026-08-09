import { useRef, useState } from "react";

// Champ de renommage inline (chips personnages, roster) : Entrée/blur = commit
// (si non vide et modifié), Échap = annule. Le parent monte/démonte le champ.
export function InlineRename({ value, onCommit, onCancel, className }: {
  value: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  const done = useRef(false);   // Échap puis blur au démontage → un seul événement de sortie
  const commit = () => {
    if (done.current) return;
    done.current = true;
    const name = draft.trim();
    if (name && name !== value) onCommit(name);
    else onCancel();
  };
  const cancel = () => {
    if (done.current) return;
    done.current = true;
    onCancel();
  };
  return (
    <input
      aria-label="Renommer"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          if (e.nativeEvent.isComposing) return;
          commit();
        }
        else if (e.key === "Escape") cancel();
        e.stopPropagation();
      }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      className={className}
    />
  );
}
