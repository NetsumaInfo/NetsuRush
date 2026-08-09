// Slice bibliothèque de personnages nommés : roster (CRUD + échantillons), recherche par
// personnage enregistré, auto-étiquetage de l'index. Le serveur (SQLite) est la vérité →
// on rafraîchit après chaque mutation. Écrit dans la slice recherche (searchHits/faceMode)
// via get() pour afficher les résultats dans la grille partagée.
import type { StateCreator } from "zustand";
import i18n from "@/i18n";
import { nr, type Character, type CharRef, type SearchHit, type DuplicatePair } from "@/lib/bridge";
import type { AppState } from "./index";
import { SEARCH_TOP_K, searchScopePaths } from "./search";

export interface CharacterSlice {
  characters: Character[];
  charsLoading: boolean;
  charLabeling: { pct: number; phase: string } | null;   // passe d'auto-étiquetage en cours
  // Personnage de la recherche en cours (recherche/filtre par perso) → bouton « C'est bien lui »
  // sur les résultats (apprentissage incrémental : confirmer = nouvel échantillon du perso).
  faceChar: { id: number; name: string; color?: string } | null;
  duplicates: DuplicatePair[] | null;   // paires « probablement le même » (null = pas encore cherché)
  dupLoading: boolean;
  // Moteurs de visage : disponibilité + téléchargement inline (les poids/deps manquent souvent en dev).
  faceEngines: { anime: boolean; real: boolean; ready: boolean } | null;
  faceModelsDl: { pct: number | null; stage: string } | null;   // téléchargement en cours

  refreshCharacters: () => Promise<void>;
  createCharacter: (o: { name: string; notes?: string; tags?: string[]; color?: string }) => Promise<number | null>;
  updateCharacter: (o: { id: number; name?: string; notes?: string; tags?: string[]; color?: string }) => Promise<void>;
  deleteCharacter: (id: number) => Promise<void>;
  addSampleToCharacter: (charId: number, ref: CharRef) => Promise<boolean>;
  addFacesToCharacter: (charId: number, refs: CharRef[]) => Promise<number>;   // batch (1 refresh)
  createCharacterFromFaces: (name: string, refs: CharRef[], color?: string) => Promise<number | null>;
  mergeMany: (ids: number[]) => Promise<void>;   // fusionne tous dans le 1er
  removeCharacterSample: (id: number) => Promise<void>;
  searchByCharacter: (charId: number, name: string) => Promise<void>;   // recherche via les échantillons
  filterByCharacter: (charId: number, name: string) => Promise<void>;   // plans déjà étiquetés (instantané)
  confirmHitAsCharacter: (hit: SearchHit) => Promise<void>;             // « c'est bien lui » → nouvel échantillon
  labelIndex: () => Promise<void>;
  mergeCharacters: (sourceId: number, targetId: number) => Promise<void>;   // fusionne source dans cible
  findDuplicates: () => Promise<void>;                                       // détecte les doublons probables
  clearDuplicates: () => void;
  checkFaceEngines: () => Promise<void>;                 // rafraîchit la disponibilité des moteurs
  downloadFaceModels: () => Promise<void>;               // télécharge les modèles visage (réel + animé)
}

export const createCharacterSlice: StateCreator<AppState, [], [], CharacterSlice> = (set, get) => ({
  characters: [],
  charsLoading: false,
  charLabeling: null,
  faceChar: null,
  duplicates: null,
  dupLoading: false,
  faceEngines: null,
  faceModelsDl: null,

  refreshCharacters: async () => {
    set({ charsLoading: true });
    try {
      const r = await nr.charList({ filePaths: searchScopePaths(get()) });
      set({ characters: r.characters ?? [], charsLoading: false });
    } catch {
      set({ charsLoading: false });
    }
  },

  createCharacter: async (o) => {
    const r = await nr.charCreate(o);
    await get().refreshCharacters();
    return r.id ?? null;
  },
  updateCharacter: async (o) => { await nr.charUpdate(o); await get().refreshCharacters(); },
  deleteCharacter: async (id) => { await nr.charDelete(id); await get().refreshCharacters(); },
  addSampleToCharacter: async (charId, ref) => {
    const r = await nr.charAddSample({ charId, ...ref });
    await get().refreshCharacters();
    if (r.error) set({ searchError: r.error });
    return !!r.ok;
  },
  // Ajoute N visages à un perso en une passe (un seul refresh à la fin, pas N).
  addFacesToCharacter: async (charId, refs) => {
    let added = 0; let lastErr = "";
    for (const ref of refs) {
      const r = await nr.charAddSample({ charId, ...ref });
      if (r.ok) added += 1; else if (r.error) lastErr = r.error;
    }
    await get().refreshCharacters();
    if (lastErr) set({ searchError: lastErr });
    return added;
  },
  // Crée un perso puis y verse tous les visages sélectionnés (création groupée depuis « Détectés »).
  createCharacterFromFaces: async (name, refs, color) => {
    const id = await nr.charCreate({ name, color }).then((r) => r.id ?? null);
    if (id == null) { await get().refreshCharacters(); return null; }
    for (const ref of refs) await nr.charAddSample({ charId: id, ...ref });
    await get().refreshCharacters();
    return id;
  },
  // Fusionne une liste de persos dans le PREMIER (cible) — les autres sont absorbés puis supprimés.
  mergeMany: async (ids) => {
    if (ids.length < 2) return;
    const [target, ...sources] = ids;
    for (const src of sources) {
      const r = await nr.charMerge({ sourceId: src, targetId: target });
      if (!r.ok && r.error) set({ searchError: r.error });
    }
    set((s) => ({ duplicates: s.duplicates?.filter((p) => !ids.includes(p.a.id) && !ids.includes(p.b.id)) ?? null }));
    await get().refreshCharacters();
  },
  removeCharacterSample: async (id) => { await nr.charRemoveSample(id); await get().refreshCharacters(); },

  searchByCharacter: async (charId, name) => {
    const color = get().characters.find((c) => c.id === charId)?.color;
    set({ searching: true, searchError: null, searchNotice: null, searchQuery: i18n.t("collections:char.queryCharacter", { name }), faceMode: true, faceChar: { id: charId, name, color }, resultView: "flat", clusters: [], dedupGroups: [], faceHubOpen: false });
    try {
      const r = await nr.charSearch({ charId, topK: SEARCH_TOP_K, minScore: 0, filePaths: searchScopePaths(get()) });
      set({ searching: false, searchHits: r.hits ?? [], searchError: r.error ?? null });
    } catch (e) {
      set({ searching: false, searchHits: [], searchError: i18n.t("collections:char.searchUnavailable", { error: String(e) }) });
    }
  },
  filterByCharacter: async (charId, name) => {
    const color = get().characters.find((c) => c.id === charId)?.color;
    set({ searching: true, searchError: null, searchNotice: null, searchQuery: i18n.t("collections:char.queryShots", { name }), faceMode: true, faceChar: { id: charId, name, color }, resultView: "flat", clusters: [], dedupGroups: [], faceHubOpen: false });
    try {
      const r = await nr.charShots({ charId, topK: SEARCH_TOP_K, filePaths: searchScopePaths(get()) });
      set({ searching: false, searchHits: r.hits ?? [], searchError: r.error ?? null });
    } catch (e) {
      set({ searching: false, searchHits: [], searchError: i18n.t("collections:char.shotsUnavailable", { error: String(e) }) });
    }
  },
  // « C'est bien lui » : le visage confirmé devient un ÉCHANTILLON du personnage (le perso
  // s'améliore à l'usage) + le hit prend son badge immédiatement (le backend choisit le
  // visage du plan étiqueté pour CE perso).
  confirmHitAsCharacter: async (hit) => {
    const fc = get().faceChar;
    if (!fc) return;
    const r = await nr.charAddSample({ charId: fc.id, file_path: hit.file_path, scene_index: hit.scene_index });
    if (!r.ok) { set({ searchError: r.error || i18n.t("collections:char.cannotSaveFace") }); return; }
    set({
      searchHits: get().searchHits.map((h) =>
        h.file_path === hit.file_path && h.scene_index === hit.scene_index
          ? { ...h, char: { id: fc.id, name: fc.name, color: fc.color } } : h),
    });
    void get().refreshCharacters();
  },

  // Fusion : les échantillons + labels de la source passent à la cible, métadonnées fondues,
  // source supprimée. Rafraîchit le roster et retire la paire des doublons proposés.
  mergeCharacters: async (sourceId, targetId) => {
    const r = await nr.charMerge({ sourceId, targetId });
    if (!r.ok) { set({ searchError: r.error || i18n.t("collections:char.mergeFailed") }); return; }
    set((s) => ({
      duplicates: s.duplicates?.filter((p) => p.a.id !== sourceId && p.b.id !== sourceId
        && p.a.id !== targetId && p.b.id !== targetId) ?? null,
    }));
    await get().refreshCharacters();
  },
  findDuplicates: async () => {
    set({ dupLoading: true });
    try {
      const r = await nr.charDuplicates({ minScore: 0.55 });
      set({ duplicates: r.pairs ?? [], dupLoading: false });
    } catch (e) {
      set({ dupLoading: false, searchError: i18n.t("collections:char.dupUnavailable", { error: String(e) }) });
    }
  },
  clearDuplicates: () => set({ duplicates: null }),

  checkFaceEngines: async () => {
    try { set({ faceEngines: await nr.faceEngines() }); } catch { /* mock/hors-ligne */ }
  },
  // Télécharge les 2 modèles de visage via le gestionnaire (barre de progression models:progress),
  // puis rafraîchit la disponibilité des moteurs. Réel (léger) puis animé (pip + pré-fetch).
  downloadFaceModels: async () => {
    set({ faceModelsDl: { pct: 0, stage: "download" }, searchError: null });
    const off = nr.onModelsProgress((p) => {
      if (p.id === "face-real" || p.id === "face-anime") set({ faceModelsDl: { pct: p.pct ?? null, stage: p.stage ?? "download" } });
    });
    try {
      for (const id of ["face-real", "face-anime"]) {
        const r = await nr.modelsDownload(id);
        if (!r.ok && r.error) set({ searchError: i18n.t("collections:char.dlFailed", { id, error: r.error }) });
      }
    } catch (e) {
      set({ searchError: i18n.t("collections:char.dlModelsUnavailable", { error: String(e) }) });
    } finally {
      off();
      set({ faceModelsDl: null });
      await get().checkFaceEngines();
    }
  },

  // Auto-étiquetage : matche tous les visages indexés contre le roster (progression SSE search:progress).
  labelIndex: async () => {
    get().offerCloseForRam();
    set({ charLabeling: { pct: 0, phase: "" }, searchError: null });
    const off = nr.onSearchProgress((p) => {
      if (p.kind && p.kind !== "label") return;   // ignore la progression des autres indexations concurrentes
      const cur = get().charLabeling;
      if (cur) set({ charLabeling: { pct: p.pct == null ? cur.pct : p.pct, phase: p.phase || cur.phase } });
    });
    try {
      const r = await nr.charLabelIndex({ minScore: 0.5 });
      if (r.error) set({ searchError: r.error });
    } catch (e) {
      set({ searchError: i18n.t("collections:char.recognitionUnavailable", { error: String(e) }) });
    } finally {
      off();
      set({ charLabeling: null });
    }
  },
});
