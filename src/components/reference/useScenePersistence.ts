// Persistance des scènes du board : sauve/charge via nr.reference (SQLite/JSON côté Electron,
// localStorage en mock navigateur). À la lecture, on REHYDRATE la `src` d'affichage depuis le
// localisateur durable `ref` (un objectURL persisté serait mort après un reload).

import { useCallback } from "react";
import { nr, type NetsuExportOpts, type NetsuWeight, type ScenePreviewItem } from "@/lib/bridge";
import { withLocalMediaPaths } from "@/lib/collab/board/media";
import i18n from "@/i18n";
import { useBoard } from "./useReferenceBoard";
import { type BoardItem, type BoardView, displaySrc } from "./referenceShared";
import { recoverAllOnlineMedia, recoverOnlineEmbeds } from "./boardMediaActions";

// Scènes réservées (non listées) : handoff vers la fenêtre détachée, autosave de session.
const HANDOFF_ID = "__handoff__";
const AUTOSAVE_ID = "__autosave__";
const RESERVED = new Set([HANDOFF_ID, AUTOSAVE_ID]);

// Un objectURL ne vaut que pour l'onglet qui l'a créé : écrit sur disque, il rouvre une case morte
// sans le moindre indice de ce qu'elle portait. Ça n'arrive que quand la copie en asset a échoué
// (écriture refusée, service arrêté en plein import) — rare, mais silencieux jusqu'au rechargement.
// On écrit donc l'item SANS localisateur et marqué manquant : la case dit ce qui lui manque, garde
// son titre, et se répare toute seule si le lien d'origine est connu (cf. boardMediaRecovery).
const durable = (item: BoardItem): BoardItem => {
  if (!/^blob:/i.test(item.ref || "")) return item;
  return {
    ...item,
    ref: "",
    src: "",
    missing: item.missing ?? { name: item.title || "média", size: 0, kind: item.kind },
  };
};

// Items à PERSISTER : on exclut les placeholders de téléchargement (loading) — transitoires, l'autosave
// debouncé peut sinon les figer sur disque (spinner bloqué à la réouverture si l'app ferme en plein DL).
const persistable = (items: BoardItem[]) => items.filter((it) => !it.loading).map(durable);
// Une archive .netsu n'embarque que le média AFFICHÉ : le fichier gardé en réserve derrière un
// embed (`localMedia`) resterait sur la machine d'origine, donc son chemin ne veut plus rien dire
// une fois le board ouvert ailleurs. On l'oublie à l'export ; l'item se retéléchargera au besoin.
const exportable = (items: BoardItem[]) =>
  persistable(items).map(({ localMedia: _localMedia, ...it }) => it);

// Localisateurs que le board peut encore réclamer alors qu'aucun item posé ne les porte : ceux que
// retient l'HISTORIQUE d'annulation. Supprimer une image déclenche un autosave une demi-seconde
// plus tard ; sans cette liste, le ménage du core emporte ses octets et le Ctrl+Z suivant rend une
// tuile vide. Les liens distants sont ignorés : ils ne coûtent rien et ne s'effacent pas.
// Un instantané d'historique est immuable une fois enregistré, et sa liste de localisateurs ne
// change donc jamais non plus. La mémoriser par tableau évite à `retainedRefs` de reparcourir TOUT
// l'historique d'annulation à chaque écriture : seuls les instantanés jamais vus (en pratique les
// items courants) sont visités.
const snapshotRefs = new WeakMap<BoardItem[], string[]>();

function refsOf(snapshot: BoardItem[]): string[] {
  const cached = snapshotRefs.get(snapshot);
  if (cached) return cached;
  const out = new Set<string>();
  const add = (ref?: string) => { if (ref && !/^(https?:|data:|blob:|collab:)/i.test(ref)) out.add(ref); };
  for (const item of snapshot) {
    add(item.ref);
    item.frames?.forEach(add);
    add(item.prevMedia?.ref);
    add(item.localMedia?.ref);
  }
  const refs = [...out];
  snapshotRefs.set(snapshot, refs);
  return refs;
}

function retainedRefs(): string[] {
  const st = useBoard.getState();
  const out = new Set<string>();
  for (const snapshot of [...st.past, ...st.future, st.items]) {
    for (const ref of refsOf(snapshot)) out.add(ref);
  }
  return [...out];
}

/**
 * Localisateurs locaux que le board AFFICHÉ peut encore réclamer, historique d'annulation compris.
 * Paramètres › Stockage s'en sert pour ne pas prendre pour un orphelin un média posé à l'écran mais
 * pas encore enregistré dans une scène.
 */
export function liveMediaRefs(): string[] {
  return retainedRefs();
}

// ── Scène collaborative ─────────────────────────────────────────────────────────────────────────
// Une scène partagée ne persiste AUCUN item : le document Loro fait foi, et une seconde copie
// modifiable les ferait diverger. Elle garde en revanche deux choses que le document ne peut pas
// porter — la liste des localisateurs de ses médias locaux, contre laquelle la coquille autorise
// un import, et une disposition en lecture seule pour sa vignette d'accueil.

// Dernière liste écrite pour la scène collaborative ouverte : un board inchangé ne réécrit pas sa
// ligne à chaque geste.
let lastCollabMedia: string[] = [];
let lastCollabPreview = "";
let collabPreviewTimer: number | null = null;

/** Oublie la liste de la scène précédemment ouverte. */
export function resetCollabMediaSync(): void {
  lastCollabMedia = [];
  lastCollabPreview = "";
  if (collabPreviewTimer !== null) {
    window.clearTimeout(collabPreviewTimer);
    collabPreviewTimer = null;
  }
}

// Ligne de bibliothèque créée par une adoption pas encore validée. Le partage peut échouer pour
// bien des raisons et l'utilisateur réessaie ; sans ça, chaque tentative laissait un board
// identique de plus sur l'accueil.
let pendingAdoption: string | null = null;

// Disposition d'un board collaboratif, pour sa seule vignette d'accueil.
function collabPreview(): ScenePreviewItem[] {
  return useBoard.getState().items
    .filter((item) => item.w > 0 && item.h > 0)
    .sort((left, right) => (left.z ?? 0) - (right.z ?? 0))
    .slice(0, 40)
    .map((item) => ({
      id: item.id,
      kind: item.kind,
      x: item.x,
      y: item.y,
      w: item.w,
      h: item.h,
      z: item.z ?? 0,
      rotation: item.rotation ?? 0,
      ...(/^https?:\/\//i.test(item.ref || "") ? { ref: item.ref } : null),
    }));
}

/**
 * Réécrit la liste des localisateurs de la scène collaborative ouverte. C'est la seule chose qui
 * permette à la coquille d'autoriser l'import d'un fichier local dans un board partagé, et elle
 * doit être sur le disque AVANT que les médias du lot ne partent à l'importeur — d'où sa place hors
 * du hook : le pont collaboratif l'appelle directement.
 */
export async function syncCollabMedia(force = false): Promise<void> {
  const state = useBoard.getState();
  if (!state.collabProjectId || !state.sceneId) return;
  const media = retainedRefs();
  const preview = collabPreview();
  const signature = JSON.stringify(preview);
  const mediaChanged = media.length !== lastCollabMedia.length
    || media.some((ref, index) => ref !== lastCollabMedia[index]);
  if (!mediaChanged && signature === lastCollabPreview) return;
  // Seule la LISTE doit être sur disque avant le départ du lot — c'est elle qui autorise l'import.
  // La disposition n'existe que pour la vignette : réécrire la ligne à chaque vidage de 150 ms d'un
  // glissé faisait une écriture SQLite par pause du pointeur. Un changement de disposition seul
  // attend donc que le board se taise un instant.
  if (!mediaChanged && !force) {
    if (collabPreviewTimer === null) {
      collabPreviewTimer = window.setTimeout(() => {
        collabPreviewTimer = null;
        void syncCollabMedia(true);
      }, 2000);
    }
    return;
  }
  if (collabPreviewTimer !== null) {
    window.clearTimeout(collabPreviewTimer);
    collabPreviewTimer = null;
  }
  const result = await nr.reference?.saveScene({
    id: state.sceneId,
    name: state.sceneName,
    items: [],
    view: state.view,
    collaboration: { projectId: state.collabProjectId },
    media,
    preview,
  });
  if (result?.ok) {
    lastCollabMedia = media;
    lastCollabPreview = signature;
  }
}

const collaboration = () => {
  const projectId = useBoard.getState().collabProjectId;
  return projectId ? { projectId } : null;
};

// Une scène collaborative persiste son lien et sa vue, jamais une seconde copie modifiable du
// board. À la réouverture, la projection native remplace le cache vide — y compris quand le projet
// lui-même est vide.
const sceneItems = () => {
  const state = useBoard.getState();
  return state.collabProjectId ? [] : persistable(state.items);
};

// Scène telle qu'elle part au core pour un ENREGISTREMENT (par opposition à un partage).
// `adoptLocal` porte la politique de copie des médias locaux dans le dossier compagnon : c'est le
// réglage de l'utilisateur, pas une constante du core — lui seul sait s'il pose des captures de
// quelques Mo ou des rushes de plusieurs Go.
const savable = (name: string) => {
  const st = useBoard.getState();
  return {
    name,
    items: persistable(st.items),
    view: st.view,
    retain: retainedRefs(),
    adoptLocal: st.prefs.copyLocalIntoProject,
    adoptLocalMax: Math.round(st.prefs.copyLocalMaxMB * 1024 * 1024),
  };
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
    // Un projet collaboratif reste piloté par sa scène partagée : dupliquer son id sans définir un
    // second projet créerait deux noms locaux pour une seule vérité distante. L'export reste ouvert.
    if (st.collabProjectId) {
      const error = tr("collab.saveAsBlocked");
      flash(error, "error");
      return { ok: false, error };
    }
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
          items: sceneItems(),
          view: st.view,
          collaboration: collaboration(),
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
      // Une scène de bibliothèque garde des chemins ABSOLUS : un dossier compagnon déplacé ou vidé
      // depuis les laisse morts alors que les octets vivent encore ailleurs (le nom porte leur
      // empreinte). Soin en arrière-plan, silencieux — au pire il ne trouve rien et rien ne change.
      void import("./boardMediaActions")
        .then((actions) => actions.healDeadMediaRefs())
        .catch(() => undefined);
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
    // Une scène collaborative ne s'enregistre JAMAIS toute seule : `saveScene` réécrit la ligne
    // entière, donc un enregistrement sans `collaboration`/`media`/`preview` délierait le projet et
    // effacerait la liste de localisateurs qui autorise l'import d'un média. Le document fait foi.
    if (st.collabProjectId) return;
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
      const items = await withLocalMediaPaths(exportable(st.items));
      return api.weigh({ name: st.sceneName, items, view: st.view }, opts);
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
        // Un board PARTAGÉ désigne ses médias par empreinte : le core, qui ne connaît que des
        // fichiers, écrivait alors un .netsu entièrement fait de placeholders en annonçant un
        // export réussi. Leurs octets sont bien sur ce disque — on lui en donne le chemin.
        const items = await withLocalMediaPaths(exportable(st.items));
        const res = await api?.exportBoard({ name: st.sceneName, items, view: st.view }, dest, opts);
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

  /**
   * Fait entrer dans la bibliothèque un board ouvert depuis un fichier, pour qu'il puisse devenir
   * collaboratif. « Enregistrer sous » fait du `.netsu` le document de travail, et un projet
   * partagé ne peut pas avoir deux autorités sur le même board — mais c'est une raison de
   * CONVERTIR, pas de refuser. Le fichier reste sur le disque, en export figé.
   *
   * Sans effet quand le board vit déjà dans la bibliothèque.
   */
  const adoptIntoLibrary = useCallback(async () => {
    const state = useBoard.getState();
    // La coquille autorise l'import d'un média en lisant la scène TELLE QU'ELLE EST STOCKÉE : un
    // fichier que le board affiche mais que la scène enregistrée ne mentionne pas est refusé, et
    // l'item part alors amputé de son média. Tout board est donc écrit avant d'être partagé — pas
    // seulement ceux qu'on convertit — pour que le disque porte exactement ce qui est publié.
    const fresh = state.filePath !== null || state.sceneId === null;
    const result = await api?.saveScene({
      id: fresh ? pendingAdoption ?? undefined : state.sceneId ?? undefined,
      name: state.sceneName,
      items: sceneItems(),
      view: state.view,
    });
    if (!result?.ok || !result.id) throw new Error(result?.error || tr("notice.saveFailed"));
    // Seule une ligne créée par cet appel peut être retirée si le partage échoue ensuite.
    if (!fresh) return { sceneId: result.id, adopted: false as const };
    pendingAdoption = result.id;
    // Le board n'est PAS détaché de son fichier ici : le partage peut encore échouer, et un board à
    // demi converti — copie créée, fichier oublié — laisserait l'utilisateur entre deux documents.
    return { sceneId: result.id, adopted: true as const };
  }, [api]);

  /** Détache le board de son `.netsu` une fois le partage réellement abouti. */
  const completeAdoption = useCallback((sceneId: string) => {
    pendingAdoption = null;
    const { filePath } = useBoard.getState();
    // Le fichier reste sur le disque en export figé, mais sans ce lien sa carte « récents » et la
    // scène partagée sont deux boards sans rapport sur l'accueil — et la carte fichier, la plus
    // reconnaissable, est la mauvaise à éditer.
    if (filePath) void api?.linkSource(filePath, sceneId).catch(() => undefined);
    useBoard.setState({ sceneId, filePath: null, fileReadonly: false, dirty: false });
  }, [api]);

  /** Remet le board où il était quand une adoption n'a pas pu aboutir. */
  const abortAdoption = useCallback(async (before: { sceneId: string | null; filePath: string | null }) => {
    if (pendingAdoption) {
      await api?.deleteScene(pendingAdoption).catch(() => undefined);
      pendingAdoption = null;
    }
    useBoard.setState({ sceneId: before.sceneId, filePath: before.filePath, collabProjectId: null });
  }, [api]);

  /** Lie le projet collaboratif à la scène : c'est ce qui rend le board partagé sur cette machine. */
  const bindCollaboration = useCallback(async (projectId: string) => {
    const state = useBoard.getState();
    if (state.filePath) {
      throw new Error("A file-backed board must be imported into the scene library before sharing");
    }
    const result = await api?.saveScene({
      id: state.sceneId ?? undefined,
      name: state.sceneName,
      items: [],
      view: state.view,
      collaboration: { projectId },
      media: retainedRefs(),
      preview: collabPreview(),
    });
    lastCollabMedia = [];
    lastCollabPreview = "";
    pendingAdoption = null;
    if (!result?.ok || !result.id) {
      throw new Error(result?.error || "Could not bind the collaborative project to this scene");
    }
    useBoard.setState({
      sceneId: result.id,
      collabProjectId: projectId,
      collabRole: null,
      collabKeyEpoch: 0,
      collabRotationRequired: false,
      collabPeerCandidates: 0,
      collabOfflineQueued: false,
      dirty: false,
    });
    return result.id;
  }, [api]);

  return {
    save, open, list, remove, handoff, loadHandoff, saveAuto, loadAuto, weigh, exportBoard, importBoard,
    saveProject, saveProjectAs, openProject, recentProjects, forgetProject,
    bindCollaboration, adoptIntoLibrary, completeAdoption, abortAdoption,
    available: !!api,
  };
}
