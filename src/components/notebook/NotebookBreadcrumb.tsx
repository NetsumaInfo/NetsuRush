// Fil d'Ariane du Carnet : carnet > ancêtres > page courante — chaque maillon
// cliquable, chevron ▾ = frères de ce niveau, chemin profond replié en « … ». Les flèches d'historique
// vivent dans la barre d'onglets (barre de titre). Masquable via prefs.showBreadcrumb.
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { useApp } from "@/store";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { NetsuIcon } from "@/components/ui/netsu-icon";
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
      <Button variant="ghost"
        type="button"
        onClick={() => { if (!current) onOpen(page.id); }}
        className={cn("h-auto gap-0 rounded-none px-0 py-0 text-[length:inherit] font-normal whitespace-normal hover:bg-transparent dark:hover:bg-transparent justify-start shrink select-auto active:not-aria-[haspopup]:translate-y-0", `flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-sm transition-colors ${current ? "font-medium text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`)}
      >
        <span className="flex size-4 shrink-0 items-center justify-center">
          {page.icon ? renderPageIcon(page.icon, "size-4", "text-sm") : <NetsuIcon name="file-text" className="size-3.5" />}
        </span>
        <span className="max-w-44 truncate">{page.title || t("panel.untitled")}</span>
      </Button>
      {siblings.length > 1 && (
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger render={
              <DropdownMenuTrigger render={
                <Button variant="ghost" type="button" className="h-auto gap-0 rounded-none px-0 py-0 text-[length:inherit] font-normal whitespace-normal hover:bg-transparent dark:hover:bg-transparent justify-start shrink select-auto active:not-aria-[haspopup]:translate-y-0 rounded p-0.5 text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground">
                  <NetsuIcon name="chevron-down" className="size-3" />
                </Button>
              } />
            } />
            <TooltipContent>{t("navigation.siblings")}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent className="max-h-72 w-56 overflow-y-auto">
            {siblings.map((s) => (
              <DropdownMenuItem key={s.id} onClick={() => onOpen(s.id)} className={s.id === page.id ? "font-medium" : ""}>
                <span className="flex size-4 shrink-0 items-center justify-center">
                  {s.icon ? renderPageIcon(s.icon, "size-3.5", "text-sm") : <NetsuIcon name="file-text" className="size-3.5" />}
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
  const sep = <NetsuIcon name="chevron-toggle" className="size-3.5 shrink-0 text-muted-foreground/40" />;

  return (
    <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
        {nb && (
          <>
            <span className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm text-muted-foreground">
              <NetsuIcon name="notebook" className="size-4 shrink-0 text-primary" />
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
                    <Button variant="ghost" type="button" className="h-auto gap-0 rounded-none px-0 py-0 text-[length:inherit] font-normal whitespace-normal hover:bg-transparent dark:hover:bg-transparent justify-start shrink select-auto active:not-aria-[haspopup]:translate-y-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
                      <NetsuIcon name="more" className="size-4" />
                    </Button>
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
