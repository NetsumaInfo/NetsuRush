import { nr, type Collection, type CollectionArchive, type CollectionShotPatch } from "@/lib/bridge";
import { api } from "@/lib/convexApi";
import { archiveProfile } from "@/features/export/archiveProfile";
import { refreshNativeCollaborationAuth } from "../authBridge";
import { abortProject, applyOperations, closeProject, createProject, flushCheckpoint, importMedia, openProject } from "../client";
import { collabFailure } from "../failure";
import type { CollabOp, ProjectRole } from "../types";

export function collectionApi() { if (!nr.collections) throw collabFailure("unavailable", "collections are unavailable"); return nr.collections; }

const jobs = new Map<string, Promise<{ projectId: string }>>();

const MIME_BY_EXTENSION: Record<string, string> = {
  mp4: "video/mp4", mov: "video/quicktime", mkv: "video/x-matroska", webm: "video/webm", avi: "video/x-msvideo",
};
function mimeOf(file: string): string {
  return MIME_BY_EXTENSION[file.split(".").pop()?.toLowerCase() ?? ""] ?? "video/mp4";
}

/**
 * Sharing publishes the collection ARCHIVE, so a shared collection always has one. A collection that
 * was never archived - the usual case when someone shares before archiving, and always the case for
 * a collection adopted from an invitation - gets the folder the app keeps for that, which the
 * archive panel then shows and the user is free to change.
 */
export async function ensureArchiveTarget(collection: Collection): Promise<CollectionArchive> {
  const archive = collection.archive ?? {};
  if (archive.dir) return archive;
  const { dir } = await collectionApi().defaultArchiveDir(collection.name);
  if (!dir) throw collabFailure("archive_folder", "no archive folder for this collection");
  const next: CollectionArchive = { ...archive, dir };
  const saved = await collectionApi().save({ id: collection.id, name: collection.name, archive: next });
  if (!saved.ok) throw saved.error ? new Error(saved.error) : collabFailure("collection_save", "could not set the archive folder");
  return next;
}

/**
 * The collection stops being shared but stays here: only the binding to the project goes.
 *
 * Deleting the project on Convex does not touch this machine, and nothing else clears the binding -
 * the account panel's "remove project" deliberately deletes the local document too, which is not
 * what stopping a share means. Without this, a collection kept claiming to be shared and the next
 * open pointed at a project that no longer exists.
 */
export async function unbindCollection(id: string): Promise<void> {
  const collection = await collectionApi().load(id);
  if (!collection) return;
  const saved = await collectionApi().save({ id, name: collection.name, collaboration: null });
  if (!saved.ok) throw saved.error ? new Error(saved.error) : collabFailure("collection_save", "could not stop sharing this collection");
}

/** What this account may do on the shared collection, kept locally for the views that never open it. */
export async function rememberCollectionRole(id: string, role: ProjectRole): Promise<void> {
  const collection = await collectionApi().load(id);
  if (!collection || collection.collaboration?.role === role) return;
  await collectionApi().save({ id, name: collection.name, collaboration: { ...collection.collaboration, role } });
}
export async function collectionBackend() {
  const { convexClient } = await import("@/lib/convexClient");
  if (!convexClient) throw collabFailure("not_configured", "collaboration is not configured");
  return convexClient;
}

function metadata(collection: Collection): CollabOp {
  return { type: "surfaceSetEntry", entryId: "collection", kind: "collection", fields: {
    name: collection.name, color: collection.color, description: collection.description ?? "", tags: collection.tags ?? [],
  } };
}

async function preparedOperations(id: string, projectId: string, archive: CollectionArchive) {
  // Preparing IS archiving: the same settings, the same files, produced once (`core/collectionSharing.js`).
  const result = await collectionApi().prepareShare(id, {
    dir: archive.dir, profile: archiveProfile(archive), autoSync: archive.autoSync, process: archive.process,
  });
  if (!result.ok || !result.prepared) throw result.error ? new Error(result.error) : collabFailure("collection_media", "media preparation failed");
  const collection = await collectionApi().load(id);
  if (!collection) throw collabFailure("collection_missing", "collection not found");
  const published = new Set(collection.collaboration?.publishedShotIds ?? []);
  const ops: CollabOp[] = [metadata(collection)];
  const entryIds: string[] = [];
  const added: string[] = [];
  for (const prepared of result.prepared) {
    if (published.has(prepared.shotId)) continue;
    const shot = collection.shots.find((candidate) => candidate.id === prepared.shotId);
    if (!shot) throw collabFailure("collection_changed", "collection changed during media preparation");
    const media = await importMedia(projectId, prepared.path, mimeOf(prepared.path));
    const entryId = `ci_${prepared.shotId}`;
    ops.push({ type: "surfaceSetEntry", entryId, kind: "collectionItem", fields: {
      name: shot.name, duration: prepared.duration, fps: shot.fps ?? null, tags: shot.tags ?? [],
      label: shot.label ?? null, rating: shot.rating ?? 0, note: shot.note ?? "", addedAt: shot.addedAt ?? Date.now(),
    } }, { type: "surfaceSetMedia", entryId, field: "primary", manifest: { primary: {
      contentHash: media.hash, displayName: shot.name, mime: media.mime, size: media.size,
    } } });
    entryIds.push(entryId);
    added.push(prepared.shotId);
  }
  return { ops, entryIds, publishedShotIds: [...published, ...added] };
}

/** Claims the shared identity of entries the document already holds, in server-sized batches. */
async function registerEntries(projectId: string, entryIds: string[]) {
  const backend = await collectionBackend();
  for (let offset = 0; offset < entryIds.length; offset += 100) {
    await backend.mutation(api.collectionAccess.register, { projectId, entryIds: entryIds.slice(offset, offset + 100) });
  }
}

export function shareCollection(id: string): Promise<{ projectId: string }> {
  const existing = jobs.get(id);
  if (existing) return existing;
  const job = publish(id).finally(() => jobs.delete(id));
  jobs.set(id, job);
  return job;
}

async function publish(id: string) {
  const collection = await collectionApi().load(id);
  if (!collection) throw collabFailure("collection_missing", "collection not found");
  if (collection.collaboration?.role === "viewer") throw collabFailure("read_only", "this collection is shared as read-only");
  if (!(await refreshNativeCollaborationAuth())) throw collabFailure("sign_in", "sign in required");
  const archive = await ensureArchiveTarget(collection);
  const previousId = collection.collaboration?.projectId ?? collection.collaboration?.pendingProjectId;
  const { projectId } = previousId ? { projectId: previousId } : await createProject("collection");
  let applied = false;
  let lease: string | undefined;
  try {
    if (!previousId) {
      const reserved = await collectionApi().save({ id, name: collection.name, collaboration: {
        ...collection.collaboration, pendingProjectId: projectId, role: "owner",
      } });
      if (!reserved.ok) throw reserved.error ? new Error(reserved.error) : collabFailure("collection_save", "could not reserve the shared project");
    }
    const session = await openProject(projectId, id, "collection", previousId ? "editor" : "owner");
    lease = session.leaseId;
    const prepared = await preparedOperations(id, projectId, archive);
    await applyOperations(projectId, prepared.ops); applied = true;
    // Claimed AFTER the document holds them: a membership row whose entry never reached the document
    // would surface in everyone's collection as a shot with no name and no media.
    await registerEntries(projectId, prepared.entryIds);
    await flushCheckpoint(projectId);
    const latest = await collectionApi().load(id);
    if (!latest) throw collabFailure("collection_missing", "collection removed during publication");
    const saved = await collectionApi().save({ id, name: latest.name, collaboration: {
      ...latest.collaboration, projectId, pendingProjectId: undefined, publishedShotIds: prepared.publishedShotIds,
    } });
    if (!saved.ok) throw saved.error ? new Error(saved.error) : collabFailure("collection_save", "could not save the shared collection binding");
    window.dispatchEvent(new CustomEvent("nr-collection-shared", { detail: { id } }));
    return { projectId };
  } catch (error) {
    if (!previousId && !applied) {
      try {
        await abortProject(projectId);
        const latest = await collectionApi().load(id);
        if (latest) await collectionApi().save({ id, name: latest.name, collaboration: { ...latest.collaboration, pendingProjectId: undefined } });
      } catch { /* Keep the reserved id for an idempotent retry after a network/storage failure. */ }
    }
    throw error;
  } finally { if (lease) await closeProject(projectId, lease).catch(() => {}); }
}

export async function syncCollectionMetadata(id: string) {
  const collection = await collectionApi().load(id);
  const projectId = collection?.collaboration?.projectId;
  if (!collection || !projectId) return;
  const session = await openProject(projectId, id, "collection", "editor");
  try { await applyOperations(projectId, [metadata(collection)]); }
  finally { await closeProject(projectId, session.leaseId); }
}

export async function patchSharedShot(projectId: string, entryId: string, patch: CollectionShotPatch) {
  // Source paths/frame ranges belong to local media preparation and never enter metadata operations.
  const fields: Record<string, unknown> = {};
  for (const key of ["name", "tags", "label", "rating", "note"] as const) {
    if (patch[key] !== undefined) fields[key] = patch[key];
  }
  if (Object.keys(fields).length) await applyOperations(projectId, [{ type: "surfaceSetEntry", entryId, kind: "collectionItem", fields }]);
}
