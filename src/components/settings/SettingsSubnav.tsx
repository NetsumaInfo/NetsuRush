// Onglets de la page de paramètres courante, posés DANS la barre de titre pour ne rien coûter en
// hauteur — même mécanique que la sous-nav du derush et les onglets du carnet. Rien à afficher pour
// une page d'un seul sujet (Export, Adobe). En mode épinglé la barre est trop étroite : SettingsPanel
// rend le repli.
import { useTranslation } from "react-i18next";
import { useApp } from "@/store";
import { settingsPageDef } from "@/features/settings/nav";
import { cn } from "@/lib/utils";

export function SettingsSubnav() {
  const { t } = useTranslation("settings");
  const page = useApp((s) => s.settingsPage);
  const active = useApp((s) => s.settingsTab[s.settingsPage]);
  const setTab = useApp((s) => s.setSettingsTab);
  const tabs = settingsPageDef(page).tabs;
  if (tabs.length < 2) return null;

  return (
    // data-no-drag : sans ça, cliquer un onglet déplacerait la fenêtre. L'espace vide de la barre
    // reste une zone de drag.
    <div className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-background p-0.5" data-no-drag>
      {tabs.map((tab) => {
        const on = tab.id === active;
        const Icon = tab.icon;
        return (
          <button
            key={tab.id}
            type="button"
            aria-current={on ? "page" : undefined}
            onClick={() => setTab(page, tab.id)}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1 text-xs font-medium transition-colors",
              on ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <Icon className="size-3.5" /> {t(`tab.${page}.${tab.id}`)}
          </button>
        );
      })}
    </div>
  );
}
