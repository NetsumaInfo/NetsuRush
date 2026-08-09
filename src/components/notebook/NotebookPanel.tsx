// Panneau du module Carnet : sidebar second-niveau (en-tête carnet + actions Recherche
// / Nouvelle page + Favoris/Récents + arbre de pages + pied Corbeille/Paramètres) et zone d'édition
// (fil d'Ariane — les onglets vivent dans la barre de titre — + en-tête cover/emoji/titre + éditeur
// BlockNote + rétroliens). Autosave débouncé, raccourcis rebindables, recherche, corbeille, paramètres.
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useApp } from "@/store";
import { ScrollArea } from "@/components/ui/scroll-area";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuGroup } from "@/components/ui/dropdown-menu";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { NotebookPen, ChevronsUpDown, Plus, Trash2, Search, Settings2, Sparkles, PanelLeftClose, PanelLeft, FileUp, PackageOpen, Package, PictureInPicture2, Pencil, SaveAll, FileSymlink, FileCheck2 } from "lucide-react";
import { nr } from "@/lib/bridge";
import { coreAvailable } from "@/lib/coreClient";
import { PageTree } from "./PageTree";
import { NotebookDocument } from "./NotebookDocument";
import { NotebookBreadcrumb } from "./NotebookBreadcrumb";
import { NotebookSidebarSections } from "./NotebookSidebarSections";
import { NotebookSettings } from "./NotebookSettings";
import { NotebookSearch } from "./NotebookSearch";
import { NotebookTrash } from "./NotebookTrash";
import { DocActions } from "./DocActions";
import { MovePageDialog } from "./MovePageDialog";
import { useNotebookAutosave } from "./useNotebookAutosave";
import { useNotebookShortcuts } from "./notebookShortcuts";
import { SIDEBAR_MIN, SIDEBAR_MAX } from "./notebookPrefs";
import { pickMarkdownFiles, markdownToBlocks, pickNetsuFile, safeFileName } from "./notebookExport";
import { CreateNotebookDialog, EditNotebookDialog } from "./NotebookMetaControls";

// Rangée d'action de la sidebar (Recherche / Nouvelle page) — icône + libellé.
function ActionRow({ icon, label, accent, onClick }: { icon: React.ReactNode; label: string; accent?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-muted-foreground transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary hover:bg-accent hover:text-foreground"
    >
      <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md ${accent ? "bg-primary text-primary-foreground" : "bg-[var(--color-surface-2)] text-muted-foreground"}`}>
        {icon}
      </span>
      {label}
    </button>
  );
}

export function NotebookPanel() {
  const { t } = useTranslation(["notebook", "common"]);
  useNotebookAutosave();
  // `hasPage` (booléen) et NON l'objet page : celui-ci change à CHAQUE frappe (l'éditeur pousse ses
  // blocs au store) et re-rendrait la sidebar entière. Le document s'abonne lui-même (NotebookDocument).
  const {
    nbList, nbActiveId, nbPages, nbActivePageId, hasPage, nbPrefs,
    nbLoadList, nbOpenNotebook, nbDeleteNotebook, nbCreatePage, nbDeletePage, nbSetPrefs,
  } = useApp(useShallow((s) => ({
    nbList: s.nbList,
    nbActiveId: s.nbActiveId,
    nbPages: s.nbPages,
    nbActivePageId: s.nbActivePageId,
    hasPage: !!s.nbPage,
    nbPrefs: s.nbPrefs,
    nbLoadList: s.nbLoadList,
    nbOpenNotebook: s.nbOpenNotebook,
    nbDeleteNotebook: s.nbDeleteNotebook,
    nbCreatePage: s.nbCreatePage,
    nbDeletePage: s.nbDeletePage,
    nbSetPrefs: s.nbSetPrefs,
  })));

  // Modales locales au panneau (recherche / corbeille / paramètres) + confirmations + déplacement.
  const [dlg, setDlg] = useState<"search" | "settings" | "trash" | null>(null);
  const [confirmDelNb, setConfirmDelNb] = useState(false);                              // suppression carnet
  const [delPage, setDelPage] = useState<{ id: string; title: string } | null>(null);  // envoi page → corbeille
  const [movePageId, setMovePageId] = useState<string | null>(null);                   // « Déplacer vers… »
  const [createOpen, setCreateOpen] = useState(false);
  const [editNotebookOpen, setEditNotebookOpen] = useState(false);
  const [projectPath, setProjectPath] = useState<string | null>(null);                 // carnet enregistré dans un .netsu
  const [dragW, setDragW] = useState<number | null>(null);                             // largeur sidebar en cours de drag
  const openDialog = useCallback((which: "search" | "settings" | "trash") => setDlg(which), []);
  useNotebookShortcuts(openDialog);

  // Redimensionnement de la sidebar : largeur locale pendant le geste, commit prefs au relâchement.
  const startResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = useApp.getState().nbPrefs.sidebarWidth;
    const clamp = (w: number) => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w));
    const onMove = (ev: PointerEvent) => setDragW(clamp(startW + ev.clientX - startX));
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDragW(null);
      useApp.getState().nbSetPrefs({ sidebarWidth: clamp(startW + ev.clientX - startX) });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  // Import de fichiers Markdown → une page racine par fichier, la dernière est ouverte.
  const importMarkdown = useCallback(async () => {
    const files = await pickMarkdownFiles();
    let lastId: string | null = null;
    for (const f of files) {
      const blocks = await markdownToBlocks(f.text);
      lastId = await useApp.getState().nbCreatePage(null, { title: f.name, blocks, silent: true });
    }
    if (lastId) await useApp.getState().nbOpenPage(lastId);
  }, []);

  // Partage commun .netsu : export du carnet ENTIER, import = nouveau carnet.
  const exportNetsu = useCallback(async () => {
    const s = useApp.getState();
    if (!s.nbActiveId) return;
    const dir = await nr.chooseDir();
    if (!dir) return; // annulé
    const title = s.nbList.find((n) => n.id === s.nbActiveId)?.title || t("notebook:panel.notebookFallback");
    await nr.notebook?.exportFile({ notebookId: s.nbActiveId, dest: `${dir}/${safeFileName(title)}.netsu` });
  }, [t]);
  // --- Carnet-DOCUMENT (.netsu) -----------------------------------------------------------------
  // « Enregistrer sous » fait DÉMÉNAGER le carnet : il quitte la bibliothèque interne pour le
  // fichier choisi, et la frappe y va ensuite directement. Le sélecteur de fichier .netsu vit sur
  // `nr.reference` — c'est le même format, dupliquer le dialogue le ferait diverger du filtre.
  const saveAsProject = useCallback(async () => {
    const s = useApp.getState();
    if (!s.nbActiveId) return;
    const title = s.nbList.find((n) => n.id === s.nbActiveId)?.title || t("notebook:panel.notebookFallback");
    const dest = await nr.reference?.saveNetsuPath(`${safeFileName(title)}.netsu`);
    if (!dest) return; // annulé
    const res = await nr.notebook?.saveProjectAs({ notebookId: s.nbActiveId, destPath: dest });
    if (!res?.ok) return;
    setProjectPath(res.path ?? dest);
    await useApp.getState().nbLoadList();
  }, [t]);

  const openProject = useCallback(async () => {
    const src = await nr.reference?.chooseNetsu();
    if (!src) return;
    const res = await nr.notebook?.openProject(src);
    if (!res?.ok || !res.notebookId) return;
    await useApp.getState().nbLoadList();
    await useApp.getState().nbOpenNotebook(res.notebookId);
  }, []);

  const importNetsu = useCallback(async () => {
    const bytes = await pickNetsuFile();
    if (!bytes) return;
    const r = await nr.notebook?.importFile({ bytes });
    if (r?.ok && r.notebookId) {
      await useApp.getState().nbLoadList();
      await useApp.getState().nbOpenNotebook(r.notebookId);
    }
  }, []);

  // Le carnet ouvert est-il un document sur disque ? Détermine l'affichage du chemin et le libellé
  // « Enregistrer sous » (un document déjà enregistré se DÉPLACE, il ne se crée pas une deuxième fois).
  useEffect(() => {
    if (!nbActiveId) { setProjectPath(null); return undefined; }
    let alive = true;
    void nr.notebook?.projectOf(nbActiveId).then((p) => { if (alive) setProjectPath(p?.path ?? null); });
    return () => { alive = false; };
  }, [nbActiveId]);

  useEffect(() => { void nbLoadList(); }, [nbLoadList]);
  useEffect(() => { if (!nbActiveId && nbList.length) void nbOpenNotebook(nbList[0].id); }, [nbList, nbActiveId, nbOpenNotebook]);

  const activeNb = nbList.find((n) => n.id === nbActiveId);

  // Envoi d'une page à la corbeille : direct, ou confirmé selon les prefs.
  const askDeletePage = useCallback((id: string, title: string) => {
    if (!useApp.getState().nbPrefs.confirmDelete) { void nbDeletePage(id); return; }
    setDelPage({ id, title });
  }, [nbDeletePage]);

  return (
    <div className="flex h-full">
      {/* Sidebar (second niveau) : en-tête + actions + arbre + pied. Repliable (Ctrl+\) + redimensionnable. */}
      {nbPrefs.sidebarOpen && (
      <aside
        className="relative flex shrink-0 flex-col border-r border-border bg-[var(--color-surface)]"
        style={{ width: dragW ?? nbPrefs.sidebarWidth }}
      >
        {/* En-tête : sélecteur de carnet + repli */}
        <div className="flex items-center gap-1 p-2">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button type="button" aria-label={t("panel.notebooks")} className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary hover:bg-accent">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
                    <NotebookPen className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">{activeNb ? activeNb.title : t("panel.notebookFallback")}</span>
                  {projectPath && <FileCheck2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label={projectPath} />}
                  <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                </button>
              }
            />
            <DropdownMenuContent className="w-60">
              <DropdownMenuGroup>
                <DropdownMenuLabel>{t("panel.notebooks")}</DropdownMenuLabel>
                {nbList.length === 0 && <DropdownMenuItem disabled>{t("panel.noNotebooks")}</DropdownMenuItem>}
                {nbList.map((n) => (
                  <DropdownMenuItem key={n.id} onClick={() => void nbOpenNotebook(n.id)}>
                    <span className="truncate">{n.title}</span>{n.id === nbActiveId ? " ✓" : ""}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              {activeNb && <DropdownMenuItem onClick={() => setEditNotebookOpen(true)}><Pencil className="mr-1 h-3.5 w-3.5" /> {t("panel.editNotebook")}</DropdownMenuItem>}
              <DropdownMenuItem onClick={() => setCreateOpen(true)}><Plus className="mr-1 h-3.5 w-3.5" /> {t("panel.newNotebook")}</DropdownMenuItem>
              {activeNb && <DropdownMenuItem onClick={() => void importMarkdown()}><FileUp className="mr-1 h-3.5 w-3.5" /> {t("panel.importMarkdown")}</DropdownMenuItem>}
              {coreAvailable && (
                <>
                  <DropdownMenuSeparator />
                  {activeNb && <DropdownMenuItem onClick={() => void saveAsProject()}><SaveAll className="mr-1 h-3.5 w-3.5" /> {t("panel.saveAsProject")}</DropdownMenuItem>}
                  <DropdownMenuItem onClick={() => void openProject()}><FileSymlink className="mr-1 h-3.5 w-3.5" /> {t("panel.openProject")}</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {activeNb && <DropdownMenuItem onClick={() => void exportNetsu()}><Package className="mr-1 h-3.5 w-3.5" /> {t("panel.exportNetsu")}</DropdownMenuItem>}
                  <DropdownMenuItem onClick={() => void importNetsu()}><PackageOpen className="mr-1 h-3.5 w-3.5" /> {t("panel.importNetsu")}</DropdownMenuItem>
                </>
              )}
              {activeNb && (
                <DropdownMenuItem onClick={() => setConfirmDelNb(true)} className="text-destructive">
                  <Trash2 className="mr-1 h-3.5 w-3.5" /> {t("panel.deleteNotebook")}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          {activeNb && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={() => setEditNotebookOpen(true)}
                    className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    aria-label={t("panel.editNotebook")}
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                }
              />
              <TooltipContent>{t("panel.editNotebook")}</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={() => nr.notebook?.detach()}
                  aria-label={t("window.detach")}
                  className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary hover:bg-accent hover:text-foreground"
                >
                  <PictureInPicture2 className="h-4 w-4" />
                </button>
              }
            />
            <TooltipContent>{t("window.detach")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={() => nbSetPrefs({ sidebarOpen: false })}
                  aria-label={t("panel.collapseSidebar")}
                  className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary hover:bg-accent hover:text-foreground"
                >
                  <PanelLeftClose className="h-4 w-4" />
                </button>
              }
            />
            <TooltipContent>{t("panel.collapseSidebar")}</TooltipContent>
          </Tooltip>
        </div>

        {activeNb && (
          <>
            {/* Actions rapides */}
            <div className="flex flex-col gap-0.5 px-2 pb-2">
              <ActionRow icon={<Search className="h-3 w-3" />} label={t("panel.search")} onClick={() => setDlg("search")} />
              <ActionRow icon={<Plus className="h-3 w-3" />} label={t("panel.newPage")} accent onClick={() => void nbCreatePage(null)} />
            </div>

            <NotebookSidebarSections />

            {/* Arbre de pages */}
            <ScrollArea className="flex-1 px-1.5">
              <div className="px-1.5 pt-1 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{t("panel.pages")}</div>
              <PageTree pages={nbPages} activeId={nbActivePageId} onAskDelete={askDeletePage} onAskMove={setMovePageId} />
            </ScrollArea>

            {/* Pied : Corbeille · Paramètres */}
            <div className="flex items-center gap-px border-t border-border p-1.5 text-sm">
              <button type="button" onClick={() => setDlg("trash")} className="flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-muted-foreground transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary hover:bg-accent hover:text-foreground">
                <Trash2 className="h-3.5 w-3.5" /> {t("panel.trash")}
              </button>
              <span className="h-4 w-px bg-border" />
              <button type="button" onClick={() => setDlg("settings")} className="flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-muted-foreground transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary hover:bg-accent hover:text-foreground">
                <Settings2 className="h-3.5 w-3.5" /> {t("panel.settings")}
              </button>
            </div>
          </>
        )}

        {/* Sidebar sans carnet : l'état vide porte l'action, il ne se contente pas de la décrire. */}
        {!activeNb && (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
            <p className="text-xs text-muted-foreground">{t("panel.emptyNotebookHint")}</p>
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity outline-none focus-visible:ring-2 focus-visible:ring-primary hover:opacity-90"
            >
              <Plus className="h-3.5 w-3.5" /> {t("panel.newNotebook")}
            </button>
          </div>
        )}

        {/* Poignée de redimensionnement (bord droit) */}
        <div
          onPointerDown={startResize}
          className="absolute inset-y-0 -right-px z-10 w-1 cursor-col-resize transition-colors hover:bg-primary/50"
        />
      </aside>
      )}

      {/* Zone d'édition : rangée du haut (réouverture sidebar + fil d'Ariane + actions du document) + document */}
      <main className="flex min-w-0 flex-1 flex-col">
        <div className={`flex h-11 shrink-0 items-center gap-1 pr-3 ${nbPrefs.sidebarOpen ? "pl-14" : "pl-3"}`}>
          {!nbPrefs.sidebarOpen && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={() => nbSetPrefs({ sidebarOpen: true })}
                    aria-label={t("panel.expandSidebar")}
                    className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary hover:bg-accent hover:text-foreground"
                  >
                    <PanelLeft className="h-4 w-4" />
                  </button>
                }
              />
              <TooltipContent>{t("panel.expandSidebar")}</TooltipContent>
            </Tooltip>
          )}
          <NotebookBreadcrumb />
          <div className="min-w-0 flex-1" />
          <DocActions onMove={setMovePageId} onAskDelete={askDeletePage} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {hasPage ? (
            <NotebookDocument />
          ) : (
            <div className="flex h-full items-center justify-center p-8 text-center">
              <div className="max-w-sm">
                <span className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                  <Sparkles className="h-7 w-7" />
                </span>
                <h2 className="mb-1.5 text-base font-semibold">{activeNb ? t("panel.emptyTitleHasNb") : t("panel.emptyTitleNoNb")}</h2>
                <p className="mb-4 text-sm text-muted-foreground">
                  {activeNb ? t("panel.emptyBodyHasNb") : t("panel.emptyBodyNoNb")}
                </p>
                <button
                  type="button"
                  onClick={() => activeNb ? void nbCreatePage(null) : setCreateOpen(true)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground transition-colors hover:opacity-90"
                >
                  <Plus className="h-4 w-4" /> {activeNb ? t("panel.newPage") : t("panel.createNotebook")}
                </button>
              </div>
            </div>
          )}
        </div>
      </main>

      <MovePageDialog pageId={movePageId} onClose={() => setMovePageId(null)} />
      <CreateNotebookDialog open={createOpen} onOpenChange={setCreateOpen} />
      {activeNb && <EditNotebookDialog notebook={activeNb} open={editNotebookOpen} onOpenChange={setEditNotebookOpen} />}
      <NotebookSettings open={dlg === "settings"} onOpenChange={(o) => setDlg(o ? "settings" : null)} />
      <NotebookSearch open={dlg === "search"} onOpenChange={(o) => setDlg(o ? "search" : null)} />
      <NotebookTrash open={dlg === "trash"} onOpenChange={(o) => setDlg(o ? "trash" : null)} />
      {activeNb && (
        <ConfirmDialog
          open={confirmDelNb}
          onOpenChange={setConfirmDelNb}
          title={t("panel.confirmDeleteNbTitle", { name: activeNb.title })}
          description={t("panel.confirmDeleteNbDesc")}
          onConfirm={() => void nbDeleteNotebook(activeNb.id)}
        />
      )}
      <ConfirmDialog
        open={!!delPage}
        onOpenChange={(o) => { if (!o) setDelPage(null); }}
        title={t("panel.confirmTrashTitle")}
        description={t("panel.confirmTrashDesc", { name: delPage?.title || t("panel.untitled") })}
        confirmLabel={t("panel.sendToTrash")}
        onConfirm={() => { if (delPage) void nbDeletePage(delPage.id); setDelPage(null); }}
      />
    </div>
  );
}
