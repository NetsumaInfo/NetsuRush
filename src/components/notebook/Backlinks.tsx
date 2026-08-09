// Rétroliens : pages du carnet qui @mentionnent la page ouverte (index calculé côté core) + les
// SCRIPTS NetsuDraft qui la mentionnent (scan renderer : les mentions du script sont sérialisées
// `data-page-id` dans le HTML des blocs — peu de docs, pas de nouvelle IPC). Pied de page.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CornerDownRight, PenLine } from "lucide-react";
import { nr } from "@/lib/bridge";
import { useApp } from "@/store";
import i18n from "@/i18n";

interface ScriptRef { id: string; title: string }

// Scripts dont au moins un bloc mentionne la page (marqueur data-page-id="<id>").
async function scanScripts(pageId: string): Promise<ScriptRef[]> {
  try {
    const metas = (await nr.script?.listDocs(null)) ?? [];
    const needle = `data-page-id="${pageId}"`;
    const out: ScriptRef[] = [];
    for (const m of metas) {
      const doc = await nr.script?.loadDoc(m.id);
      if (doc?.blocks?.some((b) => typeof b.text === "string" && b.text.includes(needle))) {
        out.push({ id: m.id, title: m.title || i18n.t("notebook:panel.untitled") });
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function Backlinks() {
  const { t } = useTranslation("notebook");
  const backlinks = useApp((s) => s.nbBacklinks);
  const pageId = useApp((s) => s.nbActivePageId);
  const openPage = useApp((s) => s.nbOpenPage);
  const [scripts, setScripts] = useState<ScriptRef[]>([]);

  useEffect(() => {
    let alive = true;
    setScripts([]);
    if (pageId) void scanScripts(pageId).then((r) => { if (alive) setScripts(r); });
    return () => { alive = false; };
  }, [pageId]);

  if (!backlinks.length && !scripts.length) return null;
  return (
    <div className="mt-8 border-t border-border pt-4">
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("navigation.backlinks")}</div>
      <div className="flex flex-col gap-1">
        {backlinks.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => void openPage(p.id)}
            className="flex items-center gap-2 rounded px-2 py-1 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <CornerDownRight className="h-3.5 w-3.5 shrink-0" />
            <span className="shrink-0">{p.icon || "📄"}</span>
            <span className="truncate">{p.title || t("panel.untitled")}</span>
          </button>
        ))}
        {scripts.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => useApp.getState().setTab("script")}
            className="flex items-center gap-2 rounded px-2 py-1 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <CornerDownRight className="h-3.5 w-3.5 shrink-0" />
            <PenLine className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{s.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
