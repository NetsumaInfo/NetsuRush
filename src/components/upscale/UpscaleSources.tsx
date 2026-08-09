import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { usePersistedChoice } from "@/lib/persistedChoice";
import { FileVideo, RefreshCw, ChevronRight, ChevronLeft, Folder, Film, HardDriveDownload, Check, Clapperboard, Plus, Search, ListPlus, ListX } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useApp } from "@/store";
import { hostShort } from "@/lib/host";
import { nr, type Clip, type TimelineCut } from "@/lib/bridge";
import { swrRead } from "@/lib/swr";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem,
} from "@/components/ui/context-menu";
import { cn, basename } from "@/lib/utils";
import { LazyThumb } from "@/components/rushes/LazyThumb";
import { THUMB_AUTO } from "@/lib/utils";
import { srcKey, type ProcController } from "./useProcSources";
import type { UpSource } from "./upscaleShared";
import { useTranslation } from "react-i18next";

// Vignette compacte (16:9, ~56px). LazyThumb = chargée seulement à l'approche de l'écran
// (IntersectionObserver + cache) → un gros Media Pool / une longue timeline ne floode plus /rpc
// (ERR_INSUFFICIENT_RESOURCES quand des centaines de vignettes tiraient toutes en même temps).
const THUMB_CLS = "aspect-video w-14 shrink-0 rounded";

// Garde-fou clic droit : le clic qui FERME un menu contextuel (Base UI) atterrit parfois sur le
// bouton d'une AUTRE ligne et déclenche son onClick (sélection/aperçu parasite). On note l'instant de
// fermeture et on ignore les clics survenus juste après. Partagé par toutes les lignes du fichier.
let lastCtxCloseAt = 0;
const noteCtx = (open: boolean) => { if (!open) lastCtxCloseAt = performance.now(); };
const ctxGuard = (fn: () => void) => () => { if (performance.now() - lastCtxCloseAt < 250) return; fn(); };

// Coche de sélection réutilisée (Media Pool + rushes de timeline).
function Tick({ on }: { on: boolean }) {
  return (
    <span className={cn(
      "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors",
      on ? "border-primary bg-primary text-primary-foreground" : "border-border",
    )}>
      {on && <Check className="h-3 w-3" />}
    </span>
  );
}

// Ligne clip = vignette + nom complet (place enfin lisible) + méta + coche de sélection.
// memo : un toggle ne re-rend QUE la ligne dont `selected` change (grosses grilles = zéro lag).
const ClipRow = memo(function ClipRow({ clip, selected, onToggle, depth }: { clip: Clip; selected: boolean; onToggle: (c: Clip) => void; depth: number }) {
  const { t } = useTranslation("upscale");
  return (
    <ContextMenu onOpenChange={noteCtx}>
      <ContextMenuTrigger
        render={<button
          type="button"
          onClick={ctxGuard(() => onToggle(clip))}
          style={{ paddingLeft: depth * 14 + 8 }}
          className={cn(
            "flex w-full items-center gap-2 rounded-lg py-1.5 pr-2 text-left transition-colors",
            selected ? "bg-primary/15" : "hover:bg-accent/60",
          )}
        />}
      >
        <LazyThumb path={clip.path} at={THUMB_AUTO} className={THUMB_CLS} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            {clip.source === "local" && <HardDriveDownload className="h-3 w-3 shrink-0 text-primary" />}
            <Tooltip>
              <TooltipTrigger render={<span className="truncate text-sm font-medium">{clip.name}</span>} />
              <TooltipContent>{clip.name}</TooltipContent>
            </Tooltip>
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {[clip.resolution, clip.duration].filter(Boolean).join(" · ") || "—"}
          </div>
        </div>
        <Tick on={selected} />
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => onToggle(clip)}>
          <Check /> {selected ? t("sources.deselect") : t("sources.select")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

interface Node { name: string; clips: Clip[]; children: Map<string, Node>; }

function buildTree(clips: Clip[]): Node {
  const root: Node = { name: "", clips: [], children: new Map() };
  for (const c of clips) {
    const parts = (c.bin || "").split("/").filter(Boolean);
    let cur = root;
    for (const part of parts) {
      let next = cur.children.get(part);
      if (!next) { next = { name: part, clips: [], children: new Map() }; cur.children.set(part, next); }
      cur = next;
    }
    cur.clips.push(c);
  }
  return root;
}
function countClips(n: Node): number {
  let c = n.clips.length;
  for (const ch of n.children.values()) c += countClips(ch);
  return c;
}
// Tous les clips du dossier (récursif) → « Ajouter tout le dossier » au bac de sélection.
function collectClips(n: Node): Clip[] {
  const out = [...n.clips];
  for (const ch of n.children.values()) out.push(...collectClips(ch));
  return out;
}

function FolderView({ node, path, depth, collapsed, toggle, selectedPaths, onToggle, addSources, forceOpen }: {
  node: Node; path: string; depth: number; collapsed: Set<string>; toggle: (p: string) => void;
  selectedPaths: Set<string>; onToggle: (c: Clip) => void; addSources: (items: UpSource[]) => void; forceOpen?: boolean;
}) {
  const { t } = useTranslation("upscale");
  const open = forceOpen || !collapsed.has(path);
  return (
    <div>
      <ContextMenu onOpenChange={noteCtx}>
        <ContextMenuTrigger render={<button type="button" onClick={ctxGuard(() => toggle(path))}
          style={{ paddingLeft: depth * 14 + 4 }}
          className="flex w-full items-center gap-1.5 rounded-lg py-1.5 pr-2 text-sm hover:bg-accent/60" />}>
          <ChevronRight className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
          <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium">{node.name}</span>
          <span className="text-xs text-muted-foreground">{countClips(node)}</span>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => addSources(collectClips(node).map((c) => ({ name: c.name, path: c.path })))}>
            <Plus /> {t("sources.addWholeFolder")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {open && (
        <div>
          {node.clips.map((c, i) => (
            <ClipRow key={`${c.path}-${i}`} clip={c} depth={depth + 1} selected={selectedPaths.has(c.path)} onToggle={onToggle} />
          ))}
          {[...node.children.values()].map((ch) => (
            <FolderView key={ch.name} node={ch} path={`${path}/${ch.name}`} depth={depth + 1} collapsed={collapsed} toggle={toggle} selectedPaths={selectedPaths} onToggle={onToggle} addSources={addSources} forceOpen={forceOpen} />
          ))}
        </div>
      )}
    </div>
  );
}

// mm:ss d'une durée/instant en secondes (libellé de plan).
function mmss(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
// Source dérivée d'UN plan de timeline : porte in/out (portion exacte) + nom unique (timecode) → sortie
// nommée sans collision quand plusieurs plans viennent du même fichier.
function planSource(c: TimelineCut): UpSource {
  return { name: `${c.name || basename(c.path)} · ${mmss(c.in)}–${mmss(c.out)}`, path: c.path, in: c.in, out: c.out };
}

// Ligne PLAN de timeline = vignette (au point d'entrée du plan) + nom + timecode + coche.
// `onToggle` (inline au parent, clos sur un cut stable) est ignoré par le comparateur — sinon sa
// nouvelle identité à chaque rendu ferait re-rendre TOUTES les rangées à chaque toggle.
const PlanRow = memo(function PlanRow({ cut, index, selected, onToggle }: { cut: TimelineCut; index: number; selected: boolean; onToggle: () => void }) {
  const { t } = useTranslation("upscale");
  return (
    <ContextMenu onOpenChange={noteCtx}>
      <ContextMenuTrigger render={<button type="button" onClick={ctxGuard(onToggle)}
        className={cn("flex w-full items-center gap-2 rounded-lg py-1.5 pl-2 pr-2 text-left transition-colors",
          selected ? "bg-primary/15" : "hover:bg-accent/60")} />}>
        <div className="relative shrink-0">
          <LazyThumb path={cut.path} at={cut.in} out={cut.out} className={THUMB_CLS} />
          <span className="absolute left-0.5 top-0.5 rounded bg-black/60 px-1 text-[9px] font-medium tabular-nums text-white">#{index + 1}</span>
        </div>
        <div className="min-w-0 flex-1">
          <Tooltip>
            <TooltipTrigger render={<div className="truncate text-sm font-medium">{cut.name}</div>} />
            <TooltipContent>{cut.name}</TooltipContent>
          </Tooltip>
          <div className="truncate text-[11px] tabular-nums text-muted-foreground">{mmss(cut.in)}–{mmss(cut.out)} · {mmss(cut.out - cut.in)}</div>
        </div>
        <Tick on={selected} />
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={onToggle}>
          <Check /> {selected ? t("sources.deselect") : t("sources.select")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}, (a, b) => a.cut === b.cut && a.index === b.index && a.selected === b.selected);

// Panneau gauche : sélection mono/multi des rushs, en liste compacte. Deux sources : le Media Pool
// (arborescence des bins) OU une timeline Resolve (ses rushes montés, en vignettes) — sélection unifiée.
export function UpscaleSources({ up }: { up: ProcController }) {
  const { t } = useTranslation("upscale");
  const { clips, localClips, clipsLoading, clipsError, loadClips, connected, activeHost } = useApp(
    useShallow((s) => ({ clips: s.clips, localClips: s.localClips, clipsLoading: s.clipsLoading, clipsError: s.clipsError, loadClips: s.loadClips, connected: !!s.status?.connected, activeHost: s.activeHost })),
  );
  useEffect(() => { loadClips(); }, [loadClips]);

  const { sources, toggleSource, addSources, removeSources, pickFiles } = up;
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const all = useMemo(() => [...clips, ...localClips], [clips, localClips]);
  const local = useMemo(() => all.filter((c) => c.source === "local" && (!q || c.name.toLowerCase().includes(q))), [all, q]);
  const pool = useMemo(() => all.filter((c) => c.source !== "local" && (!q || c.name.toLowerCase().includes(q))), [all, q]);
  const tree = useMemo(() => buildTree(pool), [pool]);
  // Set des clés sélectionnées mémoïsé sur `sources` → identité stable tant que la sélection ne change
  // pas ; couplé aux lignes memo, un toggle ne re-rend QUE la ligne concernée (désélection instantanée).
  const selectedKeys = useMemo(() => new Set(sources.map(srcKey)), [sources]);
  const onToggle = useCallback((c: Clip) => toggleSource({ name: c.name, path: c.path }), [toggleSource]);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = useCallback((p: string) => setCollapsed((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; }), []);

  // ── Source « Timeline » ──────────────────────────────────────────────────
  const [mode, setMode] = usePersistedChoice<"pool" | "timeline">("nr.up.view", ["pool", "timeline"], "pool");
  const [timelines, setTimelines] = useState<{ name: string; current: boolean }[]>([]);
  const [tlLoading, setTlLoading] = useState(false);
  const [tlErr, setTlErr] = useState<string | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const [cuts, setCuts] = useState<TimelineCut[]>([]);
  const [cutsLoading, setCutsLoading] = useState(false);
  const [tlCached, setTlCached] = useState(false); // liste/plans servis depuis le snapshot (hôte fermé)

  // Tous les rushs NetsuLab chargés (Media Pool prêt, hôte en ligne) → propose de fermer le logiciel
  // de montage pour libérer RAM/GPU (le snapshot garde rushes/timelines visibles hors ligne). Les
  // garde-fous d'offerCloseForRam (hôte ouvert, refus mémorisé, invite déjà là) évitent le spam.
  useEffect(() => {
    if (mode === "pool" && !clipsLoading && connected && clips.length) useApp.getState().offerCloseForRam();
  }, [mode, clipsLoading, connected, clips.length]);

  const loadTimelines = () => {
    setTlLoading(true); setTlErr(null);
    // SWR : liste cachée peinte d'abord (instantané), scan Resolve la remplace ensuite.
    swrRead(
      nr.snapshot?.peek("timelines"),
      () => nr.listTimelines(),
      (r, cached) => {
        if (r.ok) { setTimelines(r.timelines || []); setTlCached(!!r.cached); if (cached) setTlLoading(false); }
        else if (!cached) setTlErr(r.error || t("sources.resolveUnavailable"));
      },
    ).catch((e) => setTlErr(String(e))).finally(() => setTlLoading(false));
  };
  // Charge les timelines au 1er passage en mode Timeline (et si vide). Tenté même hôte FERMÉ : le core
  // sert alors la liste cachée (snapshot) → le navigateur de timelines reste ouvrable hors ligne.
  useEffect(() => { if (mode === "timeline" && !timelines.length) loadTimelines(); /* eslint-disable-next-line */ }, [mode, connected]);

  async function openTimeline(name: string) {
    // Reset de la recherche : le mot servait à trouver la timeline, il ne doit PAS re-filtrer ses plans.
    setQuery("");
    setOpened(name); setCutsLoading(true); setTlErr(null); setCuts([]);
    try {
      // SWR : plans cachés de la timeline peints d'abord (instantané), lecture live remplace ensuite.
      await swrRead(
        nr.snapshot?.peek("cuts", name),
        () => nr.readTimelineCuts({ timelineName: name }),
        (r, cached) => {
          if (!r.ok) { if (!cached) setTlErr(r.error || t("sources.readFailed")); return; }
          setCuts(r.cuts);
          if (cached) setCutsLoading(false);
        },
      );
    } catch (e) { setTlErr(String(e)); }
    finally { setCutsLoading(false); }
  }

  // Filtrage recherche (timeline) : liste + plans par nom. Plans gardent leur index d'origine (#N).
  const timelinesF = useMemo(() => (q ? timelines.filter((t) => t.name.toLowerCase().includes(q)) : timelines), [timelines, q]);
  const cutsF = useMemo(() => cuts.map((c, i) => ({ c, i })).filter(({ c }) => !q || (c.name || "").toLowerCase().includes(q)), [cuts, q]);
  const addAllPlans = () => addSources(cutsF.map(({ c }) => planSource(c)));
  // Désélection groupée : toutes les clés de plans de CETTE timeline (même hors filtre), une seule maj.
  const allPlanKeys = useMemo(() => cuts.map((c) => srcKey(planSource(c))), [cuts]);
  const selectedPlanCount = useMemo(() => allPlanKeys.reduce((n, k) => n + (selectedKeys.has(k) ? 1 : 0), 0), [allPlanKeys, selectedKeys]);
  const deselectAllPlans = () => removeSources(allPlanKeys);

  return (
    <div className="flex h-full flex-col">
      {/* En-tête compact : bascule source + recharger + recherche */}
      <div className="space-y-1 border-b border-border px-2 py-1">
        <div className="flex items-center gap-1.5">
          <ToggleGroup className="flex-1" value={[mode]} onValueChange={(v) => v[0] && setMode(v[0] as "pool" | "timeline")}>
            <ToggleGroupItem value="pool" className="flex-1 gap-1.5 text-xs"><Folder className="h-3.5 w-3.5" /> {t("sources.mediaPool")}</ToggleGroupItem>
            <ToggleGroupItem value="timeline" className="flex-1 gap-1.5 text-xs"><Clapperboard className="h-3.5 w-3.5" /> {t("sources.timeline")}</ToggleGroupItem>
          </ToggleGroup>
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-sm" disabled={mode === "pool" ? clipsLoading : tlLoading}
              onClick={() => (mode === "pool" ? loadClips() : (opened ? openTimeline(opened) : loadTimelines()))} aria-label={t("sources.reload")}>
              <RefreshCw className={cn("h-4 w-4", (mode === "pool" ? clipsLoading : tlLoading) && "animate-spin")} />
            </Button>} />
            <TooltipContent>{mode === "pool" ? t("sources.reloadMediaPool") : t("sources.reload")}</TooltipContent>
          </Tooltip>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder={mode === "pool" ? t("sources.searchRush") : opened ? t("sources.searchShot") : t("sources.searchTimeline")} className="h-7 pl-8" />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {mode === "pool" ? (
          local.length > 0 || tree.clips.length > 0 || tree.children.size > 0 ? (
            <div className="space-y-0.5">
              {local.length > 0 && (
                <FolderView node={{ name: t("sources.imported"), clips: local, children: new Map() }} path="Importés" depth={0}
                  collapsed={collapsed} toggle={toggle} selectedPaths={selectedKeys} onToggle={onToggle} addSources={addSources} forceOpen={!!q} />
              )}
              {tree.clips.map((c, i) => (
                <ClipRow key={`${c.path}-${i}`} clip={c} depth={0} selected={selectedKeys.has(c.path)} onToggle={onToggle} />
              ))}
              {[...tree.children.values()].map((node) => (
                <FolderView key={node.name} node={node} path={node.name} depth={0}
                  collapsed={collapsed} toggle={toggle} selectedPaths={selectedKeys} onToggle={onToggle} addSources={addSources} forceOpen={!!q} />
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border p-4 text-xs text-muted-foreground">
              {clipsLoading ? t("sources.loadingMediaPool")
                : clipsError ? t("sources.mediaPoolUnavailable", { error: clipsError })
                : q ? t("sources.noRushFor", { q: query.trim() })
                : t("sources.noClips")}
            </div>
          )
        ) : !connected && !timelines.length && !tlLoading ? (
          // Hôte fermé ET aucun snapshot à servir → gate. Avec un snapshot, `timelines` est peuplé
          // (cache) et on tombe dans le navigateur ci-dessous, ouvrable hors ligne.
          <div className="rounded-lg border border-dashed border-border p-4 text-xs text-muted-foreground">
            {activeHost === "resolve"
              ? t("sources.resolveOffline")
              : t("sources.hostFromResolve", { host: hostShort(activeHost) })}
          </div>
        ) : !opened ? (
          tlLoading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground"><Spinner className="h-4 w-4" /> {t("sources.loading")}</div>
          ) : tlErr ? (
            <div className="rounded-lg border border-dashed border-border p-4 text-xs text-destructive">{tlErr}</div>
          ) : timelines.length ? (
            <div className="space-y-0.5">
              {tlCached && (
                <div className="mb-1 rounded-md bg-muted px-2 py-1 text-[11px] text-muted-foreground">{t("sources.offlineCached")}</div>
              )}
              {!timelinesF.length && (
                <p className="py-8 text-center text-sm text-muted-foreground">{t("sources.noTimelineFor", { q: query.trim() })}</p>
              )}
              {timelinesF.map((timeline) => (
                <button key={timeline.name} type="button" onClick={() => openTimeline(timeline.name)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm transition-colors hover:bg-accent/60">
                  <Film className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate font-medium">{timeline.name}</span>
                  {timeline.current && <span className="shrink-0 text-[11px] text-[var(--color-ok)]">{t("sources.opened")}</span>}
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                </button>
              ))}
            </div>
          ) : (
            <p className="py-8 text-center text-sm text-muted-foreground">{t("sources.noTimelines")}</p>
          )
        ) : (
          // Plans de la timeline ouverte (en vignettes) — chaque plan sélectionnable indépendamment
          <div className="space-y-0.5">
            <div className="flex items-center gap-1 px-1 pb-1">
              <button type="button" onClick={() => { setQuery(""); setOpened(null); setCuts([]); }}
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
                <ChevronLeft className="h-3.5 w-3.5" /> {t("sources.timelines")}
              </button>
              <span className="min-w-0 flex-1 truncate text-xs font-medium">{opened}</span>
              {cuts.length > 0 && (
                <>
                  <Tooltip>
                    <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={addAllPlans} aria-label={t("sources.selectAll")}>
                      <ListPlus className="h-4 w-4" />
                    </Button>} />
                    <TooltipContent>{q ? t("sources.selectAllShown") : t("sources.selectAll")}</TooltipContent>
                  </Tooltip>
                  {selectedPlanCount > 0 && (
                    <Tooltip>
                      <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={deselectAllPlans} aria-label={t("sources.deselectAll")}>
                        <ListX className="h-4 w-4" />
                      </Button>} />
                      <TooltipContent>{t("sources.deselectTimeline", { count: selectedPlanCount })}</TooltipContent>
                    </Tooltip>
                  )}
                </>
              )}
            </div>
            {cutsLoading ? (
              <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground"><Spinner className="h-4 w-4" /> {t("sources.readingShots")}</div>
            ) : tlErr ? (
              <div className="rounded-lg border border-dashed border-border p-4 text-xs text-destructive">{tlErr}</div>
            ) : cuts.length ? (
              cutsF.length ? cutsF.map(({ c, i }) => (
                <PlanRow key={c.id} cut={c} index={i} selected={selectedKeys.has(srcKey(planSource(c)))} onToggle={() => toggleSource(planSource(c))} />
              )) : (
                <p className="py-8 text-center text-sm text-muted-foreground">{t("sources.noShotFor", { q: query.trim() })}</p>
              )
            ) : (
              <p className="py-8 text-center text-sm text-muted-foreground">{t("sources.noVideoShots")}</p>
            )}
          </div>
        )}
      </div>

      <div className="border-t border-border p-2">
        <Button variant="outline" size="sm" className="w-full" onClick={pickFiles}>
          <FileVideo className="h-4 w-4" /> {t("sources.diskFiles")}
        </Button>
      </div>
    </div>
  );
}
