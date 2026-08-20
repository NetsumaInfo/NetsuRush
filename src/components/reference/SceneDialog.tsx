// Gestionnaire de scènes : liste les scènes enregistrées (ouvrir / supprimer) et permet
// d'enregistrer la scène courante sous un nom. Monté conditionnellement (contrôlé par open).

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Trash2, FolderOpen } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Separator } from "@/components/ui/separator";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { RefSceneMeta } from "@/lib/bridge";
import { useBoard } from "./useReferenceBoard";
import type { useScenePersistence } from "./useScenePersistence";

function fmtDate(ts: number): string {
  try { return new Date(ts).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }); }
  catch { return ""; }
}

export function SceneDialog({
  open,
  onOpenChange,
  persistence,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  persistence: ReturnType<typeof useScenePersistence>;
}) {
  const { t } = useTranslation("reference");
  const sceneName = useBoard((s) => s.sceneName);
  const [scenes, setScenes] = useState<RefSceneMeta[]>([]);
  const [name, setName] = useState(sceneName);
  const [busy, setBusy] = useState(false);

  const refresh = () => persistence.list().then(setScenes);

  useEffect(() => {
    if (open) {
      setName(useBoard.getState().sceneName);
      void refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const doSave = async () => {
    setBusy(true);
    try {
      await persistence.save(name.trim() || t("scene.untitled"));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const doOpen = async (id: string) => {
    await persistence.open(id);
    onOpenChange(false);
  };

  const doDelete = async (id: string) => {
    await persistence.remove(id);
    await refresh();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("scene.title")}</DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.nativeEvent.isComposing) return; if (e.key === "Enter") void doSave(); }}
            placeholder={t("scene.namePlaceholder")}
          />
          <Button onClick={doSave} disabled={busy}>{busy ? <><Spinner className="size-4" />{t("scene.saving")}</> : t("common:action.save")}</Button>
        </div>

        <Separator />

        {scenes.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t("scene.noScenes")}</p>
        ) : (
          <ul className="max-h-72 space-y-1 overflow-y-auto">
            {scenes.map((s) => (
              <li
                key={s.id}
                className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted"
              >
                <button
                  type="button"
                  onClick={() => doOpen(s.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left justify-start rounded hover:bg-muted/50 transition-colors text-foreground text-sm"
                >
                  <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate text-sm">{s.name}</span>
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">{fmtDate(s.updatedAt)}</span>
                </button>
                <button
                  type="button"
                  aria-label={t("scene.delete")}
                  className="opacity-0 group-hover:opacity-100 hoverless:opacity-100 inline-flex items-center justify-center size-6 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                  onClick={() => doDelete(s.id)}
                >
                  <Trash2 className="text-destructive size-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
