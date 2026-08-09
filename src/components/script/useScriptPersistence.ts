// Persistance des documents Script : enveloppe nr.script (liste/charge/sauve/supprime) + notices.
// Le store reste pur ; ce hook fait le pont vers le core (ou le mock localStorage en navigateur).

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { nr } from "@/lib/bridge";
import type { ScriptDocMeta } from "./scriptShared";
import { emptyDoc } from "./scriptShared";
import type { HomeScope } from "./home/homeShared";
import { scriptState, useScript } from "./useScript";

export interface Notice { kind: "ok" | "error"; text: string }

// `project` scope la CRÉATION (un script neuf appartient toujours au projet ouvert) ; `scope` ne
// touche que la LISTE — « all » montre les scripts de tous les projets sans détacher les nouveaux.
export function useScriptPersistence(project: string | null | undefined, scope: HomeScope = "project") {
  const { t } = useTranslation("script");
  const [docs, setDocs] = useState<ScriptDocMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = useCallback((n: Notice) => {
    setNotice(n);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 3000);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = (await nr.script?.listDocs(scope === "all" ? null : project ?? null)) ?? [];
      setDocs(list);
    } catch (e) {
      flash({ kind: "error", text: t("persistence.listFailed", { error: String(e) }) });
    } finally {
      setLoading(false);
    }
  }, [project, scope, flash, t]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => () => { if (noticeTimer.current) clearTimeout(noticeTimer.current); }, []);

  const openDoc = useCallback(async (id: string) => {
    try {
      const doc = await nr.script?.loadDoc(id);
      if (doc) useScript.getState().loadDoc(doc);
      else flash({ kind: "error", text: t("persistence.notFound") });
    } catch (e) {
      flash({ kind: "error", text: t("persistence.openFailed", { error: String(e) }) });
    }
  }, [flash, t]);

  const createDoc = useCallback(async () => {
    const doc = emptyDoc(t("common.newScript"), project ?? null);
    useScript.getState().loadDoc(doc);
    try {
      await nr.script?.saveDoc(doc);
      useScript.getState().markSaved();
      void refresh();
    } catch (e) {
      flash({ kind: "error", text: t("persistence.createFailed", { error: String(e) }) });
    }
  }, [project, refresh, flash, t]);

  // Sauvegarde le document courant. Stable → réutilisable par l'autosave.
  const save = useCallback(async () => {
    const doc = scriptState().doc;
    if (!doc) return;
    try {
      const r = await nr.script?.saveDoc(doc);
      if (r && r.ok) {
        useScript.getState().markSaved();
        void refresh();
      } else {
        flash({ kind: "error", text: t("persistence.saveFailed", { error: r?.error ?? t("common.unknown") }) });
      }
    } catch (e) {
      flash({ kind: "error", text: t("persistence.saveFailed", { error: String(e) }) });
    }
  }, [refresh, flash, t]);

  const remove = useCallback(async (id: string) => {
    try {
      await nr.script?.deleteDoc(id);
      if (scriptState().doc?.id === id) useScript.getState().closeDoc();
      void refresh();
    } catch (e) {
      flash({ kind: "error", text: t("persistence.deleteFailed", { error: String(e) }) });
    }
  }, [refresh, flash, t]);

  return { docs, loading, notice, refresh, openDoc, createDoc, save, remove };
}
