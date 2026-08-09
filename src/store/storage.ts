// Slice « Stockage » : état du cache médias (vue d'ensemble, arbre par projet, politiques) + l'alerte
// de seuil, qui doit vivre ici plutôt que dans la page — la pastille de la barre latérale s'affiche
// même quand les Paramètres ne sont pas ouverts.
import type { StateCreator } from "zustand";
import type { AppState } from "./index";
import { nr } from "@/lib/bridge";
import { clearThumbs } from "@/lib/thumbCache";
import type { CacheOverview, CacheTree, CacheSettings, CacheWarn, CacheProgress, CacheKind } from "@/lib/bridge";

function normalizeCacheSettings(settings: CacheSettings): CacheSettings {
  // Compat HMR avec un core encore en v2 : la fenêtre Tauri doit être redémarrée pour charger le
  // backend neuf, mais la page reste utilisable entre-temps avec les nouveaux défauts.
  return {
    ...settings,
    policyVersion: settings.policyVersion || 3,
    session: {
      roto: settings.session?.roto ?? "operation",
      upscaleTest: settings.session?.upscaleTest ?? "operation",
      voice: settings.session?.voice ?? "page",
    },
  };
}

export interface StorageSlice {
  cacheOverview: CacheOverview | null;
  cacheTree: CacheTree | null;
  cacheSettings: CacheSettings | null;
  cacheLoading: boolean;
  cacheError: string | null;
  /** Opération longue en cours (purge/réindexation/déplacement) : libellé affiché, null si repos. */
  cacheBusy: string | null;
  cacheProgress: CacheProgress | null;
  /** Dernière alerte de seuil reçue. Alimente la pastille de nav ET la bannière de la page. */
  cacheWarn: CacheWarn | null;
  /** Rushs indexés dont le fichier a disparu. null = pas encore cherché. */
  cacheMissing: { source: string; bytes: number }[] | null;

  /** Branche les flux cache:warn / cache:progress et déclenche un premier contrôle de seuil.
   *  Monté une fois par l'App : la pastille doit apparaître même sans ouvrir les Paramètres. */
  subscribeCache: () => () => void;
  loadCache: () => Promise<void>;
  loadCacheSettings: () => Promise<void>;
  setCachePolicy: (patch: Partial<CacheSettings>) => Promise<void>;
  clearCache: (opts: { kinds?: CacheKind[]; sources?: string[]; unattributed?: boolean }) => Promise<{ ok: boolean; freed?: number; files?: number; rows?: number; skipped?: number; error?: string }>;
  reindexCache: () => Promise<void>;
  loadCacheMissing: () => Promise<void>;
  /** Compacte netsurush.db. Seul moyen de RENDRE au disque l'espace des lignes supprimées. */
  vacuumCache: () => Promise<{ ok: boolean; freed?: number; error?: string }>;
}

/** Vrai s'il y a au moins une alerte active — la pastille et la bannière s'y adossent. */
export const hasCacheAlert = (s: AppState) => !!s.cacheWarn && s.cacheWarn.alerts.length > 0;

export const createStorageSlice: StateCreator<AppState, [], [], StorageSlice> = (set, get) => ({
  cacheOverview: null,
  cacheTree: null,
  cacheSettings: null,
  cacheLoading: false,
  cacheError: null,
  cacheBusy: null,
  cacheProgress: null,
  cacheWarn: null,
  cacheMissing: null,

  subscribeCache: () => {
    if (!nr.cache) return () => {};
    const offWarn = nr.cache.onWarn((w) => set({ cacheWarn: w }));
    const offProgress = nr.cache.onProgress((p) => set({ cacheProgress: p }));
    // Le core émet déjà `cache:warn` à son boot, mais le renderer peut se monter après (ou
    // recharger en HMR) et manquer l'événement → on redemande un contrôle à l'abonnement.
    void nr.cache.check().then((w) => set({ cacheWarn: w })).catch(() => {});
    return () => { offWarn(); offProgress(); };
  },

  loadCache: async () => {
    if (!nr.cache) return;
    set({ cacheLoading: true, cacheError: null });
    try {
      // Les deux lectures parcourent le même index : les demander ensemble évite un affichage en
      // deux temps où le total et l'arbre se contredisent une frame.
      const [cacheOverview, cacheTree] = await Promise.all([nr.cache.overview(), nr.cache.tree()]);
      set({ cacheOverview, cacheTree, cacheLoading: false });
    } catch (e) {
      set({ cacheLoading: false, cacheError: String(e) });
    }
  },

  loadCacheSettings: async () => {
    if (!nr.cache) return;
    try {
      set({ cacheSettings: normalizeCacheSettings(await nr.cache.settings()) });
    } catch (e) {
      set({ cacheError: String(e) });
    }
  },

  setCachePolicy: async (patch) => {
    if (!nr.cache) return;
    // Optimiste : les réglages sont des interrupteurs, l'attente d'un aller-retour les rendrait mous.
    const prev = get().cacheSettings;
    if (prev) set({ cacheSettings: {
      ...prev,
      ...patch,
      session: { ...prev.session, ...(patch.session || {}) },
      kinds: { ...prev.kinds, ...(patch.kinds || {}) },
    } });
    try {
      const r = await nr.cache.setSettings(patch);
      if (r.settings) set({ cacheSettings: normalizeCacheSettings(r.settings) });
      else if (!r.ok) set({ cacheSettings: prev, cacheError: r.error || null });
    } catch (e) {
      set({ cacheSettings: prev, cacheError: String(e) });
    }
  },

  clearCache: async (opts) => {
    if (!nr.cache) return { ok: false, error: "indisponible" };
    set({ cacheBusy: "purge", cacheError: null });
    try {
      const r = await nr.cache.clear(opts);
      // Le cache de vignettes du renderer garde des CHEMINS : sans purge, il continuerait à servir
      // ceux des jpeg qu'on vient d'effacer (vignettes cassées dans la grille).
      if (r.ok && (!opts.kinds || opts.kinds.includes("thumb"))) clearThumbs();
      set({ cacheBusy: null });
      await get().loadCache();
      return r;
    } catch (e) {
      set({ cacheBusy: null, cacheError: String(e) });
      return { ok: false, error: String(e) };
    }
  },

  reindexCache: async () => {
    if (!nr.cache) return;
    set({ cacheBusy: "reindex", cacheError: null });
    try {
      await nr.cache.reindex();
    } catch (e) {
      set({ cacheError: String(e) });
    }
    set({ cacheBusy: null, cacheProgress: null });
    await get().loadCache();
  },

  loadCacheMissing: async () => {
    if (!nr.cache) return;
    try {
      const r = await nr.cache.missing();
      set({ cacheMissing: r.sources });
    } catch (e) {
      set({ cacheError: String(e) });
    }
  },

  vacuumCache: async () => {
    if (!nr.cache) return { ok: false, error: "indisponible" };
    set({ cacheBusy: "vacuum", cacheError: null });
    try {
      const r = await nr.cache.vacuum();
      set({ cacheBusy: null });
      if (r.ok) await get().loadCache();
      return r;
    } catch (e) {
      set({ cacheBusy: null });
      return { ok: false, error: String(e) };
    }
  },

});
