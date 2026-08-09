// « Déplacer vers… » (menu ⋯ du document + clic droit de l'arbre) : choisit la destination d'une page
// — la racine du carnet ou n'importe quelle autre page (hors elle-même et sa descendance, anti-cycle).
// Liste aplatie de l'arbre (indentée), filtrable par titre.
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApp } from "@/store";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FileText, NotebookPen } from "lucide-react";
import { buildPageTree, subtreeIds, type PageTreeNode } from "./notebookShared";
import { renderPageIcon } from "./IconPicker";

// Aplatit l'arbre en gardant la profondeur (indentation visuelle).
function flatten(nodes: PageTreeNode[], out: PageTreeNode[] = []): PageTreeNode[] {
  for (const n of nodes) { out.push(n); flatten(n.children, out); }
  return out;
}

export function MovePageDialog({ pageId, onClose }: { pageId: string | null; onClose: () => void }) {
  const { t } = useTranslation("notebook");
  const pages = useApp((s) => s.nbPages);
  const movePage = useApp((s) => s.nbMovePage);
  const [q, setQ] = useState("");
  useEffect(() => { if (pageId) setQ(""); }, [pageId]);

  const candidates = useMemo(() => {
    if (!pageId) return [];
    const excluded = new Set(subtreeIds(pages, pageId));
    const flat = flatten(buildPageTree(pages)).filter((n) => !excluded.has(n.id));
    const needle = q.trim().toLowerCase();
    return needle ? flat.filter((n) => (n.title || t("panel.untitled")).toLowerCase().includes(needle)) : flat;
  }, [pages, pageId, q, t]);

  const move = async (targetId: string | null) => {
    if (pageId) await movePage(pageId, targetId, Date.now());
    onClose();
  };

  return (
    <Dialog open={!!pageId} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-sm gap-3">
        <DialogTitle>{t("navigation.moveTo")}</DialogTitle>
        <Input autoFocus placeholder={t("navigation.filterPages")} value={q} onChange={(e) => setQ(e.target.value)} />
        <ScrollArea className="max-h-72">
          <button
            type="button"
            onClick={() => void move(null)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <NotebookPen className="h-3.5 w-3.5 shrink-0 text-primary" /> {t("navigation.notebookRoot")}
          </button>
          {candidates.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => void move(n.id)}
              style={{ paddingLeft: 8 + (q.trim() ? 0 : n.depth) * 14 }}
              className="flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                {n.icon ? renderPageIcon(n.icon, "h-3.5 w-3.5", "text-sm") : <FileText className="h-3.5 w-3.5" />}
              </span>
              <span className="min-w-0 flex-1 truncate">{n.title || t("panel.untitled")}</span>
            </button>
          ))}
          {!candidates.length && <div className="px-2 py-4 text-center text-xs text-muted-foreground">{t("navigation.noMatch")}</div>}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
