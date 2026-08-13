// Persistance des scènes du board : sauve/charge via nr.reference (SQLite/JSON côté Electron,
// localStorage en mock navigateur). À la lecture, on REHYDRATE la `src` d'affichage depuis le
// localisateur durable `ref` (un objectURL persisté serait mort après un reload).

import { useCallback } from "react";
import { nr, type NetsuExportOpts, type NetsuWeight } from "@/lib/bridge";
import i18n from "@/i18n";
import { useBoard } from "./useReferenceBoard";
import { type BoardItem, type BoardView, displaySrc } from "./referenceShared";
import { recoverAllOnlineMedia, recoverOnlineEmbeds } from "./boardMediaActions";

// Scènes réservées (non listées) : handoff vers la fenêtre détachée, autosave de session.
const HANDOFF_ID = "__handoff__";
const AUTOSAVE_ID = "__autosave__";
const RESERVED = new Set([HANDOFF_ID, AUTOSAVE_ID]);

// Items à PERSISTER : on exclut les placeholders de téléchargement (loading) — transitoires, l'autosave
// debouncé peut sinon les figer sur disque (spinner bloqué à la réouverture si l'app ferme en plein DL).
const persistable = (items: BoardItem[]) => items.filter((it) => !it.loading);
// Une archive .netsu n'embarque que le média AFFICHÉ : le fichier gardé en réserve derrière un
// embed (`localMedia`) resterait sur la machine d'origine, donc son chemin ne veut plus rien dire
// une fois le board ouvert ailleurs. On l'oublie à l'export ; l'item se retéléchargera au besoin.
const exportable = (items: BoardItem[]) =>
  persistable(items).map(({ localMedia: _localMedia, ...it }) => it);

// Localisateurs que le board peut encore réclamer alors qu'aucun item posé ne les porte : ceux que
// retient l'HISTORIQUE d'annulation. Supprimer une image déclenche un autosave une demi-seconde
// plus tard ; sans cette liste, le ménage du core emporte ses octets et le Ctrl+Z suivant rend une
// tuile vide. Les liens distants sont ignorés : ils ne coûtent rien et ne s'effacent pas.
function retainedRefs(): string[] {
  const st = useBoard.getState();
  const out = new Set<string>();
  const add = (ref?: string) => { if (ref && !/^(https?:|data:|blob:)/i.test(ref)) out.add(ref); };
  for (const snapshot of [...st.past, ...st.future, st.items]) {
    for (const item of snapshot) {
      add(item.ref);
      item.frames?.forEach(add);
      add(item.prevMedia?.ref);
      add(item.localMedia?.ref);
    }
  }
  return [...out];
}

// Scène telle qu'elle part au core pour un ENREGISTREMENT (par opposition à un partage).
const savable = (name: string) => {
  const st = useBoard.getState();
  return { name, items: persistable(st.items), view: st.view, retain: retainedRefs() };
};

// Un item relu : la `src` d'affichage se recalcule depuis le localisateur durable — pour l'item
// lui-même comme pour le média d'avant un upscale, dont le bouton « revenir en arrière » a besoin.
const hydrate = (items: BoardItem[]): BoardItem[] =>
  items.map((it) => ({
    ...it,
    src: displaySrc(it.kind, it.ref),
    ...(it.prevMedia?.ref
      ? { prevMedia: { ...it.prevMedia, src: displaySrc(it.prevMedia.kind ?? it.kind, it.prevMedia.ref) } }
      : {}),
  }));

// Feedback de sauvegarde dans la barre d'outils (l'auto-effacement est géré par setNotice).
function flash(text: string, kind: "ok" | "error") {
  useBoard.getState().setNotice({ text, kind });
}

const tr = (key: string, opts?: Record<string, unknown>) => i18n.t(`reference:${key}`, opts);

// Nom lisible d'un projet dans une notice : le fichier, sans son dossier ni son extension — un
// chemin absolu complet déborde de la barre de notices et ne dit rien de plus à qui vient de le choisir.
export const fileLabel = (filePath: string) =>
  (filePath.split(/[\\/]/).pop() || filePath).replace(/\.netsu$/i, "");

// L'autosave se déclenche en rafale (debounce 500 ms) : on ne signale un échec qu'UNE fois
// jusqu'au prochain succès, sinon la notice d'erreur clignoterait en boucle.
let autoErrShown = false;

export function useScenePersistence() {
  const api = nr.reference;

  // Enregistre le projet dans SON fichier (Ctrl+S). Incrémental côté core : seules les lignes qui
  // ont bougé sont écrites, aucun média n'est réencodé.
  const saveProject = useCallback(async () => {
    const st = useBoard.getState();
    if (!st.filePath) return { ok: false, error: tr("notice.noProjectFile") };
    try {
      const res = await api?.saveProject(st.filePath, savable(st.sceneName));
      if (res?.ok) {
        useBoard.setState({ dirty: false });
        flash(tr("notice.projectSaved", { name: fileLabel(st.filePath) }), "ok");
      } else {
        flash(tr("notice.failedWith", { error: res?.error || tr("notice.unknown") }), "error");
      }
      return res;
    } catch (e) {
      flash(tr("notice.failedWith", { error: String(e) }), "error");
      return { ok: false, error: String(e) };
    }
  }, [api]);

  // « Enregistrer sous… » : choisit le fichier, l'écrit, et le board DEVIENT ce fichier. La scène
  // interne est détachée (`sceneId: null`) — le fichier fait foi, garder les deux les ferait diverger.
  const saveProjectAs = useCallback(async () => {
    const st = useBoard.getState();
    const dest = await api?.saveNetsuPath(`${st.sceneName || "board"}.netsu`);
    if (!dest) return null; // annulé
    const projectName = fileLabel(dest);
    try {
      const res = await api?.saveProjectAs({
        scene: { ...savable(projectName) },
        destPath: dest,
        fromPath: st.filePath,
        sourceSceneId: st.sceneId,
      });
      if (res?.ok) {
        useBoard.setState({ filePath: res.path ?? dest, fileReadonly: false, sceneId: null, sceneName: fileLabel(res.path ?? dest), dirty: false });
        flash(tr("notice.projectSaved", { name: fileLabel(res.path ?? dest) }), "ok");
      } else {
        flash(tr("notice.failedWith", { error: res?.error || tr("notice.unknown") }), "error");
      }
      return res;
    } catch (e) {
      flash(tr("notice.failedWith", { error: String(e) }), "error");
      return { ok: false, error: String(e) };
    }
  }, [api]);

  // Ouvre un projet .netsu : le fichier reste ouvert côté core et devient le document courant.
  const openProject = useCallback(
    async (srcPath: string) => {
      const res = await api?.openProject(srcPath);
      if (!res?.ok || !res.scene) {
        flash(tr("notice.openFailedWith", { error: res?.error || tr("notice.unknown") }), "error");
        return false;
      }
      const items = hydrate(res.scene.items as BoardItem[]);
      useBoard.getState().loadScene({
        id: "",
        name: fileLabel(res.path ?? srcPath),
        items,
        view: (res.scene.view as BoardView) ?? undefined,
        filePath: res.readonly ? null : (res.path ?? srcPath),
        fileReadonly: !!res.readonly,
      });
      // Une archive v1 n'est pas un document vivant : on la charge comme un board neuf, à qui
      // « Enregistrer sous » donnera un vrai fichier de projet.
      useBoard.setState({ sceneId: null, dirty: !!res.readonly });
      flash(tr(res.readonly ? "notice.projectOpenedLegacy" : "notice.projectOpened", { name: fileLabel(srcPath) }), "ok");
      // Remise en état des médias en ligne, sans rien demander. Une archive v1 en a autant besoin
      // qu'un projet — elle n'a simplement pas de fichier où réécrire le résultat.
      void recoverAllOnlineMedia().then(async (result) => {
        if (result.recovered > 0 && !res.readonly) await saveProject();
      });
      return true;
    },
    [api, saveProject],
  );

  const recentProjects = useCallback(() => api?.recentProjects("board") ?? Promise.resolve([]), [api]);
  const forgetProject = useCallback((p: string) => api?.forgetProject(p) ?? Promise.resolve([]), [api]);

  const save = useCallback(
    async (name?: string) => {
      const st = useBoard.getState();
      // Board lié à un fichier : « Enregistrer » écrit CE fichier, pas une scène de la bibliothèque.
      if (st.filePath && !st.fileReadonly) return saveProject();
      const finalName = name ?? st.sceneName;
      try {
        const res = await api?.saveScene({
          id: st.sceneId ?? undefined,
          name: finalName,
          items: persistable(st.items),
          view: st.view,
        });
        if (res?.ok) {
          useBoard.setState({ sceneId: res.id ?? st.sceneId, sceneName: finalName, dirty: false });
          flash(tr("notice.sceneSaved", { name: finalName }), "ok");
        } else {
          flash(res?.error ? tr("notice.failedWith", { error: res.error }) : tr("notice.saveFailed"), "error");
        }
        return res;
      } catch (e) {
        flash(tr("notice.failedWith", { error: String(e) }), "error");
        return { ok: false, error: String(e) };
      }
    },
    [api, saveProject],
  );

  const open = useCallback(
    async (id: string) => {
      const sc = await api?.loadScene(id);
      if (!sc) return;
      const items = hydrate(sc.items as BoardItem[]);
      useBoard.getState().loadScene({
        id: sc.id,
        name: sc.name,
        items,
        view: (sc.view as BoardView) ?? undefined,
      });
    },
    [api],
  );

  // Liste filtrée : masque les scènes réservées (handoff, autosave).
  const list = useCallback(
    async () => (await (api?.listScenes() ?? Promise.resolve([]))).filter((s) => !RESERVED.has(s.id)),
    [api],
  );
  const remove = useCallback(
    (id: string) => api?.deleteScene(id) ?? Promise.resolve({ ok: false }),
    [api],
  );

  // Autosave silencieux du board courant (filet de sécurité, restauré au démarrage). Trois cas, du
  // plus fort au plus faible : un PROJET va dans son fichier (écriture incrémentale, c'est le point
  // du format) ; une scène NOMMÉE se réécrit sur son propre id (et perd l'état « non enregistré ») ;
  // un board anonyme va dans la scène réservée AUTOSAVE_ID, sans toucher l'indicateur dirty.
  const saveAuto = useCallback(async () => {
    const st = useBoard.getState();
    if (st.filePath && !st.fileReadonly) {
      try {
        const res = await api?.saveProject(st.filePath, savable(st.sceneName));
        if (res && !res.ok) throw new Error(res.error || tr("notice.unknown"));
        useBoard.setState({ dirty: false });
        autoErrShown = false;
      } catch (e) {
        if (!autoErrShown) {
          autoErrShown = true;
          flash(tr("notice.autosaveFailed", { error: e instanceof Error ? e.message : String(e) }), "error");
        }
      }
      return;
    }
    try {
      const res = await api?.saveScene({
        id: st.sceneId ?? AUTOSAVE_ID,
        name: st.sceneName,
        items: persistable(st.items),
        view: st.view,
      });
      if (res && !res.ok) throw new Error(res.error || tr("notice.unknown"));
      if (st.sceneId && res?.ok) useBoard.setState({ dirty: false });
      autoErrShown = false;
    } catch (e) {
      if (!autoErrShown) {
        autoErrShown = true;
        flash(tr("notice.autosaveFailed", { error: e instanceof Error ? e.message : String(e) }), "error");
      }
    }
  }, [api]);
  const loadAuto = useCallback(async () => {
    const sc = await api?.loadScene(AUTOSAVE_ID);
    if (!sc || !(sc.items as BoardItem[]).length) return false;
    const items = hydrate(sc.items as BoardItem[]);
    useBoard.getState().loadScene({ id: AUTOSAVE_ID, name: sc.name, items, view: (sc.view as BoardView) ?? undefined });
    useBoard.setState({ sceneId: null, dirty: false }); // board de travail anonyme
    return true;
  }, [api]);

  // Poids ESTIMÉ du board courant, par niveau d'embarquement — le dialogue d'export s'en sert pour
  // montrer ce que chaque choix produira. Même construction de scène que l'export, sinon l'estimation
  // porterait sur autre chose que ce qui sera écrit.
  const weigh = useCallback(
    async (opts: NetsuExportOpts): Promise<NetsuWeight> => {
      const st = useBoard.getState();
      if (!api?.weigh) return { ok: false };
      return api.weigh({ name: st.sceneName, items: exportable(st.items), view: st.view }, opts);
    },
    [api],
  );

  // Exporte le board COURANT dans un fichier .netsu (choix du fichier + niveau d'embarquement).
  const exportBoard = useCallback(
    async (opts: NetsuExportOpts) => {
      const st = useBoard.getState();
      const dest = await api?.saveNetsuPath(`${st.sceneName || "board"}.netsu`);
      if (!dest) return null; // annulé
      try {
        const res = await api?.exportBoard({ name: st.sceneName, items: exportable(st.items), view: st.view }, dest, opts);
        if (res?.ok) {
          const c = res.counts;
          flash(c ? tr("notice.exported", { bundled: c.bundled, referenced: c.referenced }) : tr("notice.boardExported"), "ok");
        } else {
          flash(res?.error ? tr("notice.exportFailedWith", { error: res.error }) : tr("notice.exportFailed"), "error");
        }
        return res;
      } catch (e) {
        flash(tr("notice.exportFailedWith", { error: String(e) }), "error");
        return { ok: false, error: String(e) };
      }
    },
    [api],
  );

  // Importe une archive .netsu → crée une nouvelle scène enregistrée et l'ouvre. Renvoie l'id ou null.
  const importBoard = useCallback(
    async (srcPath: string) => {
      const res = await api?.importBoard(srcPath);
      if (!res?.ok || !res.scene) {
        flash(res?.type ? tr("notice.typeUnsupported", { type: res.type }) : tr("notice.importFailedWith", { error: res?.error || tr("notice.unknown") }), "error");
        return null;
      }
      const items = hydrate(res.scene.items as BoardItem[]);
      const saved = await api?.saveScene({ name: res.scene.name, items, view: res.scene.view });
      const id = saved?.ok ? saved.id : undefined;
      useBoard.getState().loadScene({ id: id ?? "", name: res.scene.name, items, view: (res.scene.view as BoardView) ?? undefined });
      if (!id) useBoard.setState({ sceneId: null });
      const c = res.counts;
      flash(c ? tr("notice.imported", { count: c.items }) : tr("notice.boardImported"), "ok");
      // Un board reçu d'ailleurs arrive avec des médias en ligne qui ne pointent plus sur rien : la
      // remise en état est lancée SEULE, comme à l'ouverture d'un projet. Attendre un bouton laissait
      // l'archive s'ouvrir sur des tuiles mortes alors que tout est retrouvable depuis les liens.
      void recoverAllOnlineMedia().then(async (result) => {
        if (result.recovered > 0) await saveAuto();
        // Puis les embeds sociaux (iframe souvent noire) → média local durable, mais SEULEMENT si
        // l'auto-téléchargement est activé (Paramètres). Défaut OFF : aucun yt-dlp surprise.
        if (!useBoard.getState().prefs.autoDownloadOnline) return;
        const n = await recoverOnlineEmbeds();
        if (n) await saveAuto();
      });
      return id ?? null;
    },
    [api, saveAuto],
  );

  // Transfert vers la fenêtre détachée : fige le board courant sous l'id réservé.
  const handoff = useCallback(async () => {
    const st = useBoard.getState();
    await api?.saveScene({ id: HANDOFF_ID, name: st.sceneName, items: persistable(st.items), view: st.view });
  }, [api]);
  // Charge le handoff puis le détache de son id réservé (board de travail anonyme, non lié au handoff).
  const loadHandoff = useCallback(async () => {
    await open(HANDOFF_ID);
    useBoard.setState({ sceneId: null, dirty: false });
  }, [open]);

  return {
    save, open, list, remove, handoff, loadHandoff, saveAuto, loadAuto, weigh, exportBoard, importBoard,
    saveProject, saveProjectAs, openProject, recentProjects, forgetProject,
    available: !!api,
  };
}
