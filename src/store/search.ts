// Slice recherche de plans (SigLIP 2) : requête texte/réfs/négatif, score esthétique, dedup,
// clustering, recherche par visage, indexation (plans + visages) et ajout des plans à la timeline.
import type { StateCreator } from "zustand";
import i18n from "@/i18n";
import {
  nr, type SearchHit, type SearchStatus, type SearchRef,
  type DedupGroup, type ClusterGroup, type ProjectScopeList,
} from "@/lib/bridge";
import { hostBuildTimeline } from "@/lib/host";
import { parseMentions } from "@/components/search/mentions";
import type { AppState } from "./index";
import { basename } from "./types";
import { detectionOptionsFor } from "@/lib/detection";
import { DEFAULT_FRAMES, type SamplingFrames } from "@/lib/sampling";
import { batchCeiling, batchProgress, createSmoothProgress } from "@/lib/smoothProgress";
import { warmGenerateThumbs } from "@/lib/thumbCache";
import { thumbTime } from "@/lib/utils";

// Un daemon python qui meurt en plein clip (VRAM saturée, traceback, watchdog) ne fait échouer que
// CE clip : le suivant relance un process neuf. On retente donc une fois avant de compter l'échec —
// sans ça, une mort passagère laissait des trous dans l'index sans que rien ne les rattrape.
async function withDaemonRetry<T extends { error?: string | null }>(run: () => Promise<T>, canceled: () => boolean): Promise<T> {
  const first = await run();
  if (!first.error || !/interrompu/i.test(first.error) || canceled()) return first;
  return run();
}

/** Un job tué par le bouton « Arrêter » revient en `indexation annulée` : c'est un arrêt, pas un échec. */
function isCanceled(error?: string | null) { return !!error && /annul/i.test(error); }

// Progression d'indexation coalescée sur une frame d'animation. Le sidecar python émet STAGE:prog
// très souvent (parfois des dizaines de lignes/s) ; sans throttle, chaque ligne ferait un set() →
// re-render de tout l'arbre → la sidebar et la navigation se figent pendant une tâche. On accumule
// le dernier état (en fusionnant phase + pct) et on ne pousse qu'une fois par frame.
// Un coalesceur PAR flux d'indexation (plans + visages) → les deux barres avancent en même temps
// sans que l'une écrase l'autre (indexation concurrente).
let pendingProg: { pct: number | null; phase?: string } | null = null;
let progRaf = 0;
let pendingFace: { pct: number | null; phase?: string } | null = null;
let faceRaf = 0;

// Profondeur de recherche : on récupère un grand top-k d'un coup (le backend clampe à la taille
// de l'index, coût marginal) et la grille pagine à l'AFFICHAGE (« Afficher plus ») — dedup et
// groupes travaillent ainsi sur l'ensemble, pas sur une première page.
export const SEARCH_TOP_K = 400;
export type SearchScope = "project" | "all";

export function searchScopePaths(state: Pick<AppState, "searchScope" | "clips" | "scopePaths">): string[] | undefined {
  if (state.searchScope === "all") return undefined;
  // Portée = rushs des projets sélectionnés (registre core). Tant qu'elle n'est pas résolue (premier
  // rendu, projet jamais enregistré), on retombe sur le Media Pool chargé : jamais de portée vide.
  const paths = new Set(state.scopePaths);
  if (!paths.size) for (const clip of state.clips) if (clip.path) paths.add(clip.path);
  return [...paths];
}

// Visage de référence choisi au picker : image source + bbox du visage cliqué (+ domaine du
// moteur qui l'a détecté). bbox absent = image entière (aucun visage détecté → repli backend).
export interface FaceRef {
  path: string;
  bbox?: [number, number, number, number];
  domain?: "anime" | "real";
  thumb?: string | null;
}

export interface SearchSlice {
  searchQuery: string;            // en-tête de la dernière requête exécutée
  posQuery: string;               // texte positif en cours de saisie (champ contrôlé)
  searchHits: SearchHit[];
  searching: boolean;
  searchError: string | null;
  searchNotice: string | null;    // avertissement qui n'empêche PAS d'afficher les résultats (mention inconnue…)
  searchStatusInfo: SearchStatus | null;                  // {clips, frames} indexés
  searchScope: SearchScope;                               // projets sélectionnés (défaut) ou index global
  projectScope: ProjectScopeList | null;                  // projets connus du registre (null = pas encore lu)
  projectScopeOpen: boolean;                              // panneau latéral de sélection des projets
  selectedProjects: string[];                             // projets inclus dans la portée ([] = projet courant)
  scopePaths: string[];                                   // rushs de la portée, résolus depuis le registre
  indexBusy: { file: string; pct: number; done: number; total: number; phase: string; ts: number } | null;
  faceBusy: { file: string; pct: number; done: number; total: number; phase: string; ts: number } | null;   // indexation VISAGES (indépendante des plans)
  indexCancel: boolean;           // demande d'arrêt : la boucle d'indexation (plans) s'arrête au clip suivant
  faceCancel: boolean;            // idem pour l'indexation des visages (annulation indépendante)
  indexParallel: boolean;         // mode parallèle (opt-in) : indexe N clips en même temps selon la VRAM libre

  // Contrôles de recherche avancée (Tier A/B).
  scoreThreshold: number;         // 0..1 : filtre d'AFFICHAGE (slider) — ne réinterroge pas le backend
  negativeQuery: string;          // requête négative (« plages SANS personne »)
  refs: SearchRef[];              // bac de références : image→image (1) / moodboard (N)
  sortMode: "relevance" | "quality";
  resultView: "flat" | "clusters" | "dedup";
  clusters: ClusterGroup[];
  dedupGroups: DedupGroup[];
  analyzing: boolean;             // dedup/cluster en cours

  // Mode visage : réfs = visages CHOISIS au picker (image → visages détectés → clic sur le bon).
  faceMode: boolean;              // derniers résultats = recherche visage (adapte l'en-tête des résultats)
  facePicker: boolean;            // picker de visages de référence ouvert
  faceRefs: FaceRef[];            // visages sélectionnés (multi-images du même perso supporté)
  // Hub Visages : grande fenêtre à onglets — « Détectés » (galerie des visages indexés) +
  // « Personnages » (roster nommé). Ouvre sur l'onglet demandé depuis la barre de recherche.
  faceHubOpen: boolean;
  faceHubTab: "gallery" | "roster";
  faceGallery: import("@/lib/bridge").GalleryFace[] | null;   // null = pas encore chargé
  faceGalleryLoading: boolean;

  setPosQuery: (s: string) => void;
  setScoreThreshold: (v: number) => void;
  setNegativeQuery: (s: string) => void;
  setSortMode: (m: "relevance" | "quality") => void;
  setResultView: (v: "flat" | "clusters" | "dedup") => void;
  addRef: (ref: SearchRef) => void;
  addImageRefs: (paths: string[]) => void;
  removeRef: (idx: number) => void;
  clearRefs: () => void;

  refreshSearchStatus: () => Promise<void>;
  setSearchScope: (scope: SearchScope) => void;
  loadProjectScope: () => Promise<void>;                  // lit le registre + résout les chemins de la portée
  setSelectedProjects: (names: string[]) => void;
  setProjectScopeOpen: (open: boolean) => void;
  runSearch: (text?: string) => Promise<void>;          // texte + réfs + négatif + esthétique
  // `thumb` = la vignette AFFICHÉE par la carte : le backend ne renvoie plus d'image, et le bac
  // de références serait vide sans elle.
  findSimilar: (hit: SearchHit, thumb?: string | null) => Promise<void>;
  runDedup: (scope?: { filePath?: string }) => Promise<void>;
  runCluster: (scope?: { filePath?: string }) => Promise<void>;
  indexClips: (paths: string[], force?: boolean, frames?: SamplingFrames) => Promise<void>;
  setIndexParallel: (b: boolean) => void;
  cancelIndexing: () => void;   // stoppe l'indexation des plans en cours (au prochain clip)
  cancelFaceIndexing: () => void;   // stoppe l'indexation des visages en cours
  openFacePicker: () => void;
  closeFacePicker: () => void;
  setFaceRefs: (refs: FaceRef[]) => void;
  openFaceHub: (tab: "gallery" | "roster") => void;
  closeFaceHub: () => void;
  setFaceHubTab: (tab: "gallery" | "roster") => void;
  refreshFaceGallery: () => void;
  searchByIndexedFace: (ref: { file_path: string; scene_index: number; face_index: number; domain: "anime" | "real" }) => Promise<void>;
  runFaceSearch: () => Promise<void>;  // recherche d'un personnage par les visages de référence choisis (multi)
  indexFaces: (paths: string[], force?: boolean) => Promise<void>;  // indexe les visages des clips
  sendHitsToTimeline: (hits: SearchHit[]) => Promise<void>;   // ajout frame-accurate à la timeline ouverte
}

// Vignettes du rush qu'on vient d'indexer, tout de suite. Un plan indexé porte déjà ses bornes :
// fabriquer son image ne coûte qu'un seek ffmpeg, sans modèle ni GPU — et c'est EXACTEMENT l'image
// du découpage, puisque l'instant est celui de `thumbTime`. Sans ce passage, la première recherche
// sur un rush frais découvrait ses cartes une par une, au rythme du défilement.
// Volontairement DÉTACHÉ : `thumbsBatch` est en file basse priorité côté core (le GPU reste aux
// proxies), l'indexation suivante n'a pas à l'attendre. Un échec ne remonte pas — la carte
// fabriquera sa vignette à l'affichage, comme n'importe quelle grille.
async function warmIndexedThumbs(path: string): Promise<void> {
  try {
    const r = await nr.searchShots(path);
    const shots = r.shots || [];
    if (!shots.length) return;
    warmGenerateThumbs(shots.map((s) => ({ path, time: thumbTime(s.start_sec, s.end_sec) })));
  } catch { /* vignettes non critiques : la grille les fabriquera à la volée */ }
}

export const createSearchSlice: StateCreator<AppState, [], [], SearchSlice> = (set, get) => {
  // Pousse la dernière progression accumulée, au plus une fois par frame (cf. pendingProg).
  const scheduleProg = (p: { pct: number | null; phase?: string }) => {
    pendingProg = pendingProg
      ? { pct: p.pct == null ? pendingProg.pct : p.pct, phase: p.phase || pendingProg.phase }
      : { pct: p.pct, phase: p.phase };
    if (progRaf) return;
    progRaf = requestAnimationFrame(() => {
      progRaf = 0;
      const pp = pendingProg;
      pendingProg = null;
      if (!pp) return;
      const b = get().indexBusy;
      if (!b) return;
      set({ indexBusy: { ...b, pct: pp.pct == null ? b.pct : pp.pct, phase: pp.phase || b.phase, ts: Date.now() } });
    });
  };
  // Idem pour l'indexation des visages (écrit dans faceBusy, coalesceur séparé).
  const scheduleFaceProg = (p: { pct: number | null; phase?: string }) => {
    pendingFace = pendingFace
      ? { pct: p.pct == null ? pendingFace.pct : p.pct, phase: p.phase || pendingFace.phase }
      : { pct: p.pct, phase: p.phase };
    if (faceRaf) return;
    faceRaf = requestAnimationFrame(() => {
      faceRaf = 0;
      const pp = pendingFace;
      pendingFace = null;
      if (!pp) return;
      const b = get().faceBusy;
      if (!b) return;
      set({ faceBusy: { ...b, pct: pp.pct == null ? b.pct : pp.pct, phase: pp.phase || b.phase, ts: Date.now() } });
    });
  };

  return {
    searchQuery: "",
    posQuery: "",
    searchHits: [],
    searching: false,
    searchError: null,
    searchNotice: null,
    searchStatusInfo: null,
    searchScope: (() => {
      try { return localStorage.getItem("nr.search.scope") === "all" ? "all" : "project"; }
      catch { return "project"; }
    })(),
    setSearchScope: (searchScope) => {
      try { localStorage.setItem("nr.search.scope", searchScope); } catch { /* noop */ }
      set({ searchScope, searchHits: [], searchQuery: "", clusters: [], dedupGroups: [], resultView: "flat", searchNotice: null });
      void get().refreshSearchStatus();
      void get().refreshCharacters();
      // La galerie est une PHOTO d'une portée : on l'invalide, sinon rouvrir le hub réafficherait
      // les visages de l'ancienne portée (les autres projets).
      set({ faceGallery: null });
      if (get().faceHubOpen) get().refreshFaceGallery();
    },
    projectScope: null,
    projectScopeOpen: false,
    selectedProjects: (() => {
      try { return JSON.parse(localStorage.getItem("nr.search.projects") || "[]") as string[]; }
      catch { return []; }
    })(),
    scopePaths: [],
    setProjectScopeOpen: (projectScopeOpen) => {
      set({ projectScopeOpen });
      if (projectScopeOpen) void get().loadProjectScope();
    },
    // Lit le registre projet → rushs et résout les chemins de la portée courante. Sélection vide =
    // projet ouvert dans le logiciel de montage (comportement par défaut demandé).
    loadProjectScope: async () => {
      let scope: ProjectScopeList;
      try { scope = await nr.projects(); }
      catch { return; }
      const known = new Set(scope.projects.map((p) => p.name));
      // Un projet supprimé du registre ne doit pas rester dans la sélection persistée.
      const selected = get().selectedProjects.filter((name) => known.has(name));
      const effective = selected.length ? selected : (scope.current ? [scope.current] : []);
      let paths: string[] = [];
      if (effective.length) {
        try { paths = (await nr.projectPaths(effective)).paths ?? []; } catch { paths = []; }
      }
      set({ projectScope: scope, selectedProjects: selected, scopePaths: paths });
      if (get().searchScope === "project") {
        void get().refreshSearchStatus();
        void get().refreshCharacters();
        // La galerie est une PHOTO d'une portée : on l'invalide, sinon rouvrir le hub réafficherait
      // les visages de l'ancienne portée (les autres projets).
      set({ faceGallery: null });
      if (get().faceHubOpen) get().refreshFaceGallery();
      }
    },
    setSelectedProjects: (names) => {
      const selectedProjects = [...new Set(names)];
      try { localStorage.setItem("nr.search.projects", JSON.stringify(selectedProjects)); } catch { /* noop */ }
      set({ selectedProjects, searchHits: [], clusters: [], dedupGroups: [], resultView: "flat" });
      void get().loadProjectScope();
    },
    indexBusy: null,
    faceBusy: null,
    indexCancel: false,
    faceCancel: false,
    indexParallel: (() => { try { return localStorage.getItem("nr.search.parallel") === "1"; } catch { return false; } })(),
    setIndexParallel: (indexParallel) => {
      try { localStorage.setItem("nr.search.parallel", indexParallel ? "1" : "0"); } catch { /* noop */ }
      set({ indexParallel });
    },
    scoreThreshold: 0,
    negativeQuery: "",
    refs: [],
    sortMode: "relevance",
    resultView: "flat",
    clusters: [],
    dedupGroups: [],
    analyzing: false,
    faceMode: false,
    facePicker: false,
    faceRefs: [],
    faceHubOpen: false,
    faceHubTab: "gallery",
    faceGallery: null,
    faceGalleryLoading: false,

    setPosQuery: (posQuery) => set({ posQuery }),
    setScoreThreshold: (scoreThreshold) => set({ scoreThreshold }),
    setNegativeQuery: (negativeQuery) => set({ negativeQuery }),
    setSortMode: (sortMode) => set({ sortMode }),
    setResultView: (resultView) => set({ resultView }),
    addRef: (ref) => set((s) => {
      const key = (r: SearchRef) => (r.path ? `p:${r.path}` : `s:${r.file_path}#${r.scene_index}`);
      return s.refs.some((r) => key(r) === key(ref)) ? {} : { refs: [...s.refs, ref] };
    }),
    addImageRefs: (paths) => set((s) => {
      const known = new Set(s.refs.flatMap((r) => (r.path ? [r.path] : [])));
      const fresh = paths.flatMap((p): SearchRef[] =>
        known.has(p) ? [] : [{ path: p, thumb: nr.mediaUrl(p) }]
      );
      return fresh.length ? { refs: [...s.refs, ...fresh] } : {};
    }),
    removeRef: (idx) => set((s) => ({ refs: s.refs.filter((_, i) => i !== idx) })),
    clearRefs: () => set({ refs: [] }),

    refreshSearchStatus: async () => {
      const filePaths = searchScopePaths(get());
      const s = await nr.searchStatus({ filePaths });
      set({ searchStatusInfo: s });
    },
    // Recherche unifiée : texte positif + mentions @perso + bac de réfs (mean-pool) + requête
    // négative + score esthétique. Les jetons @perso sont extraits du texte (parseMentions) →
    // charIds pour restreindre au pool des persos ; le reste = requête SigLIP.
    // minScore=0 côté backend (on récupère tout le top-k) → le slider filtre à l'AFFICHAGE, instantané.
    runSearch: async (text) => {
      const st = get();
      const { ids, mentions, cleanText, unknown } = parseMentions(text ?? st.posQuery, st.characters);
      const pos = cleanText.trim();
      const neg = st.negativeQuery.trim();
      const refs = st.refs;
      // Un « @nom » qui ne désigne personne est retiré du texte (le chercher comme un mot ordinaire
      // donnait des résultats absurdes) → on le dit, sinon le filtrage semble muet.
      const searchNotice = unknown.length
        ? i18n.t("search:store.unknownMention", { tokens: unknown.map((u) => `@${u}`).join(", ") })
        : null;
      if (!pos && refs.length === 0 && ids.length === 0) {
        set({ searchHits: [], searchQuery: "", resultView: "flat", searchNotice }); return;
      }
      const refLabel = (r: SearchRef) => basename(r.file_path || r.path || i18n.t("search:store.referenceFallback"));
      const bits: string[] = [];
      if (mentions.length) bits.push(mentions.map((m) => `@${m.name}`).join(" "));
      if (pos) bits.push(pos);
      else if (!pos && refs.length) bits.push(refs.length === 1 ? i18n.t("search:store.querySimilarTo", { name: refLabel(refs[0]) }) : i18n.t("search:store.queryMoodboard", { count: refs.length }));
      set({
        searching: true, searchError: null, searchNotice,
        searchQuery: (bits.join(" ") || i18n.t("search:store.queryDefault")) + (neg ? `  − ${neg}` : ""),
        resultView: "flat", clusters: [], dedupGroups: [], faceMode: false, faceChar: null,
      });
      try {
        const r = await nr.runSearch({
          // La langue de l'interface tranche quand la requête est trop courte pour être reconnue
          // (le sidecar cadre le prompt DANS cette langue — cf. nrsearch/qtext.py).
          text: pos, negText: neg, lang: i18n.language?.split("-")[0],
          refs: refs.map((x) => ({ path: x.path, file_path: x.file_path, scene_index: x.scene_index })),
          topK: SEARCH_TOP_K, minScore: 0, beta: 0.4, aesthetic: true,
          charIds: ids.length ? ids : undefined,
          filePaths: searchScopePaths(st),
        });
        // Le sigmoïde calibré SigLIP donne des probas MINUSCULES sur du texte (top ~0.002 → badge
        // « 0% » partout, seuil inutilisable). On renormalise en RELATIF sur le lot renvoyé
        // (min-max, monotone → classement intact) : badge et slider redeviennent parlants.
        // UNIQUEMENT quand il y a du texte : un pool @perso SANS texte porte déjà des scores de
        // reconnaissance calibrés (0.5 = seuil moteur) → on les garde tels quels.
        let hits = r.hits ?? [];
        if (pos && hits.length > 1) {
          const scores = hits.map((h) => h.score);
          const hi = Math.max(...scores), lo = Math.min(...scores);
          if (hi > lo) hits = hits.map((h) => ({ ...h, score: (h.score - lo) / (hi - lo) }));
        }
        // Avertissements cumulés : mention inconnue (renderer) + dégradation du filtre @perso (backend).
        const notices = [searchNotice, r.notice ?? null].filter((n): n is string => !!n);
        set({ searching: false, searchHits: hits, searchError: r.error ?? null, searchNotice: notices.join(" · ") || null });
      } catch (e) {   // core/sidecar indispo → erreur lisible, jamais de spinner infini
        set({ searching: false, searchHits: [], searchError: i18n.t("search:store.searchUnavailable", { error: String(e) }) });
      }
    },
    findSimilar: async (hit, thumb = null) => {
      set({ refs: [{ file_path: hit.file_path, scene_index: hit.scene_index, thumb }], posQuery: "", negativeQuery: "" });
      await get().runSearch("");
    },
    openFacePicker: () => set({ facePicker: true }),
    closeFacePicker: () => set({ facePicker: false }),
    setFaceRefs: (faceRefs) => set({ faceRefs }),
    // Charge (ou recharge) les visages indexés regroupés pour l'onglet « Détectés ».
    refreshFaceGallery: () => {
      set({ faceGalleryLoading: true });
      nr.faceGallery({ topK: 200, filePaths: searchScopePaths(get()) })
        .then((r) => set({ faceGallery: r.faces ?? [], faceGalleryLoading: false }))
        .catch(() => set({ faceGallery: [], faceGalleryLoading: false }));
    },
    // Hub Visages : ouvre la grande fenêtre sur l'onglet demandé. L'onglet « Détectés » charge la
    // galerie ; les deux onglets rafraîchissent roster + disponibilité des moteurs.
    openFaceHub: (tab) => {
      set({ faceHubOpen: true, faceHubTab: tab });
      if (tab === "gallery") get().refreshFaceGallery();
      void get().refreshCharacters();
      void get().checkFaceEngines();
    },
    closeFaceHub: () => set({ faceHubOpen: false }),
    setFaceHubTab: (tab) => {
      set({ faceHubTab: tab });
      if (tab === "gallery" && get().faceGallery == null) get().refreshFaceGallery();
    },
    // Recherche directe par un visage DÉJÀ indexé (clic dans la galerie) : son embedding stocké sert
    // de référence — aucune photo à fournir. Résultats dans la grille (mode visage).
    searchByIndexedFace: async (ref) => {
      set({ searching: true, searchError: null, searchNotice: null, searchQuery: ref.domain === "anime" ? i18n.t("search:store.queryIndexedFaceAnime") : i18n.t("search:store.queryIndexedFaceReal"), faceMode: true, faceChar: null, resultView: "flat", clusters: [], dedupGroups: [], faceHubOpen: false });
      try {
        const r = await nr.faceSearch({ refs: [{ file_path: ref.file_path, scene_index: ref.scene_index, face_index: ref.face_index }], topK: SEARCH_TOP_K, minScore: 0, filePaths: searchScopePaths(get()) });
        set({ searching: false, searchHits: r.hits ?? [], searchError: r.error ?? null });
      } catch (e) {
        set({ searching: false, searchHits: [], searchError: i18n.t("search:store.faceSearchUnavailable", { error: String(e) }) });
      }
    },
    // Recherche par visage : visages choisis au picker (bbox + domaine → moteur d'identité CCIP/SFace).
    // Repli : images du bac Références (le backend prend le plus grand visage détecté par domaine).
    // Score déjà calibré 0..1 côté backend (0.5 = seuil officiel du moteur) → même échelle que le texte.
    runFaceSearch: async () => {
      const faceRefs = get().faceRefs;
      const refs: SearchRef[] = faceRefs.length
        ? faceRefs.map((x) => ({ path: x.path, bbox: x.bbox, domain: x.domain }))
        : get().refs.map((x) => ({ path: x.path, file_path: x.file_path, scene_index: x.scene_index }));
      if (refs.length === 0) {
        set({ searchError: i18n.t("search:store.faceSearchNeedsRef") });
        return;
      }
      const head = refs.length === 1 ? i18n.t("search:store.queryFaceSingle") : i18n.t("search:store.queryFaceMulti", { count: refs.length });
      set({ searching: true, searchError: null, searchNotice: null, searchQuery: head, resultView: "flat", clusters: [], dedupGroups: [], faceMode: true, faceChar: null });
      try {
        const r = await nr.faceSearch({ refs, topK: SEARCH_TOP_K, minScore: 0, filePaths: searchScopePaths(get()) });
        set({ searching: false, searchHits: r.hits ?? [], searchError: r.error ?? null });
      } catch (e) {
        set({ searching: false, searchHits: [], searchError: i18n.t("search:store.faceSearchUnavailableRestart", { error: String(e) }) });
      }
    },
    // Indexe les visages d'une liste de clips (réutilise les plans déjà détectés). Barre + annulation
    // INDÉPENDANTES de l'indexation des plans → les deux peuvent tourner en même temps (faceBusy,
    // faceCancel, progression filtrée sur kind==='face').
    // Arrêt IMMÉDIAT : le flag stoppe la boucle, l'appel core tue les jobs en vol (sinon il fallait
    // attendre la fin du clip courant — plusieurs minutes, bouton perçu comme mort).
    cancelIndexing: () => { set({ indexCancel: true }); void nr.cancelIndexJobs(); },
    cancelFaceIndexing: () => { set({ faceCancel: true }); void nr.cancelIndexJobs(); },
    indexFaces: async (paths, force = false) => {
      if (!paths.length) return;
      // Tâche lourde → propose de fermer le logiciel de montage (libérer RAM/GPU).
      get().offerCloseForRam();
      const total = paths.length;
      let failed = 0; let lastErr = "";
      let stopped = false;
      set({ searchError: null, faceCancel: false });
      // MÊME modèle de découpe que l'index de plans → le scene_index des visages désigne le même
      // plan que l'index texte (filtre @perso fiable, cf. cmd_face_index cut_model côté python).
      const cutModel = get().searchCutModel;

      // Concurrence : 1 (séquentiel) ou N selon la VRAM libre si le mode parallèle est coché.
      let conc = 1;
      if (get().indexParallel) {
        try { conc = Math.max(1, Math.round(await nr.indexConcurrency())); } catch { conc = 1; }
      }

      // Progression GLOBALE du lot (monotone) : le core envoie un pct DANS le clip courant → on le
      // combine avec les clips déjà faits, sinon la barre affiche 0→95 puis retour à 0 à chaque
      // clip. En parallèle elle est pilotée par bump() (agrégat clips) : à N daemons le pct
      // par-clip est ambigu.
      const track = createSmoothProgress((pct) => scheduleFaceProg({ pct }));
      const off = conc <= 1
        ? nr.onSearchProgress((p) => {
            if (p.kind !== "face") return;
            const b = get().faceBusy;
            if (!b) return;
            if (p.phase) scheduleFaceProg({ pct: null, phase: p.phase });
            track.to(batchProgress(b.done, b.total, p.pct), batchCeiling(b.done, b.total));
          })
        : () => {};
      // Keepalive : le chargement des modèles (1er clip, ~20-30 s) n'émet aucune progression →
      // sans ça l'UI afficherait « Bloqué ». On rafraîchit l'horodatage tant qu'un clip est en cours.
      const keepalive = setInterval(() => { const b = get().faceBusy; if (b) set({ faceBusy: { ...b, ts: Date.now() } }); }, 3000);

      try {
        if (conc <= 1) {
          // Séquentiel : pct = progression GLOBALE (clips faits + fraction du clip courant).
          for (let i = 0; i < total; i++) {
            if (get().faceCancel) { stopped = true; break; }
            track.to(batchProgress(i, total, 0), batchCeiling(i, total));
            set({ faceBusy: { file: basename(paths[i]), pct: track.value(), done: i, total, phase: "", ts: Date.now() } });
            const r = await withDaemonRetry(() => nr.faceIndex(paths[i], force, cutModel, detectionOptionsFor(cutModel, get().detectionOptions)), () => get().faceCancel);
            if (isCanceled(r.error)) { stopped = true; break; }
            if (r.error) { failed++; lastErr = r.error; }
          }
        } else {
          // PARALLÈLE : `conc` workers → le core spawne un daemon face par job (borné VRAM par
          // l'ordonnanceur). Progression AGRÉGÉE (done/total + nb en cours) : le pct par clip n'a
          // pas de sens à N daemons. Chaque worker garde ses moteurs chauds sur ses clips.
          let cursor = 0, done = 0, running = 0;
          const bump = () => {
            track.to(batchProgress(done, total, 0), batchCeiling(done, total, running));
            set({ faceBusy: {
              file: i18n.t("search:store.parallelRunning", { running, conc }),
              pct: track.value(), done, total, phase: "embed", ts: Date.now(),
            } });
          };
          bump();
          const worker = async () => {
            for (;;) {
              if (get().faceCancel) { stopped = true; return; }
              const i = cursor++;
              if (i >= total) return;
              running++; bump();
              try {
                const r = await withDaemonRetry(() => nr.faceIndex(paths[i], force, cutModel, detectionOptionsFor(cutModel, get().detectionOptions)), () => get().faceCancel);
                if (isCanceled(r.error)) { stopped = true; running--; return; }
                if (r.error) { failed++; lastErr = r.error; }
              } catch (e) { failed++; lastErr = String(e); }
              running--; done++; bump();
            }
          };
          await Promise.all(Array.from({ length: conc }, () => worker()));
        }
      } finally {
        clearInterval(keepalive);
        off();
        track.stop();
        set({ faceBusy: null, faceCancel: false });
      }
      if (stopped) set({ searchError: i18n.t("search:store.faceIndexingStopped") });
      else if (failed) set({ searchError: i18n.t("search:store.faceIndexingFailed", { failed, total, error: lastErr }) });
    },
    runDedup: async (scope) => {
      const st = get();
      set({ analyzing: true, searchError: null });
      const opts = scope?.filePath
        ? { filePath: scope.filePath, threshold: 0.93 }
        : { scenes: st.searchHits.map((h) => ({ file_path: h.file_path, scene_index: h.scene_index })), threshold: 0.93 };
      try {
        const r = await nr.dedup(opts);
        set({ analyzing: false, dedupGroups: r.groups ?? [], resultView: "dedup", searchError: r.error ?? null });
      } catch (e) {
        set({ analyzing: false, searchError: i18n.t("search:store.dedupUnavailable", { error: String(e) }) });
      }
    },
    runCluster: async (scope) => {
      const st = get();
      set({ analyzing: true, searchError: null });
      const opts = scope?.filePath
        ? { filePath: scope.filePath }
        : { scenes: st.searchHits.map((h) => ({ file_path: h.file_path, scene_index: h.scene_index })) };
      try {
        const r = await nr.cluster(opts);
        set({ analyzing: false, clusters: r.clusters ?? [], resultView: "clusters", searchError: r.error ?? null });
      } catch (e) {
        set({ analyzing: false, searchError: i18n.t("search:store.clustersUnavailable", { error: String(e) }) });
      }
    },
    // Indexe une liste de clips (1 frame/plan → embedding SigLIP 2, cache SQLite, incrémental).
    // Progression réelle par clip via onSearchProgress (canal search:progress).
    indexClips: async (paths, force = false, frames = DEFAULT_FRAMES) => {
      if (!paths.length) return;
      const total = paths.length;
      let failed = 0;
      let lastErr = "";   // remonte la vraie erreur du daemon (sinon avalée)
      let stopped = false;
      set({ searchError: null, indexCancel: false });
      // Indexation = tâche GPU lourde → propose de fermer le logiciel de montage pour libérer la VRAM.
      get().offerCloseForRam();
      const cutModel = get().searchCutModel;   // modèle de découpe choisi dans les paramètres

      // Concurrence : 1 (séquentiel) ou N selon la VRAM libre si le mode parallèle est coché.
      let conc = 1;
      if (get().indexParallel) {
        try { conc = Math.max(1, Math.round(await nr.indexConcurrency())); } catch { conc = 1; }
      }

      if (conc <= 1) {
        // Séquentiel : le core rend un pct DANS le clip courant (0..95) — l'afficher tel quel
        // faisait retomber la barre à 0 à chaque fichier. On le convertit en progression GLOBALE du
        // lot, lissée : le chargement du modèle (~20-30 s au 1er clip) n'émet rien.
        const track = createSmoothProgress((pct) => scheduleProg({ pct }));
        const off = nr.onSearchProgress((p) => {
          if (p.kind === "face" || p.kind === "label") return;
          const b = get().indexBusy;
          if (!b) return;
          if (p.phase) scheduleProg({ pct: null, phase: p.phase });
          track.to(batchProgress(b.done, b.total, p.pct), batchCeiling(b.done, b.total));
        });
        try {
          for (let i = 0; i < total; i++) {
            if (get().indexCancel) { stopped = true; break; }   // arrêt demandé → on s'arrête au clip suivant
            track.to(batchProgress(i, total, 0), batchCeiling(i, total));
            set({ indexBusy: { file: basename(paths[i]), pct: track.value(), done: i, total, phase: "", ts: Date.now() } });
            const r = await withDaemonRetry(() => nr.indexClip(paths[i], force, frames, cutModel, detectionOptionsFor(cutModel, get().detectionOptions)), () => get().indexCancel);   // force = seek précis + retraite tout ; frames = images par plan ; cutModel = découpe
            if (isCanceled(r.error)) { stopped = true; break; }
            if (r.error) { failed++; lastErr = r.error; }   // on saute le clip fautif, on continue le reste
            else void warmIndexedThumbs(paths[i]);
          }
        } finally {
          off();
          track.stop();
          set({ indexBusy: null, indexCancel: false });
        }
      } else {
        // PARALLÈLE : pool de `conc` workers (le core spawne un daemon SigLIP par job, borné VRAM).
        // Progression AGRÉGÉE (done/total + nb en cours) : le pct par plan n'a pas de sens à N daemons.
        let cursor = 0, done = 0, running = 0;
        // Lissée sur la FENÊTRE en vol : `done` ne bouge qu'à la fin d'un clip, donc à N workers la
        // barre serait immobile pendant des minutes puis sauterait de N crans d'un coup.
        const track = createSmoothProgress((pct) => scheduleProg({ pct }));
        const bump = () => {
          track.to(batchProgress(done, total, 0), batchCeiling(done, total, running));
          set({ indexBusy: {
            file: i18n.t("search:store.parallelRunning", { running, conc }),
            pct: track.value(), done, total, phase: "embed", ts: Date.now(),
          } });
        };
        bump();
        // Keepalive : un clip prend des minutes → sans ça l'UI croit l'indexation « bloquée » (>12 s).
        const keepalive = setInterval(() => { const b = get().indexBusy; if (b) set({ indexBusy: { ...b, ts: Date.now() } }); }, 3000);
        const worker = async () => {
          for (;;) {
            if (get().indexCancel) { stopped = true; return; }
            const i = cursor++;
            if (i >= total) return;
            running++; bump();
            try {
              const r = await withDaemonRetry(() => nr.indexClip(paths[i], force, frames, cutModel, detectionOptionsFor(cutModel, get().detectionOptions)), () => get().indexCancel);
              if (isCanceled(r.error)) { stopped = true; running--; return; }
              if (r.error) { failed++; lastErr = r.error; }
              else void warmIndexedThumbs(paths[i]);
            } catch (e) { failed++; lastErr = String(e); }
            running--; done++; bump();
          }
        };
        try {
          await Promise.all(Array.from({ length: conc }, () => worker()));
        } finally {
          clearInterval(keepalive);
          track.stop();
          set({ indexBusy: null, indexCancel: false });
        }
      }

      // Absorbe ici le cold-start du modèle et la reconstruction de l'index RAM : une fois la
      // tâche annoncée terminée, la première recherche utilisateur est réellement prête.
      if (!stopped && failed < total) {
        set({ indexBusy: {
          file: i18n.t("search:indexProgress.readyingSearch"), pct: 99,
          done: Math.max(0, total - 1), total, phase: "prep", ts: Date.now(),
        } });
        // Cette étape ne rend aucun compte : sans battement, son horodatage vieillit sur place et
        // l'écran finit par annoncer « Bloqué » alors que le modèle charge normalement.
        const beat = setInterval(() => { const b = get().indexBusy; if (b) set({ indexBusy: { ...b, ts: Date.now() } }); }, 3000);
        try { await nr.warmSearchIndex(); } catch { /* la recherche conserve son chargement lazy */ }
        finally { clearInterval(beat); }
        set({ indexBusy: null, indexCancel: false });
      }

      await get().refreshSearchStatus();
      if (stopped) set({ searchError: i18n.t("search:store.indexingStopped", { total }) });
      else if (failed) set({ searchError: i18n.t("search:store.indexingFailed", { failed, total, error: lastErr }) });
    },
    // Ajoute les plans directement à la timeline OUVERTE dans Resolve (mode 'append', frame-accurate).
    // Le hit porte déjà les bornes en frames source (start_frame/end_frame inclusifs) + src_frames →
    // même chemin que la grille derush (buildTimeline). Réutilise le toast tlBusy/tlNotice.
    sendHitsToTimeline: async (hits) => {
      if (!hits.length) return;
      set({ tlNotice: null });
      let ok = 0, fail = 0, lastErr = "";
      for (let i = 0; i < hits.length; i++) {
        const h = hits[i];
        set({ tlBusy: { phase: i18n.t("search:store.addingToTimeline", { i: i + 1, total: hits.length }), pct: Math.round((i / hits.length) * 100) } });
        const name = `${basename(h.file_path).replace(/\.[^.]+$/, "")} — recherche`;
        const r = await hostBuildTimeline(get().activeHost, {
          name, input: h.file_path, srcFrames: h.src_frames, mode: "append", fps: h.fps ?? undefined,
          segments: [{ in: h.start_sec, out: h.end_sec, inFrame: h.start_frame, outFrame: h.end_frame }],
        });
        r.ok ? ok++ : (fail++, lastErr = r.error || "");
      }
      set({
        tlBusy: null,
        tlNotice: fail
          ? { kind: "warn", text: lastErr ? i18n.t("search:store.timelineAddPartial", { ok, fail, error: lastErr }) : i18n.t("search:store.timelineAddFailed", { ok, fail }) }
          : { kind: "ok", text: i18n.t("search:store.timelineAddOk", { count: ok }) },
      });
    },
  };
};
