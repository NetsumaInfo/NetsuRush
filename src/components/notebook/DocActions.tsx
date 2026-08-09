// Actions du document ouvert (droite du fil d'Ariane) : étoile favori + menu ⋯
// (nouvel onglet, copier le lien, dupliquer, déplacer, exporter Markdown/HTML, corbeille) et infos
// (mots / caractères / dernière modification) calculées à l'OUVERTURE du menu seulement.
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import { useShallow } from "zustand/react/shallow";
import { useApp } from "@/store";
import { nr } from "@/lib/bridge";
import { coreAvailable } from "@/lib/coreClient";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Star, MoreHorizontal, ExternalLink, Link2, Copy, FolderInput, FileDown, FileCode, Package, Trash2 } from "lucide-react";
import { NBPAGE_LINK_PREFIX, pageStats, formatTimestamp, type NoteBlock } from "./notebookShared";
import { blocksToMarkdown, blocksToStandaloneHtml, safeFileName, type ExportContext } from "./notebookExport";

// Pied du menu : stats du document — monté seulement quand le menu est ouvert (pas de re-calcul à la frappe).
function DocInfo({ blocks, updatedAt }: { blocks: NoteBlock[]; updatedAt: number }) {
  const { t } = useTranslation("notebook");
  const stats = useMemo(() => pageStats(blocks), [blocks]);
  return (
    <div className="px-2 py-1.5 text-xs text-muted-foreground">
      <div>{t("actions.stats", { words: stats.words, chars: stats.chars })}</div>
      <div>{t("actions.modified", { date: formatTimestamp(updatedAt) })}</div>
    </div>
  );
}

// Exporte la page ouverte : dossier choisi par l'utilisateur (Tauri) ou téléchargement (mock navigateur).
// Le contexte d'export résout les databases + titres de sous-pages (traduits en tableaux / liens).
async function exportPage(kind: "md" | "html") {
  const s = useApp.getState();
  const page = s.nbPage;
  if (!page) return;
  const ctx: ExportContext = {
    databases: s.nbDatabases,
    pageTitle: (id) => s.nbPages.find((p) => p.id === id)?.title ?? null,
  };
  const text = kind === "md"
    ? await blocksToMarkdown(page.blocks, ctx)
    : await blocksToStandaloneHtml(
      page.blocks,
      page.title || i18n.t("notebook:panel.untitled"),
      page.icon,
      ctx,
      s.nbList.find((notebook) => notebook.id === s.nbActiveId)?.language || "fr",
    );
  const name = `${safeFileName(page.title)}.${kind}`;
  let target = name;
  if (coreAvailable) {
    const dir = await nr.chooseDir();
    if (!dir) return; // annulé
    target = `${dir}/${name}`;
  }
  await nr.notebook?.writeExport(target, text);
}

// Exporte la page ouverte + son sous-arbre dans le format commun .netsu.
// réimportable à l'identique via le menu du carnet.
async function exportPageNetsu() {
  const s = useApp.getState();
  const page = s.nbPage;
  if (!page || !s.nbActiveId) return;
  const dir = await nr.chooseDir();
  if (!dir) return; // annulé
  await nr.notebook?.exportFile({
    notebookId: s.nbActiveId,
    rootId: page.id,
    dest: `${dir}/${safeFileName(page.title)}.netsu`,
  });
}

export function DocActions({ onMove, onAskDelete }: {
  onMove: (id: string) => void;
  onAskDelete: (id: string, title: string) => void;
}) {
  const { t } = useTranslation("notebook");
  const { pageId, title, isFav } = useApp(useShallow((s) => ({
    pageId: s.nbPage?.id ?? null,
    title: s.nbPage?.title ?? "",
    isFav: !!s.nbPage && s.nbFavorites.includes(s.nbPage.id),
  })));
  const toggleFav = useApp((s) => s.nbToggleFavorite);
  const openInNewTab = useApp((s) => s.nbOpenInNewTab);
  const duplicate = useApp((s) => s.nbDuplicatePage);
  if (!pageId) return null;

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={() => toggleFav(pageId)}
              className={`rounded-md p-1.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary hover:bg-accent ${isFav ? "text-primary" : "text-muted-foreground hover:text-foreground"}`}
            >
              <Star className={`h-4 w-4 ${isFav ? "fill-current" : ""}`} />
            </button>
          }
        />
        <TooltipContent>{isFav ? t("actions.removeFavorite") : t("actions.addFavorite")}</TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                render={
                  <button type="button" className="rounded-md p-1.5 text-muted-foreground transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary hover:bg-accent hover:text-foreground">
                    <MoreHorizontal className="h-4 w-4" />
                  </button>
                }
              />
            }
          />
          <TooltipContent>{t("actions.documentActions")}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuItem onClick={() => void openInNewTab(pageId)}><ExternalLink className="mr-1 h-3.5 w-3.5" /> {t("actions.openNewTab")}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => void navigator.clipboard.writeText(`${NBPAGE_LINK_PREFIX}${pageId}`)}><Link2 className="mr-1 h-3.5 w-3.5" /> {t("actions.copyPageLink")}</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => void duplicate(pageId)}><Copy className="mr-1 h-3.5 w-3.5" /> {t("actions.duplicate")}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => onMove(pageId)}><FolderInput className="mr-1 h-3.5 w-3.5" /> {t("navigation.moveTo")}</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => void exportPage("md")}><FileDown className="mr-1 h-3.5 w-3.5" /> {t("actions.exportMarkdown")}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => void exportPage("html")}><FileCode className="mr-1 h-3.5 w-3.5" /> {t("actions.exportHtml")}</DropdownMenuItem>
          {coreAvailable && (
            <DropdownMenuItem onClick={() => void exportPageNetsu()}><Package className="mr-1 h-3.5 w-3.5" /> {t("actions.exportNetsu")}</DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => onAskDelete(pageId, title)} className="text-destructive"><Trash2 className="mr-1 h-3.5 w-3.5" /> {t("panel.sendToTrash")}</DropdownMenuItem>
          <DropdownMenuSeparator />
          <InfoFooter />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// Lit la page fraîche au montage du contenu (le menu vient de s'ouvrir).
function InfoFooter() {
  const page = useApp.getState().nbPage;
  if (!page) return null;
  return <DocInfo blocks={page.blocks} updatedAt={page.updatedAt} />;
}
