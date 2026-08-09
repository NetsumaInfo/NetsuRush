// Sections Favoris / Récents de la sidebar du Carnet : listes plates repliables
// au-dessus de l'arbre de pages. Clic = onglet actif ; Alt-clic / clic-milieu = nouvel onglet.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useApp } from "@/store";
import { ChevronRight, FileText, Star, History } from "lucide-react";
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
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary hover:bg-accent/60 hover:text-foreground"
      >
        <ChevronRight className="h-3 w-3 shrink-0" style={{ transform: open ? "rotate(90deg)" : "none" }} />
        {icon}
        {title}
      </button>
      {open && pages.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={(e) => { if (e.altKey) void openInNewTab(p.id); else void openPage(p.id); }}
          onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); void openInNewTab(p.id); } }}
          className={`flex w-full items-center gap-1.5 rounded-md py-1.5 pr-1.5 pl-5 text-left text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary ${p.id === activeId ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"}`}
        >
          <span className="flex h-4 w-4 shrink-0 items-center justify-center">
            {p.icon ? renderPageIcon(p.icon, "h-3.5 w-3.5", "text-sm") : <FileText className="h-3.5 w-3.5" />}
          </span>
          <span className="min-w-0 flex-1 truncate">{p.title || t("panel.untitled")}</span>
        </button>
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
      <Section title={t("navigation.favorites")} icon={<Star className="h-3 w-3" />} pages={favs} />
      <Section title={t("navigation.recent")} icon={<History className="h-3 w-3" />} pages={recents} defaultOpen={false} />
    </div>
  );
}
