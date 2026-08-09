// Projets connus de la recherche : la liste que le sélecteur de portée propose. Elle se remplit
// toute seule à la lecture d'un Media Pool ; on la gère ICI (recenser, oublier) plutôt que dans le
// panneau de portée, qui doit rester un simple sélecteur.
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderKanban, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { nr, type ProjectScopeEntry, type ProjectScanProgress } from "@/lib/bridge";
import { useApp } from "@/store";

function fmtDate(ms: number, locale: string): string {
  if (!ms) return "";
  return new Date(ms).toLocaleDateString(locale, { day: "2-digit", month: "short", year: "numeric" });
}

export function ProjectsSection() {
  const { t, i18n } = useTranslation(["settings", "common"]);
  const reloadScope = useApp((s) => s.loadProjectScope);
  const [projects, setProjects] = useState<ProjectScopeEntry[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [scan, setScan] = useState<ProjectScanProgress | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await nr.projects();
      setProjects(r.projects);
      setCurrent(r.current);
    } catch {
      setProjects([]);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => nr.onProjectScan((p) => setScan(p.finished ? null : p)), []);

  async function runScan() {
    setNotice(null);
    setScan({ done: 0, total: 0, project: null });
    const r = await nr.scanProjects();
    setScan(null);
    setNotice(r.ok
      ? t("settings:storage.projects.scanDone", { count: r.scanned ?? 0 })
      : r.error || t("common:action.error"));
    await load();
    void reloadScope();
  }

  async function forget(name: string) {
    await nr.forgetProject(name);
    await load();
    void reloadScope();
  }

  const scanning = scan !== null;

  return (
    <section className="space-y-3">
      <div className="rounded-lg border border-border p-3">
        <h4 className="text-xs font-medium text-foreground">{t("settings:storage.projects.title")}</h4>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t("settings:storage.projects.desc")}</p>
        <div className="mt-3 flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => void runScan()} disabled={scanning}>
            {scanning ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" />}
            {t("settings:storage.projects.scan")}
          </Button>
          {notice && <span className="text-xs text-muted-foreground">{notice}</span>}
        </div>
        {scanning && (
          <div className="mt-3 space-y-1.5">
            {/* total inconnu au démarrage → barre indéterminée (null), pas une barre à 0 % figée. */}
            <Progress value={scan.total ? Math.round((scan.done / scan.total) * 100) : null} />
            <p className="text-xs text-muted-foreground">
              {scan.project
                ? t("settings:storage.projects.scanning", { project: scan.project, done: scan.done + 1, total: scan.total })
                : t("settings:storage.projects.scanStarting")}
            </p>
          </div>
        )}
      </div>

      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
        {projects === null && (
          <li className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
            <Spinner className="size-3.5" /> {t("common:action.loading")}
          </li>
        )}
        {projects?.length === 0 && (
          <li className="p-3 text-xs text-muted-foreground">{t("settings:storage.projects.empty")}</li>
        )}
        {projects?.map((p) => (
          <li key={p.name} className="flex items-center gap-3 p-3">
            <FolderKanban className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm text-foreground">{p.name}</span>
                {p.name === current && <Badge variant="secondary">{t("settings:storage.projects.current")}</Badge>}
              </div>
              <p className="text-xs text-muted-foreground">
                {t("settings:storage.projects.rushCount", { count: p.count })}
                {p.at ? ` · ${fmtDate(p.at, i18n.language)}` : ""}
              </p>
            </div>
            <Tooltip>
              <TooltipTrigger render={<Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive"
                aria-label={t("settings:storage.projects.forget")} onClick={() => void forget(p.name)} />}>
                <Trash2 className="size-4" />
              </TooltipTrigger>
              <TooltipContent>{t("settings:storage.projects.forgetTooltip")}</TooltipContent>
            </Tooltip>
          </li>
        ))}
      </ul>
    </section>
  );
}
