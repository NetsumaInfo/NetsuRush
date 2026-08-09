// Panneau REMOTE (app dans le panneau CEP Adobe) : coquille dégraissée, pensée pour un panneau
// étroit. Pas de rail latéral (inutile ici) → un simple sélecteur de vue en haut. Max de place.
// Navigation aussi au CLIC DROIT (ViewContextMenu, comme dans l'app) : « Aller au module »,
// actions de la vue, Paramètres, Recharger — variante remote (pas d'items fenêtre OS).
import { useEffect, type ReactNode } from "react";
import { Scissors, ChevronDown, Settings, Check, RotateCw, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useApp } from "@/store";
import { NAV } from "@/components/nav";
import { ViewContextMenu } from "@/components/common/ViewContextMenu";
import { MainContent } from "@/components/MainContent";
import { DerushSubnav } from "@/components/rushes/DerushSubnav";
import { SettingsSubnav } from "@/components/settings/SettingsSubnav";
import { NotebookTabs } from "@/components/notebook/NotebookTabs";
import { BrandIcon } from "@/components/BrandIcon";
import { panelCommand, signalPanelReady } from "@/lib/remote";
import { useHostSync } from "@/hooks/useHostSync";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// Bouton-icône de la barre : même gabarit que les contrôles de fenêtre du shell (36×36 tactile en
// panneau étroit), infobulle obligatoire — l'icône seule ne dit pas ce qu'elle recharge/ferme.
function PanelButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            onClick={onClick}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function RemotePanel() {
  const { t } = useTranslation("adobe");
  const tab = useApp((s) => s.tab);
  const setTab = useApp((s) => s.setTab);
  const current = NAV.find((n) => n.id === tab);
  const CurrentIcon = current?.icon ?? Scissors;

  // Prévient la coquille CEP que l'app est bien montée (sinon elle ne peut pas distinguer un iframe
  // resté blanc d'un chargement lent, et l'utilisateur se retrouve devant un panneau vide).
  useEffect(signalPanelReady, []);

  // Le panneau ne rend pas la coquille : sans cette synchro, le statut de l’hôte (Resolve ou
  // panneau Adobe) restait inconnu ici et les actions « projet » y étaient toutes grisées.
  useHostSync();

  const subnav = tab === "derush" ? <DerushSubnav />
    : tab === "settings" ? <SettingsSubnav />
    : tab === "notebook" ? <NotebookTabs />
    : null;

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      {/* Barre compacte : marque + sélecteur de vue + commandes de la coquille CEP. La coquille n'a
          plus de barre à elle — son libellé « NetsuRush » doublonnait le titre du panneau Adobe. */}
      <header className="relative flex h-9 shrink-0 items-center gap-2 border-b border-border bg-card px-2">
        <BrandIcon className="size-6" />
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent"
              >
                <CurrentIcon className="size-3.5 text-primary" />
                {/* Panneau très étroit : le nom du module cède la place à la sous-nav CENTRÉE (qui
                    doit rester au milieu de la barre), l'icône et le chevron suffisent à la lire. */}
                <span className="hidden min-[480px]:inline">{current ? t(`shell:${current.labelKey}`) : "NetsuRush"}</span>
                <ChevronDown className="size-3 text-muted-foreground" />
              </button>
            }
          />
          <DropdownMenuContent align="start" className="w-52">
            <DropdownMenuGroup>
              {NAV.map((n) => {
                const Icon = n.icon;
                return (
                  <DropdownMenuItem key={n.id} onClick={() => setTab(n.id)}>
                    <Icon className="size-4 text-muted-foreground" />
                    <span className="flex-1">{t(`shell:${n.labelKey}`)}</span>
                    {tab === n.id && <Check className="size-3.5 text-primary" />}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setTab("settings")}>
              <Settings className="size-4 text-muted-foreground" />
              <span className="flex-1">{t("remote.settings")}</span>
              {tab === "settings" && <Check className="size-3.5 text-primary" />}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="flex-1" />
        {/* Sous-nav du module actif (Découpage/Collections/Timeline Live, onglets Paramètres, onglets
            Carnet). Dans l'app elle vit dans la BARRE DE TITRE ; ici elle partage la barre du panneau
            plutôt que d'y ajouter une bande — le panneau CEP est déjà court. CENTRÉE en absolu comme
            dans l'app : elle ne bouge pas avec la largeur du sélecteur de module à sa gauche. */}
        {subnav && (
          <div className="absolute left-1/2 flex -translate-x-1/2 items-center">{subnav}</div>
        )}
        <PanelButton label={t("remote.reload")} onClick={() => panelCommand("reload")}>
          <RotateCw className="size-3.5" />
        </PanelButton>
        <PanelButton label={t("remote.close")} onClick={() => panelCommand("home")}>
          <X className="size-3.5" />
        </PanelButton>
      </header>

      <ViewContextMenu remote>
        <MainContent />
      </ViewContextMenu>
    </div>
  );
}
