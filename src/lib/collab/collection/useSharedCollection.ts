import { useCallback, useEffect, useRef, useState } from "react";
import { type Collection, type CollectionShot } from "@/lib/bridge";
import { api } from "@/lib/convexApi";
import { closeProject, mediaPath, nativeProjection, onChanged, openProject, resolveMedia } from "../client";
import { refreshNativeCollaborationAuth } from "../authBridge";
import { getCollabCadence, subscribeCollabPreferences } from "../preferences";
import { setCurrentCollabProject, releaseCollabProject } from "../currentProject";
import type { ProjectRole, SurfaceEntryProjection } from "../types";
import { collectionBackend, rememberCollectionRole } from "./session";
import { errorText } from "@/lib/errorText";

type Access = { userId: string; role: ProjectRole; canDeleteOthers: boolean;
  entries: Array<{ entryId: string; contributorId: string; removed: boolean }> };
type Projection = { revision: number; entries: SurfaceEntryProjection[] };
const hiddenKey = (projectId: string) => `nr.collection.hidden.${projectId}`;
function hiddenIds(projectId: string): Set<string> {
  try { const value: unknown = JSON.parse(localStorage.getItem(hiddenKey(projectId)) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []);
  } catch { return new Set(); }
}

export function useSharedCollection(local: Collection | null) {
  const projectId = local?.collaboration?.projectId;
  const id = local?.id;
  const [shared, setShared] = useState<Collection | null>(null);
  const [access, setAccess] = useState<Access | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hiddenCount, setHiddenCount] = useState(0);
  const refreshRef = useRef<(download?: boolean) => void>(() => {});
  const localRef = useRef(local); localRef.current = local;

  useEffect(() => {
    setShared(null); setAccess(null); setError(null); setHiddenCount(0);
    if (!projectId || !id) return;
    let disposed = false;
    let lease: string | undefined;
    let unsubscribe: (() => void) | undefined;
    let unquery: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let queued = false;
    let forced = false;
    let roster: Access | undefined;
    let starting = false;
    const failed = (cause: unknown) => { if (!disposed) setError(errorText(cause)); };
    const refresh = async () => {
      if (disposed || !lease || !roster) return;
      if (running) { queued = true; return; }
      running = true;
      const download = forced || getCollabCadence("collection").autoDownload; forced = false;
      try {
        const projection = await nativeProjection<Projection>(projectId);
        const entries = new Map(projection.entries.map((entry) => [entry.entryId, entry]));
        const hidden = hiddenIds(projectId);
        const shots: CollectionShot[] = [];
        const missing: Array<{ hash: string; name: string; mime: string; size: number }> = [];
        // Membership records, not opaque CRDT tombstones, determine whether a shared entry exists.
        for (const authority of roster.entries) {
          if (authority.removed || hidden.has(authority.entryId)) continue;
          const entry = entries.get(authority.entryId);
          // Claimed but not in the document yet: a contribution whose edits are still travelling, or
          // one whose publication failed after claiming its identity. Neither is a shot to show -
          // painting it would put a nameless, medialess card in everyone's collection for good.
          if (!entry) continue;
          const fields = entry.fields ?? {};
          const asset = entry.media.primary?.primary;
          const hash = asset?.contentHash;
          const path = hash ? await mediaPath(projectId, hash) : null;
          const duration = typeof fields.duration === "number" && Number.isFinite(fields.duration) ? Math.max(0, fields.duration) : 0;
          shots.push({ id: authority.entryId, path: path ?? "", name: typeof fields.name === "string" ? fields.name : "",
            in: 0, out: duration, fps: typeof fields.fps === "number" ? fields.fps : undefined,
            tags: Array.isArray(fields.tags) ? fields.tags.filter((v): v is string => typeof v === "string") : [],
            note: typeof fields.note === "string" ? fields.note : "", label: typeof fields.label === "string" ? fields.label : null,
            rating: typeof fields.rating === "number" ? fields.rating : 0, addedAt: typeof fields.addedAt === "number" ? fields.addedAt : 0,
          });
          if (!path && hash && asset && download) missing.push({ hash, name: asset.displayName, mime: asset.mime, size: asset.size });
        }
        const base = localRef.current;
        const metadata = entries.get("collection")?.fields;
        if (!disposed && base) {
          setShared({ ...base, shots, name: typeof metadata?.name === "string" ? metadata.name : base.name,
            description: typeof metadata?.description === "string" ? metadata.description : base.description,
            color: typeof metadata?.color === "string" ? metadata.color : base.color });
          setHiddenCount(roster.entries.filter((e) => !e.removed && hidden.has(e.entryId)).length);
          setError(null);
        }
        let cursor = 0;
        let arrived = false;
        await Promise.all(Array.from({ length: Math.min(missing.length, getCollabCadence("collection").mediaConcurrency) }, async () => {
          while (!disposed && cursor < missing.length) {
            const asset = missing[cursor++];
            const resolution = await resolveMedia(projectId, asset);
            if (resolution.status === "available") arrived = true;
          }
        }));
        if (arrived) queued = true;
      } catch (cause) { failed(cause); }
      finally {
        running = false;
        if (queued && !disposed) { queued = false; schedule(); }
      }
    };
    function schedule(download = false) {
      forced ||= download;
      if (timer || disposed) return;
      timer = setTimeout(() => { timer = undefined; void refresh(); }, getCollabCadence("collection").batchMs);
    }
    refreshRef.current = (download = false) => { forced ||= download; if (lease) schedule(download); else void start().catch(failed); };
    const unprefs = subscribeCollabPreferences(() => schedule());
    const authTimer = setInterval(() => { void refreshNativeCollaborationAuth().catch(failed); }, 5 * 60_000);
    async function start() {
      if (starting || disposed) return;
      starting = true;
      try {
      if (!(await refreshNativeCollaborationAuth())) throw new Error("Sign in required");
      const backend = await collectionBackend();
      const initial = await backend.query(api.collectionAccess.list, { projectId }) as Access;
      if (disposed) return;
      roster = initial; setAccess(initial);
      // The role travels with the collection: "Range" and the collection list have to know a
      // read-only share without opening it (cf. session.rememberCollectionRole).
      void rememberCollectionRole(id!, initial.role).catch(() => undefined);
      const session = await openProject(projectId!, id!, "collection", initial.role);
      if (disposed) { await closeProject(projectId!, session.leaseId); return; }
      lease = session.leaseId; setCurrentCollabProject(projectId!);
      unsubscribe = await onChanged((event) => { if (event.projectId === projectId) schedule(); });
      if (disposed) { unsubscribe(); return; }
      const watch = backend.watchQuery(api.collectionAccess.list, { projectId });
      unquery = watch.onUpdate(() => {
        try {
          const value = watch.localQueryResult() as Access | undefined;
          if (!value || disposed) return;
          roster = value; setAccess(roster);
          void rememberCollectionRole(id!, value.role).catch(() => undefined);
          schedule();
        } catch (cause) { failed(cause); }
      });
      schedule();
      } catch (cause) {
        unsubscribe?.(); unquery?.(); unsubscribe = undefined; unquery = undefined;
        const failedLease = lease; lease = undefined;
        if (failedLease) await closeProject(projectId!, failedLease).catch(() => {});
        throw cause;
      } finally { starting = false; }
    }
    void start().catch(failed);
    return () => {
      disposed = true; refreshRef.current = () => {};
      clearTimeout(timer); clearInterval(authTimer); unsubscribe?.(); unquery?.(); unprefs();
      if (lease) void closeProject(projectId, lease).catch(() => {});
      releaseCollabProject(projectId);
    };
  }, [projectId, id]);

  const hide = useCallback((entryId: string) => {
    if (!projectId) return;
    const hidden = hiddenIds(projectId); hidden.add(entryId);
    localStorage.setItem(hiddenKey(projectId), JSON.stringify([...hidden])); refreshRef.current();
  }, [projectId]);
  const restoreHidden = useCallback(() => {
    if (!projectId) return;
    localStorage.removeItem(hiddenKey(projectId)); refreshRef.current();
  }, [projectId]);
  // Who may touch a shot, and it is the same answer for removing it and for editing its metadata:
  // the owner governs the whole collection, an editor governs what they contributed, and anything
  // else only once the owner delegated it (`convex/collectionAccess.ts`). A viewer touches nothing.
  //
  // The document itself cannot enforce the last part - a CRDT has no per-entry author - so the
  // membership table is the authority on existence, and this gate is the authority on editing.
  const governs = (entryId: string) => {
    if (!access || access.role === "viewer") return false;
    if (access.role === "owner" || access.canDeleteOthers) return true;
    return access.entries.some((e) => e.entryId === entryId && e.contributorId === access.userId);
  };
  const remove = async (entryId: string) => {
    if (!projectId) return;
    await (await collectionBackend()).mutation(api.collectionAccess.remove, { projectId, entryId });
  };
  return { collection: shared?.id === id ? shared : null, access, error, hide, restoreHidden, hiddenCount,
    canRemove: governs, canEdit: governs, remove,
    refresh: () => refreshRef.current(), retry: () => refreshRef.current(true) };
}
