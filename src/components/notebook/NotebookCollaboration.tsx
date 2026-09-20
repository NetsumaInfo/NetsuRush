import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApp } from "@/store";
import type { NotebookCollabBinding } from "@/lib/bridge";
import { convexConfigured } from "@/lib/convexEnv";
import { collabAvailable } from "@/lib/collab/client";
import { CollaborationDialog } from "@/components/collab/CollaborationDialog";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Users, FileText, RotateCw, AlertTriangle } from "lucide-react";
import { notebookBindings } from "./collabSurface";
import { shareNotebook } from "./notebookCollabSession";
import { useNotebookCollaboration } from "./useNotebookCollaboration";

const ICON_BUTTON = "shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40";

export function NotebookCollaboration() {
  const available = convexConfigured && collabAvailable();
  const { t } = useTranslation(["notebook", "collab"]);
  const notebookId = useApp((s) => s.nbActiveId);
  const pageId = useApp((s) => s.nbActivePageId);
  const [bindings, setBindings] = useState<NotebookCollabBinding[]>([]);
  const [scope, setScope] = useState<"notebook" | "notebook-page" | null>(null);
  const [sharePageId, setSharePageId] = useState<string | null>(null);
  const [bindingError, setBindingError] = useState(false);
  useEffect(() => {
    let disposed = false;
    const refresh = () => { void notebookBindings().then((value) => { if (!disposed) { setBindings(value); setBindingError(false); } }).catch(() => { if (!disposed) setBindingError(true); }); };
    if (available) refresh(); window.addEventListener("nr-notebook-binding", refresh);
    return () => { disposed = true; window.removeEventListener("nr-notebook-binding", refresh); };
  }, [notebookId, pageId]);
  const active = bindings.find((b) => !b.pending && b.notebookId === notebookId && (b.surface === "notebook" || b.subjectId === pageId)) ?? null;
  const { error } = useNotebookCollaboration(available ? active : null);
  const selected = bindings.find((b) => !b.pending && b.notebookId === notebookId &&
    (b.surface === "notebook" || (b.surface === scope && b.subjectId === sharePageId)));
  const openScope = (next: "notebook" | "notebook-page", documentId: string | null = pageId) => { setSharePageId(documentId); setScope(next); };
  useEffect(() => {
    const open = (event: Event) => {
      const request = (event as CustomEvent<{ scope: "notebook" | "notebook-page"; pageId?: string }>).detail;
      if (request?.scope === "notebook" || request?.scope === "notebook-page") openScope(request.scope, request.pageId ?? pageId);
    };
    window.addEventListener("nr-notebook-share", open);
    return () => window.removeEventListener("nr-notebook-share", open);
  }, [pageId]);
  useEffect(() => { setScope(null); }, [notebookId]);
  if (!notebookId) return null;
  const unavailable = t(convexConfigured ? "collab:device.desktopOnly" : "collab:notConfigured");
  return <>
    {/* Actions de partage : icônes seules, alignées à droite de la rangée du haut. */}
    <div className="flex shrink-0 items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger
          render={
            <button type="button" onClick={() => openScope("notebook")} aria-label={t("share.notebook")} className={ICON_BUTTON}>
              <Users className="h-4 w-4" />
            </button>
          }
        />
        <TooltipContent>{available ? t("share.notebook") : unavailable}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <button type="button" onClick={() => openScope("notebook-page")} disabled={!pageId} aria-label={t("share.document")} className={ICON_BUTTON}>
              <FileText className="h-4 w-4" />
            </button>
          }
        />
        <TooltipContent>{available ? t("share.document") : unavailable}</TooltipContent>
      </Tooltip>
      {active && (
        <Tooltip>
          <TooltipTrigger
            render={
              <button type="button" onClick={() => window.dispatchEvent(new Event("nr-notebook-collab-retry"))} aria-label={t("share.retry")} className={ICON_BUTTON}>
                <RotateCw className="h-4 w-4" />
              </button>
            }
          />
          <TooltipContent>{t("share.retry")}</TooltipContent>
        </Tooltip>
      )}
      {(error || bindingError) && (
        <Tooltip>
          <TooltipTrigger
            render={
              <span role="alert" aria-label={error || t("share.failed")} className="shrink-0 p-1.5 text-destructive">
                <AlertTriangle className="h-4 w-4" />
              </span>
            }
          />
          <TooltipContent>{error || t("share.failed")}</TooltipContent>
        </Tooltip>
      )}
    </div>
    {available ? <CollaborationDialog open={scope !== null} onOpenChange={(open) => { if (!open) setScope(null); }} projectId={selected?.projectId ?? null}
      onShare={async () => {
        if (scope === "notebook-page" && !sharePageId) throw new Error(t("share.failed"));
        const result = await shareNotebook(notebookId, scope === "notebook-page" ? sharePageId! : undefined);
        setBindings(await notebookBindings()); return result;
      }} onRemoved={() => { setScope(null); window.dispatchEvent(new Event("nr-notebook-binding")); }} /> :
      <Dialog open={scope !== null} onOpenChange={(open) => { if (!open) setScope(null); }}>
        <DialogContent><DialogHeader><DialogTitle>{t("collab:dialog.title")}</DialogTitle>
          <DialogDescription>{unavailable}</DialogDescription>
        </DialogHeader></DialogContent>
      </Dialog>}
  </>;
}
