// Slice « export » : liste de profils d'export + profil actif (bouton principal) + profil du
// petit bouton de vignette. Les profils s'éditent dans les Paramètres ; le bouton principal
// applique le profil ACTIF. Persisté en localStorage. Défaut = import dans la timeline.
import type { StateCreator } from "zustand";
import type { AppState } from "./index";
import {
  type ExportProfile,
  DEFAULT_EXPORT_PROFILES,
  DEFAULT_EXPORT_PROFILE_ID,
  normalizeExportProfile,
  createExportProfile,
} from "@/features/export/profiles";

const KEY_PROFILES = "nr.export.profiles.v2";
const KEY_ACTIVE = "nr.export.active.v2";
const KEY_CARD = "nr.export.card.v1";
const KEY_ICONS = "nr.export.icons.v1";
const ICON_LIBRARY_MAX = 30;

function defaults(): ExportProfile[] {
  return DEFAULT_EXPORT_PROFILES.map(normalizeExportProfile);
}

function readProfiles(): ExportProfile[] {
  try {
    const raw = localStorage.getItem(KEY_PROFILES);
    if (!raw) return defaults();
    const parsed = JSON.parse(raw) as ExportProfile[];
    if (!Array.isArray(parsed) || !parsed.length) return defaults();
    return parsed.map(normalizeExportProfile);
  } catch {
    return defaults();
  }
}

function readStored(key: string, profiles: ExportProfile[], fallback: string): string {
  try {
    const id = localStorage.getItem(key);
    if (id && profiles.some((p) => p.id === id)) return id;
  } catch {
    /* noop */
  }
  return profiles.some((p) => p.id === fallback) ? fallback : (profiles[0]?.id ?? DEFAULT_EXPORT_PROFILE_ID);
}

function persist(profiles: ExportProfile[], active: string, card: string): void {
  try {
    localStorage.setItem(KEY_PROFILES, JSON.stringify(profiles));
    localStorage.setItem(KEY_ACTIVE, active);
    localStorage.setItem(KEY_CARD, card);
  } catch {
    /* noop */
  }
}

function readIconLibrary(): string[] {
  try {
    const raw = localStorage.getItem(KEY_ICONS);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (Array.isArray(parsed)) return parsed.filter((s): s is string => typeof s === "string");
  } catch {
    /* noop */
  }
  return [];
}

function persistIconLibrary(icons: string[]): void {
  try {
    localStorage.setItem(KEY_ICONS, JSON.stringify(icons));
  } catch {
    /* quota dépassé (gros gif) → reste en mémoire pour la session */
  }
}

export interface ExportSlice {
  exportProfiles: ExportProfile[];
  activeExportProfileId: string;
  // Profil appliqué par le petit bouton « télécharger » de chaque vignette.
  cardActionProfileId: string;
  // Images/gifs importés comme icônes, réutilisables sur n'importe quel profil.
  iconLibrary: string[];
  exportBusy: string | null;
  exportProgress: number;
  exportError: string | null;

  setActiveExportProfile: (id: string) => void;
  setCardActionProfile: (id: string) => void;
  // Remplace la liste ENTIÈRE + les sélections d'un coup. Sert l'hydratation des réglages partagés
  // (hooks/useSharedPrefs) : appliquer profils puis id actif en deux temps rejetterait un id encore
  // inconnu de la liste.
  replaceExportProfiles: (profiles: ExportProfile[], activeId?: string, cardId?: string) => void;
  addExportProfile: () => void;
  duplicateExportProfile: (id: string) => void;
  // Rajoute les préréglages livrés qui manquent à la liste (aucun profil existant n'est touché).
  restoreDefaultExportProfiles: () => void;
  updateExportProfile: (id: string, patch: Partial<ExportProfile>) => void;
  removeExportProfile: (id: string) => void;
  addIconToLibrary: (src: string) => void;
  removeIconFromLibrary: (src: string) => void;

  setExportProgress: (pct: number) => void;
  setExportBusy: (m: string | null) => void;
  setExportError: (m: string | null) => void;
}

export const createExportSlice: StateCreator<AppState, [], [], ExportSlice> = (set, get) => {
  const profiles = readProfiles();
  const active = readStored(KEY_ACTIVE, profiles, DEFAULT_EXPORT_PROFILE_ID);
  const card = readStored(KEY_CARD, profiles, DEFAULT_EXPORT_PROFILE_ID);

  const commit = (next: ExportProfile[], nextActive?: string) => {
    const a = nextActive ?? get().activeExportProfileId;
    const safeActive = next.some((p) => p.id === a) ? a : (next[0]?.id ?? DEFAULT_EXPORT_PROFILE_ID);
    const c = get().cardActionProfileId;
    const safeCard = next.some((p) => p.id === c) ? c : safeActive;
    persist(next, safeActive, safeCard);
    set({ exportProfiles: next, activeExportProfileId: safeActive, cardActionProfileId: safeCard });
  };

  return {
    exportProfiles: profiles,
    activeExportProfileId: active,
    cardActionProfileId: card,
    iconLibrary: readIconLibrary(),
    exportBusy: null,
    exportProgress: 0,
    exportError: null,

    setActiveExportProfile: (id) => {
      if (!get().exportProfiles.some((p) => p.id === id)) return;
      persist(get().exportProfiles, id, get().cardActionProfileId);
      set({ activeExportProfileId: id });
    },

    replaceExportProfiles: (profiles, activeId, cardId) => {
      const list = profiles.length ? profiles : get().exportProfiles;
      const has = (id?: string) => !!id && list.some((p) => p.id === id);
      const active = has(activeId) ? activeId! : (list[0]?.id ?? DEFAULT_EXPORT_PROFILE_ID);
      const card = has(cardId) ? cardId! : active;
      persist(list, active, card);
      set({ exportProfiles: list, activeExportProfileId: active, cardActionProfileId: card });
    },

    setCardActionProfile: (id) => {
      if (!get().exportProfiles.some((p) => p.id === id)) return;
      persist(get().exportProfiles, get().activeExportProfileId, id);
      set({ cardActionProfileId: id });
    },

    addExportProfile: () => {
      const list = get().exportProfiles;
      const np: ExportProfile = { ...createExportProfile(list.length + 1), id: `export-profile-${Date.now()}` };
      commit([...list, np], np.id);
    },

    duplicateExportProfile: (id) => {
      const list = get().exportProfiles;
      const src = list.find((p) => p.id === id);
      if (!src) return;
      const copy: ExportProfile = { ...src, id: `export-profile-${Date.now()}`, name: `${src.name} (copie)` };
      commit([...list, copy], copy.id);
    },

    // Les profils sont persistés (et partagés entre origines) : enrichir DEFAULT_EXPORT_PROFILES ne
    // suffit pas à les faire apparaître chez qui a déjà une liste. Les greffer automatiquement ferait
    // revenir un préréglage supprimé exprès → c'est une action EXPLICITE de l'utilisateur.
    restoreDefaultExportProfiles: () => {
      const list = get().exportProfiles;
      const missing = defaults().filter((profile) => !list.some((p) => p.id === profile.id));
      if (!missing.length) return;
      commit([...list, ...missing]);
    },

    updateExportProfile: (id, patch) => {
      const next = get().exportProfiles.map((p) =>
        p.id === id ? normalizeExportProfile({ ...p, ...patch }) : p,
      );
      commit(next);
    },

    removeExportProfile: (id) => {
      const list = get().exportProfiles;
      if (list.length <= 1) return;
      const next = list.filter((p) => p.id !== id);
      const nextActive = get().activeExportProfileId === id ? next[0]?.id : undefined;
      commit(next, nextActive);
    },

    addIconToLibrary: (src) => {
      if (!src) return;
      const next = [src, ...get().iconLibrary.filter((s) => s !== src)].slice(0, ICON_LIBRARY_MAX);
      persistIconLibrary(next);
      set({ iconLibrary: next });
    },

    removeIconFromLibrary: (src) => {
      const next = get().iconLibrary.filter((s) => s !== src);
      persistIconLibrary(next);
      set({ iconLibrary: next });
    },

    setExportProgress: (pct) => set({ exportProgress: pct }),
    setExportBusy: (exportBusy) => set({ exportBusy }),
    setExportError: (exportError) => set({ exportError }),
  };
};
