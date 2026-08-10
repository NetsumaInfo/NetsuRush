// Accueil de NetsuDraft : reprendre le dernier script, chercher/trier/parcourir les autres, et les
// créer. Le bouton engrenage déplie les PARAMÈTRES GÉNÉRAUX (défauts de l'app — chaque doc peut les
// surcharger depuis son menu ⋯). Les cartes affichent les chiffres renvoyés par `listDocs` : rien
// n'est chargé document par document pour dessiner cette page.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUpRight, Clapperboard, LayoutGrid, List, PenLine, Plus, Search, Settings2, SlidersHorizontal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { usePersistedChoice } from "@/lib/persistedChoice";
import { Kbd } from "@/components/ui/kbd";
import { isTyping } from "@/lib/shortcuts";
import type { ScriptDocMeta } from "@/lib/bridge";
import { ScriptSettings } from "./ScriptSettings";
import { BetaNotice } from "@/components/common/BetaNotice";
import { fmtDuration } from "./scriptShared";
import type { useScriptPersistence } from "./useScriptPersistence";
import { DocCard } from "./home/DocCard";
import { duplicateDoc, renameDoc } from "./home/docActions";
import {
  HOME_SORTS, HOME_VIEWS, filterDocs, relDate, sortDocs,
  type HomeScope, type HomeSort, type HomeView,
} from "./home/homeShared";

interface Props {
  project: string | null;
  scope: HomeScope;
  onSetScope: (s: HomeScope) => void;
  persistence: ReturnType<typeof useScriptPersistence>;
}

export function ScriptHome({ project, scope, onSetScope, persistence }: Props) {
  const { t } = useTranslation("script");
  const { docs, loading, notice, refresh, openDoc, createDoc, remove } = persistence;
  const [showSettings, setShowSettings] = useState(false);
  const [query, setQuery] = useState("");
  const [view, setView] = usePersistedChoice<HomeView>("nr.script.home.view", HOME_VIEWS, "grid");
  const [sort, setSort] = usePersistedChoice<HomeSort>("nr.script.home.sort", HOME_SORTS, "recent");
  const [renaming, setRenaming] = useState<ScriptDocMeta | null>(null);
  const [renameText, setRenameText] = useState("");
  const [deleting, setDeleting] = useState<ScriptDocMeta | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const searching = query.trim().length > 0;
  const visible = useMemo(() => sortDocs(filterDocs(docs, query), sort), [docs, query, sort]);
  // Reprendre = le plus récemment modifié, sorti de la grille pour ne pas s'y répéter. Une recherche
  // en cours le masque : à ce moment l'utilisateur cherche un AUTRE script, pas le dernier.
  const resume = !searching && sort === "recent" ? visible[0] : undefined;
  const listed = resume ? visible.slice(1) : visible;

  // Ctrl+N crée · « / » saute à la recherche. `isTyping` garde la frappe : sans lui, taper « / »
  // dans le champ de renommage sauterait le focus ailleurs en plein mot.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isTyping(document.activeElement)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") { e.preventDefault(); void createDoc(); }
      else if (e.key === "/") { e.preventDefault(); searchRef.current?.focus(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [createDoc]);

  const doRename = useCallback(async () => {
    if (!renaming) return;
    const target = renaming;
    setRenaming(null);
    await renameDoc(target.id, renameText.trim() || t("common.untitled"));
    void refresh();
  }, [renaming, renameText, refresh, t]);

  const doDuplicate = useCallback(async (d: ScriptDocMeta) => {
    await duplicateDoc(d.id, t("home.copySuffix", { title: d.title || t("common.untitled") }));
    void refresh();
  }, [refresh, t]);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-7">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <PenLine className="size-5 text-primary" /> {t("common.script")}
          </h1>
          <p className="mt-0.5 truncate text-sm text-muted-foreground">
            {project ? <>{t("home.project")} : <span className="text-foreground">{project}</span></> : t("home.tagline")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger render={
              <Button variant={showSettings ? "secondary" : "ghost"} size="icon" aria-label={t("home.settings")} onClick={() => setShowSettings((v) => !v)} />
            }><Settings2 className="size-4" /></TooltipTrigger>
            <TooltipContent>{t("home.settingsHint")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={<Button onClick={() => void createDoc()} />}>
              <Plus className="size-4" /> {t("common.newScript")}
            </TooltipTrigger>
            <TooltipContent><span className="inline-flex items-center gap-1.5">{t("common.newScript")} <Kbd>Ctrl N</Kbd></span></TooltipContent>
          </Tooltip>
        </div>
      </header>

      <BetaNotice module="script" />

      {showSettings && (
        <section className="rounded-lg border border-border bg-card px-4 py-2">
          <ScriptSettings mode="global" />
        </section>
      )}

      {notice && (
        <div className={notice.kind === "error" ? "rounded-md bg-destructive/15 px-3 py-2 text-sm text-destructive" : "rounded-md bg-primary/15 px-3 py-2 text-sm"}>
          {notice.text}
        </div>
      )}

      {resume && (
        <button
          type="button"
          onClick={() => void openDoc(resume.id)}
          className="group flex items-center gap-4 rounded-xl bg-card p-5 text-left shadow-xs ring-1 ring-foreground/10 transition-all outline-none hover:-translate-y-0.5 hover:ring-primary/60 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
            <Clapperboard className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{resume.title || t("common.untitled")}</div>
            <p className="mt-0.5 truncate text-sm text-muted-foreground">
              {t("home.resumeHint", { date: relDate(resume.updatedAt) })}
              {resume.stats ? ` · ~${fmtDuration(resume.stats.seconds)}` : ""}
            </p>
          </div>
          <ArrowUpRight className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" />
        </button>
      )}

      {(docs.length > 0 || searching) && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-52 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") setQuery(""); }}
              placeholder={t("home.search")}
              aria-label={t("home.search")}
              className="pr-8 pl-8"
            />
            {searching && (
              <button
                type="button"
                aria-label={t("home.clearSearch")}
                onClick={() => { setQuery(""); searchRef.current?.focus(); }}
                className="absolute top-1/2 right-2 -translate-y-1/2 rounded text-muted-foreground transition-colors hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            )}
          </div>

          {project && (
            <ToggleGroup value={[scope]} onValueChange={(v) => v[0] && onSetScope(v[0] as HomeScope)}>
              <ToggleGroupItem value="project">{t("home.thisProject")}</ToggleGroupItem>
              <ToggleGroupItem value="all">{t("home.allProjects")}</ToggleGroupItem>
            </ToggleGroup>
          )}

          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger render={
                <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={t("home.sort")} />} />
              }><SlidersHorizontal className="size-4" /></TooltipTrigger>
              <TooltipContent>{t(`home.sorts.${sort}`)}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="w-40">
              {HOME_SORTS.map((s) => (
                <DropdownMenuItem key={s} onClick={() => setSort(s)}>
                  {t(`home.sorts.${s}`)}
                  {sort === s && <span className="ml-auto text-xs text-muted-foreground">✓</span>}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <ToggleGroup value={[view]} onValueChange={(v) => v[0] && setView(v[0] as HomeView)}>
            <ToggleGroupItem value="grid" aria-label={t("home.views.grid")}><LayoutGrid className="size-4" /></ToggleGroupItem>
            <ToggleGroupItem value="list" aria-label={t("home.views.list")}><List className="size-4" /></ToggleGroupItem>
          </ToggleGroup>
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
          {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-32 rounded-xl" />)}
        </div>
      ) : docs.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-6 py-14 text-center">
          <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl bg-muted text-primary">
            <PenLine className="size-7" strokeWidth={1.5} />
          </div>
          <p className="font-medium">{t("home.empty")}</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">{t("home.emptyHint")}</p>
          <Button className="mt-5" onClick={() => void createDoc()}>
            <Plus className="size-4" /> {t("home.createFirst")}
          </Button>
        </div>
      ) : listed.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-6 py-10 text-center">
          <p className="text-sm text-muted-foreground">{searching ? t("home.noResults", { query: query.trim() }) : t("home.onlyResume")}</p>
          {searching && (
            <Button variant="outline" className="mt-4" onClick={() => setQuery("")}>
              <X className="size-4" /> {t("home.clearSearch")}
            </Button>
          )}
        </div>
      ) : (
        <section className="flex flex-col gap-3">
          <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {searching ? t("home.results", { count: listed.length }) : t("home.all", { count: listed.length })}
          </h2>
          <div className={view === "grid" ? "grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3" : "flex flex-col gap-1.5"}>
            {listed.map((d) => (
              <DocCard
                key={d.id}
                doc={d}
                view={view}
                onOpen={() => void openDoc(d.id)}
                onRename={() => { setRenaming(d); setRenameText(d.title || ""); }}
                onDuplicate={() => void doDuplicate(d)}
                onDelete={() => setDeleting(d)}
              />
            ))}
          </div>
        </section>
      )}

      <Dialog open={renaming !== null} onOpenChange={(o) => !o && setRenaming(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogTitle>{t("home.renameTitle")}</DialogTitle>
          <Input
            autoFocus
            value={renameText}
            onChange={(e) => setRenameText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void doRename(); }}
            placeholder={t("home.renamePlaceholder")}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRenaming(null)}>{t("common.cancel")}</Button>
            <Button onClick={() => void doRename()}>{t("common.confirm")}</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogTitle>{t("home.deleteTitle")}</DialogTitle>
          <p className="text-sm text-muted-foreground">
            {t("home.deleteBody", { title: deleting?.title || t("common.untitled") })}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDeleting(null)}>{t("common.cancel")}</Button>
            <Button
              variant="destructive"
              onClick={() => { const id = deleting?.id; setDeleting(null); if (id) void remove(id); }}
            >
              {t("common.delete")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
