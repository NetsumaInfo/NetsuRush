// Slice « bibliothèque de rushs importés ».
// Modèle : le CORE est la source unique de vérité, le renderer est un miroir rechargé après chaque
// mutation (calque de la slice collections). Différence assumée : loadLibrary réécrit AUSSI
// `derush.localClips` — les six consommateurs existants (`[...clips, ...localClips]` dans RushGrid,
// MediaPicker du board, UpscaleSources, FootagesPanel, IndexPicker, FaceIndexPicker) héritent ainsi
// de la persistance sans une ligne modifiée, et il n'y a toujours qu'une seule vérité.
import type { StateCreator } from "zustand";
import type { AppState } from "./index";
import type { LibraryItem, LibraryFolder, LibraryUndo } from "@/lib/bridge";
import { nr } from "@/lib/bridge";
import { itemsToClips } from "@/components/rushes/libraryShared";
import i18n from "@/i18n";

// Profondeur de l'historique d'annulation. Une pile bornée : les retraits sont réversibles à volonté
// dans une session, sans garder indéfiniment des enregistrements de rushs oubliés.
const UNDO_MAX = 20;
// Durée d'affichage de la notice « N rushs retirés · Annuler ».
const NOTICE_MS = 8000;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;

export interface LibrarySlice {
  libraryItems: LibraryItem[];
  libraryFolders: LibraryFolder[];
  // Chemins des rushs dont le fichier a disparu (badge + bandeau). Jamais purgés automatiquement :
  // un disque externe débranché viderait la bibliothèque toute seule.
  libraryOffline: Set<string>;
  libraryLoading: boolean;
  // Dossier qu'une puce de l'accueil demande au navigateur de déplier/révéler (chemin d'arbre).
  libraryFocus: string | null;
  // Dernière erreur d'import/rangement. Sans ça un échec (dossier introuvable, nom en double, base
  // illisible) ne se voit NULLE PART : l'utilisateur choisit ses fichiers et rien ne bouge.
  libraryError: string | null;
  // Pile d'annulation des retraits (rushs et dossiers). Rien ici ne concerne le disque : un retrait
  // n'efface qu'une entrée d'index, l'annulation la remet à l'identique.
  libraryUndo: LibraryUndo[];
  // Retour du dernier retrait (« N rushs retirés »), avec l'annulation à portée de clic.
  libraryNotice: string | null;

  loadLibrary: () => Promise<void>;
  importFiles: (paths: string[]) => Promise<{ ok: boolean; added?: number; error?: string }>;
  importFolder: (dir: string) => Promise<{ ok: boolean; added?: number; error?: string }>;
  moveLibraryItem: (id: string, folderId: string | null) => Promise<void>;
  removeLibraryItem: (id: string) => Promise<void>;
  removeLibraryItems: (ids: string[]) => Promise<void>;
  saveLibraryFolder: (f: { id?: string; name: string; parentId?: string | null }) => Promise<void>;
  // `withItems` : true = le sous-arbre entier (dossiers + rushs) part ; false = tout remonte au parent.
  deleteLibraryFolder: (id: string, withItems?: boolean) => Promise<void>;
  undoLibraryDelete: () => Promise<void>;
  setLibraryNotice: (text: string | null) => void;
  checkLibraryOffline: () => Promise<void>;
  relinkLibraryDir: (dir: string) => Promise<{ ok: boolean; relinked?: number; error?: string }>;
  setLibraryFocus: (path: string | null) => void;
  dismissLibraryError: () => void;
}

export const createLibrarySlice: StateCreator<AppState, [], [], LibrarySlice> = (set, get) => ({
  libraryItems: [],
  libraryFolders: [],
  libraryOffline: new Set(),
  libraryLoading: false,
  libraryFocus: null,
  libraryError: null,
  libraryUndo: [],
  libraryNotice: null,

  loadLibrary: async () => {
    if (!nr.library) return;
    set({ libraryLoading: true });
    try {
      const [libraryItems, libraryFolders] = await Promise.all([nr.library.list(), nr.library.listFolders()]);
      set({ libraryItems, libraryFolders, localClips: itemsToClips(libraryItems, libraryFolders) });
    } catch {
      // Lecture en échec : on garde ce qui est affiché plutôt que de vider la bibliothèque.
    } finally {
      set({ libraryLoading: false });
    }
  },

  importFiles: async (paths) => {
    if (!nr.library || !paths.length) return { ok: true, added: 0 };
    set({ libraryError: null });
    const r = await nr.library.addPaths(paths);
    if (r.ok) {
      await get().loadLibrary();
      set({ derushView: "browser" });
    } else set({ libraryError: r.error ?? null });
    return r;
  },

  importFolder: async (dir) => {
    if (!nr.library || !dir) return { ok: true, added: 0 };
    set({ libraryError: null });
    const r = await nr.library.addDir(dir);
    if (r.ok) {
      await get().loadLibrary();
      set({ derushView: "browser" });
    } else set({ libraryError: r.error ?? null });
    return r;
  },

  moveLibraryItem: async (id, folderId) => {
    if (!nr.library) return;
    const r = await nr.library.move(id, folderId);
    if (!r.ok) { set({ libraryError: r.error ?? null }); return; }
    await get().loadLibrary();
  },

  // Retire l'entrée de la bibliothèque. Le fichier sur le disque n'est JAMAIS touché (garde côté core).
  removeLibraryItem: async (id) => { await get().removeLibraryItems([id]); },

  // Retrait en lot (multi-sélection) : UN aller-retour puis UN rechargement — une boucle sur le retrait
  // unitaire ferait N suppressions ET N rechargements complets de la bibliothèque.
  removeLibraryItems: async (ids) => {
    if (!nr.library || !ids.length) return;
    set({ libraryError: null });
    const r = await nr.library.removeMany(ids);
    if (!r.ok) { set({ libraryError: r.error ?? null }); return; }
    if (r.undo) set({ libraryUndo: [...get().libraryUndo, r.undo].slice(-UNDO_MAX) });
    await get().loadLibrary();
    const n = r.undo?.items.length ?? ids.length;
    get().setLibraryNotice(i18n.t("derush:library.removedNotice", { count: n }));
  },

  // Le core refuse un nom vide, contenant « / », ou déjà pris par un frère → l'erreur doit remonter,
  // sinon le dialogue se ferme comme si le dossier avait été créé.
  saveLibraryFolder: async (f) => {
    if (!nr.library) return;
    set({ libraryError: null });
    const r = await nr.library.saveFolder(f);
    if (!r.ok) { set({ libraryError: r.error ?? null }); return; }
    await get().loadLibrary();
  },

  deleteLibraryFolder: async (id, withItems) => {
    if (!nr.library) return;
    set({ libraryError: null });
    const r = await nr.library.deleteFolder(id, withItems);
    if (!r.ok) { set({ libraryError: r.error ?? null }); return; }
    if (r.undo) set({ libraryUndo: [...get().libraryUndo, r.undo].slice(-UNDO_MAX) });
    await get().loadLibrary();
    const n = r.undo?.items.length ?? 0;
    get().setLibraryNotice(withItems && n
      ? i18n.t("derush:library.folderRemovedWithItems", { count: n })
      : i18n.t("derush:library.folderRemoved"));
  },

  // Annule le dernier retrait : les enregistrements repartent au core tels quels (même id, même
  // dossier). Sans pile, rien à faire.
  undoLibraryDelete: async () => {
    const stack = get().libraryUndo;
    const last = stack[stack.length - 1];
    if (!nr.library || !last) return;
    set({ libraryUndo: stack.slice(0, -1), libraryError: null });
    const r = await nr.library.restore(last);
    if (!r.ok) { set({ libraryError: r.error ?? null }); return; }
    await get().loadLibrary();
    get().setLibraryNotice(i18n.t("derush:library.removalUndone"));
  },

  // Effacement auto CENTRALISÉ ici : aucun appelant ne gère de minuteur.
  setLibraryNotice: (libraryNotice) => {
    clearTimeout(noticeTimer);
    set({ libraryNotice });
    if (libraryNotice) noticeTimer = setTimeout(() => set({ libraryNotice: null }), NOTICE_MS);
  },

  checkLibraryOffline: async () => {
    if (!nr.library) return;
    try {
      const r = await nr.library.offline();
      if (r.ok) set({ libraryOffline: new Set((r.missing ?? []).map((m) => m.path)) });
    } catch { /* sonde hors-ligne indisponible : pas de badge, jamais de purge */ }
  },

  relinkLibraryDir: async (dir) => {
    if (!nr.library) return { ok: false, error: "indisponible" };
    const r = await nr.library.relinkDir(dir);
    if (r.ok) {
      await get().loadLibrary();
      await get().checkLibraryOffline();
    }
    return r;
  },

  setLibraryFocus: (libraryFocus) => set({ libraryFocus }),
  dismissLibraryError: () => set({ libraryError: null }),
});
