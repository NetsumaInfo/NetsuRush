// Sous-nav du derush (Découpage / Collections / Timeline Live), posée DANS la barre de titre pour
// ne rien coûter en hauteur (segmented control compact). Pilote `derushSection` du store.
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { NetsuIcon } from "@/components/ui/netsu-icon";
import { useShallow } from "zustand/react/shallow";
import { useApp } from "@/store";
import { type DerushSection } from "@/store";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const SECTIONS: { id: DerushSection; labelKey: string; icon: string }[] = [
  { id: "decoupage", labelKey: "subnav.decoupage", icon: "tab-cut" },
  { id: "collections", labelKey: "subnav.collections", icon: "tab-collections" },
  { id: "timeline", labelKey: "subnav.timeline", icon: "tab-timeline-live" },
];

export function DerushSubnav() {
  const { t } = useTranslation("derush");
  const { section, setSection } = useApp(
    useShallow((s) => ({ section: s.derushSection, setSection: s.setDerushSection })),
  );
  return (
    <div className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-background p-0.5" data-no-drag>
      {SECTIONS.map((s) => {
        const active = section === s.id;
        return (
          <Tooltip key={s.id}>
            <TooltipTrigger
              render={
                <Button variant="ghost"
                  type="button"
                  onClick={() => setSection(s.id)}
                  aria-label={t(s.labelKey)}
                  className={cn("h-auto justify-start whitespace-normal text-left font-normal border-0 p-0 gap-0 rounded-none hover:bg-transparent dark:hover:bg-transparent", 
                    "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                    active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                />
              }
            >
              {/* Sous ~560 px (panneau CEP étroit), les libellés sortiraient de la barre : on garde
                  les TROIS entrées visibles en icônes plutôt que d'en pousser une hors de vue. */}
              <NetsuIcon name={s.icon} className="size-3.5" />
              <span className="hidden min-[560px]:inline">{t(s.labelKey)}</span>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t(s.labelKey)}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
