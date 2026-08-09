import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { FolderKanban, Library, RefreshCw, X } from "lucide-react";

import { useApp } from "@/store";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Progress } from "@/components/ui/progress";
import { nr, type ProjectScanProgress } from "@/lib/bridge";

// Panneau latéral de PORTÉE : quels projets de montage la recherche (plans, visages, compteurs)
// prend en compte. Sélection vide = projet actuellement ouvert — c'est le défaut voulu ; cocher
// d'autres projets élargit la portée sans jamais quitter le projet courant.
//
// Les projets listés sont ceux DÉJÀ ouverts une fois dans NetsuRush : l'API du logiciel de montage
// n'expose le Media Pool que du projet courant, le registre core est donc la seule source possible.
export function ProjectScopeSheet() {
  const { t } = useTranslation("search");
  const { open, setOpen, scope, selected, setSelected, searchScope, setSearchScope, load } = useApp(useShallow((s) => ({
    open: s.projectScopeOpen,
    setOpen: s.setProjectScopeOpen,
    scope: s.projectScope,
    selected: s.selectedProjects,
    setSelected: s.setSelectedProjects,
    searchScope: s.searchScope,
    setSearchScope: s.setSearchScope,
    load: s.loadProjectScope,
  })));
  // Recensement : ouvre chaque projet Resolve tour à tour pour relever ses rushs. Accessible ICI
  // parce que c'est là qu'on constate qu'un ancien projet manque.
  const [scan, setScan] = useState<ProjectScanProgress | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  useEffect(() => nr.onProjectScan((p) => setScan(p.finished ? null : p)), []);

  const runScan = async () => {
    setScanError(null);
    setScan({ done: 0, total: 0, project: null });
    const r = await nr.scanProjects();
    setScan(null);
    if (!r.ok) setScanError(r.error || "");
    await load();
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  if (!open) return null;

  const projects = scope?.projects ?? [];
  const current = scope?.current ?? null;
  // Sélection vide = « projet actuel » : on le montre coché sans l'écrire dans la préférence.
  const allScope = searchScope === "all";
  const isChecked = (name: string) =>
    allScope ? false : (selected.length ? selected.includes(name) : name === current);

  const toggle = (name: string) => {
    // Cocher un projet quitte le mode « tout l'index ».
    if (allScope) setSearchScope("project");
    const base = selected.length ? selected : (current ? [current] : []);
    const next = base.includes(name) ? base.filter((n) => n !== name) : [...base, name];
    // Tout décocher revient au défaut (projet actuel) plutôt qu'à une portée vide qui ne trouverait rien.
    setSelected(next.length ? next : []);
  };

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
      <aside
        className="fixed right-0 top-0 z-50 flex h-full w-80 max-w-[calc(100vw-2rem)] flex-col border-l border-border bg-card shadow-2xl animate-in slide-in-from-right-8 fade-in-0 duration-200"
        aria-label={t("projectScope.title")}
      >
        <header className="flex items-center gap-1 border-b border-border py-2 pr-2 pl-3">
          <FolderKanban className="size-4 shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate pl-1 text-sm font-medium">{t("projectScope.title")}</span>
          <Tooltip>
            <TooltipTrigger render={
              <Button variant="ghost" size="icon-sm" disabled={!!scan} onClick={() => void runScan()} aria-label={t("projectScope.scan")} />
            }>
              {scan ? <Spinner className="size-4" /> : <RefreshCw className="size-4" />}
            </TooltipTrigger>
            <TooltipContent>{t("projectScope.scan")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={() => setOpen(false)} aria-label={t("projectScope.close")} />}>
              <X className="size-4" />
            </TooltipTrigger>
            <TooltipContent>{t("projectScope.close")}</TooltipContent>
          </Tooltip>
        </header>

        <div className="p-2">
          <button
            type="button"
            onClick={() => setSearchScope(allScope ? "project" : "all")}
            className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-muted ${allScope ? "bg-primary/10 text-primary hover:bg-primary/15" : ""}`}
          >
            <Library className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-sm">{t("projectScope.allFootage")}</span>
            {allScope && <Badge variant="secondary" className="shrink-0">{t("projectScope.activeMode")}</Badge>}
          </button>
        </div>

        <ScrollArea className="flex-1">
          <ul className="flex flex-col gap-0.5 px-2 pb-2">
            {scope === null && (
              <li className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
                <Spinner className="size-3.5" /> {t("projectScope.loading")}
              </li>
            )}
            {/* L'explication ne vaut qu'une fois, quand la liste est vide : elle apprend d'où viennent les projets. */}
            {scope !== null && projects.length === 0 && (
              <li className="space-y-1.5 px-2 py-3">
                <p className="text-xs text-foreground">{t("projectScope.empty")}</p>
                <p className="text-xs leading-relaxed text-muted-foreground">{t("projectScope.hint")}</p>
              </li>
            )}
            {projects.map((p) => (
              <li key={p.name} className="flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-muted">
                <Checkbox checked={isChecked(p.name)} onCheckedChange={() => toggle(p.name)} aria-label={p.name} />
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => toggle(p.name)}>
                  <span className="block truncate text-sm">{p.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {t("projectScope.rushCount", { count: p.count })}
                  </span>
                </button>
                {p.current && <Badge variant="secondary" className="shrink-0">{t("projectScope.current")}</Badge>}
              </li>
            ))}
          </ul>
        </ScrollArea>

        <footer className="space-y-2 border-t border-border p-2">
          {scan && (
            <div className="space-y-1.5 px-1 pt-1">
              <Progress value={scan.total ? Math.round((scan.done / scan.total) * 100) : null} />
              <p className="truncate text-[11px] text-muted-foreground">
                {scan.project ? `${scan.project} — ${scan.done + 1}/${scan.total}` : t("projectScope.scanStarting")}
              </p>
            </div>
          )}
          {scanError && <p className="px-1 text-[11px] text-destructive">{scanError}</p>}
          {/* `shrink-0` est dans les variantes du Button : sans `min-w-0` + troncature, un libellé
              long déborde la largeur du panneau au lieu de se réduire. */}
          <div className="flex gap-1">
            <Button variant="ghost" size="sm" className="min-w-0 flex-1"
              onClick={() => { if (allScope) setSearchScope("project"); setSelected(projects.map((p) => p.name)); }}>
              <span className="truncate">{t("projectScope.selectAll")}</span>
            </Button>
            <Button variant="ghost" size="sm" className="min-w-0 flex-1"
              onClick={() => { if (allScope) setSearchScope("project"); setSelected([]); }}>
              <span className="truncate">{t("projectScope.reset")}</span>
            </Button>
          </div>
        </footer>
      </aside>
    </>
  );
}
