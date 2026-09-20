import { nr, type NotebookCollabBinding } from "@/lib/bridge";
import { useApp } from "@/store";
import { abortProject, applyOperations, closeProject, createProject, flushCheckpoint, importMedia, mediaUrl, nativeProjection, openProject } from "@/lib/collab/client";
import { refreshNativeCollaborationAuth } from "@/lib/collab/authBridge";
import type { SurfaceEntryProjection } from "@/lib/collab/types";
import { encodeNotebook, diffNotebook, type NotebookSnapshot } from "./notebookCollabModel";
import { notebookBindings } from "./collabSurface";

export function notebookApi() { if (!nr.notebook) throw new Error("Notebook unavailable"); return nr.notebook; }
export async function loadNotebookSnapshot(binding: Pick<NotebookCollabBinding, "notebookId" | "subjectId" | "surface">): Promise<NotebookSnapshot> {
  const loaded = await notebookApi().load(binding.notebookId);
  if (!loaded) throw new Error("Notebook unavailable");
  const pages: NotebookSnapshot["pages"] = [];
  const databases: NotebookSnapshot["databases"] = {};
  for (const meta of loaded.pages) {
    if (binding.surface === "notebook-page" && meta.id !== binding.subjectId) continue;
    const result = await notebookApi().loadPage(meta.id);
    if (!result) throw new Error("Notebook page unavailable");
    pages.push(result.page); Object.assign(databases, result.databases);
  }
  return { notebook: loaded.notebook, pages, databases };
}

function localPath(value: string): string | null {
  if (/^[a-z]:[\\/]|^\\\\/i.test(value)) return value;
  try {
    const url = new URL(value);
    if (["localhost", "127.0.0.1", "core.localhost"].includes(url.hostname) && url.pathname.startsWith("/media")) return url.searchParams.get("path") ?? url.searchParams.get("p");
  } catch { /* Plain text is not media. */ }
  return null;
}
function mime(path: string) {
  const ext = path.split(".").pop()?.toLowerCase();
  return ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", mp4: "video/mp4", mov: "video/quicktime", mp3: "audio/mpeg", wav: "audio/wav", pdf: "application/pdf" } as Record<string, string>)[ext ?? ""] ?? "application/octet-stream";
}

export async function notebookEntries(snapshot: NotebookSnapshot, projectId: string, previous: SurfaceEntryProjection[] = [], mediaScope?: Pick<NotebookCollabBinding, "surface" | "subjectId">) {
  const entries = encodeNotebook(snapshot);
  const old = new Map(previous.map((entry) => [entry.entryId, entry]));
  const imported = new Map<string, Awaited<ReturnType<typeof importMedia>>>();
  let grantsPrepared = false;
  for (const entry of entries) {
    let mediaIndex = 0;
    const visit = async (value: unknown, key: string): Promise<unknown> => {
      if (typeof value === "string") {
        if (key === "urls") {
          let parsed: unknown; try { parsed = JSON.parse(value); } catch { return value; }
          return JSON.stringify(await visit(parsed, "url"));
        }
        const shared = value.match(/^(?:collab:|http:\/\/collab\.localhost\/[^/]+\/)([a-f0-9]{64})(?:\?.*)?$/);
        if (shared) {
          const manifest = Object.values(old.get(entry.entryId)?.media ?? {}).find((m) => m.primary.contentHash === shared[1]);
          if (manifest) entry.media[`asset_${mediaIndex++}`] = manifest;
          return `collab:${shared[1]}`;
        }
        // Only media-bearing properties are interpreted as locators, never prose or code blocks.
        const path = ["url", "src", "path", "cover"].includes(key) ? localPath(value) : null;
        if (!path) return value;
        if (!grantsPrepared) {
          await useApp.getState().nbFlushPage();
          await notebookApi().prepareCollaborationMedia(mediaScope?.surface ?? "notebook", mediaScope?.subjectId ?? snapshot.notebook.id);
          grantsPrepared = true;
        }
        let asset = imported.get(path);
        if (!asset) { asset = await importMedia(projectId, path, mime(path)); imported.set(path, asset); }
        entry.media[`asset_${mediaIndex++}`] = { primary: { contentHash: asset.hash, displayName: asset.name, mime: asset.mime, size: asset.size } };
        return `collab:${asset.hash}`;
      }
      if (Array.isArray(value)) return Promise.all(value.map((child) => visit(child, key)));
      if (value && typeof value === "object") return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, child]) => [key, await visit(child, key)])));
      return value;
    };
    entry.fields = await visit(entry.fields, "") as Record<string, unknown>;
  }
  return entries;
}

export function displayNotebookMedia<T>(value: T, projectId: string, available: string[] = []): T {
  if (typeof value === "string" && /^collab:[a-f0-9]{64}$/.test(value)) return (mediaUrl(projectId, value.slice(7)) + (available.includes(value.slice(7)) ? "?ready=1" : "")) as T;
  if (typeof value === "string" && value.startsWith("[") && value.includes("collab:")) { try { return JSON.stringify(displayNotebookMedia(JSON.parse(value), projectId, available)) as T; } catch { return value; } }
  if (Array.isArray(value)) return value.map((v) => displayNotebookMedia(v, projectId, available)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, displayNotebookMedia(v, projectId, available)])) as T;
  return value;
}

export async function shareNotebook(notebookId: string, pageId?: string) {
  await useApp.getState().nbFlushPage();
  const surface = pageId ? "notebook-page" as const : "notebook" as const;
  const subjectId = pageId ?? notebookId;
  const existing = (await notebookBindings()).find((binding) => binding.notebookId === notebookId &&
    (binding.surface === "notebook" || !pageId || binding.subjectId === pageId));
  if (existing) {
    if (existing.surface !== surface || existing.subjectId !== subjectId) throw new Error("This notebook already contains a shared document");
    if (!existing.pending) return { projectId: existing.projectId };
  }
  const snapshot = await loadNotebookSnapshot({ notebookId, subjectId, surface });
  if (pageId) snapshot.pages = snapshot.pages.map((page) => ({ ...page, parentId: null }));
  if (!(await refreshNativeCollaborationAuth())) throw new Error("Sign in required");
  const created = existing ?? await createProject(surface);
  const name = pageId ? snapshot.pages[0]?.title ?? snapshot.notebook.title : snapshot.notebook.title;
  const binding: NotebookCollabBinding = { projectId: created.projectId, surface, subjectId, notebookId, name, remoteSubjectId: subjectId, pending: true };
  let applied = false, lease: string | undefined;
  try {
    const reserved = await notebookApi().setCollaborationBinding(binding, created.projectId);
    if (!reserved.ok) throw new Error("Could not reserve notebook binding");
    const session = await openProject(created.projectId, subjectId, surface, "owner"); lease = session.leaseId;
    const projectId = created.projectId;
    const entries = await notebookEntries(snapshot, projectId, [], { surface, subjectId });
    entries.find((entry) => entry.entryId === "notebook")!.fields.rootPageId = pageId ?? null;
    const projection = await nativeProjection<{ revision: number; entries: SurfaceEntryProjection[] }>(projectId);
    await applyOperations(projectId, diffNotebook(projection.entries, entries), projection.revision); applied = true;
    await flushCheckpoint(projectId);
    const saved = await notebookApi().setCollaborationBinding({ ...binding, pending: false }, projectId);
    if (!saved.ok) throw new Error("Could not save notebook binding");
  } catch (error) {
    if (!existing && !applied) {
      try { await abortProject(created.projectId); await notebookApi().setCollaborationBinding(null, created.projectId); } catch { /* Retain reservation for retry. */ }
    }
    throw error;
  } finally { if (lease) await closeProject(created.projectId, lease).catch(() => {}); }
  window.dispatchEvent(new Event("nr-notebook-binding"));
  return created;
}
