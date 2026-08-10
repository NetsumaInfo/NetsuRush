// Onglet Timeline Live. Façon « Media Pool » : on PARCOURT les timelines Resolve (barre de recherche
// + cartes) comme des médias, on en ouvre une → ses plans déjà montés s'affichent en vignettes (comme
// le derush : aperçu au survol + lecture auto). Bouton « ajouter » par plan (ou en lot) → ajoute à la
// timeline OUVERTE, à une timeline CHOISIE, ou à une NOUVELLE (sélecteur de destination).
import { useEffect, useMemo, useRef, useState } from "react";
import { usePersistedChoice } from "@/lib/persistedChoice";
import { useTranslation } from "react-i18next";
import { RotateCw, LayoutGrid, Minus, Plus, Play, Film, Search, Zap, Square, CheckSquare, Image as ImageIcon, GripVertical, PanelRightClose, PanelRightOpen } from "lucide-react";
import { nr, type TimelineCut, type CollectionShot, type SnapshotState } from "@/lib/bridge";
import { useApp } from "@/store";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Toggle } from "@/components/ui/toggle";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { ScenePlayer } from "@/components/player/ScenePlayer";
import { ExportButton } from "@/components/export/ExportButton";
import { ExportAudioSelect } from "@/components/export/ExportAudioSelect";
import { ExportTimelineTarget } from "@/components/export/ExportTimelineTarget";
import { ShotCard } from "./ShotCard";
import { TimelineFolders } from "./TimelineFolders";
import { SortSelect, FoldersToggle, TIMELINE_SORT_DEFS } from "./BrowserControls";
import { useShotGrid } from "./useShotGrid";
import { useTimelineTarget } from "./useTimelineTarget";
import { TimelineInsertionSelect } from "./TimelineInsertionSelect";
import { usePanelLayout } from "./usePanelLayout";
import { useAdobeTimelines } from "./useAdobeTimelines";
import { TimelineTrackSelect } from "./TimelineTrackSelect";
import { cutsOfTrack, trackOptions } from "./timelineTracks";
import { hostBuildTimeline, hostShort } from "@/lib/host";
import { getActiveExportProfile } from "@/features/export/profiles";
import { timelineBuildOptsFromProfile } from "@/features/export/timelineTarget";
import { fmt, gridContainerStyle, nextSegId } from "./cutStudioShared";

// L'identité d'un plan ne suffit pas : sa fin, sa position timeline, son FPS ou même sa source peuvent
// changer sans modifier `track:index:inFrame`. Cette empreinte pilote la réutilisation exacte du cache.
// Le nom de piste en fait partie : renommer une piste ne change aucun plan, mais doit repeindre le bandeau.
function timelineCutsSignature(cuts: TimelineCut[]): string {
  return JSON.stringify(cuts.map((cut) => [
    cut.path, cut.track, cut.trackName ?? "", cut.tlStart, cut.inFrame, cut.outFrame, cut.fps, cut.srcFrames,
  ]));
}

export function TimelineLiveView() {
  const { t } = useTranslation("derush");
  const connected = useApp((s) => !!s.status?.connected);
  const activeHost = useApp((s) => s.activeHost);
  // Projet courant : passé au core comme indice → un switch invalide son cache de vignettes (sinon il
  // resservait les timelines de l'ancien projet) et déclenche un rescan.
  const project = useApp((s) => s.status?.project ?? null);
  const timelinesEpoch = useApp((s) => s.timelinesEpoch);
  const grid = useShotGrid();
  // Cache projet (snapshot) : quand Resolve est fermé, le core sert timelines/plans/vignettes cachés →
  // on garde le navigateur ouvrable HORS LIGNE. `browsable` = en ligne OU un snapshot avec timelines.
  const [snap, setSnap] = useState<SnapshotState | null>(null);
  useEffect(() => { if (activeHost === "resolve") nr.snapshot?.state().then(setSnap).catch(() => {}); }, [connected, activeHost]);
  // Hôte Adobe : les plans montés vivent dans le snapshot du panneau CEP, pas derrière un pont à
  // interroger. Même vue, autre source — cf. useAdobeTimelines.
  const adobe = useAdobeTimelines();
  const cacheReady = !!snap && snap.timelines > 0;
  const browsable = adobe.active ? adobe.ready : connected || cacheReady;
  // Le sélecteur de destination reste sur son propre chemin : sur Adobe il n'a pas de liste à
  // scanner, on ne l'active donc pas (les envois passent par hostBuildTimeline plus bas).
  const target = useTimelineTarget(browsable && !adobe.active);
  const timelineList = adobe.active ? adobe.timelines : target.timelines;
  const { panelW, setPanelW, panelRef, startPanelDrag, playerOpen, setPlayerOpen } = usePanelLayout();

  const [q, setQ] = useState("");
  // timeline ouverte + sélection PERSISTÉES dans le store (la vue se démonte au changement d'onglet →
  // sinon retour = navigateur vide). Les plans (cuts) sont rechargés au remount.
  const opened = useApp((s) => s.tlOpened);              // null = navigateur
  const setOpened = useApp((s) => s.setTlOpened);
  const selArr = useApp((s) => s.tlSel);
  const setSelArr = useApp((s) => s.setTlSel);
  const tlTrack = useApp((s) => s.tlTrack);
  const setTlTrack = useApp((s) => s.setTlTrack);
  const sel = useMemo(() => new Set(selArr), [selArr]);
  const [cuts, setCuts] = useState<TimelineCut[]>([]);
  const cutsRef = useRef<TimelineCut[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeCutId, setActiveCutId] = useState<string | null>(null);
  const [activeUrl, setActiveUrl] = useState<string | null>(null);
  const previewRequestRef = useRef(0);
  // Seules les ERREURS restent affichées : la timeline illisible explique une grille vide. Les retours
  // de réussite passent par une pastille qui s'efface d'elle-même (cf. `toast`).
  const [error, setError] = useState<string | null>(null);
  const exportProfiles = useApp((s) => s.exportProfiles);
  const activeExportProfileId = useApp((s) => s.activeExportProfileId);
  const exportBusy = useApp((s) => s.exportBusy);
  const exportProgress = useApp((s) => s.exportProgress);
  const exportError = useApp((s) => s.exportError);
  const activeProfile = getActiveExportProfile(exportProfiles, activeExportProfileId);

  // Vignette par timeline (1er plan source). Le scan Resolve est coûteux (round-trips par timeline) →
  // le core STREAME chaque résultat (onTimelineThumb) : la grille se remplit au fil de l'eau au lieu
  // d'attendre les 61. Cache de session côté core → réouverture instantanée.
  const [thumbs, setThumbs] = useState<Map<string, { path: string; in: number }>>(new Map());
  // Streaming des vignettes = uniquement en ligne (le core émet onTimelineThumb au fil du scan). On NE
  // wipe PLUS sur !connected (ça effacerait les vignettes cachées offline) — le switch de projet a son
  // propre reset ci-dessous.
  useEffect(() => {
    if (!connected || adobe.active) return;
    const off = nr.onTimelineThumb((t) => {
      setThumbs((m) => { const n = new Map(m); n.set(t.name, { path: t.path, in: t.in }); return n; });
    });
    return () => off();
  }, [connected, adobe.active]);
  // Adobe : la vignette de chaque carte est le 1er plan de la séquence, déjà présent dans le
  // snapshot → aucun scan, la grille est peinte dès l'arrivée des données.
  useEffect(() => { if (adobe.active) setThumbs(adobe.thumbs); }, [adobe.active, adobe.thumbs]);
  // Switch de projet → les entrées (clés = noms de timelines de l'ANCIEN projet) sont obsolètes : on
  // repart d'une Map vide, le rescan ciblé du nouveau projet la repeuple.
  useEffect(() => { setThumbs(new Map()); }, [project]);
  // Stale-while-revalidate : vignettes du snapshot disque peintes AVANT le scan live (remplissage
  // instantané au montage) ; le streaming en ligne écrase ensuite entrée par entrée.
  useEffect(() => {
    if (adobe.active) return;
    nr.snapshot?.peek("thumbs").then((r) => {
      if (!r?.ok || !r.thumbs?.length) return;
      setThumbs((m) => {
        const n = new Map(m);
        for (const th of r.thumbs) if (!n.has(th.name)) n.set(th.name, { path: th.path, in: th.in });
        return n;
      });
    }).catch(() => {});
  }, [project]);

  // Repli pour les anciens snapshots : ils peuvent avoir conservé les timelines et leurs plans,
  // sans avoir la tranche `thumbs` (ajoutée plus tard). Le premier plan caché suffit à reconstruire
  // la source de la carte, puis LazyThumb génère/récupère l'image normalement.
  useEffect(() => {
    if (adobe.active || !browsable || connected || !target.timelines.length) return;
    let alive = true;
    void Promise.all(target.timelines.map(async (timeline) => {
      try {
        const cached = await nr.snapshot?.peek("cuts", timeline.name);
        const first = cached?.cuts?.find((cut) => cut && cut.path);
        if (!first) return null;
        const time = Number(first.in);
        return {
          name: timeline.name,
          path: first.path,
          in: Number.isFinite(time) ? time : 0,
        };
      } catch {
        return null;
      }
    })).then((entries) => {
      if (!alive) return;
      setThumbs((current) => {
        const next = new Map(current);
        for (const entry of entries) if (entry && !next.has(entry.name)) {
          next.set(entry.name, { path: entry.path, in: entry.in });
        }
        return next;
      });
    });
    return () => { alive = false; };
  }, [browsable, connected, target.timelines, project]);

  // Scan des vignettes UNIQUEMENT dans le navigateur. Pendant qu'une timeline est ouverte, le scan
  // des 61 timelines monopoliserait le pont Python (séquentiel) → readTimelineCuts resterait en file
  // = chargement infini. On ne le lance donc pas tant qu'une timeline est ouverte.
  useEffect(() => {
    if (adobe.active || !browsable || opened) return;
    // Le retour porte les vignettes CACHÉES quand l'hôte est fermé (cached:true) → on peuple la Map
    // depuis la réponse (offline, aucun streaming). En ligne, le streaming remplit déjà, ceci est idempotent.
    nr.timelineThumbs({ project: project ?? undefined })
      .then((r) => { if (r.ok && r.thumbs?.length) setThumbs((m) => { const n = new Map(m); for (const t of r.thumbs) n.set(t.name, { path: t.path, in: t.in }); return n; }); })
      .catch(() => {});
  }, [browsable, opened, project]);

  // Auto-actualisation : Resolve est piloté de l'extérieur, donc l'état (timelines, plans montés) peut
  // changer pendant qu'on est sur la vue. On rafraîchit dès que la fenêtre NetsuRush reprend le focus
  // (= retour depuis Resolve) → plus besoin du bouton « Recharger ».
  const openedRef = useRef<string | null>(null);
  useEffect(() => { openedRef.current = opened; }, [opened]);
  const projectRef = useRef<string | null>(project);
  useEffect(() => { projectRef.current = project; }, [project]);
  // Anti-stacking : un switch de projet enchaîne plusieurs focus/visibilitychange → sans cooldown, on
  // empilerait autant de resyncs (scans Resolve lourds) sur le pont séquentiel = chargement infini.
  const lastSyncRef = useRef(0);
  useEffect(() => {
    if (adobe.active || !connected) return;
    const sync = () => {
      if (document.hidden) return;
      const now = Date.now();
      if (now - lastSyncRef.current < 1500) return;
      lastSyncRef.current = now;
      void target.refresh();
      // Timeline ouverte → on ne rafraîchit QUE ses plans (pas le scan des 61 vignettes, qui
      // bloquerait readTimelineCuts). Navigateur → on rafraîchit les vignettes (cache invalidé côté
      // core si le projet a changé via l'indice `project`).
      if (openedRef.current) void open(openedRef.current);
      else nr.timelineThumbs({ project: projectRef.current ?? undefined }).catch(() => {});
    };
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", sync);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, adobe.active]);

  // Remount (retour sur l'onglet) : la timeline ouverte est persistée mais les plans (state local)
  // sont perdus → on les recharge. L'absence d'empreinte force le premier remplissage.
  useEffect(() => {
    if (browsable && opened) { setLoading(true); void open(opened); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browsable]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? timelineList.filter((t) => t.name.toLowerCase().includes(s)) : timelineList;
  }, [timelineList, q]);

  // Bins Media Pool de chaque timeline (rangement façon Media Pool). Chargé au navigateur.
  const [bins, setBins] = useState<Map<string, string>>(new Map());
  const [treeMode, setTreeMode] = useState(true);
  const [sortDir, setSortDir] = usePersistedChoice<"az" | "za">("nr.tl.sortdir", ["az", "za"], "az");
  useEffect(() => {
    // Adobe n'a pas de Media Pool : une séquence n'est rangée dans aucun dossier → pas d'arbre.
    if (adobe.active || !browsable || opened) return;
    // SWR : bins du snapshot d'abord (instantané), le timelineTree live remplace ensuite.
    nr.snapshot?.peek("tree").then((r) => {
      if (r?.ok && r.timelines?.length) setBins((m) => (m.size ? m : new Map<string, string>(r.timelines.map((t: { name: string; bin: string }) => [String(t.name), String(t.bin ?? "")]))));
    }).catch(() => {});
    nr.timelineTree().then((r) => { if (r.ok) setBins(new Map(r.timelines.map((t) => [t.name, t.bin]))); }).catch(() => {});
  }, [browsable, opened, project]);
  const hasBins = useMemo(() => { for (const b of bins.values()) if (b) return true; return false; }, [bins]);

  // Si l'empreinte complète est identique, on ne remonte aucune carte et on conserve vignettes/proxys.
  // Si elle change, on purge les anciennes plages puis on réchauffe progressivement les miniatures.
  const cutsSigRef = useRef<string | null>(null);
  const loadedTimelineRef = useRef<string | null>(null);
  const openRequestRef = useRef(0);
  const applyCuts = (next: TimelineCut[], signature: string) => {
    cutsSigRef.current = signature;
    cutsRef.current = next;
    setCuts(next);
  };

  async function open(name: string) {
    const requestId = ++openRequestRef.current;
    const isCurrent = () => openRequestRef.current === requestId && loadedTimelineRef.current === name;
    setOpened(name);
    if (loadedTimelineRef.current !== name) {
      loadedTimelineRef.current = name;
      setLoading(true);
      setSelArr([]);
      // Les pistes d'une AUTRE timeline n'ont rien à voir : on repart de « Tout ».
      setTlTrack(null);
      previewRequestRef.current++;
      setActiveCutId(null);
      setActiveUrl(null);
      cutsSigRef.current = null;
      cutsRef.current = [];
    }
    setError(null);
    // Adobe : les plans sont déjà là (snapshot du panneau). Rien à demander à l'hôte, donc pas de
    // skeleton ni de stale-while-revalidate — on peint et on s'arrête.
    if (adobe.active) {
      const list = adobe.cuts(name);
      const signature = timelineCutsSignature(list);
      if (signature !== cutsSigRef.current) {
        const previous = cutsRef.current.map((c) => ({ path: c.path, in: c.in, out: c.out }));
        if (cutsSigRef.current != null) await grid.invalidatePreviewRanges(previous);
        if (!isCurrent()) return;
        applyCuts(list, signature);
        grid.warmThumbs(list.map((c) => ({ path: c.path, in: c.in, out: c.out, inFrame: c.inFrame, fps: c.fps })));
      }
      setLoading(false);
      return;
    }
    // Stale-while-revalidate : rien d'affiché → on peint les plans CACHÉS de cette timeline
    // (snapshot disque, instantané) et on retire les skeletons ; la lecture live ci-dessous
    // remplace ensuite (le sig-dédup évite tout re-render si identique).
    if (cutsSigRef.current == null) {
      try {
        const peek = await nr.snapshot?.peek("cuts", name);
        if (!isCurrent()) return;
        if (peek?.ok && peek.cuts.length && cutsSigRef.current == null) {
          applyCuts(peek.cuts, timelineCutsSignature(peek.cuts));
          setLoading(false);
          grid.warmThumbs(peek.cuts.map((c) => ({ path: c.path, in: c.in, out: c.out, inFrame: c.inFrame, fps: c.fps })));
        }
      } catch { /* pas de snapshot : chargement classique */ }
    }
    // try/finally OBLIGATOIRE : sans ça, un rejet de l'RPC (op Resolve concurrente sur connexion
    // fraîche) saute setLoading(false) → skeletons à l'infini.
    try {
      const r = await nr.readTimelineCuts({ timelineName: name });
      if (!isCurrent()) return;
      if (r.ok) {
        const sig = timelineCutsSignature(r.cuts);
        if (sig === cutsSigRef.current) return;   // inchangé → aucun re-render
        const hadBaseline = cutsSigRef.current != null;
        const previous = cutsRef.current.map((c) => ({ path: c.path, in: c.in, out: c.out }));
        if (hadBaseline) await grid.invalidatePreviewRanges(previous);
        if (!isCurrent()) return;
        applyCuts(r.cuts, sig);
        const thumbs = r.cuts.map((c) => ({ path: c.path, in: c.in, out: c.out, inFrame: c.inFrame, fps: c.fps }));
        // Jamais de génération massive automatique de proxys : ils restent à la demande (lecture/survol)
        // ou via le bouton explicite. Les miniatures arrivent par petits lots de priorité basse.
        grid.warmThumbs(thumbs);
      } else { cutsSigRef.current = null; cutsRef.current = []; setCuts([]); setError(r.error || t("timelineLive.readFailed")); }
    } catch (e) {
      if (!isCurrent()) return;
      cutsSigRef.current = null; cutsRef.current = []; setCuts([]); setError(String(e));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }

  // Le poll Resolve détecte aussi les montages internes (pas seulement ajout/suppression de timeline).
  // Si Timeline Live est ouverte pendant ce changement, on compare aussitôt son empreinte complète.
  const handledEpochRef = useRef(timelinesEpoch);
  useEffect(() => {
    if (handledEpochRef.current === timelinesEpoch) return;
    handledEpochRef.current = timelinesEpoch;
    if (!adobe.active && connected && opened) void open(opened);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timelinesEpoch]);

  // Adobe : équivalent de l'epoch Resolve. Un nouveau scan du panneau remplace le snapshot →
  // la timeline ouverte se relit depuis la nouvelle donnée (le sig-dédup évite tout re-render inutile).
  useEffect(() => {
    if (adobe.active && opened) void open(opened);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adobe.cuts, adobe.active]);

  // seg.id STABLE par plan (clé Resolve `cut.id`) : indispensable pour que React garde les cartes
  // montées entre deux lectures identiques (un id aléatoire remonterait toute la grille).
  const segIds = useRef<Map<string, number>>(new Map());
  const segIdFor = (cutId: string) => {
    let id = segIds.current.get(cutId);
    if (id == null) { id = nextSegId(); segIds.current.set(cutId, id); }
    return id;
  };
  // Pistes de la timeline ouverte + plans de la piste choisie. TOUT ce qui suit (grille, sélection,
  // export, lecteur) travaille sur `visibleCuts` : filtrer l'affichage seul laisserait « tout
  // sélectionner » et l'export porter sur des plans que l'utilisateur ne voit pas.
  const tracks = useMemo(() => trackOptions(cuts), [cuts]);
  const visibleCuts = useMemo(() => cutsOfTrack(cuts, tlTrack), [cuts, tlTrack]);
  // La piste choisie peut disparaître d'un rafraîchissement à l'autre (plans déplacés, piste vidée) :
  // sans ce repli la grille resterait vide sans qu'aucune entrée du bandeau ne soit active.
  useEffect(() => {
    if (tlTrack != null && !tracks.some((track) => track.index === tlTrack)) setTlTrack(null);
  }, [tracks, tlTrack, setTlTrack]);

  const items = useMemo(
    () => visibleCuts.map((cut) => ({ cut, seg: { id: segIdFor(cut.id), in: cut.in, out: cut.out, inFrame: cut.inFrame, outFrame: cut.outFrame } })),
    [visibleCuts],
  );

  const toShot = (c: TimelineCut): CollectionShot => ({ path: c.path, name: c.name, in: c.in, out: c.out, inFrame: c.inFrame, outFrame: c.outFrame, srcFrames: c.srcFrames, fps: c.fps });
  const block = (c: TimelineCut) => ({ filePath: c.path, inFrame: c.inFrame, outFrame: c.outFrame, fps: c.fps });
  const selectedCuts = useMemo(() => visibleCuts.filter((c) => sel.has(c.id)), [visibleCuts, sel]);
  // Une sélection faite sur une AUTRE piste ne compte pas ici : sans ce test sur les plans visibles,
  // « générer les vignettes » partirait sur une liste vide au lieu de traiter la piste affichée.
  const targets = () => (selectedCuts.length ? selectedCuts : visibleCuts);
  const activeCut = activeCutId ? visibleCuts.find((c) => c.id === activeCutId) ?? null : null;

  const toggle = useApp((s) => s.toggleTlSel);

  async function sendToProfile(list: TimelineCut[], forceAppend = false) {
    if (!list.length) return { ok: false, error: t("shared.noShots") };
    const state = useApp.getState();
    const profile = getActiveExportProfile(state.exportProfiles, state.activeExportProfileId);
    const opts = timelineBuildOptsFromProfile(profile);
    if (forceAppend) opts.mode = "append";
    // `nr.script.buildTimeline` est le monteur natif Resolve (blocs en frames). Sur Premiere/AE le
    // montage repart en SECONDES par le job du panneau — même route que Derush et Recherche.
    if (adobe.active) {
      const r = await hostBuildTimeline(state.activeHost, {
        name: t("shared.defaultDerushName", { name: opened || t("shared.timelineFallback") }),
        input: list[0].path,
        mode: forceAppend ? "append" : opts.mode,
        fps: list[0].fps,
        insertion: state.timelineInsertions[state.activeHost],
        segments: list.map((c) => ({ in: c.in, out: c.out, inFrame: c.inFrame, outFrame: c.outFrame, path: c.path })),
      });
      return { ok: r.ok, timeline: r.timeline, count: r.count, error: r.error };
    }
    const r = await nr.script?.buildTimeline({
      name: t("shared.defaultDerushName", { name: opened || t("shared.timelineFallback") }),
      blocks: list.map(block),
      ...opts,
      insertion: state.timelineInsertions[state.activeHost],
    });
    return { ok: !!r?.ok, timeline: r?.timeline, count: r?.count, error: r?.error };
  }

  async function addOne(c: TimelineCut) {
    // Un clic de carte ne doit jamais créer une timeline par plan : même contrat que NetsuCut.
    const r = await sendToProfile([c], true);
    if (!r.ok && r.error) setError(r.error);
    return { ok: r.ok, error: r.error };
  }
  async function exportToTimeline() {
    if (!selectedCuts.length) return;
    setError(null);
    const r = await sendToProfile(selectedCuts);
    if (r.ok) toast.ok(t("timelineLive.added", { count: r.count ?? selectedCuts.length, name: r.timeline }));
    else setError(r.error || t("shared.failedTimeline"));
  }

  async function playCut(c: TimelineCut) {
    const requestId = ++previewRequestRef.current;
    setActiveCutId(c.id);
    setActiveUrl(null);
    // Même requête et même clé que la carte : si le proxy existe déjà, le lecteur le reçoit sans
    // seconde variante ni nouvel encodage.
    const url = await grid.getProxy(c.path, c.in, c.out, "high");
    if (previewRequestRef.current === requestId) setActiveUrl(url);
  }

  // À l'ouverture d'une timeline, le panneau droit ne doit pas attendre un clic supplémentaire :
  // il affiche immédiatement le premier plan, comme NetsuCut.
  useEffect(() => {
    if (!playerOpen || !visibleCuts.length) return;
    if (!activeCutId || !visibleCuts.some((cut) => cut.id === activeCutId)) {
      const first = visibleCuts[0];
      void playCut(first);
    }
    // playCut est volontairement déclenché uniquement par un changement de contenu/plan actif.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerOpen, visibleCuts, activeCutId]);

  // Compte de sélection VISIBLE : le bouton d'export porte sur ce que la piste affiche, pas sur des
  // plans cochés puis masqués par un changement de piste.
  const selCount = selectedCuts.length;
  // La barre d'outils se scinde autour du ressort : sans grille, ni les outils ni la bascule du
  // panneau n'ont de prise, mais le sélecteur de pistes reste (c'est lui qui ramène une grille).
  const hasCuts = !!visibleCuts.length;

  // Gate uniquement si aucune source lisible. Resolve : hors ligne ET sans cache projet. Adobe :
  // aucun snapshot encore reçu du panneau CEP — l'invite dit alors quoi faire dans l'app hôte.
  if (!browsable) {
    return (
      <div className="p-6">
        <Card className="block p-6 text-sm text-muted-foreground">
          <div className="font-medium text-foreground">
            {adobe.active ? t("timelineLive.noSnapshotTitle") : t("timelineLive.offlineTitle")}
          </div>
          <p className="mt-1">
            {adobe.active ? t("timelineLive.noSnapshotHint", { host: hostShort(activeHost) }) : t("timelineLive.offlineHint")}
          </p>
        </Card>
      </div>
    );
  }

  // --- Navigateur de timelines (façon Media Pool) ---
  if (!opened) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-2.5 border-b border-border px-4 py-2">
          <Film className="h-4 w-4 shrink-0 text-muted-foreground" />
          <h1 className="text-[13px] font-medium">{t("subnav.timeline")}</h1>
          <span className="text-[11px] text-muted-foreground">{timelineList.length || "—"}</span>
          {adobe.active && !adobe.live && (
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{t("timelineLive.offlineCache")}</span>
          )}
          {!adobe.active && !connected && cacheReady && (
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{t("timelineLive.offlineCache")}</span>
          )}
          <div className="relative ml-2 max-w-xs flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("shared.searchTimeline")} className="h-8 pl-8" />
          </div>
          <div className="flex-1" />
          {hasBins && <FoldersToggle pressed={treeMode} onPressedChange={setTreeMode} />}
          <SortSelect value={sortDir} onChange={(v) => setSortDir(v as "az" | "za")} options={TIMELINE_SORT_DEFS.map((o) => ({ value: o.value, label: t(o.labelKey) }))} />
          <Tooltip>
            <TooltipTrigger render={<Button variant="outline" size="icon-sm" onClick={() => {
              // Adobe : c'est le PANNEAU qui relit le projet (adobe:cmd scan) ; le snapshot revient
              // en SSE et la vue se repeint. Resolve : scan natif + vignettes + arbre de bins.
              if (adobe.active) { void adobe.refresh(); return; }
              target.refresh(); nr.timelineThumbs({ refresh: true }).catch(() => {}); nr.timelineTree().then((r) => { if (r.ok) setBins(new Map(r.timelines.map((tl) => [tl.name, tl.bin]))); }).catch(() => {});
            }} aria-label={t("shared.reload")} />}>
              <RotateCw className="h-4 w-4" />
            </TooltipTrigger>
            <TooltipContent>{t("timelineLive.reloadTimelines")}</TooltipContent>
          </Tooltip>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {filtered.length > 0 ? (
            <TimelineFolders timelines={filtered} bins={treeMode ? bins : new Map()} thumbs={thumbs} sortDir={sortDir} onOpen={open} />
          ) : target.loading && !q ? (
            // Connexion fraîche : le scan Resolve prend un instant → grille de skeletons (pas « aucune »).
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {Array.from({ length: 10 }).map((_, i) => (
                <Skeleton key={i} className="aspect-[4/3] rounded-xl" />
              ))}
            </div>
          ) : (
            <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center text-sm text-muted-foreground">
              <span className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary"><Film className="size-7" /></span>
              <p>{q ? t("shared.noTimelineFor", { q }) : t("timelineLive.noneInProject")}</p>
            </div>
          )}
        </div>
      </div>
    );
  }

  // --- Plans de la timeline ouverte ---
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2.5 border-b border-border px-4 py-2">
        <Tooltip>
          <TooltipTrigger render={
            <button type="button" aria-label={t("timelineLive.backToTimelines")} onClick={() => { openRequestRef.current++; setOpened(null); setCuts([]); cutsRef.current = []; cutsSigRef.current = null; loadedTimelineRef.current = null; }}
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" />
          }>
            <Film className="h-4 w-4" />
          </TooltipTrigger>
          <TooltipContent>{t("timelineLive.backToTimelines")}</TooltipContent>
        </Tooltip>
        {/* Même grammaire qu'au Découpage : un ressort UNIQUE coupe la barre en deux. À gauche ce qui
            porte sur les plans (nom, sélection, fabrication) ; à droite ce qui cadre la vue et sa
            sortie. Une disposition par page casserait le réflexe d'un onglet à l'autre. */}
        <div className="min-w-0 max-w-56 shrink">
          {/* Le compte de plans vit sur le bouton de sélection (comme au Découpage), pas ici. */}
          <div className="truncate text-[13px] font-medium leading-tight">{opened}</div>
        </div>
        {hasCuts && (
          <>
            {/* Indicateur UNIQUE de sélection : porte le compte ET sert de bascule tout/rien. */}
            <Tooltip>
              <TooltipTrigger render={
                <Button size="sm" variant="outline" onClick={() => setSelArr(selCount ? [] : visibleCuts.map((c) => c.id))}
                  className={"h-8 gap-1.5 text-xs " + (selCount ? "border-primary/40 text-primary" : "text-muted-foreground")} />
              }>
                {selCount ? <CheckSquare className="size-3.5" /> : <Square className="size-3.5" />}
                <span className="tabular-nums">
                  {t("cutStudio.shotCount", { count: visibleCuts.length })}{selCount ? t("cutStudio.selSuffix", { count: selCount }) : ""}
                </span>
              </TooltipTrigger>
              <TooltipContent>{selCount ? t("shared.deselectAll") : t("shared.selectAll")}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger render={
                <Button size="sm" variant="outline"
                  onClick={() => grid.generateThumbs(targets().map((c) => ({ path: c.path, in: c.in, out: c.out, inFrame: c.inFrame, fps: c.fps })))}
                  className={"h-8 text-xs " + (grid.thumbsGen ? "border-destructive/40 text-destructive hover:text-destructive" : "text-muted-foreground")} />
              }>
                {grid.thumbsGen
                  ? <><Square className="size-3.5 fill-current" /> {grid.thumbsGen.done}/{grid.thumbsGen.total} (+{grid.thumbsGen.started - grid.thumbsGen.done})</>
                  : <ImageIcon className="size-3.5" />}
              </TooltipTrigger>
              <TooltipContent>{grid.thumbsGen ? t("shared.stop") : t("shared.genThumbs", { verb: selCount ? `(${selCount})` : t("shared.all") })}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger render={
                <Button size="sm" variant="outline"
                  onClick={() => grid.generateProxies(targets().map((c) => ({ path: c.path, in: c.in, out: c.out })))}
                  className={"h-8 text-xs " + (grid.proxyGen ? "border-destructive/40 text-destructive hover:text-destructive" : "text-muted-foreground")} />
              }>
                {grid.proxyGen
                  ? <><Square className="size-3.5 fill-current" /> {grid.proxyGen.done}/{grid.proxyGen.total} (+{grid.proxyGen.started - grid.proxyGen.done})</>
                  : <Zap className="size-3.5" />}
              </TooltipTrigger>
              <TooltipContent>{grid.proxyGen ? t("shared.stop") : t("shared.genProxies", { verb: selCount ? `(${selCount})` : t("shared.all") })}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger render={
                <Toggle size="sm" variant="outline" pressed={grid.gridPlay} onPressedChange={grid.setGridPlay} aria-label={t("shared.autoplay")}
                  className="text-muted-foreground aria-pressed:border-primary aria-pressed:bg-primary/15 aria-pressed:text-primary aria-pressed:hover:bg-primary/15" />
              }>
                <Play className="size-3.5" />
              </TooltipTrigger>
              <TooltipContent>{t("shared.autoplayPreviews")}</TooltipContent>
            </Tooltip>
            {/* Le ressort sépare ce qui FABRIQUE la grille (à gauche) de ce qui la CADRE : quelle
                piste, quelle taille, quelle destination. */}
            <div className="flex-1" />
            <TimelineTrackSelect options={tracks} value={tlTrack} onChange={setTlTrack} total={cuts.length} />
            <Tooltip>
              <TooltipTrigger render={<div className="flex h-8 items-center gap-0.5 rounded-md border border-border bg-card px-1 text-xs" />}>
                <LayoutGrid className="mr-0.5 h-3.5 w-3.5 text-muted-foreground" />
                <button type="button" aria-label={t("common:action.decrease")} onClick={() => grid.setCols((c) => Math.max(2, c - 1))} disabled={grid.cols <= 2} className="flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-accent disabled:opacity-40"><Minus className="h-3.5 w-3.5" /></button>
                <span className="w-4 text-center tabular-nums">{grid.cols}</span>
                <button type="button" aria-label={t("common:action.increase")} onClick={() => grid.setCols((c) => Math.min(8, c + 1))} disabled={grid.cols >= 8} className="flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-accent disabled:opacity-40"><Plus className="h-3.5 w-3.5" /></button>
              </TooltipTrigger>
              <TooltipContent>{t("shared.thumbSize")}</TooltipContent>
            </Tooltip>
            {/* Accès rapide à la destination effective du profil, identique au sélecteur du panneau. */}
            <ExportTimelineTarget profile={activeProfile} className="max-w-60" />
            <ExportButton
              clips={() => selectedCuts.map((c) => ({ input: c.path, start: c.in, end: c.out }))}
              baseName={opened || t("shared.timelineFallback")}
              onTimelineImport={() => void exportToTimeline()}
              disabled={selCount === 0}
              compact
            />
          </>
        )}
        {/* Bascule du panneau de droite : dernière, contre le bord qu'elle ouvre (comme au Découpage). */}
        {hasCuts && (
          <Tooltip>
            <TooltipTrigger render={<Button size="sm" variant="outline" onClick={() => setPlayerOpen((v) => !v)} className="h-8 text-xs text-muted-foreground" />}>
              {playerOpen ? <PanelRightClose className="size-3.5" /> : <PanelRightOpen className="size-3.5" />}
            </TooltipTrigger>
            <TooltipContent>{playerOpen ? t("cutStudio.hidePlayer") : t("cutStudio.showPlayer")}</TooltipContent>
          </Tooltip>
        )}
      </div>

      <div className="flex min-h-0 flex-1 px-4">
      <div ref={grid.gridScrollRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto mr-1 pl-1 pr-2 pb-4 pt-2">
        {loading ? (
          <div className="grid gap-3" style={gridContainerStyle(grid.actualCols || grid.cols, grid.cell)}>
            {Array.from({ length: 12 }).map((_, i) => <Skeleton key={i} className="aspect-video w-full rounded-xl" />)}
          </div>
        ) : items.length ? (
          <div className="grid gap-3" style={gridContainerStyle(grid.actualCols || grid.cols, grid.cell)}>
            {items.map(({ cut, seg }, i) => (
              <ShotCard
                key={cut.id} seg={seg} index={i} clipPath={cut.path}
                active={activeCutId === cut.id}
                selected={sel.has(cut.id)}
                play={grid.gridPlay}
                getProxy={(h, tok, prio) => grid.getProxy(cut.path, seg.in, seg.out, prio ?? "high", h, tok)}
                bustProxy={() => grid.bust(cut.path, seg.in, seg.out)}
                onPlay={() => void playCut(cut)}
                onToggle={() => toggle(cut.id)}
                onAddToTimeline={() => addOne(cut)}
                rangerShots={[toShot(cut)]}
                badge={`#${i + 1}`}
                dur={fmt(cut.out - cut.in)}
              />
            ))}
          </div>
        ) : (
          <Card className="mx-3 mt-3 flex flex-col items-center gap-2 p-12 text-center text-sm text-muted-foreground">
            <Film className="h-8 w-8" />
            <span>{t("timelineLive.noShots")}</span>
          </Card>
        )}
      </div>

      {playerOpen && !!visibleCuts.length && (
        <div className="flex h-full min-h-0 shrink-0 bg-background">
          <div role="separator" aria-orientation="vertical" aria-label={t("shared.resize")}
            tabIndex={0}
            onPointerDown={startPanelDrag}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") { e.preventDefault(); setPanelW((w) => Math.min(560, w + 20)); }
              else if (e.key === "ArrowRight") { e.preventDefault(); setPanelW((w) => Math.max(260, w - 20)); }
            }}
            className="group relative w-px shrink-0 touch-none self-stretch cursor-col-resize bg-border transition-colors hover:bg-primary outline-none focus-visible:bg-primary">
            {/* Zone de PRÉHENSION élargie mais SANS largeur de layout : la grille et le lecteur
                restent collés au trait, seul le curseur dispose de quelques pixels de chaque côté. */}
            <div className="absolute inset-y-0 -left-1.5 -right-1.5" />
            <GripVertical className="pointer-events-none absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
          </div>

          <aside ref={panelRef} style={{ width: panelW }} className="flex h-full min-h-0 shrink-0 flex-col gap-3 overflow-y-auto overflow-x-hidden py-3 pl-5">
            <Card className="shrink-0 overflow-hidden p-0">
              <div className="relative aspect-video">
                <ScenePlayer src={activeUrl} loop defaultVolume={0.2} />
                {activeCut && (
                  <div className="absolute left-2 top-2 rounded bg-black/60 px-2 py-0.5 text-xs">
                    {visibleCuts.findIndex((c) => c.id === activeCut.id) + 1}/{visibleCuts.length}
                  </div>
                )}
              </div>
            </Card>

            <div className="space-y-2">
              <div className="flex items-center gap-2 px-0.5 pt-1 text-[11px] font-semibold text-muted-foreground">
                {t("cutStudio.export")}
              </div>
              <ExportAudioSelect profile={activeProfile} sourcePath={activeCut?.path ?? selectedCuts[0]?.path ?? visibleCuts[0]?.path} size="sm" />
              <div className="timeline-insertion-container min-w-0">
                <div className="timeline-insertion-row grid min-w-0 items-center gap-2">
                  <ExportTimelineTarget profile={activeProfile} className="timeline-insertion-target w-full max-w-none min-w-0" />
                  <TimelineInsertionSelect className="timeline-insertion-select w-full min-w-0" />
                </div>
              </div>
              <ExportButton
                clips={() => selectedCuts.map((c) => ({ input: c.path, start: c.in, end: c.out }))}
                baseName={opened || t("shared.timelineFallback")}
                onTimelineImport={() => void exportToTimeline()}
                verb={selCount ? `(${selCount})` : undefined}
                disabled={selCount === 0}
                className="w-full"
              />
              {exportBusy && <Progress value={exportProgress} />}
            </div>

            {exportBusy && <p className="break-words text-xs text-muted-foreground">{exportBusy}</p>}
            {exportError && <p className="break-words text-xs text-destructive">{exportError}</p>}
          </aside>
        </div>
      )}
      </div>

      {/* Bandeau d'état en PIED de vue, comme au Découpage et dans Collections. */}
      {error && (
        <div className="shrink-0 border-t border-border px-4 py-1.5 text-xs">
          <span className="text-destructive">{error}</span>
        </div>
      )}
    </div>
  );
}
