// Slice derush : clips du Media Pool + clips locaux importés, clip ouvert, et envoi des plans
// découpés vers la timeline Resolve (toast de progression/résultat).
import type { StateCreator } from "zustand";
import i18n from "@/i18n";
import { getActiveExportProfile } from "@/features/export/profiles";
import { timelineBuildOptsFromProfile } from "@/features/export/timelineTarget";
import { nr, type Clip, type DetectModel } from "@/lib/bridge";
import { detectionOptionsFor, detectionThreshold } from "@/lib/detection";
import { createSmoothProgress, type SmoothProgress } from "@/lib/smoothProgress";
import { rushesToClips, hostShort, hostImport } from "@/lib/host";
import type { AppState } from "./index";
import { basename, type DerushView, type DerushSection } from "./types";

// Un rush dans la file de découpe en lot.
interface BatchDetectItem {
  path: string;
  name: string;
  status: "pending" | "running" | "done" | "error";
  pct: number;
  scenes?: number;        // nb de plans détectés (status done)
  error?: string;
}
interface BatchDetectState {
  items: BatchDetectItem[];
  running: boolean;
  model: DetectModel;
}

export interface DerushSlice {
  // Sous-onglet de l'onglet Derush (barre segmentée) : découpage / collections / timeline live.
  derushSection: DerushSection;
  setDerushSection: (s: DerushSection) => void;

  // Accueil (2 cartes) ↔ navigateur (grille par dossiers)
  derushView: DerushView;
  backHome: () => void;

  // Page pleine « Découpe timeline » DANS le sous-onglet Découpage (recouper une timeline Resolve
  // existante en vignettes → nouvelle timeline). Ouverte par le bouton « Découper une timeline ».
  cutTimelineOpen: boolean;
  openCutTimeline: () => void;
  closeCutTimeline: () => void;

  // Timeline Live : timeline ouverte + sélection de plans PERSISTÉES (la vue se démonte au
  // changement d'onglet → sans ça, retour = navigateur vide). Les plans sont rechargés au remount.
  tlOpened: string | null;
  setTlOpened: (name: string | null) => void;
  tlSel: string[];
  setTlSel: (ids: string[]) => void;
  // Piste vidéo affichée dans la timeline ouverte ; null = toutes. Persistée au même titre que la
  // timeline ouverte, sinon revenir sur l'onglet rejetterait la vue sur « Tout ».
  tlTrack: number | null;
  setTlTrack: (track: number | null) => void;
  // Bascule un id en lisant l'état FRAIS du store (les cartes ShotCard sont memo → un onToggle
  // capturé garderait un ancien `sel` = sélection foireuse au-delà de 2 éléments).
  toggleTlSel: (id: string) => void;

  clips: Clip[];          // Media Pool Resolve
  localClips: Clip[];     // vidéos importées du disque, derushées hors projet
  clipsLoading: boolean;      // premier chargement, rien à afficher → squelettes/spinner
  clipsRevalidating: boolean; // resynchro en fond, clips déjà affichés → pas de spinner plein écran
  clipsCached: boolean;       // clips affichés = snapshot disque (pas encore confirmés par une lecture live)
  clipsError: string | null;
  connected: boolean;
  loadClips: () => Promise<void>;
  enterMediaPool: () => Promise<void>;
  importToPool: (paths: string[]) => Promise<{ ok: boolean; count?: number; error?: string }>;
  addLocalClips: (paths: string[]) => void;

  selected: Clip | null;
  open: (c: Clip) => void;
  close: () => void;

  // Découpe en lot : détection IA de plusieurs rushs d'affilée, mise en cache (chaque rush s'ouvre
  // ensuite instantanément dans CutStudio). Progression par rush (status + pct), arrêt possible.
  batchDetect: BatchDetectState | null;
  batchCancel: boolean;
  runBatchDetect: (paths: string[], threshold: number, model: DetectModel) => Promise<void>;
  cancelBatchDetect: () => void;
  dismissBatchDetect: () => void;

  // Envoi des plans découpés vers la timeline ouverte (bouton « Timeline » des cartes).
  // (Le rush entier se glisse en drag OS natif vers DaVinci — pas via le store.)
  tlBusy: { phase: string; pct: number } | null;          // progression de l'envoi
  tlNotice: { kind: "ok" | "warn" | "err"; text: string } | null; // résultat (toast)
  dismissTlNotice: () => void;
  // Envoi vers timeline depuis une carte de rush. whole=true → rush entier ; sinon découpe
  // EN CACHE du modèle choisi (frame-accurate). mode 'new' = timeline dédiée, 'append' = à la
  // suite de la timeline ouverte. name = nom de la timeline (créée).
  sendToTimeline: (opts: { clip: Clip; mode: "new" | "append"; name?: string; whole?: boolean; model?: DetectModel }) => Promise<{ kind: "ok" | "warn" | "err"; text: string }>;
}

// Signature bon marché d'une liste de clips : si la resynchro live renvoie la MÊME liste que ce qui
// est affiché (cas ultra-courant), on ne re-set pas `clips` → la grille ne re-render pas.
const clipsSig = (cs: Clip[]) =>
  cs.map((c) => `${c.path}|${c.duration ?? ""}|${c.bin ?? ""}|${c.name}`).join("\n");

// Dédup in-flight : plusieurs vues (grille, Voix, Upscale, picker…) appellent loadClips au montage —
// un seul fetch part, tous attendent la même promesse.
let clipsInflight: Promise<void> | null = null;

export const createDerushSlice: StateCreator<AppState, [], [], DerushSlice> = (set, get) => ({
  derushSection: "decoupage",
  // Changer de sous-onglet ferme le clip ouvert (CutStudio couvre tout l'onglet sinon) + la page de découpe.
  setDerushSection: (derushSection) => set({ derushSection, selected: null, cutTimelineOpen: false }),

  derushView: "home",
  backHome: () => set({ derushView: "home" }),

  cutTimelineOpen: false,
  openCutTimeline: () => set({ cutTimelineOpen: true, selected: null }),
  closeCutTimeline: () => set({ cutTimelineOpen: false }),

  tlOpened: null,
  setTlOpened: (tlOpened) => set({ tlOpened }),
  tlSel: [],
  setTlSel: (tlSel) => set({ tlSel }),
  tlTrack: null,
  setTlTrack: (tlTrack) => set({ tlTrack }),
  toggleTlSel: (id) => set((s) => ({
    tlSel: s.tlSel.includes(id) ? s.tlSel.filter((x) => x !== id) : [...s.tlSel, id],
  })),

  clips: [],
  localClips: [],
  clipsLoading: false,
  clipsRevalidating: false,
  clipsCached: false,
  clipsError: null,
  connected: false,
  // Stale-while-revalidate : on PEINT d'abord (clips déjà en mémoire, sinon snapshot disque via
  // snapshot:peek — instantané, zéro appel Resolve), PUIS la lecture live remplace en arrière-plan.
  // Le spinner plein écran n'apparaît que s'il n'y a VRAIMENT rien à montrer.
  loadClips: async () => {
    if (clipsInflight) return clipsInflight;
    const host = get().activeHost;
    clipsInflight = (async () => {
      try {
        // Resolve : Media Pool via le pont natif. Adobe : rushs du dernier snapshot poussé par le panneau CEP.
        if (host === "resolve") {
          if (get().clips.length) {
            set({ clipsRevalidating: true, clipsError: null });
          } else {
            set({ clipsLoading: true, clipsError: null });
            try {
              const peek = await nr.snapshot?.peek("mediaPool");
              if (peek?.clips?.length && !get().clips.length) {
                set({ clips: peek.clips, clipsCached: true, clipsLoading: false, clipsRevalidating: true });
              }
            } catch { /* pas de snapshot : chargement classique */ }
          }
          const r = await nr.listMediaPool();
          const next = r.clips ?? [];
          const same = clipsSig(get().clips) === clipsSig(next);
          set({
            ...(same ? {} : { clips: next }),
            connected: r.connected,
            clipsCached: !!r.cached,
            clipsError: r.error ?? null,
            clipsLoading: false,
            clipsRevalidating: false,
          });
          return;
        }
        const [snap, st] = await Promise.all([nr.adobeSnapshot(host), nr.adobeStatus()]);
        const connected = host === "ppro" ? st.ppro.panelConnected : st.aeft.panelConnected;
        set({
          clips: rushesToClips(snap),
          connected,
          clipsCached: false,
          clipsError: snap || !connected ? null : i18n.t("derush:store.noProject"),
          clipsLoading: false,
          clipsRevalidating: false,
        });
      } catch (e) {
        // Échec live : on GARDE ce qui est affiché (cache), l'erreur n'efface rien.
        set({ clipsLoading: false, clipsRevalidating: false, clipsError: get().clips.length ? null : String(e) });
      }
    })().finally(() => {
      clipsInflight = null;
      // L'hôte a changé PENDANT le fetch (Resolve ↔ Adobe) → relance pour le bon hôte.
      if (get().activeHost !== host) void get().loadClips();
    });
    return clipsInflight;
  },
  enterMediaPool: async () => {
    set({ derushView: "browser" });
    await get().loadClips();
  },
  // Import dans le Media Pool de l'hôte ACTIF. Passe par hostImport : nr.importToMediaPool en dur
  // tapait Resolve même sur hôte Adobe.
  importToPool: async (paths) => {
    const r = await hostImport(get().activeHost, paths);
    if (r.ok) {
      set({ derushView: "browser" });
      await get().loadClips();
    }
    return r;
  },
  // Ajoute des rushs à la bibliothèque PERSISTANTE (ils survivent à la fermeture de l'app) ; le miroir
  // `localClips` est réécrit par loadLibrary. Signature conservée : les appelants existants n'attendent
  // rien en retour.
  addLocalClips: (paths) => { void get().importFiles(paths); },

  selected: null,
  open: (selected) => set({ selected }),
  close: () => set({ selected: null }),

  batchDetect: null,
  batchCancel: false,
  // Découpe plusieurs rushs avec un pool concurrentiel dimensionné par le CORE selon la VRAM/RAM
  // libres (nr.detectConcurrency, 1..6) — le backend a un pool de daemons detect.py à modèles chauds.
  // Le gain vient du parallélisme ET du pipeline : OmniShotCut alterne lecture full-vidéo (CPU/disque)
  // et inférence (GPU) → les jobs chevauchent lecture et inférence (ressources distinctes). Le
  // heartbeat de detect.py nourrit le watchdog pendant la phase muette → pas de « délai dépassé ».
  // Chaque `scenes:progress` porte le chemin → pct routé vers le bon item (les barres ne se mélangent pas).
  runBatchDetect: async (paths, threshold, model) => {
    if (!paths.length) return;
    // Tâche lourde → propose de fermer le logiciel de montage (libérer RAM/GPU).
    get().offerCloseForRam();
    const items: BatchDetectItem[] = paths.map((p) => ({ path: p, name: basename(p), status: "pending", pct: 0 }));
    set({ batchDetect: { items, running: true, model }, batchCancel: false });
    const idxByPath = new Map(paths.map((p, i) => [p, i]));
    const detectionOptions = detectionOptionsFor(model, get().detectionOptions);
    const effectiveThreshold = detectionThreshold(model, threshold, get().detectionOptions);
    const patch = (i: number, p: Partial<BatchDetectItem>) =>
      set((s) => {
        if (!s.batchDetect) return {};
        const next = s.batchDetect.items.slice();
        if (next[i]) next[i] = { ...next[i], ...p };
        return { batchDetect: { ...s.batchDetect, items: next } };
      });
    // Progression routée par chemin → uniquement l'item EN COURS (un événement tardif n'écrase pas
    // un item déjà terminé), et lissée par item : la détection reste muette pendant le chargement
    // du modèle et la lecture full-vidéo.
    const tracks = new Map<number, SmoothProgress>();
    const off = nr.onScenesProgress((pr) => {
      const i = pr.path != null ? idxByPath.get(pr.path) : undefined;
      if (i == null) return;
      tracks.get(i)?.to(pr.pct);
    });
    let cursor = 0;
    const runOne = async (i: number) => {
      patch(i, { status: "running", pct: 0 });
      const track = createSmoothProgress((pct) => patch(i, { pct }));
      tracks.set(i, track);
      let result: Partial<BatchDetectItem>;
      try {
        const r = await nr.detectScenes(paths[i], effectiveThreshold, model, detectionOptions);
        result = r.error
          ? { status: "error", error: r.error, pct: 100 }
          : { status: "done", pct: 100, scenes: (r.scenes ?? []).length };
      } catch (e) {
        result = { status: "error", error: String(e), pct: 100 };
      }
      // Arrêt AVANT l'état final : un tic en vol repousserait la barre sous les 100 % qu'on pose.
      tracks.delete(i);
      track.stop();
      patch(i, result);
    };
    const conc = Math.min(
      Math.max(1, await nr.detectConcurrency().catch(() => 2)),
      paths.length,
    );
    const worker = async () => {
      while (!get().batchCancel) {
        const i = cursor++;
        if (i >= paths.length) return;
        await runOne(i);
      }
    };
    try {
      await Promise.all(Array.from({ length: conc }, () => worker()));
    } finally {
      off();
      set((s) => (s.batchDetect ? { batchDetect: { ...s.batchDetect, running: false } } : {}));
    }
  },
  cancelBatchDetect: () => set({ batchCancel: true }),
  dismissBatchDetect: () => set({ batchDetect: null, batchCancel: false }),

  tlBusy: null,
  tlNotice: null,
  dismissTlNotice: () => set({ tlNotice: null }),
  // Envoi d'un rush vers la timeline depuis sa carte. Soit le rush ENTIER (whole), soit la
  // DÉCOUPE en cache du modèle choisi (lue sans relancer la détection → instantané, frame-accurate
  // via les frames source). AppendToTimeline n'écrase jamais : 'append' ajoute à la suite de la
  // timeline ouverte (ou la crée), 'new' crée une timeline dédiée au bon fps. Aucun fichier déplacé.
  sendToTimeline: async ({ clip, mode, name, whole, model }) => {
    const base = clip.name.replace(/\.[^.]+$/, "");
    const tlName = (name?.trim() || i18n.t("derush:shared.defaultDerushName", { name: base }));
    const insertion = get().timelineInsertions[get().activeHost];
    const videoOnly = timelineBuildOptsFromProfile(
      getActiveExportProfile(get().exportProfiles, get().activeExportProfileId),
    ).videoOnly;
    const fail = (text: string) => {
      const n = { kind: "err" as const, text };
      set({ tlBusy: null, tlNotice: n });
      return n;
    };
    const host = get().activeHost;
    const connected = get().connected;

    // Segments (découpe en cache) résolus UNE fois — nécessaires au build ET à la mise en file.
    let segments: { in: number; out: number; inFrame?: number; outFrame?: number }[] = [];
    let srcFrames: number | undefined;
    if (!whole) {
      const c = await nr.cachedScenes(clip.path, model);
      if (!c.cached || !c.scenes.length) return fail(i18n.t("derush:store.noCacheForModel"));
      segments = c.scenes.map((s) => ({ in: s.start, out: s.end, inFrame: s.startFrame, outFrame: s.endFrame }));
      srcFrames = c.frames ?? undefined;
    }

    // « Cache projet » : hôte FERMÉ + file activée → on met l'envoi en attente (appliqué automatiquement
    // à la réouverture). Sinon échec explicite comme avant.
    if (!connected) {
      const enabled = get().outbox?.settings.enabled ?? true;
      if (enabled && nr.outbox) {
        const opts = host === "resolve"
          ? (whole ? { mode, whole: true, name: tlName, input: clip.path, videoOnly, insertion } : { mode, name: tlName, input: clip.path, srcFrames, segments, videoOnly, insertion })
          : { name: tlName, input: clip.path, mode, whole: !!whole, fps: clip.fps ? Number(clip.fps) : undefined, segments, videoOnly, insertion };
        const label = `${base} — ${whole ? i18n.t("derush:store.wholeRush") : i18n.t("derush:shared.shotsCount", { count: segments.length })}`;
        const r = await nr.outbox.enqueue({ host, kind: "buildTimeline", label, opts });
        const notice = r?.ok
          ? { kind: "ok" as const, text: i18n.t("derush:store.queuedOffline", { host: hostShort(host), count: r.pending ?? 1 }) }
          : { kind: "err" as const, text: i18n.t("derush:store.queueFailed") };
        set({ tlBusy: null, tlNotice: notice });
        return notice;
      }
      return fail(i18n.t("derush:store.offlineNoQueue", { host: hostShort(host) }));
    }

    set({ tlNotice: null, tlBusy: { phase: whole ? i18n.t("derush:store.addingRush") : i18n.t("derush:store.creatingCut"), pct: 100 } });
    try {
      // Hôte Adobe : montage via le panneau CEP (résultat plus sobre que Resolve).
      if (host !== "resolve") {
        const ar = await nr.adobeBuildTimeline({
          app: host, name: tlName, input: clip.path, mode, whole,
          fps: clip.fps ? Number(clip.fps) : undefined, segments, videoOnly, insertion,
        });
        if (!ar.ok) return fail(ar.error || i18n.t("derush:store.mountFailed"));
        const what = whole ? i18n.t("derush:store.wholeRush") : i18n.t("derush:shared.shotsCount", { count: ar.count ?? 0 });
        const notice = { kind: "ok" as const, text: i18n.t("derush:store.adobeAdded", { what, name: ar.timeline, created: ar.created ? i18n.t("derush:store.adobeCreatedSuffix") : "" }) };
        set({ tlBusy: null, tlNotice: notice });
        return notice;
      }
      const r = whole
        ? await nr.buildTimeline({ mode, whole: true, name: tlName, input: clip.path, videoOnly, insertion })
        : await nr.buildTimeline({ mode, name: tlName, input: clip.path, srcFrames, segments, videoOnly, insertion });
      if (!r.ok) return fail(r.error || i18n.t("derush:shared.failedTimeline"));
      const what = whole ? i18n.t("derush:store.wholeRush") : i18n.t("derush:shared.shotsCount", { count: r.count ?? 0 });
      let notice: { kind: "ok" | "warn" | "err"; text: string };
      if (r.fpsMismatch) {
        notice = { kind: "warn", text: i18n.t("derush:store.fpsMismatch", { what, name: r.timeline, timelineFps: r.timelineFps, clipFps: r.clipFps }) };
      } else if (r.created) {
        const renamed = r.renamed ? i18n.t("derush:store.renamedSuffix") : "";
        notice = { kind: "ok", text: i18n.t("derush:store.createdAdded", { name: r.timeline, renamed, what }) };
      } else {
        notice = { kind: "ok", text: i18n.t("derush:store.appendedAdded", { what, name: r.timeline }) };
      }
      set({ tlBusy: null, tlNotice: notice });
      return notice;
    } catch (e) {
      return fail(String(e));
    }
  },
});
