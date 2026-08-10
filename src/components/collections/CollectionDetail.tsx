// Détail d'un dossier de collection : grille des plans gardés (machinerie média du derush — vignette +
// aperçu au survol). Les MODES D'AFFICHAGE vivent au niveau de la LISTE des collections (CollectionsView)
// ; ICI on garde le TRI + le FILTRE PAR TAGS (organiser les plans du dossier). Un inspecteur édite les
// méta du plan sélectionné (note, label, tags, annotation).
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, LayoutGrid, Minus, Plus, Play, Pencil, Library, Zap, Square, CheckSquare, Search, ArrowDownUp, Tag, PanelRight, HardDrive, GripVertical, Undo2, Image as ImageIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { nr, type Collection, type CollectionMeta, type CollectionShot, type CollectionShotPatch, type ExportClipInput } from "@/lib/bridge";
import { useApp } from "@/store";
import { hostConnected } from "@/store/hostStatus";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ExportButton } from "@/components/export/ExportButton";
import { ShotCard } from "@/components/rushes/ShotCard";
import { useShotGrid } from "@/components/rushes/useShotGrid";
import { useTimelineTarget } from "@/components/rushes/useTimelineTarget";
import { TimelineTargetSelect } from "@/components/rushes/TimelineTargetSelect";
import { fmt, nextSegId } from "@/components/rushes/cutStudioShared";
import { type ScenePlayerApi } from "@/components/player/ScenePlayer";
import { CollectionGlyph } from "./collectionGlyph";
import { FolderEditor } from "./FolderEditor";
import { ShotInspector } from "./ShotInspector";
import { CollectionSidePanel } from "./CollectionSidePanel";
import {
  collectTags, sortShots, filterShots, labelColor, labelNameKey, loadShotSort, saveShotSort,
  EMPTY_FILTER, SORT_KEYS, SORT_LABELS, type CollSortKey, type ShotFilter,
} from "./collectionShared";

// Sous cette largeur la vue passe en colonne (lecteur en tête, grille dessous) et la grille garde
// toujours MIN_GRID_W : mêmes seuils que le Découpage, qui vit dans les mêmes contenants étroits
// (panneau CEP ~560 px, fenêtre épinglée).
const NARROW_W = 640;
const MIN_GRID_W = 260;

export function CollectionDetail({ id }: { id: string }) {
  const { t: tr } = useTranslation(["collections", "common"]);
  const { closeCollection, connected, loadCollections, collectionTags, loadCollectionTags, archiveCollection } = useApp(
    useShallow((s) => ({ closeCollection: s.closeCollection, connected: hostConnected(s), loadCollections: s.loadCollections, collectionTags: s.collectionTags, loadCollectionTags: s.loadCollectionTags, archiveCollection: s.archiveCollection })),
  );
  const [coll, setColl] = useState<Collection | null>(null);
  const [loading, setLoading] = useState(true);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  // Seules les ERREURS restent affichées : elles décrivent un état à corriger. Les retours de
  // réussite passent par une pastille qui s'efface d'elle-même (cf. `toast`).
  const [error, setError] = useState<string | null>(null);
  const [sidePanel, setSidePanel] = useState<boolean>(() => typeof localStorage !== "undefined" && localStorage.getItem("nr.coll.side") === "1");
  const toggleSide = (v: boolean) => { setSidePanel(v); try { localStorage.setItem("nr.coll.side", v ? "1" : "0"); } catch { /* noop */ } };
  const [archiving, setArchiving] = useState(false);
  // Plan OUVERT dans le lecteur de droite. Indépendant de la sélection, comme au Découpage :
  // un clic (dé)sélectionne, un double-clic ouvre — sinon on ne peut plus lire un plan sans
  // vider la sélection, ni garder une sélection en regardant un plan.
  const [openShot, setOpenShot] = useState<CollectionShot | null>(null);
  // Plans retirés (pile d'annulation) → Ctrl+Z les restaure (pas de confirmation bloquante : window.confirm
  // est interdit par Tauri). On garde l'objet complet (tags/label/note) → restauration fidèle.
  const [undoStack, setUndoStack] = useState<CollectionShot[]>([]);

  // Largeur du panneau lecteur (poignée glissable) — comme le Découpage (CutStudio), clé dédiée.
  const [panelW, setPanelW] = useState<number>(() => {
    const v = parseInt(localStorage.getItem("nr.coll.panelW") || "", 10);
    return Number.isFinite(v) && v >= 260 && v <= 600 ? v : 360;
  });
  useEffect(() => { try { localStorage.setItem("nr.coll.panelW", String(panelW)); } catch { /* noop */ } }, [panelW]);
  const panelDrag = useRef<{ x: number; w: number } | null>(null);
  function startPanelDrag(e: { clientX: number; preventDefault: () => void }) {
    panelDrag.current = { x: e.clientX, w: panelW };
    document.body.style.userSelect = "none"; document.body.style.cursor = "col-resize";
    const onMove = (ev: MouseEvent) => { const d = panelDrag.current; if (d) setPanelW(Math.min(600, Math.max(260, d.w + (d.x - ev.clientX)))); };
    const onUp = () => { panelDrag.current = null; document.body.style.userSelect = ""; document.body.style.cursor = ""; window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);
    e.preventDefault();
  }

  // Largeur RÉELLE de la vue (≠ largeur de fenêtre) : le détail d'une collection vit aussi dans le
  // panneau CEP et la fenêtre épinglée. Sous NARROW_W on empile, sinon le lecteur latéral ne
  // laisserait plus qu'une bande à la grille (cf. CutStudio).
  const rootRef = useRef<HTMLDivElement>(null);
  const [rootW, setRootW] = useState(0);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setRootW(el.clientWidth));
    setRootW(el.clientWidth);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const narrow = rootW > 0 && rootW < NARROW_W;
  const asideW = rootW ? Math.min(panelW, Math.max(MIN_GRID_W, rootW - MIN_GRID_W)) : panelW;

  const [sort, setSortState] = useState<CollSortKey>(loadShotSort);
  const [filter, setFilter] = useState<ShotFilter>(EMPTY_FILTER);
  const setSort = (s: CollSortKey) => { setSortState(s); saveShotSort(s); };
  const toggleTag = (t: string) => setFilter((f) => ({ ...f, tags: f.tags.includes(t) ? f.tags.filter((x) => x !== t) : [...f.tags, t] }));

  const grid = useShotGrid({ narrow });
  const target = useTimelineTarget(connected);
  const playerApi = useRef<ScenePlayerApi | null>(null);

  // « Tout lire » concentre la lecture sur la grille : le lecteur latéral s'arrête pour libérer son
  // décodeur, comme au Découpage — deux sources de lecture concurrentes se disputaient le GPU.
  function setGridPlayback(enabled: boolean) {
    if (enabled) playerApi.current?.pause();
    grid.setGridPlay(enabled);
  }

  async function reload() {
    setLoading(true);
    try {
      const c = await nr.collections?.load(id);
      setColl(c ?? null);
      if (c?.shots?.length) grid.warmThumbs(c.shots.map((s) => ({ path: s.path, in: s.in, inFrame: s.inFrame, fps: s.fps })));
    } finally { setLoading(false); }
  }
  useEffect(() => { void reload(); void loadCollectionTags(); setSel(new Set()); setFilter(EMPTY_FILTER); /* eslint-disable-next-line */ }, [id]);

  // Id de segment STABLE par plan (clé + état de lecture) → les cartes ne remontent pas.
  const segIds = useRef(new Map<string, number>());
  const segIdFor = (sid: string) => { let n = segIds.current.get(sid); if (n == null) { n = nextSegId(); segIds.current.set(sid, n); } return n; };

  const allTags = useMemo(() => collectTags(coll?.shots ?? []), [coll]);
  const displayed = useMemo(() => sortShots(filterShots(coll?.shots ?? [], filter), sort), [coll, filter, sort]);
  const items = useMemo(
    () => displayed.map((shot) => ({ shot, seg: { id: segIdFor(shot.id!), in: shot.in, out: shot.out, inFrame: shot.inFrame, outFrame: shot.outFrame } })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [displayed],
  );

  // Cibles des traitements DE FOND (préchauffe des aperçus) : la sélection, sinon tout — préparer
  // toute la collection sans rien sélectionner est le cas nominal.
  const targets = (): CollectionShot[] => {
    const list = coll?.shots ?? [];
    return sel.size ? list.filter((s) => s.id && sel.has(s.id)) : list;
  };
  // Cibles des actions qui ÉCRIVENT ailleurs (montage timeline, export fichier) : la sélection et
  // rien d'autre. Comme au Découpage, on n'envoie jamais une collection entière sur un clic distrait.
  const selectedShots = (): CollectionShot[] => (coll?.shots ?? []).filter((s) => s.id && sel.has(s.id));

  function toggle(sid?: string) {
    if (!sid) return;
    setSel((s) => { const n = new Set(s); n.has(sid) ? n.delete(sid) : n.add(sid); return n; });
  }

  // Édition optimiste des méta d'un plan (note/label/tags/annotation) : maj locale immédiate + persiste.
  function patchShot(shotId: string, patch: CollectionShotPatch) {
    setColl((c) => c ? { ...c, shots: c.shots.map((s) => {
      if (s.id !== shotId) return s;
      const n = { ...s };
      if (patch.tags !== undefined) n.tags = patch.tags;
      if (patch.label !== undefined) n.label = patch.label;
      if (patch.rating !== undefined) n.rating = patch.rating ?? undefined;
      if (patch.note !== undefined) n.note = patch.note ?? undefined;
      return n;
    }) } : c);
    void nr.collections?.updateShot(id, shotId, patch);
  }

  async function removeShot(shotId?: string) {
    if (!shotId || !coll) return;
    const s = coll.shots.find((x) => x.id === shotId);
    if (s) setUndoStack((st) => [...st, s]);           // mémorise pour Ctrl+Z (annulation)
    await nr.collections?.removeShot(coll.id, shotId);
    setSel((prev) => { const n = new Set(prev); n.delete(shotId); return n; });
    setOpenShot((cur) => (cur?.id === shotId ? null : cur));
    toast.ok(tr("detail.removed", { name: s?.name || tr("detail.shotWord") }));
    await reload();
    await loadCollections();
  }

  // Annule le dernier retrait : ré-ajoute le plan mémorisé (dédup côté core, fidèle : tags/label/note).
  async function undoRemove() {
    if (!coll || !undoStack.length) return;
    const last = undoStack[undoStack.length - 1];
    setUndoStack((st) => st.slice(0, -1));
    await nr.collections?.addShots(coll.id, [last]);
    toast.ok(tr("detail.restored", { name: last.name || tr("detail.shotWord") }));
    await reload();
    await loadCollections();
  }
  // Ctrl+Z (hors saisie) → annule le dernier retrait.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); void undoRemove(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [undoStack, coll]);

  const block = (s: CollectionShot) => ({ filePath: s.path, inFrame: s.inFrame, outFrame: s.outFrame ?? null, fps: s.fps });

  async function addOne(s: CollectionShot) {
    const r = await target.build(coll?.name || "Collection", [block(s)]);
    if (!r.ok && r.error) setError(r.error);
    return { ok: r.ok, error: r.error };
  }
  async function toTimeline() {
    const list = selectedShots();
    if (!list.length || !coll) return;
    setError(null); setBusy(tr("detail.mounting"));
    const r = await target.build(coll.name, list.map(block));
    setBusy(null);
    if (r.ok) toast.ok(tr("detail.toTimelineOk", { count: r.count ?? list.length, timeline: r.timeline }));
    else setError(r.error || tr("detail.timelineFailed"));
  }

  async function archiveNow() {
    if (!coll || archiving) return;
    setArchiving(true); setError(null);
    const r = await archiveCollection(coll.id, {});
    setArchiving(false);
    if (r.ok) { toast.ok(tr("detail.archived")); await reload(); }
    else setError(r.error || tr("detail.archiveFailed"));
  }

  // Le lecteur n'ouvre AUCUN plan de lui-même : ouvrir la collection lançait la lecture en boucle
  // d'un plan que personne n'avait demandé, pendant que la grille jouait déjà ses aperçus. Le
  // Découpage attend un plan, et son lecteur vide (icône de lecture) dit ce qu'il attend.

  // Double-clic (ou bouton lecture / menu contextuel) sur une carte : ouvre le plan dans le lecteur
  // de droite, en dépliant le panneau s'il était replié — sans ça le double-clic n'aurait l'air de
  // rien faire.
  function openInPlayer(shot: CollectionShot) {
    setOpenShot(shot);
    if (!sidePanel) toggleSide(true);
  }

  // Colonnes TENUES (cf. gridMetrics) : rétrécir le panneau rétrécit les vignettes, il n'en passe
  // pas une à la ligne.
  const gridTemplate = `repeat(${grid.actualCols || grid.cols}, minmax(0, 1fr))`;
  // Rang du plan ouvert dans la grille AFFICHÉE (tri/filtre compris) → repère « n/N » du lecteur.
  const openPosition = openShot ? items.findIndex(({ shot }) => shot.id === openShot.id) + 1 : 0;

  const selCount = sel.size;
  const verb = selCount ? `(${selCount})` : tr("detail.all");
  const selectAllVisible = () => setSel(selCount ? new Set() : new Set(items.map(({ shot }) => shot.id).filter((sid): sid is string => !!sid)));
  const inspected = selCount === 1 ? (coll?.shots.find((s) => s.id && sel.has(s.id)) ?? null) : null;
  // Suggestions de tags = tags de la collection + registre global (réutilisation cross-collections).
  const tagSuggestions = useMemo(() => [...new Set([...allTags, ...collectionTags])].sort((a, b) => a.localeCompare(b, "fr")), [allTags, collectionTags]);
  // Plans ciblés par l'export du panneau (sélection ou tout).
  const panelExportClips = (): ExportClipInput[] => selectedShots().map((s) => ({ input: s.path, start: s.in, end: s.out }));

  const meta: CollectionMeta | null = coll ? {
    id: coll.id, name: coll.name, color: coll.color, icon: coll.icon, count: coll.shots.length, updatedAt: coll.updatedAt,
    description: coll.description, collTags: coll.tags, folderId: coll.folderId, archive: coll.archive,
    archived: !!coll.archive?.lastAt, autoSync: !!coll.archive?.autoSync,
  } : null;

  return (
    <div ref={rootRef} className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2.5 border-b border-border px-4 py-2">
        <Button variant="ghost" size="icon-sm" aria-label={tr("common:action.back")} onClick={closeCollection}><ArrowLeft className="size-4" /></Button>
        {coll && <CollectionGlyph icon={coll.icon} color={coll.color} size={26} />}
        <div className="min-w-0 max-w-[40%]">
          {/* Le compte de plans et la sélection vivent sur le bouton de sélection (comme au
              Découpage) ; il ne reste ici que le total, et seulement si un filtre en cache. */}
          <div className="truncate text-[13px] font-medium leading-tight">{coll?.name ?? "…"}</div>
          {displayed.length !== (coll?.shots.length ?? 0) && (
            <div className="text-[11px] leading-tight text-muted-foreground">{tr("detail.ofTotal", { count: coll?.shots.length ?? 0 })}</div>
          )}
        </div>
        {/* Le crayon modifie CE dossier : il se tient contre son nom, pas à l'autre bout de la barre
            au milieu d'outils qui parlent de la grille. */}
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={() => setEditing(true)} aria-label={tr("common:action.edit")} className="shrink-0 text-muted-foreground" />}>
            <Pencil className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent>{tr("detail.editFolder")}</TooltipContent>
        </Tooltip>
        <div className="flex-1" />
        <Tooltip>
          <TooltipTrigger render={<div className="flex h-8 items-center gap-0.5 rounded-md border border-border bg-card px-1 text-xs" />}>
            <LayoutGrid className="mr-0.5 h-3.5 w-3.5 text-muted-foreground" />
            <button type="button" aria-label={tr("common:action.decrease")} onClick={() => grid.setCols((c) => Math.max(2, c - 1))} disabled={grid.cols <= 2} className="flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-accent disabled:opacity-40"><Minus className="h-3.5 w-3.5" /></button>
            <span className="w-4 text-center tabular-nums">{grid.cols}</span>
            <button type="button" aria-label={tr("common:action.increase")} onClick={() => grid.setCols((c) => Math.min(8, c + 1))} disabled={grid.cols >= 8} className="flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-accent disabled:opacity-40"><Plus className="h-3.5 w-3.5" /></button>
          </TooltipTrigger>
          <TooltipContent>{tr("detail.thumbSize")}</TooltipContent>
        </Tooltip>
        {connected && !!items.length && <TimelineTargetSelect target={target} />}
        {/* Export par PROFIL, accessible sans ouvrir le lecteur (le panneau de droite est fermé par
            défaut) : même bouton et mêmes profils que le Découpage et la Recherche. Il porte AUSSI
            le montage vers la timeline — c'est le profil qui décide (`timeline_import`), d'où le
            retrait du clap : un second bouton faisait le travail d'un des choix du sélecteur. */}
        {!!items.length && (
          <ExportButton clips={panelExportClips} baseName={coll?.name || "collection"} onTimelineImport={toTimeline} disabled={!!busy || selCount === 0} compact />
        )}
        {coll?.archive?.dir && (
          <Tooltip>
            <TooltipTrigger render={<Button size="sm" variant="outline" onClick={archiveNow} disabled={archiving} aria-label={tr("archive.onDisk")} className="h-8 text-xs text-muted-foreground" />}>
              {archiving ? <Spinner className="size-3.5" /> : <HardDrive className="size-3.5" />}
            </TooltipTrigger>
            <TooltipContent>{tr("detail.archiveDiskHint")}</TooltipContent>
          </Tooltip>
        )}
      </div>

      <div className={"flex min-h-0 flex-1 px-4 " + (narrow ? "flex-col" : "")}>
      {/* Colonne GAUCHE : barre d'outils de la grille PUIS la grille — exactement la disposition du
          Découpage. Ces outils vivaient dans l'entête de la vue, donc au-dessus du lecteur, qui
          démarrait deux rangées plus bas que sa grille pour des réglages qui ne le concernent pas. */}
      <div className="flex min-h-0 flex-1 flex-col pr-1">
        <div className="flex shrink-0 flex-wrap items-center gap-2 py-1.5">
          {(coll?.shots.length ?? 0) > 0 && (<>
            {/* Champ de recherche COURT : il partage sa ligne avec les tags et tous les outils de
                grille ; pleine largeur, il repoussait le reste sur une seconde rangée. */}
            <div className="relative w-40 shrink-0">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={filter.q} onChange={(e) => setFilter((f) => ({ ...f, q: e.target.value }))} placeholder={tr("detail.searchPlaceholder")} className="h-8 pl-8" />
            </div>
            <Select value={sort} onValueChange={(v) => setSort(v as CollSortKey)}>
              <SelectTrigger size="sm" className="w-auto gap-1.5" aria-label={tr("detail.sortShots")}>
                <ArrowDownUp className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <SelectValue>{tr(SORT_LABELS[sort])}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {SORT_KEYS.map((k) => <SelectItem key={k} value={k}>{tr(SORT_LABELS[k])}</SelectItem>)}
              </SelectContent>
            </Select>
            {allTags.length > 0 && (
              <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
                <Tag className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                {allTags.map((t) => {
                  const on = filter.tags.includes(t);
                  return (
                    <button key={t} type="button" onClick={() => toggleTag(t)}
                      className={"shrink-0 rounded-full border px-2 py-0.5 text-[11px] transition-colors " + (on ? "border-primary bg-primary/15 text-primary" : "border-border text-muted-foreground hover:text-foreground")}>
                      {t}
                    </button>
                  );
                })}
              </div>
            )}
          </>)}
          <div className="flex-1" />
          {!!items.length && (
            /* Indicateur UNIQUE de sélection : porte le compte ET sert de bascule tout/rien (même
               contrôle qu'au Découpage et dans Timeline Live). */
            <Tooltip>
              <TooltipTrigger render={
                <Button size="sm" variant="outline" onClick={selectAllVisible} aria-label={selCount ? tr("detail.deselectAll") : tr("detail.selectAll")}
                  className={"h-8 gap-1.5 text-xs " + (selCount ? "border-primary/40 text-primary" : "text-muted-foreground")} />
              }>
                {selCount ? <CheckSquare className="size-3.5" /> : <Square className="size-3.5" />}
                <span className="tabular-nums">
                  {tr("detail.shotCount", { count: items.length })}{selCount ? tr("detail.selCount", { count: selCount }) : ""}
                </span>
              </TooltipTrigger>
              <TooltipContent>{selCount ? tr("detail.deselectAll") : tr("detail.selectAll")}</TooltipContent>
            </Tooltip>
          )}
          {!!items.length && (<>
            {/* Vignettes puis aperçus : deux files SÉPARÉES côté core (CPU / GPU), donc les deux
                boutons peuvent tourner en même temps. Re-clic = arrêt. */}
            <Tooltip>
              <TooltipTrigger render={
                <Button size="sm" variant="outline"
                  onClick={() => grid.generateThumbs(targets().map((s) => ({ path: s.path, in: s.in, out: s.out, inFrame: s.inFrame, fps: s.fps })))}
                  className={"h-8 text-xs " + (grid.thumbsGen ? "border-destructive/40 text-destructive hover:text-destructive" : "text-muted-foreground")} />
              }>
                {grid.thumbsGen
                  ? <><Square className="size-3.5 fill-current" /> {grid.thumbsGen.done}/{grid.thumbsGen.total}</>
                  : <ImageIcon className="size-3.5" />}
              </TooltipTrigger>
              <TooltipContent>{grid.thumbsGen ? tr("detail.stopGen") : tr("detail.genThumbs", { verb })}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger render={
                <Button size="sm" variant="outline"
                  onClick={() => grid.generateProxies(targets().map((s) => ({ path: s.path, in: s.in, out: s.out })))}
                  className={"h-8 text-xs " + (grid.proxyGen ? "border-destructive/40 text-destructive hover:text-destructive" : "text-muted-foreground")} />
              }>
                {grid.proxyGen
                  ? <><Square className="size-3.5 fill-current" /> {grid.proxyGen.done}/{grid.proxyGen.total}</>
                  : <Zap className="size-3.5" />}
              </TooltipTrigger>
              <TooltipContent>{grid.proxyGen ? tr("detail.stopGen") : tr("detail.pregen", { verb })}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger render={
                <Toggle size="sm" variant="outline" pressed={grid.gridPlay} onPressedChange={setGridPlayback} aria-label={tr("detail.autoplay")}
                  className="text-xs text-muted-foreground aria-pressed:border-primary aria-pressed:bg-primary/15 aria-pressed:text-primary aria-pressed:hover:bg-primary/15" />
              }>
                <Play className="size-3.5" />
              </TooltipTrigger>
              <TooltipContent>{tr("detail.autoplayHint")}</TooltipContent>
            </Tooltip>
          </>)}
          {/* Ouverture du lecteur EN DERNIER : il borde la colonne, donc il touche le panneau qu'il
              ouvre — le bouton et sa cible sont voisins. */}
          <Tooltip>
            <TooltipTrigger render={
              <Toggle size="sm" variant="outline" pressed={sidePanel} onPressedChange={toggleSide} aria-label={tr("detail.player")}
                className="text-xs text-muted-foreground aria-pressed:border-primary aria-pressed:bg-primary/15 aria-pressed:text-primary aria-pressed:hover:bg-primary/15" />
            }>
              <PanelRight className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent>{tr("detail.playerHint")}</TooltipContent>
          </Tooltip>
        </div>

      {/* Grille : même géométrie que le Découpage — la densité EST le nombre de colonnes, tenu quelle
          que soit la largeur (cf. gridMetrics). */}
      <div ref={grid.gridScrollRef} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto pl-1 pr-2 pb-4 pt-1.5">
        {loading ? (
          <div className="grid gap-3" style={{ gridTemplateColumns: gridTemplate }}>
            {Array.from({ length: 12 }).map((_, i) => <Skeleton key={i} className="aspect-video w-full rounded-xl" />)}
          </div>
        ) : !items.length ? (
          <Card className="mt-3 flex flex-col items-center gap-2 p-12 text-center text-sm text-muted-foreground">
            <Library className="h-8 w-8" />
            <span>{(coll?.shots.length ?? 0) ? tr("detail.noMatch") : tr("detail.emptyFolder")}</span>
          </Card>
        ) : (
          <div className="grid gap-3" style={{ gridTemplateColumns: gridTemplate }}>
            {items.map(({ shot, seg }, i) => {
              const nameKey = labelNameKey(shot.label);
              return (
                <ShotCard
                  key={seg.id}
                  seg={seg} index={i} clipPath={shot.path} cols={grid.actualCols} cellH={grid.cellH}
                  active={!!shot.id && openShot?.id === shot.id}
                  selected={!!shot.id && sel.has(shot.id)}
                  play={grid.gridPlay}
                  getProxy={(h, tok, prio) => grid.getProxy(shot.path, seg.in, seg.out, prio ?? "high", h, tok)}
                  bustProxy={() => grid.bust(shot.path, seg.in, seg.out)}
                  onPlay={() => openInPlayer(shot)}
                  onToggle={() => toggle(shot.id)}
                  onAddToTimeline={connected ? () => addOne(shot) : undefined}
                  onRemove={() => removeShot(shot.id)}
                  rangerShots={[shot]}
                  dur={fmt(shot.out - shot.in)}
                  labelColor={labelColor(shot.label)}
                  labelName={nameKey ? tr(nameKey) : undefined}
                  rating={shot.rating}
                  tagCount={shot.tags?.length}
                />
              );
            })}
          </div>
        )}
      </div>
      </div>

        {sidePanel && (
        <div className={"flex min-h-0 bg-background " + (narrow ? "order-first w-full shrink-0 flex-col" : "h-full shrink-0")}>
          {/* poignée : glisser pour élargir/rétrécir le lecteur (comme le Découpage). Inutile en
              colonne, où le lecteur prend toute la largeur. */}
          {!narrow && (
          <div role="separator" aria-orientation="vertical" aria-label={tr("detail.resize")} tabIndex={0}
            onMouseDown={startPanelDrag}
            onKeyDown={(e) => { if (e.key === "ArrowLeft") { e.preventDefault(); setPanelW((w) => Math.min(600, w + 20)); } else if (e.key === "ArrowRight") { e.preventDefault(); setPanelW((w) => Math.max(260, w - 20)); } }}
            className="group relative w-px shrink-0 self-stretch cursor-col-resize bg-border transition-colors hover:bg-primary outline-none focus-visible:bg-primary">
            {/* Zone de PRÉHENSION élargie mais SANS largeur de layout : la grille et le lecteur
                restent collés au trait, seul le curseur dispose de quelques pixels de chaque côté. */}
            <div className="absolute inset-y-0 -left-1.5 -right-1.5" />
            <GripVertical className="pointer-events-none absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
          </div>
          )}
          {/* Rognage ouvert → lecteur du panneau suspendu (sinon il continue de tourner derrière la modale). */}
          <CollectionSidePanel
            width={asideW}
            narrow={narrow}
            shot={openShot}
            position={openPosition}
            total={items.length}
            name={coll?.name || "collection"}
            exportClips={panelExportClips}
            onTimelineImport={toTimeline}
            getProxy={(p, i, o, prio) => grid.getProxy(p, i, o, prio, undefined, undefined, true)}
            playerApi={playerApi}
          />
        </div>)}
      </div>

      {inspected && inspected.id && (
        <ShotInspector shot={inspected} suggestions={tagSuggestions} onPatch={(p) => patchShot(inspected.id!, p)} onClose={() => setSel(new Set())} />
      )}

      {/* Bandeau d'état en PIED de vue, comme au Découpage : au-dessus de la grille il repoussait
          les vignettes vers le bas à chaque message. */}
      {(busy || error || undoStack.length > 0) && (
        <div className="flex shrink-0 items-center gap-2 border-t border-border px-4 py-1.5 text-xs">
          {busy && <span className="flex items-center gap-1.5 text-muted-foreground"><Spinner /> {busy}</span>}
          {!busy && error && <span className="text-destructive">{error}</span>}
          {undoStack.length > 0 && (
            <button type="button" onClick={() => void undoRemove()} className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
              <Undo2 className="size-3" /> {tr("detail.undoRemove")}
            </button>
          )}
        </div>
      )}

      {meta && <FolderEditor open={editing} onOpenChange={(v) => { setEditing(v); if (!v) void reload(); }} editing={meta} />}
    </div>
  );
}
