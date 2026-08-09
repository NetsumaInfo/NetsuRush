// Corbeille du carnet (Dialog) : pages supprimées en douceur → Restaurer (revient dans l'arbre, avec
// sa descendance) ou Supprimer définitivement. « Vider la corbeille » purge tout (confirmation).
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useApp } from "@/store";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Trash2, Undo2, FileText, X } from "lucide-react";
import { renderPageIcon } from "./IconPicker";

export function NotebookTrash({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation("notebook");
  const { trash, loadTrash, restorePage, purgePage, emptyTrash } = useApp(useShallow((s) => ({
    trash: s.nbTrash,
    loadTrash: s.nbLoadTrash,
    restorePage: s.nbRestorePage,
    purgePage: s.nbPurgePage,
    emptyTrash: s.nbEmptyTrash,
  })));
  const [confirmEmpty, setConfirmEmpty] = useState(false);

  useEffect(() => {
    if (open) { setConfirmEmpty(false); void loadTrash(); }
  }, [open, loadTrash]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg gap-3">
        <DialogHeader>
          <DialogTitle>{t("trash.title")}</DialogTitle>
          <DialogDescription>
            {trash.length ? t("trash.count", { count: trash.length }) : t("trash.description")}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-80 overflow-y-auto">
          {!trash.length && (
            <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
              <Trash2 className="h-8 w-8 opacity-40" />
              <p className="text-sm">{t("trash.empty")}</p>
            </div>
          )}
          {trash.map((p) => (
            <div key={p.id} className="group flex items-center gap-2 rounded px-2 py-1.5 hover:bg-muted">
              <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                {p.icon ? renderPageIcon(p.icon, "h-3.5 w-3.5", "text-sm") : <FileText className="h-3.5 w-3.5 text-muted-foreground" />}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm">{p.title || t("panel.untitled")}</span>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button size="sm" variant="ghost" onClick={() => void restorePage(p.id)}>
                      <Undo2 className="size-3.5" /> {t("trash.restore")}
                    </Button>
                  }
                />
                <TooltipContent>{t("trash.restoreWithChildren")}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button size="sm" variant="ghost" onClick={() => void purgePage(p.id)} className="text-destructive">
                      <X className="size-3.5" />
                    </Button>
                  }
                />
                <TooltipContent>{t("trash.deleteForever")}</TooltipContent>
              </Tooltip>
            </div>
          ))}
        </div>
        {trash.length > 0 && (
          <div className="flex justify-end gap-2 border-t border-border pt-3">
            {confirmEmpty ? (
              <>
                <span className="self-center text-xs text-muted-foreground">{t("trash.confirmAll")}</span>
                <Button size="sm" variant="outline" onClick={() => setConfirmEmpty(false)}>{t("trash.cancel")}</Button>
                <Button size="sm" variant="destructive" onClick={() => { void emptyTrash(); setConfirmEmpty(false); }}>
                  <Trash2 className="size-3.5" /> {t("trash.deleteAll")}
                </Button>
              </>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setConfirmEmpty(true)} className="text-destructive">
                <Trash2 className="size-3.5" /> {t("trash.emptyTrash")}
              </Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
