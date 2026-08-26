import { useCallback, useRef, useState, type ReactNode } from "react";
import { AccordionItem, AccordionTrigger, AccordionContent } from "@/components/ui/accordion";

// Tiroir d'une section du rail Roto. Le rail empile neuf étapes ; tout déplier d'office dépasse
// largement la hauteur de la fenêtre, et rien qu'un panneau de post-traitement porte sept curseurs.
//
// Une section repliée AFFICHE SON ÉTAT (`summary`) : sans ça, replier ne gagne pas de place, ça
// cache l'information — on rouvrirait chaque tiroir juste pour savoir ce qu'il contient.

// Six étapes, dans l'ordre du travail. Neuf tiroirs éparpillaient les mêmes réglages : le modèle
// de segmentation, les objets et les points décrivent UNE seule chose (ce qu'on isole), et le
// modèle de matte et les curseurs de retouche façonnent UN seul alpha, l'un après l'autre.
// La suppression d'objet garde SON tiroir : c'est une sortie qui reconstruit le fond au lieu de
// l'exporter, et la ranger sous « Sortie » la rendait introuvable. « Sortie » ferme la marche —
// écrire le fichier est le dernier geste, tout ce qui précède le prépare.
const ROTO_SECTIONS = ["select", "track", "view", "mask", "remove", "output"] as const;
export type RotoSectionId = (typeof ROTO_SECTIONS)[number];

const LS_KEY = "nr.roto.sections";
const DEFAULT_OPEN: RotoSectionId[] = ["select", "track"];

function readOpen(): RotoSectionId[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return DEFAULT_OPEN;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return DEFAULT_OPEN;
    return parsed.filter((v): v is RotoSectionId => ROTO_SECTIONS.includes(v as RotoSectionId));
  } catch {
    return DEFAULT_OPEN;
  }
}

/** État d'ouverture des tiroirs, persisté. `openOnce` déplie une section quand elle DEVIENT
 *  pertinente (le matte fin après un suivi) sans jamais la rouvrir si l'utilisateur l'a refermée. */
export function useRotoSections() {
  const [open, setOpenState] = useState<RotoSectionId[]>(readOpen);
  const revealed = useRef(new Set<RotoSectionId>());

  const setOpen = useCallback((next: RotoSectionId[]) => {
    setOpenState(next);
    try { localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch { /* stockage indisponible */ }
  }, []);

  const openOnce = useCallback((id: RotoSectionId) => {
    if (revealed.current.has(id)) return;
    revealed.current.add(id);
    setOpenState((cur) => {
      if (cur.includes(id)) return cur;
      const next = [...cur, id];
      try { localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch { /* stockage indisponible */ }
      return next;
    });
  }, []);

  return { open, setOpen, openOnce };
}

export function RotoSection({ id, title, summary, disabled, children }: {
  id: RotoSectionId;
  title: string;
  /** État résumé, montré uniquement quand le tiroir est fermé. */
  summary?: ReactNode;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <AccordionItem value={id} disabled={disabled} className="border-b border-border last:border-b-0">
      {/* `hover:no-underline` : le défaut shadcn souligne le titre au survol, ce qui déplace la
          ligne de base sur une rangée de 28 px. Le fond au survol dit la même chose sans bouger. */}
      <AccordionTrigger className="h-9 gap-3 rounded-none py-0 text-xs font-semibold text-foreground transition-colors hover:bg-foreground/[0.04] hover:no-underline aria-expanded:text-foreground">
        <span className="min-w-0 shrink-0">{title}</span>
        {summary != null && (
          // Le résumé ne sert QUE fermé : ouvert, la section montre déjà ses contrôles.
          // `text-right` + `ml-auto` : il se cale sur le chevron, jamais contre le titre.
          <span className="ml-auto min-w-0 truncate text-right text-[11px] font-normal tabular-nums text-muted-foreground group-aria-expanded/accordion-trigger:hidden">
            {summary}
          </span>
        )}
      </AccordionTrigger>
      <AccordionContent className="pb-3 pt-0.5">{children}</AccordionContent>
    </AccordionItem>
  );
}

/** Étape à l'intérieur d'un tiroir. Une section regroupe des réglages qui s'appliquent l'un APRÈS
 *  l'autre (le modèle de matte, puis la retouche manuelle) : sans ce repère, l'ordre se devine. */
export function RotoStep({ label, hint, children }: {
  label: string; hint?: string; children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline gap-1.5">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</h4>
        {hint && <span className="min-w-0 truncate text-[10px] text-muted-foreground/70">{hint}</span>}
      </div>
      {children}
    </div>
  );
}
