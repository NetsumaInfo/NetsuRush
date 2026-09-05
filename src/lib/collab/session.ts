// Publication boundary of a collaborative project.
//
// Creating one is transactional at product level: Convex writes the metadata, Rust opens the local
// document, the surface seeds it, and only a sealed, recoverable checkpoint makes it real. A
// failure before that boundary rolls the empty project back, so nothing on this machine is left
// pointing at a project nobody can recover.

import { refreshNativeCollaborationAuth } from "./authBridge";
import {
  abortProject,
  applyOperations,
  closeProject,
  createProject,
  flushCheckpoint,
  openProject,
} from "./client";
import type { CollabOp } from "./types";

export type UnresolvedMedia = { ref: string; cause: string };
export type SeedResult = { ops: CollabOp[]; missing: UnresolvedMedia[] };

/**
 * A publication stopped by unreadable media. Carries the list so the UI can name the files and
 * mark the items instead of printing a wall of absolute paths and OS errors.
 */
export class UnreadableMediaError extends Error {
  constructor(readonly unresolved: UnresolvedMedia[]) {
    super(`${unresolved.length} media could not be read: ${describeUnresolved(unresolved)}`);
    this.name = "UnreadableMediaError";
  }
}

/** One readable line naming what could not travel, and why. */
export function describeUnresolved(missing: UnresolvedMedia[]): string {
  const named = missing.slice(0, 3).map((entry) => `${entry.ref} (${entry.cause})`).join(" · ");
  return missing.length > 3 ? `${named} … +${missing.length - 3}` : named;
}

export async function createCollaborativeProject(options: {
  /** Module the document belongs to (`surfaces.ts`). */
  surface: string;
  /** Local document being shared. */
  subjectId: string;
  /**
   * Imports the document's local media and returns the operations that seed the shared document.
   * Called once, between creation and the first checkpoint.
   */
  seed?: (projectId: string) => Promise<SeedResult>;
}): Promise<{ projectId: string }> {
  if (!(await refreshNativeCollaborationAuth())) {
    throw new Error("Sign in is required to create a collaborative project");
  }
  const { projectId } = await createProject(options.surface);
  const session = await openProject(projectId, options.subjectId, options.surface, "owner");
  try {
    if (options.seed) {
      const seeded = await options.seed(projectId);
      // Publishing is the one moment a media enters the shared document. A document that goes out
      // amputated stays amputated for everyone, including its author, so a file that cannot be
      // read stops the share here with its name and its cause instead of being left behind.
      if (seeded.missing.length) throw new UnreadableMediaError(seeded.missing);
      if (seeded.ops.length) await applyOperations(projectId, seeded.ops);
    }
    // The publication boundary: the document is not collaborative until a sealed, recoverable
    // checkpoint and its owner key envelope both exist in Convex.
    await flushCheckpoint(projectId);
    return { projectId };
  } catch (error) {
    await abortProject(projectId).catch(() => undefined);
    throw error;
  } finally {
    await closeProject(projectId, session.leaseId).catch(() => undefined);
  }
}
