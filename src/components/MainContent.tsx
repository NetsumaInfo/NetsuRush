// Contenu principal (le panneau du module actif) — partagé entre le Shell normal (sidebar) et le
// panneau remote compact (sélecteur). Un seul endroit pour la table onglet→panneau.
import { Suspense, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { NAV } from "@/components/nav";
import { useApp } from "@/store";
import { DictateOverlay } from "@/components/dictate/DictateOverlay";
import { PANELS, hasPanel, prefetchPanelsWhenIdle } from "@/components/panels";
import { Spinner } from "@/components/ui/spinner";

export function MainContent() {
  const { t } = useTranslation("shell");
  const tab = useApp((s) => s.tab);
  const Panel = hasPanel(tab) ? PANELS[tab] : null;

  // Les autres pages se chargent pendant les temps morts, une fois celle-ci affichée : changer
  // d'onglet ne déclenche alors plus aucun téléchargement.
  useEffect(() => { prefetchPanelsWhenIdle(tab); }, [tab]);

  return (
    <>
      <Suspense fallback={<div className="grid h-full flex-1 place-items-center"><Spinner className="size-5" /></div>}>
        {Panel ? <Panel /> : (() => {
          const item = NAV.find((n) => n.id === tab);
          const Icon = item?.icon;
          return (
            <div className="grid h-full place-items-center p-7">
              <div className="flex max-w-xs flex-col items-center gap-3 text-center">
                {Icon && (
                  <div className="grid size-12 place-items-center rounded-xl bg-muted text-muted-foreground">
                    <Icon className="size-6" />
                  </div>
                )}
                <div className="text-sm font-medium text-foreground">{item ? t(item.labelKey) : null}</div>
                <p className="text-sm text-muted-foreground">{t("app.modulePreparing")}</p>
              </div>
            </div>
          );
        })()}
      </Suspense>
      {/* Dictée globale : MAINTIENS le raccourci → parle → RELÂCHE → le texte s'insère dans
          le champ/éditeur focalisé. Pas de bouton visible ; pastille discrète pendant l'écoute. */}
      <DictateOverlay />
    </>
  );
}
