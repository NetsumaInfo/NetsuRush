// Native bridge of collaborative projects (`docs/collab.md`).
//
// Everything authoritative lives in Rust: the Loro document, the iroh endpoint, the durable outbox
// and every secret. This module only speaks to it. It knows nothing about what is being shared —
// a board, a collection, a notebook — so a new surface adds a projection and a diff (see
// `surfaces.ts`), never another copy of this file.

import { COLLAB_PROTOCOL_VERSION, type CollabOp, type ProjectRole } from "./types";
import { takeImportGrant } from "./importGrants";

export type ApplyResult = { revision: number; applied: number };
export type CollabChanged = { projectId: string; revision: number };
export type ProjectSession = {
  projectId: string;
  /** Local document this project is bound to — a scene id, a collection id, a notebook id. */
  subjectId: string;
  surface: string;
  role: ProjectRole;
  keyEpoch: number;
  leaseId: string;
};
export type MemberPresence = {
  userId: string;
  devices: number;
  /** Milliseconds since this machine last reached one of their devices; absent = never reached. */
  lastSeenMs?: number | null;
  canWrite: boolean;
  /** False while no device of theirs holds the current key: a member who cannot read yet. */
  hasKey: boolean;
};
export type ProjectStatus = {
  role: ProjectRole;
  keyEpoch: number;
  rotationRequired: boolean;
  peerCandidates: number;
  offlineQueued: boolean;
  members?: MemberPresence[];
};
export type ImportedMedia = { hash: string; name: string; mime: string; size: number };
export type MediaResolution = { status: "available" | "waiting" | "removed"; hash: string };
export type CollabFailure = {
  code: "authorization" | "conflict" | "corrupt" | "key_pending" | "network"
    | "read_only" | "storage" | "unavailable" | "validation";
  message: string;
};

export function collabErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === "string" && error.trim()) return error;
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "object" && error !== null) {
    // A rejection reaches us in three shapes: an Error, a Convex error carrying `data`, and a plain
    // object from the Tauri boundary. Reading only `message` turned the other two into
    // "[object Object]" on screen, which hides the one thing the user needs.
    for (const key of ["message", "data", "error"] as const) {
      const value = (error as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim()) return value;
      if (typeof value === "object" && value !== null) {
        const nested = (value as { message?: unknown }).message;
        if (typeof nested === "string" && nested.trim()) return nested;
      }
    }
  }
  return fallback;
}

// The dynamic import is resolved ONCE and shared. Re-entering it per call meant one module
// resolution per IPC — and there is one per pointer frame during a drag — while two calls issued
// concurrently could race on it, the loser failing for no reason of its own.
let invokePromise: Promise<typeof import("@tauri-apps/api/core")["invoke"]> | null = null;

async function invoker() {
  if (!("__TAURI_INTERNALS__" in window)) throw new Error("collaboration requires the desktop app");
  invokePromise ??= import("@tauri-apps/api/core").then((module) => module.invoke);
  return invokePromise;
}

/** Is the native service reachable at all? False in a browser tab and in the Adobe CEP panel. */
export function collabAvailable(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function configureAuth(
  deploymentUrl: string,
  token: string,
  deviceLabel?: string,
): Promise<void> {
  await (await invoker())("collab_configure_auth", {
    configuration: { deploymentUrl, token, deviceLabel },
  });
}

export async function deviceIdentity(): Promise<{ deviceId: string; createdAt: number }> {
  return (await invoker())("collab_device_identity");
}

export async function openProject(
  projectId: string,
  subjectId: string,
  surface: string,
  role: ProjectRole,
): Promise<ProjectSession> {
  return (await invoker())<ProjectSession>("collab_project_open", {
    request: { projectId, subjectId, surface, role },
  });
}

export async function createProject(surface: string): Promise<{ projectId: string }> {
  return (await invoker())<{ projectId: string }>("collab_project_create", { surface });
}

export async function abortProject(projectId: string): Promise<void> {
  await (await invoker())("collab_project_abort", { projectId });
}

export async function flushCheckpoint(projectId: string): Promise<void> {
  await (await invoker())("collab_project_flush_checkpoint", { projectId });
}

export async function inviteMembers(
  projectId: string,
  userIds: string[],
  role: Exclude<ProjectRole, "owner"> = "editor",
): Promise<{ results: Array<{ userId: string; status: string }> }> {
  return (await invoker())("collab_project_invite", { request: { projectId, userIds, role } });
}

export async function respondInvite(inviteId: string, accept: boolean): Promise<{
  status: string;
  projectId?: string;
  keyStatus?: string;
}> {
  return (await invoker())("collab_invite_respond", { request: { inviteId, accept } });
}

export async function cancelInvite(inviteId: string): Promise<void> {
  await (await invoker())("collab_invite_cancel", { inviteId });
}

export async function setMemberRole(
  projectId: string,
  userId: string,
  role: Exclude<ProjectRole, "owner">,
): Promise<void> {
  await (await invoker())("collab_member_set_role", { request: { projectId, userId, role } });
}

export async function removeMember(projectId: string, userId: string): Promise<void> {
  await (await invoker())("collab_member_remove", { request: { projectId, userId } });
}

export async function leaveProject(projectId: string): Promise<void> {
  await (await invoker())("collab_project_leave", { projectId });
}

export async function deleteProject(projectId: string): Promise<void> {
  await (await invoker())("collab_project_delete", { projectId });
}

export async function discardStaleHead(headId: string): Promise<void> {
  await (await invoker())("collab_head_discard_stale", { headId });
}

export async function forgetDevice(deviceId: string): Promise<void> {
  await (await invoker())("collab_device_forget", { deviceId });
}

export async function importMedia(projectId: string, path: string, mime: string): Promise<ImportedMedia> {
  const grant = takeImportGrant(path) ?? await (await invoker())<string>("collab_media_grant_known", {
    projectId,
    path,
  });
  return (await invoker())<ImportedMedia>("collab_media_import", {
    request: { projectId, grant, mime },
  });
}

export async function resolveMedia(
  projectId: string,
  asset: ImportedMedia,
): Promise<MediaResolution> {
  return (await invoker())<MediaResolution>("collab_media_resolve", {
    request: { projectId, asset },
  });
}

/**
 * Disk path of a shared media's bytes, or null while they are still travelling. The Node service
 * only knows files, so this is what lets a shared document be exported with its media instead of a
 * document full of placeholders.
 */
export async function mediaPath(projectId: string, hash: string): Promise<string | null> {
  return (await invoker())<string | null>("collab_media_path", { projectId, hash });
}

export function mediaUrl(projectId: string, hash: string): string {
  return `http://collab.localhost/${encodeURIComponent(projectId)}/${hash}`;
}

export async function closeProject(projectId: string, leaseId: string): Promise<void> {
  await (await invoker())("collab_project_close", { request: { projectId, leaseId } });
}

export async function applyOperations(projectId: string, ops: CollabOp[]): Promise<ApplyResult> {
  if (!ops.length) return { revision: 0, applied: 0 };
  return (await invoker())<ApplyResult>("collab_project_apply", {
    projectId,
    batch: { protocol: COLLAB_PROTOCOL_VERSION, ops },
  });
}

/**
 * Total projection of the document, straight from Rust. A surface turns it into its own model;
 * nothing here interprets it.
 */
export async function nativeProjection<T>(projectId: string): Promise<T> {
  return (await invoker())<T>("collab_project_projection", { projectId });
}

export async function projectStatus(projectId: string): Promise<ProjectStatus> {
  return (await invoker())<ProjectStatus>("collab_project_status", { projectId });
}

export async function undo(projectId: string): Promise<ApplyResult> {
  return (await invoker())<ApplyResult>("collab_project_undo", { projectId });
}

export async function redo(projectId: string): Promise<ApplyResult> {
  return (await invoker())<ApplyResult>("collab_project_redo", { projectId });
}

export async function onChanged(handler: (event: CollabChanged) => void): Promise<() => void> {
  if (!collabAvailable()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<CollabChanged>("nr-collab-changed", (event) => handler(event.payload));
}
