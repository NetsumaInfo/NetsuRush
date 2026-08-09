// Fil d'Ariane du Carnet : carnet > ancêtres > page courante — chaque maillon
// cliquable, chevron ▾ = frères de ce niveau, chemin profond replié en « … ». Les flèches d'historique
// vivent dans la barre d'onglets (barre de titre). Masquable via prefs.showBreadcrumb.
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { useApp } from "@/store";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { ChevronRight, MoreHorizontal, NotebookPen, FileText } from "lucide-react";
import { pageAncestors, type PageMeta } from "./notebookShared";
import { renderPageIcon } from "./IconPicker";

function Crumb({ page, current, siblings, onOpen }: {
  page: PageMeta;
  current: boolean;
  siblings: PageMeta[];
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslation("notebook");
  return (
    <span className="flex min-w-0 items-center">
      <button
        type="button"
        onClick={() => { if (!current) onOpen(page.id); }}
        className={`flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-sm transition-colors ${current ? "font-medium text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">
          {page.icon ? renderPageIcon(page.icon, "h-4 w-4", "text-sm") : <FileText className="h-3.5 w-3.5" />}
        </span>
        <span className="max-w-44 truncate">{page.title || t("panel.untitled")}</span>
      </button>
      {siblings.length > 1 && (
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger render={
              <DropdownMenuTrigger render={
                <button type="button" className="rounded p-0.5 text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground">
                  <ChevronRight className="h-3 w-3 rotate-90" />
                </button>
              } />
            } />
            <TooltipContent>{t("navigation.siblings")}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent className="max-h-72 w-56 overflow-y-auto">
            {siblings.map((s) => (
              <DropdownMenuItem key={s.id} onClick={() => onOpen(s.id)} className={s.id === page.id ? "font-medium" : ""}>
                <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                  {s.icon ? renderPageIcon(s.icon, "h-3.5 w-3.5", "text-sm") : <FileText className="h-3.5 w-3.5" />}
                </span>
                <span className="truncate">{s.title || t("panel.untitled")}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </span>
  );
}

export function NotebookBreadcrumb() {
  const { t } = useTranslation("notebook");
  const { nbList, nbActiveId, nbPages, nbActivePageId, nbOpenPage, show } = useApp(useShallow((s) => ({
    nbList: s.nbList,
    nbActiveId: s.nbActiveId,
    nbPages: s.nbPages,
    nbActivePageId: s.nbActivePageId,
    nbOpenPage: s.nbOpenPage,
    show: s.nbPrefs.showBreadcrumb,
  })));

  if (!show || !nbActivePageId) return null;
  const current = nbPages.find((p) => p.id === nbActivePageId);
  if (!current) return null;
  const nb = nbList.find((n) => n.id === nbActiveId);
  const ancestors = pageAncestors(nbPages, current.id);
  // Chemin profond : garde 1er ancêtre, replie le milieu en « … », garde le parent direct.
  const deep = ancestors.length > 3;
  const shown = deep ? [ancestors[0]] : ancestors;
  const hidden = deep ? ancestors.slice(1, -1) : [];
  const tail = deep ? [ancestors[ancestors.length - 1]] : [];
  const siblingsOf = (p: PageMeta) => nbPages.filter((x) => (x.parentId ?? null) === (p.parentId ?? null));
  const open = (id: string) => void nbOpenPage(id);
  const sep = <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />;

  return (
    <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
        {nb && (
          <>
            <span className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm text-muted-foreground">
              <NotebookPen className="h-4 w-4 shrink-0 text-primary" />
              <span className="max-w-32 truncate">{nb.title}</span>
            </span>
            {sep}
          </>
        )}
        {shown.map((p) => (
          <span key={p.id} className="flex min-w-0 items-center gap-0.5">
            <Crumb page={p} current={false} siblings={siblingsOf(p)} onOpen={open} />
            {sep}
          </span>
        ))}
        {hidden.length > 0 && (
          <span className="flex items-center gap-0.5">
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger render={
                  <DropdownMenuTrigger render={
                    <button type="button" className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
                      <MoreHorizontal className="h-4 w-4" />
                    </button>
                  } />
                } />
                <TooltipContent>{t("navigation.intermediate")}</TooltipContent>
              </Tooltip>
              <DropdownMenuContent className="w-56">
                {hidden.map((p) => (
                  <DropdownMenuItem key={p.id} onClick={() => open(p.id)}>
                    <span className="truncate">{p.title || t("panel.untitled")}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            {sep}
          </span>
        )}
        {tail.map((p) => (
          <span key={p.id} className="flex min-w-0 items-center gap-0.5">
            <Crumb page={p} current={false} siblings={siblingsOf(p)} onOpen={open} />
            {sep}
          </span>
        ))}
        <Crumb page={current} current siblings={siblingsOf(current)} onOpen={open} />
    </div>
  );
}
