// Sélecteur « Depuis le projet » : panneau docké à droite, fond transparent SANS flou (board net
// derrière). Cartes = MÊME mécanisme que Derush (useSceneCardMedia + PreviewVideo : vignette lazy,
// aperçu animé au survol, content-visibility). Deux modes (icônes) :
//   • PARCOURIR : grille de rushs → clic ouvre les découpes du rush.
//   • RECHERCHE IA : requête texte → plans SigLIP les plus proches.
// Glisser une carte → board (drop au curseur). Glisser des fichiers vidéo OS → ajoutés comme rushs.

import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Film, FolderOpen, Search, Sparkles } from "lucide-react";
import { SelectCheck } from "@/components/common/selectable";
import { useShallow } from "zustand/react/shallow";
import { nr, type Clip, type DetectModel, type Scene, type SearchHit } from "@/lib/bridge";
import { useApp } from "@/store";
import { MODELS, PRESETS, fmt, type Segment } from "@/components/rushes/cutStudioShared";
import { DetectionAdvancedSettings } from "@/components/rushes/DetectionAdvancedSettings";
import { DetectionModelSelect } from "@/components/rushes/DetectionControls";
import { detectionOptionsFor, detectionThreshold } from "@/lib/detection";
import { createSmoothProgress } from "@/lib/smoothProgress";
import { useSceneCardMedia } from "@/components/rushes/useSceneCardMedia";
import { warmResolveThumbs } from "@/lib/thumbCache";
import { PreviewVideo } from "@/components/player/PreviewVideo";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn, basename, thumbTime } from "@/lib/utils";
import { previewSettingsFingerprint } from "@/lib/previewSettings";
import { NR_MEDIA_DND, type NrMediaDrag, kindFromPath } from "./referenceShared";
import type { BoardHandle } from "./ReferenceBoard";

type Mode = "browse" | "search";

function parseDur(d: string | null): number {
  if (!d) return 0;
  const parts = d.split(":").map(Number);
  if (parts.every((n) => !Number.isNaN(n))) {
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
  }
  const n = Number(d);
  return Number.isNaN(n) ? 0 : n;
}

// Plans en cache, tous modèles confondus.
async function loadCachedCuts(path: string): Promise<Scene[]> {
  const models: DetectModel[] = MODELS.map((entry) => entry.id);
  for (const m of models) {
    const r = await nr.cachedScenes(path, m).catch(() => null);
    if (r?.cached && r.scenes.length) return r.scenes;
  }
  return [];
}

// Glisser une carte vers le board (drop au curseur, cf. ReferenceBoard.onDrop).
function startDrag(e: React.DragEvent, m: NrMediaDrag) {
  e.dataTransfer.setData(NR_MEDIA_DND, JSON.stringify(m));
  e.dataTransfer.effectAllowed = "copy";
}

// Carte média = même rendu/comportement qu'une carte de plan Derush (SceneCard) : vignette lazy +
// aperçu animé au survol via useSceneCardMedia. Draggable vers le board (l'<img> est non-draggable
// sinon le navigateur drague l'image au lieu de notre payload).
function MediaCardImpl({
  clipPath, inSec, outSec, index, proxies, drag, selectable, selected, onActivate, badge, footer,
}: {
  clipPath: string; inSec: number; outSec: number; index: number;
  proxies: Map<string, string>; drag: NrMediaDrag;
  selectable?: boolean; selected?: boolean; onActivate: () => void; badge?: string; footer?: string;
}) {
  const seg: Segment = { id: index, in: inSec, out: outSec };
  const key = `${clipPath}@${inSec}-${outSec}|${previewSettingsFingerprint()}`;
  const getProxy = useCallback(
    (height?: number, token?: number, priority?: "high" | "low") => {
      const c = proxies.get(key);
      if (c) return Promise.resolve<string | null>(c);
      return nr.proxy({ input: clipPath, start: inSec, end: outSec, height, token, priority }).then((r) => {
        if (r.ok && r.path) { const u = nr.mediaUrl(r.path); proxies.set(key, u); return u; }
        return null;
      });
    },
    [clipPath, inSec, outSec, key, proxies],
  );
  const bustProxy = useCallback(() => { proxies.delete(key); }, [key, proxies]);
  const { rootRef, thumb, url, showVideo, videoPaused, hovered, onVideoError, enter, leave } =
    useSceneCardMedia({ seg, index, clipPath, play: false, getProxy, bustProxy });
  const shown = thumb;

  return (
    <div
      ref={rootRef}
      role="button"
      tabIndex={0}
      draggable
      onDragStart={(e) => startDrag(e, drag)}
      onMouseEnter={enter}
      onMouseLeave={leave}
      onClick={onActivate}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onActivate(); } }}
      className={cn(
        "group relative aspect-video cursor-grab overflow-hidden rounded-xl border bg-muted transition-transform hover:-translate-y-0.5 active:cursor-grabbing [content-visibility:auto] [contain-intrinsic-size:auto_120px]",
        selected ? "border-primary ring-2 ring-inset ring-primary" : "border-border hover:border-primary/60",
      )}
    >
      {!shown && <Skeleton className="absolute inset-0 rounded-none" />}
      {shown && <img src={shown} alt="" draggable={false} decoding="async" className="absolute inset-0 h-full w-full object-cover" />}
      {showVideo && <PreviewVideo url={url!} label="" onError={onVideoError} audible={hovered} paused={videoPaused} />}
      {badge && <span className="absolute left-1.5 top-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-white">{badge}</span>}
      {footer && <span className="absolute bottom-1.5 right-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] tabular-nums text-white">{footer}</span>}
      {selectable && selected && <SelectCheck />}
    </div>
  );
}

// Mémoïsé : la grille re-rend à chaque sélection/survol d'UNE carte (≥1000 plans sur gros rush).
// On compare les seules props qui changent le rendu ; les callbacks (recréés à chaque rendu, lus
// via ref dans useSceneCardMedia, ou fermeture stable sur index) sont ignorés → 1 seule carte re-rend.
const MediaCard = memo(MediaCardImpl, (a, b) =>
  a.clipPath === b.clipPath && a.inSec === b.inSec && a.outSec === b.outSec &&
  a.index === b.index && a.selected === b.selected &&
  a.selectable === b.selectable && a.badge === b.badge && a.footer === b.footer &&
  a.proxies === b.proxies,
);

// Sélection multi-cartes (cases) partagée par les grilles plans / résultats IA.
function useGridSelection() {
  const [sel, setSel] = useState<Set<number>>(new Set());
  const toggle = useCallback((i: number) => setSel((p) => { const n = new Set(p); n.has(i) ? n.delete(i) : n.add(i); return n; }), []);
  const clear = useCallback(() => setSel(new Set()), []);
  return { sel, setSel, toggle, clear };
}

// Barre d'ajout (groupe les picks par fichier → addCuts, tuilage propre).
function AddBar({ picks, board, onDone }: {
  picks: { file: string; in: number; out: number; title: string }[];
  board: RefObject<BoardHandle | null>;
  onDone: () => void;
}) {
  const { t } = useTranslation("reference");
  function add() {
    const byFile = new Map<string, { in: number; out: number; title: string }[]>();
    for (const p of picks) {
      const arr = byFile.get(p.file) ?? [];
      arr.push({ in: p.in, out: p.out, title: p.title });
      byFile.set(p.file, arr);
    }
    for (const [file, cuts] of byFile) board.current?.addCuts(file, cuts);
    onDone();
  }
  return (
    <Button size="sm" onClick={add} disabled={picks.length === 0}>
      {picks.length > 0 ? t("media.addShots", { count: picks.length }) : t("media.dragOrSelect")}
    </Button>
  );
}

// Vue des découpes d'un rush : rush entier + multi-sélection des plans + détection si vide.
function CutsView({ clip, proxies, board, onClose }: {
  clip: Clip; proxies: Map<string, string>; board: RefObject<BoardHandle | null>; onClose: () => void;
}) {
  const { t } = useTranslation("reference");
  const [cuts, setCuts] = useState<Scene[] | null>(null);
  const { sel, setSel, toggle, clear } = useGridSelection();
  // Part du modèle de découpe choisi dans les réglages, pas d'un défaut en dur.
  const [model, setModel] = useState<DetectModel>(useApp.getState().searchCutModel);
  const [detecting, setDetecting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const detectionOptions = useApp((state) => state.detectionOptions);

  useEffect(() => {
    let alive = true;
    setCuts(null); clear();
    loadCachedCuts(clip.path).then((c) => {
      if (!alive) return;
      setCuts(c);
      // Amorce le cache renderer en UN RPC → cartes sans 1 RPC/carte (scroll fluide).
      if (c?.length) void warmResolveThumbs(c.map((s) => ({ path: clip.path, time: thumbTime(s.start, s.end) })));
    });
    return () => { alive = false; };
  }, [clip.path]);

  async function detect() {
    setDetecting(true); setProgress(0); setErr(null);
    // Filtre par chemin : d'autres détections peuvent tourner en parallèle ailleurs dans l'app.
    // Lissée : la détection est muette pendant le chargement du modèle et la lecture full-vidéo.
    const track = createSmoothProgress(setProgress);
    const off = nr.onScenesProgress((p) => {
      if (p.path == null || p.path === clip.path) track.to(p.pct);
    });
    try {
      const threshold = detectionThreshold(model, PRESETS[1].thr, detectionOptions);
      const r = await nr.detectScenes(clip.path, threshold, model, detectionOptionsFor(model, detectionOptions));
      if (r.error) { setErr(r.error); return; }
      const got = (r.scenes ?? []).filter((s) => s.end > s.start);
      setCuts(got);
      if (!got.length) setErr(t("media.noShotFound"));
    } catch (e) { setErr(String(e)); }
    finally { off(); track.stop(); setDetecting(false); }
  }

  const allSel = !!cuts && cuts.length > 0 && sel.size === cuts.length;
  const picks = cuts ? [...sel].sort((a, b) => a - b).map((i) => ({
    file: clip.path, in: cuts[i].start, out: cuts[i].end, title: t("media.shotLabel", { name: clip.name, n: i + 1 }),
  })) : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon-sm" onClick={onClose}><ArrowLeft className="size-4" /></Button>
        <Tooltip>
          <TooltipTrigger render={<span className="min-w-0 flex-1 truncate text-sm font-medium">{clip.name}</span>} />
          <TooltipContent>{clip.path}</TooltipContent>
        </Tooltip>
        <Button variant="outline" size="xs" onClick={() => board.current?.addPath(clip.path, clip.name)}>
          <Film className="size-3.5" /> {t("media.whole")}
        </Button>
      </div>

      {cuts === null ? (
        <div className="grid grid-cols-3 gap-2">
          {Array.from({ length: 9 }).map((_, i) => <Skeleton key={i} className="aspect-video rounded-xl" />)}
        </div>
      ) : cuts.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-12 text-center">
          <Sparkles className="size-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{t("media.noShots")}</p>
          <DetectionModelSelect model={model} onChange={setModel} disabled={detecting} className="w-40" />
          <DetectionAdvancedSettings model={model} disabled={detecting} compact />
          <Button size="sm" onClick={detect} disabled={detecting}>
            {detecting ? <Spinner className="size-3.5" /> : <Sparkles className="size-3.5" />}
            {detecting ? t("media.detecting") : t("media.detect")}
          </Button>
          {detecting && <Progress value={progress} className="w-52" />}
          {err && <p className="text-xs text-destructive">{err}</p>}
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between px-0.5 text-xs text-muted-foreground">
            <span>{t("media.shotCount", { count: cuts.length })}{sel.size ? t("media.selectedSuffix", { count: sel.size }) : ""}</span>
            <button type="button" className="hover:text-foreground" onClick={() => setSel(allSel ? new Set() : new Set(cuts.map((_, i) => i)))}>
              {allSel ? t("media.none") : t("media.all")}
            </button>
          </div>
          {/* Le défilement vit sur un wrapper SÉPARÉ ; la grille reste auto-height. Une grille à la
              fois flex-1 ET scroller casse l'estimation content-visibility (rangées effondrées →
              cartes en lamelles). */}
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            <div className="grid grid-cols-3 gap-2">
              {cuts.map((c, i) => (
                <MediaCard
                  key={`${clip.path}@${c.start}-${c.end}`}
                  clipPath={clip.path} inSec={c.start} outSec={c.end} index={i} proxies={proxies}
                  drag={{ file: clip.path, in: c.start, out: c.end, title: t("media.shotLabel", { name: clip.name, n: i + 1 }) }}
                  selectable selected={sel.has(i)} onActivate={() => toggle(i)}
                  badge={String(i + 1)} footer={fmt(c.end - c.start)}
                />
              ))}
            </div>
          </div>
          <AddBar picks={picks} board={board} onDone={clear} />
        </>
      )}
    </div>
  );
}

// Recherche IA sémantique (SigLIP) : requête texte → plans les plus proches du projet indexé.
function SearchView({ proxies, board }: { proxies: Map<string, string>; board: RefObject<BoardHandle | null> }) {
  const { t } = useTranslation("reference");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const { sel, toggle, clear } = useGridSelection();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [indexed, setIndexed] = useState<number | null>(null);

  useEffect(() => { nr.searchStatus().then((s) => setIndexed(s.frames ?? 0)).catch(() => setIndexed(0)); }, []);

  async function run() {
    if (!q.trim()) return;
    setBusy(true); setErr(null); clear();
    try {
      const r = await nr.search(q.trim(), 60);
      if (r.error) { setErr(r.error); setHits([]); return; }
      setHits(r.hits ?? []);
    } catch (e) { setErr(String(e)); setHits([]); }
    finally { setBusy(false); }
  }

  const picks = hits ? [...sel].map((i) => ({
    file: hits[i].file_path, in: hits[i].start_sec, out: hits[i].end_sec, title: `${basename(hits[i].file_path)} · ${fmt(hits[i].start_sec)}`,
  })) : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <form onSubmit={(e) => { e.preventDefault(); run(); }} className="flex items-center gap-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("media.searchPlaceholder")} className="h-8 flex-1" autoFocus />
        <Button type="submit" size="icon-sm" disabled={busy || !q.trim()}>
          {busy ? <Spinner className="size-3.5" /> : <Search className="size-3.5" />}
        </Button>
      </form>

      {indexed === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">{t("media.notIndexed")}</p>
      ) : hits === null ? (
        <p className="py-12 text-center text-sm text-muted-foreground">{t("media.searchHint")}</p>
      ) : err ? (
        <p className="py-12 text-center text-sm text-destructive">{err}</p>
      ) : hits.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">{t("media.noMatch")}</p>
      ) : (
        <>
          <div className="px-0.5 text-xs text-muted-foreground">{t("media.results", { count: hits.length })}{sel.size ? t("media.selectedSuffix", { count: sel.size }) : ""}</div>
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            <div className="grid grid-cols-3 gap-2">
              {hits.map((h, i) => (
                <MediaCard
                  key={`${h.file_path}#${h.scene_index}`}
                  clipPath={h.file_path} inSec={h.start_sec} outSec={h.end_sec} index={i} proxies={proxies}
                  drag={{ file: h.file_path, in: h.start_sec, out: h.end_sec, title: `${basename(h.file_path)} · ${fmt(h.start_sec)}` }}
                  selectable selected={sel.has(i)} onActivate={() => toggle(i)}
                  badge={`${Math.round(h.score * 100)}%`} footer={fmt(h.end_sec - h.start_sec)}
                />
              ))}
            </div>
          </div>
          <AddBar picks={picks} board={board} onDone={clear} />
        </>
      )}
    </div>
  );
}

export function MediaPicker({
  open, onOpenChange, board,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  board: RefObject<BoardHandle | null>;
}) {
  const { t } = useTranslation("reference");
  const { clips, localClips, loadClips, clipsLoading, addLocalClips } = useApp(
    useShallow((s) => ({ clips: s.clips, localClips: s.localClips, loadClips: s.loadClips, clipsLoading: s.clipsLoading, addLocalClips: s.addLocalClips })),
  );
  const [mode, setMode] = useState<Mode>("browse");
  const [q, setQ] = useState("");
  const [drill, setDrill] = useState<Clip | null>(null);
  const [over, setOver] = useState(false);
  const proxies = useRef<Map<string, string>>(new Map()).current;

  const all = useMemo(() => [...clips, ...localClips], [clips, localClips]);
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? all.filter((c) => c.name.toLowerCase().includes(s)) : all;
  }, [all, q]);

  useEffect(() => { if (!open) { setDrill(null); setMode("browse"); } }, [open]);
  useEffect(() => { setDrill(null); }, [mode]);

  // Glisser-déposer de fichiers vidéo OS DANS le picker → rushs locaux sélectionnables.
  function onDropFiles(e: React.DragEvent) {
    if (!e.dataTransfer.files.length) return; // un drag interne (carte) ne porte pas de fichiers
    e.preventDefault();
    setOver(false);
    // Les File sont lus MAINTENANT (dataTransfer est vidé à la fin de l'événement) ; leur chemin
    // disque se résout côté host — Chromium ne l'expose pas.
    const files = Array.from(e.dataTransfer.files);
    void nr.pathsForFiles(files).then((all) => {
      const paths = all.filter((p) => p && kindFromPath(p) === "video");
      if (paths.length) { addLocalClips(paths); setMode("browse"); setDrill(null); }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={false}>
      <DialogContent
        // Docké à droite, fond transparent SANS flou → board net derrière.
        overlayClassName="bg-transparent supports-backdrop-filter:backdrop-blur-none pointer-events-none"
        onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setOver(true); } }}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setOver(false); }}
        onDrop={onDropFiles}
        className={cn(
          "left-auto right-4 top-1/2 flex h-[88vh] max-h-[88vh] w-[26rem] max-w-[calc(100%-2rem)] -translate-x-0 -translate-y-1/2 flex-col gap-3 p-4 shadow-2xl sm:max-w-md",
          over && "ring-2 ring-primary",
        )}
      >
        {over && (
          <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-xl bg-primary/10 text-sm font-medium">
            {t("media.dropVideos")}
          </div>
        )}

        <DialogHeader className="flex-row items-center gap-2 space-y-0">
          <ToggleGroup value={[mode]} onValueChange={(v) => v[0] && setMode(v[0] as Mode)} className="h-8">
            <Tooltip>
              <TooltipTrigger render={<ToggleGroupItem value="browse" aria-label={t("media.browse")} />}>
                <FolderOpen className="size-4" />
              </TooltipTrigger>
              <TooltipContent>{t("media.browse")}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger render={<ToggleGroupItem value="search" aria-label={t("media.searchAI")} />}>
                <Sparkles className="size-4" />
              </TooltipTrigger>
              <TooltipContent>{t("media.searchAI")}</TooltipContent>
            </Tooltip>
          </ToggleGroup>
          <DialogTitle className="flex-1 text-sm">
            {mode === "search" ? t("media.searchAI") : drill ? t("media.cuts") : t("media.projectRushes")}
          </DialogTitle>
        </DialogHeader>

        {mode === "search" ? (
          <SearchView proxies={proxies} board={board} />
        ) : drill ? (
          <CutsView clip={drill} proxies={proxies} board={board} onClose={() => setDrill(null)} />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            <div className="flex items-center gap-2">
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("media.filter")} className="h-8 flex-1" />
              <Button variant="outline" size="sm" onClick={loadClips} disabled={clipsLoading}>
                {clipsLoading ? <Spinner className="size-3.5" /> : t("media.reload")}
              </Button>
            </div>

            {filtered.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">{t("media.noRushes")}</p>
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto pr-1">
                <div className="grid grid-cols-2 gap-2">
                  {filtered.map((c, i) => {
                    const dur = parseDur(c.duration);
                    return (
                      <div key={c.path} className="flex flex-col gap-1">
                        <MediaCard
                          clipPath={c.path} inSec={0} outSec={dur ? Math.min(dur, 8) : 8} index={i} proxies={proxies}
                          drag={{ file: c.path, title: c.name }}
                          onActivate={() => setDrill(c)}
                          footer={c.source === "local" ? t("media.local") : undefined}
                        />
                        <Tooltip>
                          <TooltipTrigger render={<p className="truncate px-0.5 text-[11px] text-muted-foreground">{c.name}</p>} />
                          <TooltipContent>{c.name}</TooltipContent>
                        </Tooltip>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
