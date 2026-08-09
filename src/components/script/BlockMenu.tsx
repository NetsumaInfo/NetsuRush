// Menu slash « / » : liste flottante des commandes filtrées. Présentation pure — la navigation
// clavier (flèches/Entrée/Échap) est pilotée par le bloc parent (le textarea garde le focus).
// La LISTE est exportée à part : la gouttière l'affiche dans sa propre boîte, positionnée par
// rapport au viewport (le menu du « + » doit pouvoir basculer au-dessus du bouton près du bas).

import type { SlashCommand } from "./scriptShared";

interface ListProps {
  commands: SlashCommand[];
  activeIndex: number;
  onSelect: (cmd: SlashCommand) => void;
  onHover: (index: number) => void;
}

export function BlockMenuList({ commands, activeIndex, onSelect, onHover }: ListProps) {
  return (
    <>
      {commands.map((c, i) => {
        const Icon = c.icon;
        return (
          <button
            key={c.id}
            type="button"
            ref={i === activeIndex ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
            className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm ${i === activeIndex ? "bg-accent text-accent-foreground" : "text-foreground"}`}
            onMouseEnter={() => onHover(i)}
            onMouseDown={(e) => { e.preventDefault(); onSelect(c); }}
          >
            <Icon className="size-4 shrink-0 text-muted-foreground" />
            <span className="flex-1">{c.label}</span>
            <span className="text-xs text-muted-foreground">{c.hint}</span>
          </button>
        );
      })}
    </>
  );
}

export function BlockMenu(props: ListProps) {
  if (!props.commands.length) return null;
  return (
    <div className="absolute left-8 top-full z-30 mt-1 max-h-72 w-64 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg">
      <BlockMenuList {...props} />
    </div>
  );
}
