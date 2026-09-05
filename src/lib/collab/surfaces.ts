// Which module of the app a shared project belongs to.
//
// Collaboration itself knows nothing about boards, collections or notebooks: Rust owns a document,
// Convex owns the membership, and both are indifferent to what the document holds. What is NOT
// indifferent is the local side — a project is only useful when it is bound to something on this
// machine that can be opened, named, created when an invitation is accepted, and removed when the
// project goes away. That binding is what a surface provides.
//
// The label also travels to Convex in clear (`convex/schema.ts#projects.surface`): an invitation
// has to say what it invites to before its recipient holds any key.
//
// Adding a surface = one `registerCollabSurface` call from that module. Nothing here, in the
// settings panel, in the notifications or in the native service has to learn its name.

import { collabAvailable } from "./client";

/** A local document bound to a shared project. */
export type CollabBinding = {
  projectId: string;
  /** Id of the local document — a scene id, a collection id, a notebook id. */
  subjectId: string;
  /** What the user calls it. The only human-readable identity a project has on this machine. */
  name: string;
};

export interface CollabSurface {
  /** Stable label, lowercase, also written on the Convex project row. */
  id: string;
  /** Key in the `collab` i18n namespace naming the kind of thing shared, singular. */
  labelKey: string;
  /** Documents of this surface currently bound to a project. */
  listBindings(): Promise<CollabBinding[]>;
  /**
   * Creates the local document an accepted invitation lands in, empty: the shared document is
   * authoritative and its content arrives from the network. Returns the binding it created.
   */
  adopt(projectId: string, suggestedName: string): Promise<CollabBinding>;
  /** Removes the local document after the project was left or deleted. */
  forget(binding: CollabBinding): Promise<void>;
  /**
   * The project is gone. A view still projecting that very document has to leave it rather than
   * keep painting a dead projection.
   */
  onRemoved?(projectId: string): void;
  /** Brings the document to the front — the answer to "someone changed this". */
  open?(binding: CollabBinding): void;
}

const surfaces = new Map<string, CollabSurface>();

export function registerCollabSurface(surface: CollabSurface): () => void {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(surface.id)) {
    throw new Error(`invalid collaboration surface id: ${surface.id}`);
  }
  surfaces.set(surface.id, surface);
  return () => {
    if (surfaces.get(surface.id) === surface) surfaces.delete(surface.id);
  };
}

export function collabSurface(id: string | undefined): CollabSurface | null {
  return (id && surfaces.get(id)) || null;
}

export function collabSurfaces(): CollabSurface[] {
  return [...surfaces.values()];
}

/**
 * Every binding known on this machine, keyed by project.
 *
 * A project whose surface is not registered — an old build's, or a module this window does not
 * load — is simply absent from the map. It stays visible in the account settings as a project with
 * no local document, which is exactly what it is; inventing a binding for it would create a second
 * name for one remote truth.
 */
export async function collabBindings(): Promise<Map<string, CollabBinding>> {
  const bound = new Map<string, CollabBinding>();
  if (!collabAvailable()) return bound;
  const lists = await Promise.all(
    collabSurfaces().map((surface) => surface.listBindings().catch(() => [] as CollabBinding[])),
  );
  for (const list of lists) for (const binding of list) bound.set(binding.projectId, binding);
  return bound;
}
