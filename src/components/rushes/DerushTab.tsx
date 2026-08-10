// Contenu de l'onglet Derush selon le sous-onglet actif (la sous-nav vit dans la barre de titre,
// cf. DerushSubnav). Découpage = flux existant (accueil → grille de rushs → CutStudio).
import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { nr } from "@/lib/bridge";
import { useApp } from "@/store";
import { RushGrid } from "./RushGrid";
import { DerushHome } from "./DerushHome";
import { CutStudio } from "./CutStudio";
import { CutTimelineView } from "./CutTimelineView";
import { TimelineLiveView } from "./TimelineLiveView";
import { CollectionsView } from "@/components/collections/CollectionsView";

export function DerushTab() {
  const { section, selected, derushView, cutTimelineOpen, activeHost, loadClips } = useApp(
    useShallow((s) => ({ section: s.derushSection, selected: s.selected, derushView: s.derushView, cutTimelineOpen: s.cutTimelineOpen, activeHost: s.activeHost, loadClips: s.loadClips })),
  );

  // Hôte Adobe : quand le panneau CEP pousse un projet (« Envoyer vers NetsuRush » → SSE adobe:update),
  // recharge la grille de rushs si on la regarde → les rushs apparaissent sans action manuelle.
  useEffect(() => {
    if (activeHost === "resolve") return;
    const off = nr.onAdobeUpdate((p) => {
      if (p.app === activeHost && derushView === "browser") void loadClips();
    });
    return off;
  }, [activeHost, derushView, loadClips]);

  return (
    <div className="h-full">
      {section === "decoupage" && (
        selected
          ? <CutStudio />
          : cutTimelineOpen
            ? <CutTimelineView />
            : <div className="h-full overflow-auto">{derushView === "home" ? <DerushHome /> : <RushGrid />}</div>
      )}
      {section === "collections" && <CollectionsView />}
      {section === "timeline" && <TimelineLiveView />}
    </div>
  );
}
