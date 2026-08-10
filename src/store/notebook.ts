// Slice Carnet (Notebook) : carnets (liste), arbre de pages du carnet actif, ONGLETS multi-documents
// (chacun avec son historique ◀▶, persistés par carnet), page ouverte (document de blocs) + ses
// databases, rétroliens, favoris/récents, corbeille (soft-delete), recherche plein-texte et prefs
// (apparence + raccourcis rebindables). L'édition met à jour l'état LOCAL et marque `nbDirty` ; un
// hook (useNotebookAutosave) débounce et appelle `nbFlushPage` → persistance core.
import type { StateCreator } from "zustand";
import { nr, type NbSearchHit } from "@/lib/bridge";
import type { AppState } from "./index";
import {
  nbId as newId,
  type NotebookMeta, type PageMeta, type NotebookPage, type NoteBlock, type Database, type NbTab,
  type NotebookKind, type NotebookLanguage,
} from "@/components/notebook/notebookShared";
import { readPrefs, PREFS_KEY, type NotebookPrefs } from "@/components/notebook/notebookPrefs";
import i18n from "@/i18n";

interface NbOpenOpts {
  blockId?: string;   // ancre : scroller/surligner ce bloc à l'arrivée
  newTab?: boolean;   // ouvrir dans un nouvel onglet (Alt-clic / clic-milieu)
}

interface NbCreateOpts {
  title?: string;
  blocks?: NoteBlock[];
  newTab?: boolean;
  silent?: boolean;   // créer SANS naviguer (mention @, bloc sous-page)
}

export interface NotebookSlice {
  nbList: NotebookMeta[];
  nbActiveId: string | null;
  nbPages: PageMeta[];            // arbre (métas) du carnet actif
  nbActivePageId: string | null;
  nbPage: NotebookPage | null;    // page ouverte (avec blocs)
  nbDatabases: Record<string, Database>;
  nbBacklinks: PageMeta[];
  nbLoading: boolean;
  nbDirty: boolean;              // page ouverte modifiée, en attente de flush

  // Onglets (multi-documents) + ancre de bloc + navigation.
  nbTabs: NbTab[];
  nbActiveTabId: string | null;
  nbClosedTabs: string[];        // pile des pageId d'onglets fermés (rouvrir Ctrl+Shift+T)
  nbAnchor: string | null;       // blockId à scroller/surligner (consommé par l'éditeur)
  nbClearAnchor: () => void;

  // Prefs (apparence/éditeur/raccourcis) + favoris/récents + corbeille + recherche.
  nbPrefs: NotebookPrefs;
  nbSetPrefs: (patch: Partial<NotebookPrefs>) => void;
  nbFavorites: string[];
  nbRecents: string[];
  nbToggleFavorite: (pageId: string) => void;
  nbTrash: PageMeta[];
  nbLoadTrash: () => Promise<void>;
  nbRestorePage: (id: string) => Promise<void>;
  nbPurgePage: (id: string) => Promise<void>;
  nbEmptyTrash: () => Promise<void>;
  nbSearchResults: NbSearchHit[];
  nbRunSearch: (query: string) => Promise<void>;
  nbClearSearch: () => void;

  nbLoadList: () => Promise<void>;
  nbCreateNotebook: (title?: string, kind?: NotebookKind, language?: NotebookLanguage) => Promise<string | null>;
  nbOpenNotebook: (id: string) => Promise<void>;
  nbRenameNotebook: (id: string, patch: { title?: string; icon?: string | null; kind?: NotebookKind; language?: NotebookLanguage }) => Promise<void>;
  nbDeleteNotebook: (id: string) => Promise<void>;
  // Ouvre (ou crée) le carnet lié à un script et bascule sur l'onglet Carnet.
  nbForScript: (scriptId: string, title?: string) => Promise<void>;

  nbCreatePage: (parentId?: string | null, opts?: NbCreateOpts) => Promise<string | null>;
  nbOpenPage: (id: string, opts?: NbOpenOpts) => Promise<void>;
  nbOpenInNewTab: (id: string) => Promise<void>;
  nbActivateTab: (tabId: string) => Promise<void>;
  nbCloseTab: (tabId: string) => void;
  nbCloseOthers: (tabId: string) => void;
  nbReopenTab: () => Promise<void>;
  nbReorderTabs: (from: number, to: number) => void;
  nbCycleTab: (dir: 1 | -1) => void;
  nbTabBack: () => Promise<void>;
  nbTabFwd: () => Promise<void>;

  nbSetPageBlocks: (blocks: NoteBlock[]) => void;
  nbSetPageMeta: (patch: { title?: string; icon?: string | null; cover?: string | null }) => void;
  nbFlushPage: () => Promise<void>;   // persiste la page ouverte (autosave)
  nbDeletePage: (id: string) => Promise<void>;
  nbDuplicatePage: (id: string) => Promise<void>;
  nbMovePage: (id: string, parentId: string | null, orderIdx: number) => Promise<void>;

  nbSaveDatabase: (db: Database) => Promise<void>;   // persiste + met à jour l'état
  // Mutation fonctionnelle : lit l'état FRAIS de la database (évite l'overwrite par closure obsolète
  // quand deux éditions s'enchaînent, ex. créer une option puis l'affecter à une cellule).
  nbUpdateDatabase: (dbId: string, fn: (db: Database) => Database) => void;
  nbDeleteDatabase: (id: string) => Promise<void>;

  nbLoadBacklinks: () => Promise<void>;
}

const api = () => nr.notebook;

// --- Persistance légère (localStorage, par carnet) : onglets / favoris / récents ---------------
const lsRead = <T,>(key: string, def: T): T => {
  try { const v = JSON.parse(localStorage.getItem(key) || ""); return (v ?? def) as T; } catch { return def; }
};
const lsWrite = (key: string, v: unknown) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* plein/privé */ } };
const tabsKey = (nbId: string) => `nr-nb-tabs-${nbId}`;
const favKey = (nbId: string) => `nr-nb-fav-${nbId}`;
const recKey = (nbId: string) => `nr-nb-rec-${nbId}`;
const currentNotebookLanguage = (): NotebookLanguage => {
  const code = i18n.language.split("-")[0];
  return (["fr", "en", "es", "de", "ja", "zh"] as string[]).includes(code) ? code as NotebookLanguage : "fr";
};

export const createNotebookSlice: StateCreator<AppState, [], [], NotebookSlice> = (set, get) => {
  // Sauvegarde l'état des onglets du carnet actif (restauré par nbOpenNotebook).
  const persistTabs = () => {
    const { nbActiveId, nbTabs, nbActiveTabId } = get();
    if (nbActiveId) lsWrite(tabsKey(nbActiveId), { tabs: nbTabs, activeTabId: nbActiveTabId });
  };

  // Charge une page dans l'état (flush avant, ancre éventuelle, récents). NE touche PAS aux onglets.
  const loadPageIntoState = async (id: string, blockId?: string) => {
    const a = api(); if (!a) return false;
    if (get().nbDirty) await get().nbFlushPage();
    try {
      const res = await a.loadPage(id);
      if (!res) return false;
      set({ nbActivePageId: id, nbPage: res.page, nbDatabases: res.databases, nbDirty: false, nbBacklinks: [], nbAnchor: blockId || null });
      void get().nbLoadBacklinks();
      // Récents : page en tête, dédupliquée, plafonnée.
      const nbIdCur = get().nbActiveId;
      if (nbIdCur) {
        const rec = [id, ...get().nbRecents.filter((x) => x !== id)].slice(0, 12);
        set({ nbRecents: rec });
        lsWrite(recKey(nbIdCur), rec);
      }
      return true;
    } catch { return false; }
  };

  return {
    nbList: [],
    nbActiveId: null,
    nbPages: [],
    nbActivePageId: null,
    nbPage: null,
    nbDatabases: {},
    nbBacklinks: [],
    nbLoading: false,
    nbDirty: false,

    nbTabs: [],
    nbActiveTabId: null,
    nbClosedTabs: [],
    nbAnchor: null,
    nbClearAnchor: () => set({ nbAnchor: null }),

    nbPrefs: readPrefs(),
    nbSetPrefs: (patch) => {
      const next = { ...get().nbPrefs, ...patch };
      if (patch.shortcutKeys) next.shortcutKeys = { ...get().nbPrefs.shortcutKeys, ...patch.shortcutKeys };
      lsWrite(PREFS_KEY, next);
      set({ nbPrefs: next });
    },

    nbFavorites: [],
    nbRecents: [],
    nbToggleFavorite: (pageId) => {
      const nbIdCur = get().nbActiveId; if (!nbIdCur) return;
      const cur = get().nbFavorites;
      const next = cur.includes(pageId) ? cur.filter((x) => x !== pageId) : [...cur, pageId];
      set({ nbFavorites: next });
      lsWrite(favKey(nbIdCur), next);
    },

    nbTrash: [],
    nbLoadTrash: async () => {
      const a = api(); const nbIdCur = get().nbActiveId; if (!a || !nbIdCur) return;
      try { set({ nbTrash: await a.trashList(nbIdCur) }); } catch { set({ nbTrash: [] }); }
    },
    nbRestorePage: async (id) => {
      const a = api(); const nbIdCur = get().nbActiveId; if (!a || !nbIdCur) return;
      await a.restorePage(id);
      await get().nbOpenNotebook(nbIdCur);
      await get().nbLoadTrash();
    },
    nbPurgePage: async (id) => {
      const a = api(); if (!a) return;
      await a.purgePage(id);
      await get().nbLoadTrash();
    },
    nbEmptyTrash: async () => {
      const a = api(); const nbIdCur = get().nbActiveId; if (!a || !nbIdCur) return;
      await a.emptyTrash(nbIdCur);
      set({ nbTrash: [] });
    },

    nbSearchResults: [],
    nbRunSearch: async (query) => {
      const a = api(); const nbIdCur = get().nbActiveId;
      if (!a || !nbIdCur || !query.trim()) { set({ nbSearchResults: [] }); return; }
      try { set({ nbSearchResults: await a.search(nbIdCur, query) }); } catch { set({ nbSearchResults: [] }); }
    },
    nbClearSearch: () => set({ nbSearchResults: [] }),

    nbLoadList: async () => {
      const a = api(); if (!a) return;
      try { set({ nbList: await a.list() }); } catch { /* hors application */ }
    },

    nbCreateNotebook: async (title, kind = "notes", language = currentNotebookLanguage()) => {
      const a = api(); if (!a) return null;
      const r = await a.saveNotebook({ title: title || i18n.t("notebook:panel.newNotebook"), kind, language });
      if (!r.ok || !r.id) return null;
      await get().nbLoadList();
      await get().nbOpenNotebook(r.id);
      return r.id;
    },

    nbOpenNotebook: async (id) => {
      const a = api(); if (!a) return;
      set({ nbLoading: true });
      try {
        const res = await a.load(id);
        if (!res) { set({ nbLoading: false }); return; }
        const pageIds = new Set(res.pages.map((p) => p.id));
        // Restaure onglets + favoris + récents du carnet (purgés des pages disparues/supprimées).
        const saved = lsRead<{ tabs?: NbTab[]; activeTabId?: string | null }>(tabsKey(id), {});
        let tabs = (saved.tabs || []).filter((t) => pageIds.has(t.pageId));
        for (const t of tabs) {
          t.hist = t.hist.filter((p) => pageIds.has(p));
          if (!t.hist.length) t.hist = [t.pageId];
          t.histIdx = Math.min(Math.max(0, t.histIdx), t.hist.length - 1);
        }
        if (!tabs.length) {
          const first = res.pages.find((p) => !p.parentId) || res.pages[0];
          if (first) tabs = [{ id: newId(), pageId: first.id, hist: [first.id], histIdx: 0 }];
        }
        const activeTabId = tabs.find((t) => t.id === saved.activeTabId)?.id ?? tabs[0]?.id ?? null;
        const favorites = lsRead<string[]>(favKey(id), []).filter((p) => pageIds.has(p));
        const recents = lsRead<string[]>(recKey(id), []).filter((p) => pageIds.has(p));
        set({
          nbActiveId: id, nbPages: res.pages, nbLoading: false, nbBacklinks: [],
          nbTabs: tabs, nbActiveTabId: activeTabId, nbFavorites: favorites, nbRecents: recents, nbTrash: [],
        });
        persistTabs();
        const active = tabs.find((t) => t.id === activeTabId);
        if (active) await loadPageIntoState(active.pageId);
        else set({ nbActivePageId: null, nbPage: null, nbDatabases: {} });
      } catch {
        set({ nbLoading: false });
      }
    },

    nbRenameNotebook: async (id, patch) => {
      const a = api(); if (!a) return;
      const cur = get().nbList.find((n) => n.id === id);
      await a.saveNotebook({
        id,
        title: patch.title ?? cur?.title ?? i18n.t("notebook:panel.notebookFallback"),
        icon: patch.icon ?? cur?.icon ?? null,
        scriptId: cur?.scriptId ?? null,
        kind: patch.kind ?? cur?.kind ?? "notes",
        language: patch.language ?? cur?.language ?? "fr",
      });
      await get().nbLoadList();
    },

    nbDeleteNotebook: async (id) => {
      const a = api(); if (!a) return;
      await a.deleteNotebook(id);
      if (get().nbActiveId === id) set({ nbActiveId: null, nbPages: [], nbActivePageId: null, nbPage: null, nbDatabases: {}, nbTabs: [], nbActiveTabId: null, nbFavorites: [], nbRecents: [], nbTrash: [] });
      await get().nbLoadList();
    },

    nbForScript: async (scriptId, title) => {
      const a = api(); if (!a) return;
      const r = await a.forScript(scriptId, title);
      set({ tab: "notebook" });
      await get().nbLoadList();
      if (r.ok && r.notebook) await get().nbOpenNotebook(r.notebook.id);
    },

    nbCreatePage: async (parentId = null, opts) => {
      const a = api(); const nbIdCur = get().nbActiveId; if (!a || !nbIdCur) return null;
      const orderIdx = Date.now();
      const r = await a.savePage({ notebookId: nbIdCur, parentId, title: opts?.title || i18n.t("notebook:panel.untitled"), orderIdx, blocks: opts?.blocks || [] });
      if (!r.ok || !r.id) return null;
      // Rafraîchit l'arbre sans toucher aux onglets (a.load, pas nbOpenNotebook qui les restaurerait).
      const res = await a.load(nbIdCur);
      if (res) set({ nbPages: res.pages });
      if (!opts?.silent) await get().nbOpenPage(r.id, { newTab: opts?.newTab });
      return r.id;
    },

    // Navigation : onglet actif (défaut) ou nouvel onglet. Même page + ancre → scroll direct.
    nbOpenPage: async (id, opts) => {
      const cur = get();
      if (!opts?.newTab && cur.nbActivePageId === id) {
        set({ nbAnchor: opts?.blockId || null });
        return;
      }
      let tabs = [...cur.nbTabs];
      let activeTabId = cur.nbActiveTabId;
      if (opts?.newTab || !tabs.length) {
        const tab: NbTab = { id: newId(), pageId: id, hist: [id], histIdx: 0 };
        tabs = [...tabs, tab];
        activeTabId = tab.id;
      } else {
        const idx = tabs.findIndex((t) => t.id === activeTabId);
        const tab = { ...tabs[idx < 0 ? 0 : idx] };
        // Tronque l'historique « avant » puis pousse la nouvelle page (comportement navigateur).
        tab.hist = [...tab.hist.slice(0, tab.histIdx + 1), id];
        tab.histIdx = tab.hist.length - 1;
        tab.pageId = id;
        tabs[idx < 0 ? 0 : idx] = tab;
        activeTabId = tab.id;
      }
      set({ nbTabs: tabs, nbActiveTabId: activeTabId });
      persistTabs();
      await loadPageIntoState(id, opts?.blockId);
    },

    nbOpenInNewTab: async (id) => { await get().nbOpenPage(id, { newTab: true }); },

    nbActivateTab: async (tabId) => {
      const tab = get().nbTabs.find((t) => t.id === tabId);
      if (!tab || get().nbActiveTabId === tabId) return;
      set({ nbActiveTabId: tabId });
      persistTabs();
      await loadPageIntoState(tab.pageId);
    },

    nbCloseTab: (tabId) => {
      const cur = get();
      const idx = cur.nbTabs.findIndex((t) => t.id === tabId);
      if (idx < 0) return;
      const closed = cur.nbTabs[idx];
      const tabs = cur.nbTabs.filter((t) => t.id !== tabId);
      const closedStack = [closed.pageId, ...cur.nbClosedTabs].slice(0, 10);
      if (cur.nbActiveTabId === tabId) {
        // Active le voisin (droite sinon gauche) ; plus d'onglet → zone vide.
        const next = tabs[idx] || tabs[idx - 1] || null;
        set({ nbTabs: tabs, nbClosedTabs: closedStack, nbActiveTabId: next?.id ?? null });
        persistTabs();
        if (next) void loadPageIntoState(next.pageId);
        else set({ nbActivePageId: null, nbPage: null, nbDatabases: {}, nbBacklinks: [] });
      } else {
        set({ nbTabs: tabs, nbClosedTabs: closedStack });
        persistTabs();
      }
    },

    nbCloseOthers: (tabId) => {
      const cur = get();
      const keep = cur.nbTabs.find((t) => t.id === tabId);
      if (!keep) return;
      const closedStack = [...cur.nbTabs.filter((t) => t.id !== tabId).map((t) => t.pageId), ...cur.nbClosedTabs].slice(0, 10);
      set({ nbTabs: [keep], nbClosedTabs: closedStack });
      persistTabs();
      if (cur.nbActiveTabId !== tabId) void get().nbActivateTab(tabId);
    },

    nbReopenTab: async () => {
      const [last, ...rest] = get().nbClosedTabs;
      if (!last) return;
      set({ nbClosedTabs: rest });
      // Page supprimée entre-temps → on dépile sans rien ouvrir.
      if (!get().nbPages.some((p) => p.id === last)) return;
      await get().nbOpenPage(last, { newTab: true });
    },

    nbReorderTabs: (from, to) => {
      const tabs = [...get().nbTabs];
      if (from < 0 || from >= tabs.length || to < 0 || to >= tabs.length || from === to) return;
      const [moved] = tabs.splice(from, 1);
      tabs.splice(to, 0, moved);
      set({ nbTabs: tabs });
      persistTabs();
    },

    nbCycleTab: (dir) => {
      const { nbTabs, nbActiveTabId } = get();
      if (nbTabs.length < 2) return;
      const idx = nbTabs.findIndex((t) => t.id === nbActiveTabId);
      const next = nbTabs[(idx + dir + nbTabs.length) % nbTabs.length];
      void get().nbActivateTab(next.id);
    },

    nbTabBack: async () => {
      const cur = get();
      const idx = cur.nbTabs.findIndex((t) => t.id === cur.nbActiveTabId);
      if (idx < 0) return;
      const tab = { ...cur.nbTabs[idx] };
      if (tab.histIdx <= 0) return;
      tab.histIdx -= 1;
      tab.pageId = tab.hist[tab.histIdx];
      const tabs = [...cur.nbTabs]; tabs[idx] = tab;
      set({ nbTabs: tabs });
      persistTabs();
      await loadPageIntoState(tab.pageId);
    },

    nbTabFwd: async () => {
      const cur = get();
      const idx = cur.nbTabs.findIndex((t) => t.id === cur.nbActiveTabId);
      if (idx < 0) return;
      const tab = { ...cur.nbTabs[idx] };
      if (tab.histIdx >= tab.hist.length - 1) return;
      tab.histIdx += 1;
      tab.pageId = tab.hist[tab.histIdx];
      const tabs = [...cur.nbTabs]; tabs[idx] = tab;
      set({ nbTabs: tabs });
      persistTabs();
      await loadPageIntoState(tab.pageId);
    },

    nbSetPageBlocks: (blocks) => {
      const page = get().nbPage; if (!page) return;
      set({ nbPage: { ...page, blocks }, nbDirty: true });
    },

    nbSetPageMeta: (patch) => {
      const page = get().nbPage; if (!page) return;
      const next = { ...page, ...patch };
      // Reflète le titre/icône dans l'arbre immédiatement (sidebar réactive).
      const nbPages = get().nbPages.map((p) => (p.id === page.id ? { ...p, title: next.title, icon: next.icon, cover: next.cover } : p));
      set({ nbPage: next, nbPages, nbDirty: true });
    },

    nbFlushPage: async () => {
      const a = api(); const page = get().nbPage; if (!a || !page) return;
      set({ nbDirty: false });
      try {
        await a.savePage({
          id: page.id, notebookId: page.notebookId, parentId: page.parentId,
          title: page.title, icon: page.icon, cover: page.cover, orderIdx: page.orderIdx,
          blocks: page.blocks,
        });
      } catch { /* réessaiera au prochain edit */ }
    },

    // Suppression DOUCE : la page (et sa descendance) part à la corbeille ; les onglets qui la
    // montraient reculent dans leur historique vers une page encore vivante, sinon se ferment.
    nbDeletePage: async (id) => {
      const a = api(); const nbIdCur = get().nbActiveId; if (!a || !nbIdCur) return;
      const r = await a.deletePage(id);
      const removed = new Set((r && "removed" in r && r.removed) || [id]);
      const cur = get();
      const tabs: NbTab[] = [];
      for (const t of cur.nbTabs) {
        const tab = { ...t, hist: t.hist.filter((p) => !removed.has(p)) };
        if (!tab.hist.length) continue; // tout l'historique supprimé → onglet fermé
        tab.histIdx = Math.min(tab.histIdx, tab.hist.length - 1);
        tab.pageId = removed.has(tab.pageId) ? tab.hist[tab.histIdx] : tab.pageId;
        tabs.push(tab);
      }
      const activeTabId = tabs.find((t) => t.id === cur.nbActiveTabId)?.id ?? tabs[0]?.id ?? null;
      const favorites = cur.nbFavorites.filter((p) => !removed.has(p));
      const recents = cur.nbRecents.filter((p) => !removed.has(p));
      set({ nbTabs: tabs, nbActiveTabId: activeTabId, nbFavorites: favorites, nbRecents: recents });
      lsWrite(favKey(nbIdCur), favorites);
      lsWrite(recKey(nbIdCur), recents);
      persistTabs();
      // Rafraîchit l'arbre puis recharge la page de l'onglet actif (si affectée).
      const res = await a.load(nbIdCur);
      if (res) set({ nbPages: res.pages });
      const active = tabs.find((t) => t.id === activeTabId);
      if (removed.has(cur.nbActivePageId || "")) {
        if (active) await loadPageIntoState(active.pageId);
        else set({ nbActivePageId: null, nbPage: null, nbDatabases: {}, nbBacklinks: [] });
      }
    },

    // Duplique la page (sous-arbre + databases, côté backend) puis ouvre la copie.
    nbDuplicatePage: async (id) => {
      const a = api(); const nbIdCur = get().nbActiveId; if (!a || !nbIdCur) return;
      const r = await a.duplicatePage(id);
      const res = await a.load(nbIdCur);
      if (res) set({ nbPages: res.pages });
      if (r.ok && r.id) await get().nbOpenPage(r.id);
    },

    nbMovePage: async (id, parentId, orderIdx) => {
      const a = api(); const nbIdCur = get().nbActiveId; if (!a || !nbIdCur) return;
      const meta = get().nbPages.find((p) => p.id === id);
      if (!meta) return;
      // Persiste le déplacement : on relit la page pour ne pas écraser ses blocs.
      const full = await a.loadPage(id);
      if (!full) return;
      await a.savePage({ ...full.page, parentId, orderIdx });
      const res = await a.load(nbIdCur);
      if (res) set({ nbPages: res.pages });
    },

    nbSaveDatabase: async (db) => {
      const a = api(); const pageId = get().nbActivePageId; if (!a || !pageId) return;
      set({ nbDatabases: { ...get().nbDatabases, [db.id]: db } });
      try { await a.saveDatabase({ ...db, pageId }); } catch { /* ignore */ }
    },

    nbUpdateDatabase: (dbId, fn) => {
      const cur = get().nbDatabases[dbId];
      if (!cur) return;
      void get().nbSaveDatabase(fn(cur));
    },

    nbDeleteDatabase: async (id) => {
      const a = api(); if (!a) return;
      const next = { ...get().nbDatabases };
      delete next[id];
      set({ nbDatabases: next });
      try { await a.deleteDatabase(id); } catch { /* ignore */ }
    },

    nbLoadBacklinks: async () => {
      const a = api(); const nbIdCur = get().nbActiveId; const pageId = get().nbActivePageId;
      if (!a || !nbIdCur || !pageId) { set({ nbBacklinks: [] }); return; }
      try { set({ nbBacklinks: await a.backlinks(nbIdCur, pageId) }); } catch { set({ nbBacklinks: [] }); }
    },
  };
};
