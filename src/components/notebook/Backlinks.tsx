// Rétroliens : pages du carnet qui @mentionnent la page ouverte (index calculé côté core). Pied de page.
import { useTranslation } from "react-i18next";
import { CornerDownRight } from "lucide-react";
import { useApp } from "@/store";

export function Backlinks() {
  const { t } = useTranslation("notebook");
  const backlinks = useApp((s) => s.nbBacklinks);
  const openPage = useApp((s) => s.nbOpenPage);
  if (!backlinks.length) return null;
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
      </div>
    </div>
  );
}
