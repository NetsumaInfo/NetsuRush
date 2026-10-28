// Boutons système de la fenêtre frameless (réduire / agrandir-restaurer / fermer). La fenêtre est
// `decorations: false` : on redessine donc les contrôles. `data-no-drag` les exclut de la région
// non-client WebView2 utilisée par la barre de titre.

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { NetsuIcon } from "@/components/ui/netsu-icon";
import { CloseGlyph, MaximizeGlyph, MinimizeGlyph, RestoreGlyph } from "@/components/ui/window-glyphs";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useApp } from "@/store";
import { UpdateButton } from "@/components/updates/UpdateButton";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

// Mise en forme d'un bouton de la barre de titre. Exportée : `HeaderLinks` pose les siens à côté
// des contrôles de fenêtre, et deux styles voisins qui divergent se voient tout de suite.
export const TITLEBAR_BTN =
  "group inline-flex h-9 w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset [&_svg]:size-3.5";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function win() {
  const m = await import("@tauri-apps/api/window");
  return m.getCurrentWindow();
}

export function WindowControls() {
  const { t } = useTranslation(["shell", "common"]);
  const [maxed, setMaxed] = useState(false);
  const { pinned, togglePinned } = useApp(useShallow((s) => ({ pinned: s.pinned, togglePinned: s.togglePinned })));

  useEffect(() => {
    if (!isTauri) return;
    let un: (() => void) | undefined;
    void (async () => {
      const w = await win();
      setMaxed(await w.isMaximized());
      un = await w.onResized(async () => setMaxed(await w.isMaximized()));
    })();
    return () => un?.();
  }, []);

  if (!isTauri) return null;

  const btn = TITLEBAR_BTN;
  return (
    <div className="ml-auto flex items-center" data-no-drag>
      {/* Mise à jour disponible : même coin, à toutes les étapes (installation, gates, application).
          Absent tant qu'aucune version n'attend — cf. UpdateButton. */}
      <UpdateButton variant="icon" />
      <Tooltip>
        <TooltipTrigger render={
          <Button variant="ghost"
            type="button"
            aria-label={pinned ? t("windowControls.unpin") : t("windowControls.pinAbove")}
            aria-pressed={pinned}
            className={cn("h-auto gap-0 rounded-none px-0 py-0 text-[length:inherit] font-normal whitespace-normal hover:bg-transparent dark:hover:bg-transparent", `${btn} ${pinned ? "text-primary hover:text-primary" : ""}`)}
            onClick={togglePinned}
          >
            <NetsuIcon name="window-pin" on={pinned} />
          </Button>
        } />
        <TooltipContent>{pinned ? t("windowControls.unpinShort") : t("windowControls.pinAbove")}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger render={
          <Button variant="ghost" type="button" aria-label={t("windowControls.minimize")} className={cn("h-auto gap-0 rounded-none px-0 py-0 text-[length:inherit] font-normal whitespace-normal hover:bg-transparent dark:hover:bg-transparent", btn)} onClick={() => void win().then((w) => w.minimize()).catch(() => undefined)}>
            <MinimizeGlyph />
          </Button>
        } />
        <TooltipContent>{t("windowControls.minimize")}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger render={
          <Button variant="ghost" type="button" aria-label={maxed ? t("windowControls.restore") : t("windowControls.maximize")} className={cn("h-auto gap-0 rounded-none px-0 py-0 text-[length:inherit] font-normal whitespace-normal hover:bg-transparent dark:hover:bg-transparent", btn)} onClick={() => void win().then((w) => w.toggleMaximize()).catch(() => undefined)}>
            {maxed ? <RestoreGlyph /> : <MaximizeGlyph />}
          </Button>
        } />
        <TooltipContent>{maxed ? t("windowControls.restore") : t("windowControls.maximize")}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger render={
          <Button variant="ghost" type="button" aria-label={t("common:action.close")} className={cn("h-auto gap-0 rounded-none px-0 py-0 text-[length:inherit] font-normal whitespace-normal hover:bg-transparent dark:hover:bg-transparent", `${btn} hover:bg-destructive hover:text-primary-foreground`)} onClick={() => void win().then((w) => w.close()).catch(() => undefined)}>
            <CloseGlyph />
          </Button>
        } />
        <TooltipContent>{t("common:action.close")}</TooltipContent>
      </Tooltip>
    </div>
  );
}
