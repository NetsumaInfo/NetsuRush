// Which shared projects are open right now, and how to address their media.
//
// A shared media is designated by `collab:<hash>` — never by a path. Its DISPLAY address depends on
// the open project (`http://collab.localhost/<project>/<hash>`), which makes it impossible to
// compute from the model alone. A projection names one for each item's own media, but not for
// everything around it: a sequence's frames, a strip under a player, the off-DOM render behind an
// export. Those callers used to land on an empty address and paint a blank tile without ever
// saying why.
//
// Hence this tiny registry. It depends on NOTHING — not the store, not the native bridge — so a
// model can ask it without an import cycle, and one rule decides a shared media's address wherever
// it is asked for.

import { mediaUrl } from "./client";

let current: string | null = null;
const open = new Set<string>();

/** Followed by each surface's bridge as it opens and closes a shared document. */
export function setCurrentCollabProject(projectId: string | null): void {
  current = projectId;
  if (projectId) open.add(projectId);
}

export function releaseCollabProject(projectId: string): void {
  open.delete(projectId);
  if (current === projectId) current = null;
}

export function currentCollabProject(): string | null {
  return current;
}

/**
 * Is this project being shown somewhere right now? A live collaborator already sees the revision
 * arrive, so a "while you were away" notice about it would be a lie.
 */
export function isCollabProjectOpen(projectId: string): boolean {
  return open.has(projectId);
}

/** A media served by the shell's own protocol, neither a remote link nor a file the core can open. */
export function isCollabRef(ref: string): boolean {
  return /^collab:/i.test(ref);
}

/** Can the core open this locator as a file? (proxy, poster, frames, upscale, cut, export) */
export function isCoreFileRef(ref: string | undefined): boolean {
  return !!ref && !/^(https?:|data:|blob:)/i.test(ref) && !isCollabRef(ref);
}

/**
 * Display address of a `collab:<hash>`, or '' outside a shared document — in which case the hash
 * designates nothing reachable and an empty tile is the only honest answer.
 */
export function collabMediaSrc(ref: string): string {
  if (!current) return "";
  const hash = ref.slice("collab:".length);
  return hash ? mediaUrl(current, hash) : "";
}
