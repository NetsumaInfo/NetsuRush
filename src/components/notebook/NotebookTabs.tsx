// Barre d'onglets du Carnet (façon navigateur) — LOGÉE DANS LA BARRE DE TITRE (App.tsx) pour
// ne pas ajouter de bande. Groupe flèches ◀▶ (historique de l'onglet actif) à gauche, puis onglets
// (icône + titre), × au survol, clic-milieu ferme, glisser-déposer natif réordonne, clic droit =
// fermer / fermer les autres, débordement = scroll + menu « » », bouton + = nouvelle page.
// `data-no-drag` sur les contrôles → le clic ne déplace pas la fenêtre (l'espace vide, lui, drague).
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useApp } from "@/store";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } from "@/components/ui/context-menu";
import { X, Plus, ChevronsRight, FileText, ArrowLeft, ArrowRight } from "lucide-react";
import { renderPageIcon } from "./IconPicker";

export function NotebookTabs() {
  const { t: tr } = useTranslation("notebook");
  const { nbTabs, nbActiveTabId, nbPages, nbActivateTab, nbCloseTab, nbCloseOthers, nbReorderTabs, nbCreatePage, nbTabBack, nbTabFwd } = useApp(useShallow((s) => ({
    nbTabs: s.nbTabs,
    nbActiveTabId: s.nbActiveTabId,
    nbPages: s.nbPages,
    nbActivateTab: s.nbActivateTab,
    nbCloseTab: s.nbCloseTab,
    nbCloseOthers: s.nbCloseOthers,
    nbReorderTabs: s.nbReorderTabs,
    nbCreatePage: s.nbCreatePage,
    nbTabBack: s.nbTabBack,
    nbTabFwd: s.nbTabFwd,
  })));
  const [dragIdx, setDragIdx] = useState<number | null>(null);

  if (!nbTabs.length) return null;
  const titleOf = (pageId: string) => nbPages.find((p) => p.id === pageId)?.title || tr("panel.untitled");
  const iconOf = (pageId: string) => nbPages.find((p) => p.id === pageId)?.icon ?? null;
  const activeTab = nbTabs.find((t) => t.id === nbActiveTabId);
  const canBack = !!activeTab && activeTab.histIdx > 0;
  const canFwd = !!activeTab && activeTab.histIdx < activeTab.hist.length - 1;
  const navBtn = "flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30";

  return (
    <div className="flex h-full min-w-0 flex-1 items-center gap-2">
      {/* Historique de l'onglet actif (◀ ▶) */}
      <div data-no-drag className="flex shrink-0 items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger render={<button type="button" onClick={() => void nbTabBack()} disabled={!canBack} className={navBtn}><ArrowLeft className="h-4 w-4" /></button>} />
          <TooltipContent>{tr("tabs.prev")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<button type="button" onClick={() => void nbTabFwd()} disabled={!canFwd} className={navBtn}><ArrowRight className="h-4 w-4" /></button>} />
          <TooltipContent>{tr("tabs.next")}</TooltipContent>
        </Tooltip>
      </div>

      <div className="nb-tabstrip flex min-w-0 items-center gap-1 overflow-x-auto">
        {nbTabs.map((t, i) => {
          const active = t.id === nbActiveTabId;
          return (
            <ContextMenu key={t.id}>
              <Tooltip>
                <TooltipTrigger render={
                  <ContextMenuTrigger
                    render={
                      <div
                        data-no-drag
                        draggable
                        onDragStart={(e) => { setDragIdx(i); e.dataTransfer.effectAllowed = "move"; }}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => { e.preventDefault(); if (dragIdx != null && dragIdx !== i) nbReorderTabs(dragIdx, i); setDragIdx(null); }}
                        onDragEnd={() => setDragIdx(null)}
                        onClick={() => void nbActivateTab(t.id)}
                        onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); nbCloseTab(t.id); } }}
                        className={`group relative flex h-7 max-w-48 min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors ${
                          active
                            ? "bg-[var(--color-surface-2)] text-foreground"
                            : "text-muted-foreground hover:bg-[color-mix(in_srgb,var(--color-surface-2)_60%,transparent)] hover:text-foreground"
                        }`}
                      >
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                      {iconOf(t.pageId) ? renderPageIcon(iconOf(t.pageId), "h-3.5 w-3.5", "text-sm") : <FileText className="h-3.5 w-3.5" />}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{titleOf(t.pageId)}</span>
                    <Tooltip>
                      <TooltipTrigger render={
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); nbCloseTab(t.id); }}
                          className={`-mr-1 flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-accent ${active ? "" : "opacity-0 group-hover:opacity-100"}`}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      } />
                      <TooltipContent>{tr("tabs.closeTab")}</TooltipContent>
                    </Tooltip>
                        {active && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary" />}
                      </div>
                    }
                  />
                } />
                <TooltipContent>{titleOf(t.pageId)}</TooltipContent>
              </Tooltip>
              <ContextMenuContent>
                <ContextMenuItem onClick={() => nbCloseTab(t.id)}>{tr("tabs.closeTab")}</ContextMenuItem>
                <ContextMenuItem onClick={() => nbCloseOthers(t.id)} disabled={nbTabs.length < 2}>{tr("tabs.closeOthers")}</ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
      </div>

      {nbTabs.length > 5 && (
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger render={
              <DropdownMenuTrigger render={
                <button type="button" data-no-drag className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
                  <ChevronsRight className="h-4 w-4" />
                </button>
              } />
            } />
            <TooltipContent>{tr("tabs.all")}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent className="max-h-80 w-56 overflow-y-auto">
            {nbTabs.map((t) => (
              <DropdownMenuItem key={t.id} onClick={() => void nbActivateTab(t.id)} className={t.id === nbActiveTabId ? "font-medium" : ""}>
                <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                  {iconOf(t.pageId) ? renderPageIcon(iconOf(t.pageId), "h-3.5 w-3.5", "text-sm") : <FileText className="h-3.5 w-3.5" />}
                </span>
                <span className="truncate">{titleOf(t.pageId)}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <Tooltip>
        <TooltipTrigger render={
          <button
            type="button"
            data-no-drag
            onClick={() => void nbCreatePage(null, { newTab: true })}
            className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Plus className="h-4 w-4" />
          </button>
        } />
        <TooltipContent>{tr("tabs.newPage")}</TooltipContent>
      </Tooltip>
    </div>
  );
}
