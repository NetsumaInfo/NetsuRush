// Indicateur d'erreur GLOBAL : petite pastille rouge, visible depuis N'IMPORTE QUELLE page dès qu'une
// erreur est journalisée (console.error, exception non gérée, rejet de promesse, ou log core/python de
// niveau error). Clic → ouvre Paramètres › Console sur l'erreur. Le positionnement vient de la colonne
// flottante du coin bas-droit qui l'accueille (cf. `App`), partagée avec les pastilles d'état.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Terminal, Check } from "lucide-react";
import { useApp } from "@/store";
import { subscribeErrorCount, markConsoleSeen } from "@/lib/appConsole";
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem,
} from "@/components/ui/context-menu";

export function ErrorBadge() {
  const { t } = useTranslation("shell");
  const [count, setCount] = useState(0);
  const openConsole = useApp((s) => s.openConsole);
  const onConsole = useApp((s) => s.tab === "settings" && s.settingsPage === "system" && s.settingsTab.system === "console");

  useEffect(() => subscribeErrorCount(setCount), []);
  // Déjà sur la console → l'utilisateur voit les erreurs : on remet le compteur à zéro.
  useEffect(() => { if (onConsole) markConsoleSeen(); }, [onConsole, count]);

  if (count === 0 || onConsole) return null;

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <button
            type="button"
            onClick={() => { openConsole(); markConsoleSeen(); }}
            aria-label={t("errorBadge.aria", { count })}
            className="pointer-events-auto flex items-center gap-1.5 rounded-full bg-destructive px-3 py-2 text-xs font-medium text-destructive-foreground shadow-lg ring-1 ring-black/20 transition-transform hover:scale-105 active:scale-95"
          />
        }
      >
        <AlertTriangle className="size-4" />
        <span className="tabular-nums">{count > 99 ? "99+" : count}</span>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-44">
        <ContextMenuItem onClick={() => { openConsole(); markConsoleSeen(); }}><Terminal /> {t("errorBadge.open")}</ContextMenuItem>
        <ContextMenuItem onClick={() => markConsoleSeen()}><Check /> {t("errorBadge.markRead")}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
