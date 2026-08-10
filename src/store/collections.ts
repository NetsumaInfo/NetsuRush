// Slice collections : bibliothèque de plans gardés (dossiers nommés, code couleur, icône, tags,
// description). La méta (liste des dossiers) vit ici ; le CONTENU d'une collection (ses shots) est
// chargé à la demande par la vue détail. En plus : hiérarchie de DOSSIERS de rangement, registre
// GLOBAL de tags (autocomplétion), et archivage (export indépendant de la source).
import type { StateCreator } from "zustand";
import { nr, type CollectionMeta, type CollectionIcon, type CollectionShot, type CollectionFolder, type CollectionArchive } from "@/lib/bridge";
import {
  coerceExportCodec, coerceExportContainer, coerceExportAudioMode, coerceAudioSelect,
  coerceExportEncoderMode, coerceExportSpeed, type ExportProfile,
} from "@/features/export/profiles";
import type { AppState } from "./index";
import i18n from "@/i18n";

// Navigation interne de l'onglet Collections : liste des dossiers ↔ détail d'un dossier.
type CollectionsView = "list" | "detail";

// Patch de méta d'une collection (création OU mise à jour).
interface CollectionSavePatch {
  id?: string;
  name: string;
  color?: string | null;
  icon?: CollectionIcon | null;
  description?: string;
  tags?: string[];
  folderId?: string | null;
  archive?: CollectionArchive | null;
}

export interface CollectionsSlice {
  collections: CollectionMeta[];
  collectionsLoading: boolean;
  collectionsView: CollectionsView;
  currentCollectionId: string | null;
  // Hiérarchie de rangement (dossiers de collections) + dossier ouvert dans la liste.
  collectionFolders: CollectionFolder[];
  currentFolderId: string | null;
  // Registre global des tags (plans + collections) → autocomplétion partout.
  collectionTags: string[];

  loadCollections: () => Promise<void>;
  loadCollectionFolders: () => Promise<void>;
  loadCollectionTags: () => Promise<void>;
  openCollection: (id: string) => void;
  closeCollection: () => void;
  setCollectionFolder: (id: string | null) => void;
  createCollection: (c: CollectionSavePatch) => Promise<string | null>;
  updateCollection: (c: CollectionSavePatch) => Promise<void>;
  deleteCollection: (id: string) => Promise<void>;
  // Dossiers de rangement.
  saveCollectionFolder: (f: { id?: string; name: string; parentId?: string | null }) => Promise<string | null>;
  deleteCollectionFolder: (id: string) => Promise<void>;
  moveCollection: (id: string, folderId: string | null) => Promise<void>;
  // Range des plans dans un dossier (dédoublonnés côté core). Déclenche l'archivage si auto-sync.
  rangeShots: (id: string, shots: CollectionShot[]) => Promise<{ ok: boolean; added?: number; error?: string }>;
  // Archive une collection : export (remux/encode, codec au choix) vers son dossier de stockage.
  // Ne refait que ce qui a changé — `skipped`/`copied`/`rendered` disent ce qui a vraiment été produit.
  archiveCollection: (id: string, opts: { dir?: string; autoSync?: boolean })
    => Promise<{ ok: boolean; skipped?: number; copied?: number; rendered?: number; error?: string }>;
  // Met l'archivage en FILE plutôt que de le lancer : un archivage avec upscale prend le GPU pour
  // longtemps, il attend que la machine ne fasse plus d'encodage.
  queueArchive: (id: string, mode?: "now" | "idle") => Promise<{ ok: boolean; error?: string }>;
  // Change le dossier de stockage : déplace les fichiers déjà archivés vers `dir` et ré-exporte les
  // manquants. `archive` = réglages à appliquer (ceux du formulaire, pas encore en méta) ; absent =
  // réglages persistés.
  relocateArchive: (id: string, opts: { dir: string; archive?: CollectionArchive | null; autoSync?: boolean })
    => Promise<{ ok: boolean; moved?: number; exported?: number; error?: string }>;
}

// Un upscale REMPLACE les pixels : la copie de flux ne peut pas le faire. Activer l'agrandissement
// impose donc le ré-encodage, quel que soit le réglage enregistré (le core applique la même règle —
// l'UI et le core doivent conclure pareil, sinon le fichier produit ne correspond pas à l'aperçu).
const archiveUpscaling = (a: CollectionArchive | null | undefined) => !!a?.upscale?.enabled;

// Le core ne connaît pas les profils d'export → on FABRIQUE un profil de toutes pièces à partir des
// réglages d'archivage d'une collection (format/codec/conteneur/audio choisis dans les réglages).
function archiveProfile(a: CollectionArchive | null | undefined): ExportProfile {
  return {
    id: "__archive__", name: i18n.t("collections:archive.profileName"),
    workflow: a?.workflow === "video_encode" || archiveUpscaling(a) ? "video_encode" : "video_remux",
    codec: coerceExportCodec(a?.codec), audioMode: coerceExportAudioMode(a?.audioMode),
    container: coerceExportContainer(a?.container), mergeEnabled: false,
    encoderMode: coerceExportEncoderMode(a?.encoderMode), speed: coerceExportSpeed(a?.speed),
    audioSelect: coerceAudioSelect(a?.audioSelect),
  };
}

export const createCollectionsSlice: StateCreator<AppState, [], [], CollectionsSlice> = (set, get) => ({
  collections: [],
  collectionsLoading: false,
  collectionsView: "list",
  currentCollectionId: null,
  collectionFolders: [],
  currentFolderId: null,
  collectionTags: [],

  loadCollections: async () => {
    set({ collectionsLoading: true });
    const list = (await nr.collections?.list()) ?? [];
    set({ collections: list, collectionsLoading: false });
  },
  loadCollectionFolders: async () => {
    const f = (await nr.collections?.listFolders?.()) ?? [];
    set({ collectionFolders: f });
  },
  loadCollectionTags: async () => {
    const t = (await nr.collections?.allTags?.()) ?? [];
    set({ collectionTags: t });
  },
  openCollection: (id) => set({ currentCollectionId: id, collectionsView: "detail" }),
  closeCollection: () => set({ collectionsView: "list", currentCollectionId: null }),
  setCollectionFolder: (id) => set({ currentFolderId: id }),

  createCollection: async (c) => {
    const r = await nr.collections?.save(c);
    if (!r?.ok) return null;
    await get().loadCollections();
    return r.id ?? null;
  },
  updateCollection: async (c) => {
    await nr.collections?.save(c);
    await Promise.all([get().loadCollections(), get().loadCollectionTags()]);
  },
  deleteCollection: async (id) => {
    await nr.collections?.delete(id);
    set((s) => s.currentCollectionId === id ? { collectionsView: "list", currentCollectionId: null } : {});
    await get().loadCollections();
  },
  saveCollectionFolder: async (f) => {
    const r = await nr.collections?.saveFolder?.(f);
    await get().loadCollectionFolders();
    return r?.id ?? null;
  },
  deleteCollectionFolder: async (id) => {
    await nr.collections?.deleteFolder?.(id);
    set((s) => s.currentFolderId === id ? { currentFolderId: null } : {});
    await Promise.all([get().loadCollectionFolders(), get().loadCollections()]);
  },
  moveCollection: async (id, folderId) => {
    await nr.collections?.move?.(id, folderId);
    await get().loadCollections();
  },
  rangeShots: async (id, shots) => {
    const r = await nr.collections?.addShots(id, shots);
    if (r?.ok) {
      await Promise.all([get().loadCollections(), get().loadCollectionTags()]);
      // Auto-sync : si la collection est configurée en archivage automatique, ré-exporte en fond.
      // Avec upscale en mode « quand le GPU est libre », on met en FILE au lieu de partir : ranger un
      // plan pendant qu'on travaille ne doit pas confisquer la carte pour plusieurs minutes.
      const meta = get().collections.find((c) => c.id === id);
      if (!meta?.autoSync) return { ok: true, added: r.added };
      const a = meta.archive ?? null;
      if (archiveUpscaling(a) && a?.upscale?.when === "idle") void get().queueArchive(id);
      else void get().archiveCollection(id, { autoSync: true });
    }
    return { ok: !!r?.ok, added: r?.added, error: r?.error };
  },
  archiveCollection: async (id, opts) => {
    const a = get().collections.find((c) => c.id === id)?.archive ?? null;
    const r = await nr.collections?.archive?.(id, {
      dir: opts.dir ?? a?.dir, profile: archiveProfile(a), autoSync: opts.autoSync, upscale: a?.upscale,
    });
    if (r?.ok) await get().loadCollections();
    return { ok: !!r?.ok, skipped: r?.skipped, copied: r?.copied, rendered: r?.rendered, error: r?.error };
  },
  queueArchive: async (id, mode) => {
    const meta = get().collections.find((c) => c.id === id);
    const a = meta?.archive ?? null;
    const r = await nr.collections?.queueEnqueue?.(id, {
      name: meta?.name, mode: mode ?? a?.upscale?.when ?? "idle",
      opts: { dir: a?.dir, profile: archiveProfile(a), autoSync: a?.autoSync, upscale: a?.upscale },
    });
    return { ok: !!r?.ok, error: r?.error };
  },
  relocateArchive: async (id, opts) => {
    const a = opts.archive ?? get().collections.find((c) => c.id === id)?.archive ?? null;
    const r = await nr.collections?.relocateArchive?.(id, {
      dir: opts.dir, profile: archiveProfile(a), autoSync: opts.autoSync ?? a?.autoSync, upscale: a?.upscale,
    });
    if (r?.ok) await get().loadCollections();
    return { ok: !!r?.ok, moved: r?.moved, exported: r?.exported, error: r?.error };
  },
});
