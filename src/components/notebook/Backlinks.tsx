// Rétroliens : pages du carnet qui @mentionnent la page ouverte (index calculé côté core). Pied de page.
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";
import { NetsuIcon } from "@/components/ui/netsu-icon";
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
          <Button variant="ghost"
            key={p.id}
            type="button"
            onClick={() => void openPage(p.id)}
            className="h-auto gap-0 rounded-none px-0 py-0 text-[length:inherit] font-normal whitespace-normal hover:bg-transparent dark:hover:bg-transparent flex items-center gap-2 rounded px-2 py-1 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <NetsuIcon name="subpage" className="size-3.5 shrink-0" />
            <span className="shrink-0">{p.icon || "📄"}</span>
            <span className="truncate">{p.title || t("panel.untitled")}</span>
          </Button>
        ))}
      </div>
    </div>
  );
}
