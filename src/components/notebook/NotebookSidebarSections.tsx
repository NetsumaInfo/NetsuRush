// Sections Favoris / Récents de la sidebar du Carnet : listes plates repliables
// au-dessus de l'arbre de pages. Clic = onglet actif ; Alt-clic / clic-milieu = nouvel onglet.
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useApp } from "@/store";
import { NetsuIcon } from "@/components/ui/netsu-icon";
import { renderPageIcon } from "./IconPicker";
import type { PageMeta } from "./notebookShared";

function Section({ title, icon, pages, defaultOpen = true }: {
  title: string;
  icon: React.ReactNode;
  pages: PageMeta[];
  defaultOpen?: boolean;
}) {
  const { t } = useTranslation("notebook");
  const [open, setOpen] = useState(defaultOpen);
  const openPage = useApp((s) => s.nbOpenPage);
  const openInNewTab = useApp((s) => s.nbOpenInNewTab);
  const activeId = useApp((s) => s.nbActivePageId);
  if (!pages.length) return null;
  return (
    <div className="mb-1.5">
      <Button variant="ghost"
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="h-auto gap-0 rounded-none px-0 py-0 text-[length:inherit] font-normal whitespace-normal hover:bg-transparent dark:hover:bg-transparent justify-start shrink select-auto active:not-aria-[haspopup]:translate-y-0 flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary hover:bg-accent/60 hover:text-foreground"
      >
        <NetsuIcon name="chevron-toggle" on={open} className="size-3 shrink-0" />
        {icon}
        {title}
      </Button>
      {open && pages.map((p) => (
        <Button variant="ghost"
          key={p.id}
          type="button"
          onClick={(e) => { if (e.altKey) void openInNewTab(p.id); else void openPage(p.id); }}
          onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); void openInNewTab(p.id); } }}
          className={cn("h-auto gap-0 rounded-none px-0 py-0 text-[length:inherit] font-normal whitespace-normal hover:bg-transparent dark:hover:bg-transparent justify-start shrink select-auto active:not-aria-[haspopup]:translate-y-0", `flex w-full items-center gap-1.5 rounded-md py-1.5 pr-1.5 pl-5 text-left text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary ${p.id === activeId ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"}`)}
        >
          <span className="flex size-4 shrink-0 items-center justify-center">
            {p.icon ? renderPageIcon(p.icon, "size-3.5", "text-sm") : <NetsuIcon name="file-text" className="size-3.5" />}
          </span>
          <span className="min-w-0 flex-1 truncate">{p.title || t("panel.untitled")}</span>
        </Button>
      ))}
    </div>
  );
}

export function NotebookSidebarSections() {
  const { t } = useTranslation("notebook");
  const { nbPages, nbFavorites, nbRecents } = useApp(useShallow((s) => ({
    nbPages: s.nbPages,
    nbFavorites: s.nbFavorites,
    nbRecents: s.nbRecents,
  })));
  const byId = new Map(nbPages.map((p) => [p.id, p]));
  const favs = nbFavorites.map((id) => byId.get(id)).filter(Boolean) as PageMeta[];
  // Récents : hors page déjà en favoris, plafonnés pour rester discrets.
  const recents = nbRecents.map((id) => byId.get(id)).filter((p): p is PageMeta => !!p && !nbFavorites.includes(p.id)).slice(0, 5);
  if (!favs.length && !recents.length) return null;
  return (
    <div className="px-1.5 pb-1">
      <Section title={t("navigation.favorites")} icon={<NetsuIcon name="star" className="size-3" />} pages={favs} />
      <Section title={t("navigation.recent")} icon={<NetsuIcon name="history" className="size-3" />} pages={recents} defaultOpen={false} />
    </div>
  );
}
