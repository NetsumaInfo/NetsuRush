// Historique de versions : points de contrôle manuels du
// document + restauration. Avant chaque restauration, un snapshot « Avant restauration » est posé
// automatiquement → jamais de perte. Le snapshot restauré garde l'id du doc (la sauvegarde suivante
// écrase le document courant, pas une copie).

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { History, Loader2, RotateCcw, Trash2 } from "lucide-react";
import { nr, type ScriptVersionMeta } from "@/lib/bridge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { scriptState, useScript } from "./useScript";

function fmtDate(ts: number, locale: string): string {
  return new Date(ts).toLocaleString(locale, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function VersionHistory({ onClose, save }: { onClose: () => void; save: () => Promise<void> | void }) {
  const { t, i18n } = useTranslation("script");
  const doc = useScript((s) => s.doc);
  const [versions, setVersions] = useState<ScriptVersionMeta[]>([]);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState<string | null>(null); // "save" | id en cours
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!doc) return;
    try { setVersions((await nr.script?.listVersions(doc.id)) ?? []); } catch (e) { setError(String(e)); }
  }, [doc]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function saveVersion(customLabel?: string) {
    const d = scriptState().doc;
    if (!d) return;
    setBusy("save");
    setError(null);
    try {
      await save(); // le snapshot reflète l'état SAUVÉ (pas un brouillon divergent)
      const r = await nr.script?.saveVersion(d.id, customLabel ?? label.trim(), d);
      if (!r?.ok) setError(r?.error ?? t("versions.saveFailed"));
      else { setLabel(""); await refresh(); }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function restore(v: ScriptVersionMeta) {
    setBusy(v.id);
    setError(null);
    try {
      const full = await nr.script?.getVersion(v.id);
      if (!full?.doc) { setError(t("versions.unreadable")); return; }
      // Filet : snapshot de l'état courant avant d'écraser.
      const d = scriptState().doc;
      if (d) await nr.script?.saveVersion(d.id, t("versions.beforeRestore"), d);
      useScript.getState().loadDoc({ ...full.doc, id: v.docId });
      await save();
      await refresh();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string) {
    setBusy(id);
    try {
      await nr.script?.deleteVersion(id);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogTitle className="flex items-center gap-2"><History className="size-4" /> {t("versions.title")}</DialogTitle>

        <div className="flex items-center gap-2">
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t("versions.namePlaceholder")}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) void saveVersion(); }}
          />
          <Button disabled={busy === "save"} onClick={() => void saveVersion()}>
            {busy === "save" ? <Loader2 className="size-4 animate-spin" /> : null} {t("common.save")}
          </Button>
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}

        <div className="max-h-72 overflow-y-auto">
          {versions.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">{t("versions.empty")}</p>
          ) : (
            versions.map((v) => (
              // Clic droit : restaurer/supprimer sans viser les petits boutons de la rangée.
              <ContextMenu key={v.id}>
                <ContextMenuTrigger render={<div className="flex items-center gap-2 border-b border-border py-2 last:border-0" />}>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{v.label || t("versions.unnamed")}</div>
                    <div className="text-xs text-muted-foreground">{fmtDate(v.createdAt, i18n.language)}</div>
                  </div>
                  <Tooltip>
                    <TooltipTrigger render={<Button variant="outline" size="sm" disabled={busy === v.id} onClick={() => void restore(v)} />}>
                      {busy === v.id ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
                    </TooltipTrigger>
                    <TooltipContent>{t("versions.restoreThis")}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger render={<Button variant="ghost" size="sm" disabled={busy === v.id} onClick={() => void remove(v.id)} />}>
                      <Trash2 className="size-3.5" />
                    </TooltipTrigger>
                    <TooltipContent>{t("common.delete")}</TooltipContent>
                  </Tooltip>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onClick={() => void restore(v)} disabled={busy === v.id}><RotateCcw /> {t("common.restore")}</ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem variant="destructive" onClick={() => void remove(v.id)} disabled={busy === v.id}><Trash2 /> {t("common.delete")}</ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
