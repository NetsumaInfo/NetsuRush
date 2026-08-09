// Fenêtre OS détachée du Carnet : le panneau complet dans une 2e WebviewWindow (hash #notebook,
// mécano de ReferenceWindow) — écrire ses notes À CÔTÉ de NetsuDraft ou de n'importe quel module.
// Frameless (decorations:false) → on redessine TOUT : bande de déplacement + réduire / agrandir /
// FERMER + épingler (always-on-top) + rattacher. Le menu natif étant supprimé partout, le clic
// droit est câblé ici aussi (édition couper/copier/coller + actions fenêtre).
// Chaque fenêtre a son propre état (renderer séparé) ; la persistance passe par le core → dernier
// écrit gagne sur une MÊME page ouverte des deux côtés (limite assumée).

import { useEffect, useState, type CSSProperties } from "react";
import i18n from "@/i18n";
import { Minus, Square, Copy, X, Pin, PinOff, Minimize2, RotateCw } from "lucide-react";
import { nr } from "@/lib/bridge";
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
  ContextMenuGroup, ContextMenuLabel,
} from "@/components/ui/context-menu";
import { EditItems, editableFrom } from "@/components/common/ViewContextMenu";
import { NotebookPanel } from "./NotebookPanel";

const DRAG: CSSProperties = { WebkitAppRegion: "drag" } as CSSProperties;
const NO_DRAG: CSSProperties = { WebkitAppRegion: "no-drag" } as CSSProperties;
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function win() {
  const m = await import("@tauri-apps/api/window");
  return m.getCurrentWindow();
}

export function NotebookWindow() {
  const [maxed, setMaxed] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [edit, setEdit] = useState(false);
  const [editEl, setEditEl] = useState<HTMLElement | null>(null);

  // Suit l'état agrandi/restauré pour dessiner la bonne icône (fenêtre frameless : les contrôles
  // système n'existent pas, on les redessine — même patron que WindowControls de la principale).
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

  const togglePin = () => {
    const next = !pinned;
    setPinned(next);
    void (async () => { if (isTauri) await (await win()).setAlwaysOnTop(next).catch(() => {}); })();
  };
  const minimize = () => void (async () => { if (isTauri) await (await win()).minimize(); })();
  const toggleMax = () => void (async () => { if (isTauri) await (await win()).toggleMaximize(); })();
  const close = () => void (async () => { if (isTauri) await (await win()).close(); })();

  const ctlBtn = "inline-flex h-6 w-9 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground outline-none [&_svg]:size-3.5";

  return (
    <TooltipProvider delay={600}>
      <div className="relative flex h-screen flex-col overflow-hidden bg-[var(--color-bg)]">
        {/* Barre de fenêtre : zone de déplacement + épingler/rattacher + réduire/agrandir/fermer. */}
        <header className="flex h-6 shrink-0 items-center border-b border-border bg-card pl-2 select-none" style={DRAG}>
          <span className="text-[11px] font-medium tracking-wide text-muted-foreground">{i18n.t("notebook:panel.notebookFallback")}</span>
          <div className="ml-auto flex items-center" style={NO_DRAG}>
            <Tooltip>
              <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={pinned ? i18n.t("notebook:window.unpin") : i18n.t("notebook:window.alwaysOnTop")} aria-pressed={pinned} onClick={togglePin} />}>
                {pinned ? <Pin /> : <PinOff />}
              </TooltipTrigger>
              <TooltipContent>{pinned ? i18n.t("notebook:window.stopAlwaysOnTop") : i18n.t("notebook:window.keepOnTop")}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={i18n.t("notebook:window.attach")} onClick={() => nr.notebook?.attach()} />}>
                <Minimize2 />
              </TooltipTrigger>
              <TooltipContent>{i18n.t("notebook:window.attach")}</TooltipContent>
            </Tooltip>
            {isTauri && (
              <>
                <button type="button" className={ctlBtn} aria-label={i18n.t("notebook:window.minimize")} onClick={minimize}><Minus /></button>
                <button type="button" className={ctlBtn} aria-label={maxed ? i18n.t("notebook:window.restore") : i18n.t("notebook:window.maximize")} onClick={toggleMax}>{maxed ? <Copy /> : <Square />}</button>
                <button type="button" className={`${ctlBtn} hover:bg-destructive hover:text-destructive-foreground`} aria-label={i18n.t("notebook:window.close")} onClick={close}><X /></button>
              </>
            )}
          </div>
        </header>

        <ContextMenu>
          <ContextMenuTrigger
            render={<div className="min-h-0 flex-1" />}
            onContextMenuCapture={(e: React.MouseEvent) => {
              const el = editableFrom(e.target);
              setEditEl(el);
              setEdit(!!el);
            }}
          >
            <NotebookPanel />
          </ContextMenuTrigger>
          <ContextMenuContent className="min-w-48">
            {edit ? (
              <EditItems el={editEl} />
            ) : (
              <ContextMenuGroup>
                <ContextMenuLabel>{i18n.t("notebook:window.title")}</ContextMenuLabel>
                <ContextMenuItem onClick={togglePin}>
                  {pinned ? <PinOff /> : <Pin />} {pinned ? i18n.t("notebook:window.stopAlwaysOnTop") : i18n.t("notebook:window.keepOnTop")}
                </ContextMenuItem>
                <ContextMenuItem onClick={() => nr.notebook?.attach()}><Minimize2 /> {i18n.t("notebook:window.attach")}</ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => window.location.reload()}><RotateCw /> {i18n.t("notebook:window.reload")}</ContextMenuItem>
                <ContextMenuItem onClick={close}><X /> {i18n.t("notebook:window.closeWindow")}</ContextMenuItem>
              </ContextMenuGroup>
            )}
          </ContextMenuContent>
        </ContextMenu>
      </div>
    </TooltipProvider>
  );
}
