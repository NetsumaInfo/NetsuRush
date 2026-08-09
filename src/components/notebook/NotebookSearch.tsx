// Recherche plein-texte du carnet (Dialog, Ctrl+P) : titres + texte des blocs, résultats avec extrait,
// clic = ouvre la page À L'ANCRE du bloc contenant le terme (scroll + surbrillance).
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useApp } from "@/store";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Search, FileText, History } from "lucide-react";
import { renderPageIcon } from "./IconPicker";

export function NotebookSearch({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation("notebook");
  const { results, runSearch, clearSearch, openPage, nbPages, nbRecents } = useApp(useShallow((s) => ({
    results: s.nbSearchResults,
    runSearch: s.nbRunSearch,
    clearSearch: s.nbClearSearch,
    openPage: s.nbOpenPage,
    nbPages: s.nbPages,
    nbRecents: s.nbRecents,
  })));
  const [query, setQuery] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Débounce : la recherche scanne toutes les pages côté core, pas besoin de tirer à chaque frappe.
  useEffect(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void runSearch(query), 220);
    return () => clearTimeout(timer.current);
  }, [query, runSearch]);

  // Fermeture → repart propre à la prochaine ouverture.
  useEffect(() => {
    if (!open) { setQuery(""); clearSearch(); }
  }, [open, clearSearch]);

  const pick = (pageId: string, blockId: string) => {
    onOpenChange(false);
    void openPage(pageId, { blockId: blockId || undefined });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg gap-3">
        <DialogHeader>
          <DialogTitle>{t("navigation.searchTitle")}</DialogTitle>
          <DialogDescription className="sr-only">{t("navigation.searchDescription")}</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.nativeEvent.isComposing) return; if (e.key === "Enter" && results[0]) { e.preventDefault(); pick(results[0].pageId, results[0].blockId); } }}
            placeholder={t("navigation.searchPlaceholder")}
            className="pl-8"
          />
        </div>
        <div className="max-h-80 overflow-y-auto">
          {query.trim() && !results.length && (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">{t("navigation.noSearchResult", { query: query.trim() })}</p>
          )}
          {/* Requête vide → pages récentes, clic direct. */}
          {!query.trim() && (() => {
            const byId = new Map(nbPages.map((p) => [p.id, p]));
            const recents = nbRecents.map((id) => byId.get(id)).filter(Boolean).slice(0, 8);
            if (!recents.length) return null;
            return (
              <>
                <div className="flex items-center gap-1 px-2 pt-1 pb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground/70 uppercase">
                  <History className="h-3 w-3" /> {t("navigation.recent")}
                </div>
                {recents.map((p) => p && (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => pick(p.id, "")}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted"
                  >
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                      {p.icon ? renderPageIcon(p.icon, "h-3.5 w-3.5", "text-sm") : <FileText className="h-3.5 w-3.5 text-muted-foreground" />}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm">{p.title || t("panel.untitled")}</span>
                  </button>
                ))}
              </>
            );
          })()}
          {results.map((r) => (
            <button
              key={`${r.pageId}-${r.blockId}`}
              type="button"
              onClick={() => pick(r.pageId, r.blockId)}
              className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-muted"
            >
              <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                {r.icon ? renderPageIcon(r.icon, "h-3.5 w-3.5", "text-sm") : <FileText className="h-3.5 w-3.5 text-muted-foreground" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{r.title || t("panel.untitled")}</span>
                {r.snippet && <span className="block truncate text-xs text-muted-foreground">{r.snippet}</span>}
              </span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
