import { useEffect, useLayoutEffect, useRef } from "react";
import type { BoardItem } from "./referenceShared";
import { same } from "@/lib/collab/board/operations";
import { releaseCollabProject, setCurrentCollabProject } from "@/lib/collab/currentProject";
import { useBoard } from "./useReferenceBoard";
import { resetCollabMediaSync, syncCollabMedia } from "./useScenePersistence";
import { useCollabProject } from "./useCollabProject";
import { getCollabCadence, subscribeCollabPreferences } from "@/lib/collab/preferences";

// A drag emits one store update per pointer frame. Sending each of them to the document as its own
// batch cost an IPC round trip per frame and kept the outbox permanently behind, which is what the
// toolbar reported as "sync pending". Local edits are coalesced over this window and leave as one
// batch once the gesture rests; the document is never more than this far behind the screen.

/** Bidirectional adapter. Rust/Loro is always authoritative; the Zustand board is a render cache. */
export function useCollabBridge() {
  const projectId = useBoard((state) => state.collabProjectId);
  const sceneId = useBoard((state) => state.sceneId);
  const collab = useCollabProject(projectId, sceneId);
  const applyingProjection = useRef(false);
  const lastSent = useRef<BoardItem[]>([]);
  const sendQueue = useRef(Promise.resolve());
  // Non-zero while a local edit is either waiting for the coalescing window or in flight. An
  // authoritative projection that lands in that interval describes a board older than the one under
  // the user's cursor, so it is held back rather than applied on top of the gesture.
  const localPending = useRef(0);
  const projectionDeferred = useRef(false);
  // `useCollabProject` returns a fresh object on every render; subscribing on its identity would
  // tear the subscription down and rebuild it several times per second.
  const latest = useRef(collab);
  latest.current = collab;

  // Publié AVANT tout rendu du board : `displaySrc` s'en sert pour adresser les médias partagés que
  // la projection ne nomme pas un par un (frames d'une séquence, pellicule, rendu d'export). Réglé
  // en layout effect, donc la toute première peinture d'un board qui vient de s'ouvrir a déjà la
  // bonne adresse au lieu d'une case vide rattrapée au rendu suivant.
  useLayoutEffect(() => {
    setCurrentCollabProject(projectId);
    // La liste de localisateurs écrite pour la scène précédente ne vaut plus rien ici : la garder
    // ferait sauter la première écriture du nouveau board, dont les médias seraient alors refusés.
    resetCollabMediaSync();
    return () => {
      releaseCollabProject(projectId ?? "");
      setCurrentCollabProject(null);
    };
  }, [projectId]);

  useEffect(() => {
    if (!projectId || !collab.session) return;
    useBoard.setState({
      collabRole: collab.session.role,
      collabKeyEpoch: collab.session.keyEpoch,
      collabRotationRequired: collab.status?.rotationRequired ?? false,
      collabPeerCandidates: collab.status?.peerCandidates ?? 0,
      collabOfflineQueued: collab.status?.offlineQueued ?? false,
      collabMembers: collab.status?.members ?? [],
    });
  }, [collab.session, collab.status, projectId]);

  // Empty is a complete authoritative state too. Never retain stale local items merely because the
  // remote projection contains zero entries.
  useEffect(() => {
    if (!projectId || !collab.session) return;
    if (useBoard.getState().collabProjectId !== projectId) return;
    if (localPending.current > 0) {
      projectionDeferred.current = true;
      return;
    }
    applyingProjection.current = true;
    // The projection rebuilds every item object on every remote change. Reusing the existing object
    // for items the change did not touch keeps their identity stable, so memoized item components
    // skip their render and the outgoing diff's `old === item` fast path holds.
    const currentById = new Map(useBoard.getState().items.map((item) => [item.id, item]));
    const items = collab.items.map((item) => {
      const current = currentById.get(item.id);
      return current && same(current, item) ? current : item;
    });
    lastSent.current = items;
    // Selection is the user's, not the document's: a remote edit elsewhere on the board must not
    // deselect what is being worked on. Only references to items that no longer exist are dropped.
    useBoard.setState((state) => {
      const ids = new Set(items.map((item) => item.id));
      const selectedIds = state.selectedIds.filter((id) => ids.has(id));
      const shapes = items.find((item) => item.kind === "draw")?.shapes ?? [];
      const shapeIds = new Set(shapes.map((shape) => shape.id));
      const keptShapes = state.drawSel.filter((id) => shapeIds.has(id));
      return {
        items,
        dirty: false,
        selectedIds,
        selectedId: state.selectedId && ids.has(state.selectedId)
          ? state.selectedId
          : selectedIds[selectedIds.length - 1] ?? null,
        editingId: state.editingId && ids.has(state.editingId) ? state.editingId : null,
        croppingId: state.croppingId && ids.has(state.croppingId) ? state.croppingId : null,
        // Identité conservée quand aucune forme sélectionnée n'a disparu : une annonce distante
        // ne doit pas rerendre le calque pour une sélection qui n'a pas bougé.
        drawSel: keptShapes.length === state.drawSel.length ? state.drawSel : keptShapes,
      };
    });
    applyingProjection.current = false;
  }, [collab.items, collab.session, projectId]);

  const ready = collab.session !== null;

  useEffect(() => {
    if (!projectId || !ready) return;
    lastSent.current = useBoard.getState().items;
    let timer: number | null = null;
    let pendingSince = 0;

    // The projection held back during a gesture is re-read once the board is quiet, so a concurrent
    // remote edit is not lost — it simply arrives after the local one. Every path out of a pending
    // batch goes through here, otherwise a batch that turned out to be empty would strand it.
    const settle = () => {
      localPending.current -= 1;
      if (localPending.current === 0 && projectionDeferred.current) {
        projectionDeferred.current = false;
        void latest.current.refresh();
      }
    };

    const flush = () => {
      timer = null;
      const state = useBoard.getState();
      // The board may have MOVED ON since this window was armed — home screen, another scene, a solo
      // board. Its items are then someone else's, and the diff against what this project last sent
      // is a deletion of the whole document. Leaving a shared board must never empty it.
      if (state.collabProjectId !== projectId) {
        settle();
        return;
      }
      const next = state.items;
      const previous = lastSent.current;
      if (next === previous) {
        settle();
        return;
      }
      lastSent.current = next;
      sendQueue.current = sendQueue.current
        .catch(() => undefined)
        // The shell authorises a local file import against the STORED scene, and a collaborative
        // scene holds no items. Its locator list therefore has to be on disk BEFORE the media of
        // this batch are handed to the importer, or every file added to a shared board is refused.
        .then(() => syncCollabMedia())
        .catch(() => undefined)
        .then(() => latest.current.sendBoard(previous, next))
        .catch(() => undefined)
        .then(settle);
    };

    const stop = useBoard.subscribe((state) => {
      if (applyingProjection.current) return;
      if (state.collabProjectId !== projectId) return;
      if (state.items === lastSent.current) return;
      if (timer !== null) return;
      localPending.current += 1;
      pendingSince = Date.now();
      timer = window.setTimeout(flush, getCollabCadence("board").batchMs);
    });
    // Re-time the pending batch from its first edit, without resetting the gesture or its diff.
    // Repeated profile switches can never defer it beyond the slowest profile's 900 ms window.
    const stopPreferences = subscribeCollabPreferences(() => {
      if (timer === null) return;
      window.clearTimeout(timer);
      const remaining = Math.max(0, getCollabCadence("board").batchMs - (Date.now() - pendingSince));
      timer = window.setTimeout(flush, remaining);
    });

    return () => {
      stop();
      stopPreferences();
      // Whatever the last gesture produced leaves before the adapter does: dropping the pending
      // window here would silently discard the final edit of every session.
      if (timer !== null) {
        window.clearTimeout(timer);
        flush();
      }
    };
  }, [projectId, ready]);

  useEffect(() => {
    if (!collab.error) return;
    useBoard.getState().setNotice({ text: collab.error, kind: "error", sticky: true });
  }, [collab.error]);

  return collab;
}
