import { useCallback, useEffect, useRef, useState } from "react";
import type { BoardItem } from "./referenceShared";
import { diffBoard, unresolvedMediaItems, type AssetResolver } from "@/lib/collab/board/operations";
import { projectBoard, type NativeProject } from "@/lib/collab/board/projection";
import type { MediaAsset } from "@/lib/collab/types";
import type { MemberPresence } from "@/lib/collab/client";
import {
  applyOperations,
  closeProject,
  mediaUrl,
  nativeProjection,
  onChanged,
  openProject,
  projectStatus,
  redo,
  resolveMedia,
  undo,
  type ProjectStatus,
  type ProjectSession,
} from "@/lib/collab/client";
import { refreshNativeCollaborationAuth } from "@/lib/collab/authBridge";
import { BOARD_SURFACE } from "./collabSurface";
import { collabErrorMessage } from "@/lib/collab/client";
import { describeUnresolved, importBoardAssets } from "@/lib/collab/board/media";

type Resolution = "available" | "waiting" | "removed";

function nativeAssets(project: NativeProject): Map<string, MediaAsset> {
  const assets = new Map<string, MediaAsset>();
  const add = (asset?: MediaAsset | null) => {
    if (asset?.contentHash) assets.set(`collab:${asset.contentHash}`, asset);
  };
  for (const item of project.items) {
    add(item.media?.primary);
    add(item.media?.previous?.asset);
    add(item.media?.local?.asset);
    item.sequence?.frames.forEach(add);
  }
  return assets;
}

export type CollabProject = {
  items: BoardItem[];
  revision: number;
  error: string | null;
  session: ProjectSession | null;
  status: ProjectStatus | null;
  sendBoard: (previous: BoardItem[], next: BoardItem[]) => Promise<void>;
  importBoard: (items: BoardItem[]) => Promise<void>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  refresh: () => Promise<void>;
};

/**
 * Deux relevés de présence disent-ils la même chose ? La fraîcheur (`lastSeenMs`) est arrondie à la
 * dizaine de secondes : elle avance en continu, la comparer au millimètre rendrait tout relevé
 * différent du précédent et re-rendrait le board toutes les cinq secondes pour rien.
 */
function samePresence(left?: MemberPresence[], right?: MemberPresence[]): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  const bucket = (ms?: number | null) => (ms == null ? -1 : Math.round(ms / 10_000));
  return left.every((member, index) => {
    const other = right[index];
    return member.userId === other.userId
      && member.devices === other.devices
      && member.canWrite === other.canWrite
      && member.hasKey === other.hasKey
      && bucket(member.lastSeenMs) === bucket(other.lastSeenMs);
  });
}

export function useCollabProject(projectId: string | null, sceneId: string | null): CollabProject {
  const [items, setItems] = useState<BoardItem[]>([]);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<ProjectSession | null>(null);
  const [status, setStatus] = useState<ProjectStatus | null>(null);
  const assetCache = useRef(new Map<string, MediaAsset>());
  const resolutionCache = useRef(new Map<string, Resolution>());
  const importFailures = useRef(new Map<string, string>());
  const refreshGeneration = useRef(0);
  // Rust announces EVERY apply, including the ones this window just made. Reloading the projection
  // on our own echo replaced the board mid-gesture and dropped the selection with it, so a drag
  // could not survive its first frame. Each locally produced revision is parked here and the
  // matching announcement is consumed once; anything else is a genuine remote change.
  const selfRevisions = useRef(new Set<number>());

  // Tous ces caches sont indexés par une valeur PROPRE au projet — les révisions repartent à 1, les
  // empreintes n'ont de sens que dans leur document. Le hook n'est jamais démonté (son hôte vit toute
  // la session), donc sans cette remise à zéro une révision locale garée sur le projet précédent
  // avalait la première annonce du suivant : une vraie modification distante ne provoquait alors
  // aucun rafraîchissement.
  useEffect(() => {
    resolutionCache.current.clear();
    importFailures.current.clear();
    selfRevisions.current.clear();
    assetCache.current.clear();
  }, [projectId]);

  const renderProjection = useCallback((native: NativeProject) => {
    const projected = projectBoard(native, (hash) => mediaUrl(projectId!, hash));
    const nativeById = new Map(native.items.map((item) => [item.itemId, item]));
    // The projection announces which blobs are on this disk. A hash absent from that list is not
    // there yet: pointing an <img>/<video> at it only buys a 404 and a media error per element —
    // the exact console storm a fresh join produced. An old native side (before localHashes) says
    // nothing, and only then the URL is set optimistically as before.
    const authoritative = Array.isArray(native.localHashes);
    for (const item of projected) {
      const asset = nativeById.get(item.id)?.media?.primary;
      const hash = asset?.contentHash;
      let status = hash ? resolutionCache.current.get(hash) : undefined;
      if (authoritative && hash && status === undefined) status = "waiting";
      if (asset && hash && (status === "waiting" || status === "removed")) {
        // While the original travels, an image whose small preview is already here paints the
        // preview instead of a placeholder. A video keeps its placeholder: its element cannot play
        // a JPEG, and its preview waits on poster support.
        const preview = asset.previewHash;
        if (
          status === "waiting"
          && item.kind === "image"
          && preview
          && resolutionCache.current.get(preview) === "available"
        ) {
          item.src = mediaUrl(projectId!, preview);
          continue;
        }
        item.missing = {
          name: asset.displayName,
          size: asset.size,
          kind: item.kind,
          locator: hash,
          reason: status,
        };
        item.src = "";
      }
    }
    return projected;
  }, [projectId]);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    const generation = ++refreshGeneration.current;
    try {
      const native = await nativeProjection<NativeProject>(projectId);
      if (generation !== refreshGeneration.current) return;
      const assets = nativeAssets(native);
      for (const [ref, asset] of assets) assetCache.current.set(ref, asset);
      // Blobs already on disk never go through a resolve round trip.
      for (const hash of native.localHashes ?? []) resolutionCache.current.set(hash, "available");
      // Content appears immediately. Missing originals resolve in the background and never block
      // notes, geometry, or drawing while every holder of a large video is offline.
      setItems(renderProjection(native));
      setRevision(native.revision);
      setError(null);
      const status = await projectStatus(projectId);
      if (generation !== refreshGeneration.current) return;
      setStatus(status);
      setSession((current) => current ? {
        ...current,
        role: status.role,
        keyEpoch: status.keyEpoch,
      } : current);
      const hashed = [...assets.values()].filter((asset) => asset.contentHash);
      // Previews travel in a batch of their own, BEFORE any original: a few KiB each, so the board
      // shows low-res images within one round trip while the heavy files follow. The intermediate
      // re-render paints them without waiting for the originals' pass to finish.
      const previewJobs = hashed
        .filter((asset) => asset.previewHash && asset.previewSize)
        .map((asset) => ({
          hash: asset.previewHash!,
          name: `${asset.displayName} (preview)`,
          mime: "image/jpeg",
          size: asset.previewSize!,
        }));
      // Images first, then everything else by ascending size: the board fills with what is cheap
      // while the heaviest video downloads last instead of monopolising the link from second one.
      const originalJobs = hashed.map((asset) => ({
        hash: asset.contentHash!,
        name: asset.displayName,
        mime: asset.mime,
        size: asset.size,
      })).sort((a, b) => {
        const heavyA = a.mime.startsWith("image/") ? 0 : 1;
        const heavyB = b.mime.startsWith("image/") ? 0 : 1;
        return heavyA - heavyB || a.size - b.size;
      });
      // Each media paints as soon as its bytes land instead of waiting for the whole pass — with
      // downloads now nearly serial, one final repaint would leave the board in placeholders for
      // the duration of the biggest video. Throttled: a repaint per landed blob, at most every ½ s.
      let lastPaint = 0;
      const paintProgress = () => {
        if (generation !== refreshGeneration.current) return;
        const now = performance.now();
        if (now - lastPaint < 500) return;
        lastPaint = now;
        setItems(renderProjection(native));
      };
      const resolveAll = async (jobs: typeof originalJobs, parallel: number) => {
        let cursor = 0;
        const workers = Array.from({ length: Math.min(parallel, jobs.length) }, async () => {
          // La génération borne AUSSI la boucle : sinon les chaînes en cours continuaient de
          // télécharger pour un projet en fermeture et d'écrire dans un cache désormais partagé
          // avec le projet suivant.
          while (cursor < jobs.length && generation === refreshGeneration.current) {
            const job = jobs[cursor++];
            if (resolutionCache.current.get(job.hash) === "available") continue;
            const result = await resolveMedia(projectId, job);
            resolutionCache.current.set(job.hash, result.status);
            if (result.status === "available") paintProgress();
          }
        });
        await Promise.all(workers);
      };
      // Originals saturate disk and CPU together (write + hash + decode as they land): a small
      // machine froze under four at once, so they arrive one or two at a time. Previews stay wide:
      // a few KiB each, latency-bound.
      const originalWorkers = (navigator.hardwareConcurrency || 4) <= 4 ? 1 : 2;
      void (async () => {
        try {
          if (previewJobs.length) {
            await resolveAll(previewJobs, 4);
            if (generation === refreshGeneration.current) setItems(renderProjection(native));
          }
          await resolveAll(originalJobs, originalWorkers);
          if (generation === refreshGeneration.current) setItems(renderProjection(native));
        } catch (cause) {
          if (generation === refreshGeneration.current) {
            setError(collabErrorMessage(cause, "collaboration error"));
          }
        }
      })();
    } catch (cause) {
      if (generation === refreshGeneration.current) {
        setError(collabErrorMessage(cause, "collaboration error"));
      }
    }
  }, [projectId, renderProjection]);

  useEffect(() => {
    if (!projectId) {
      setItems([]);
      setSession(null);
      setStatus(null);
      return;
    }
    let cancelled = false;
    let stop: (() => void) | null = null;
    let lease: string | null = null;
    void (async () => {
      try {
        if (!(await refreshNativeCollaborationAuth())) {
          throw new Error("Sign in is required to open a collaborative project");
        }
        const opened = await openProject(projectId, sceneId ?? projectId, BOARD_SURFACE, "viewer");
        lease = opened.leaseId;
        if (cancelled) {
          await closeProject(projectId, lease);
          return;
        }
        setSession(opened);
        await refresh();
        const unlisten = await onChanged((event) => {
          if (event.projectId !== projectId) return;
          if (selfRevisions.current.delete(event.revision)) return;
          void refresh();
        });
        // Le nettoyage a pu passer PENDANT l'attente : il a alors lu `stop` encore nul, et cet
        // écouteur ne serait plus jamais retiré — il rafraîchirait un projet fermé pour le reste de
        // la session, et il s'en accumulerait un par bascule rapide.
        if (cancelled) unlisten();
        else stop = unlisten;
      } catch (cause) {
        if (!cancelled) setError(collabErrorMessage(cause, "collaboration error"));
      }
    })();
    return () => {
      cancelled = true;
      refreshGeneration.current += 1;
      stop?.();
      if (lease) void closeProject(projectId, lease);
    };
  }, [projectId, refresh, sceneId]);

  // Status is cheap and says whether the outbox is drained, whether a key rotation is pending and
  // what this device is allowed to do. It is polled on its own: the projection is only re-read when
  // the document actually changed, so hanging the badge off a projection reload left the toolbar
  // claiming "sync pending" long after the queue had emptied.
  const syncStatus = useCallback(async () => {
    if (!projectId) return;
    try {
      const next = await projectStatus(projectId);
      // `members` DOIT entrer dans la comparaison : sans lui l'objet gardait son identité tant que
      // les cinq autres champs ne bougeaient pas, le pont ne se relançait pas, et le panneau de
      // présence restait figé sur son état d'ouverture — il ne fonctionnait donc que lorsqu'un
      // changement de document le débloquait, c'est-à-dire quand il ne servait à rien.
      setStatus((current) => current
        && current.role === next.role
        && current.keyEpoch === next.keyEpoch
        && current.rotationRequired === next.rotationRequired
        && current.peerCandidates === next.peerCandidates
        && current.offlineQueued === next.offlineQueued
        && samePresence(current.members, next.members)
        ? current
        : next);
      setSession((current) => current && (current.role !== next.role || current.keyEpoch !== next.keyEpoch)
        ? { ...current, role: next.role, keyEpoch: next.keyEpoch }
        : current);
    } catch { /* the next tick reports it; a transient status read must not raise a notice */ }
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    const timer = window.setInterval(() => void syncStatus(), 5000);
    return () => window.clearInterval(timer);
  }, [projectId, syncStatus]);

  useEffect(() => {
    if (!projectId) return;
    const timer = window.setInterval(() => {
      void refreshNativeCollaborationAuth().then((authenticated) => {
        if (authenticated) void refresh();
      });
    }, 5 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [projectId, refresh]);

  useEffect(() => {
    const retry = () => {
      resolutionCache.current.clear();
      importFailures.current.clear();
      void refresh();
    };
    window.addEventListener("nr-collab-retry-media", retry);
    return () => window.removeEventListener("nr-collab-retry-media", retry);
  }, [refresh]);

  const resolverFor = useCallback(async (next: BoardItem[]) => {
    if (!projectId) return { resolve: (() => null) as AssetResolver, missing: [] };
    return importBoardAssets(projectId, next, assetCache.current, importFailures.current);
  }, [projectId]);

  const sendBoard = useCallback(async (previous: BoardItem[], next: BoardItem[]) => {
    if (!projectId || session?.role === "viewer") {
      await refresh();
      return;
    }
    try {
      const assets = await resolverFor(next);
      const operations = diffBoard(previous, next, assets.resolve);
      // Editing must not stop because one file moved: the diff already refuses to erase the media
      // of an item it could not resolve, so the board keeps working and the user is simply told
      // which files are no longer readable.
      const stranded = unresolvedMediaItems();
      setError(stranded.length && assets.missing.length
        ? `${stranded.length} media not shared: ${describeUnresolved(assets.missing)}`
        : null);
      if (!operations.length) return;
      const result = await applyOperations(projectId, operations);
      // The renderer already shows what it just sent: re-reading the projection here only threw
      // the board away and rebuilt it, one round trip per pointer event. The document keeps its
      // own copy; a divergence can only come from a remote change, which announces itself.
      if (result.revision) selfRevisions.current.add(result.revision);
      setRevision(result.revision);
    } catch (cause) {
      setError(collabErrorMessage(cause, "collaboration error"));
      await refresh();
    }
  }, [projectId, refresh, resolverFor, session?.role]);

  const importBoard = useCallback(async (source: BoardItem[]) => {
    await sendBoard([], source);
  }, [sendBoard]);

  const runHistory = useCallback(async (redoing: boolean) => {
    if (!projectId || session?.role === "viewer") return;
    try {
      const result = await (redoing ? redo(projectId) : undo(projectId));
      if (result.revision) selfRevisions.current.add(result.revision);
      await refresh();
    } catch (cause) {
      setError(collabErrorMessage(cause, "collaboration error"));
    }
  }, [projectId, refresh, session?.role]);

  return {
    items,
    revision,
    error,
    session,
    status,
    sendBoard,
    importBoard,
    undo: () => runHistory(false),
    redo: () => runHistory(true),
    refresh,
  };
}
