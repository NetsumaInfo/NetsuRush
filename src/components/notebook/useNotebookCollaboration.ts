import { useEffect, useState } from "react";
import { useApp } from "@/store";
import type { NotebookCollabBinding } from "@/lib/bridge";
import { applyOperations, closeProject, nativeProjection, onChanged, openProject, resolveMedia } from "@/lib/collab/client";
import { refreshNativeCollaborationAuth } from "@/lib/collab/authBridge";
import { getCollabCadence, subscribeCollabPreferences } from "@/lib/collab/preferences";
import { releaseCollabProject, setCurrentCollabProject } from "@/lib/collab/currentProject";
import type { ProjectRole, SurfaceEntryProjection, SurfaceProjection } from "@/lib/collab/types";
import { notebookCollabState } from "./notebookCollabState";
import { decodeNotebook, diffNotebook, type NotebookSnapshot } from "./notebookCollabModel";
import { displayNotebookMedia, loadNotebookSnapshot, notebookApi, notebookEntries } from "./notebookCollabSession";

function announce() { window.dispatchEvent(new Event("nr-notebook-collab-state")); }
function remap<T>(value: T, ids: Map<string, string>): T {
  if (typeof value === "string") return (ids.get(value) ?? value) as T;
  if (Array.isArray(value)) return value.map((v) => remap(v, ids)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [ids.get(k) ?? k, remap(v, ids)])) as T;
  return value;
}

export function useNotebookCollaboration(binding: NotebookCollabBinding | null) {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!binding) return;
    const { projectId, notebookId, surface } = binding;
    let disposed = false, closing = false, running = false, pending = false, refreshPending = false, paused = false;
    let activeFlush: Promise<void> | undefined;
    let forceMedia = false;
    let mediaRunning = false;
    let starting = false;
    let role: ProjectRole | null = null;
    let cachedPageMetas = useApp.getState().nbPages;
    let version = 0, baseRevision = 0;
    let sent: SurfaceEntryProjection[] = [];
    let snapshot: NotebookSnapshot | null = null;
    let lease: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    let unstore: (() => void) | undefined;
    const remoteIds = new Map<string, string>();
    const localIds = new Map<string, string>();
    notebookCollabState.binding = binding; notebookCollabState.role = null; announce();
    setError(null);
    const failed = (cause: unknown) => { paused = true; if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)); };

    async function readLocal() {
      const state = useApp.getState();
      const loaded = snapshot && cachedPageMetas === state.nbPages
        ? { ...snapshot, pages: [...snapshot.pages], databases: { ...snapshot.databases } }
        : await loadNotebookSnapshot(binding!);
      cachedPageMetas = state.nbPages;
      if (state.nbActiveId === notebookId) {
        if (state.nbPage && (surface === "notebook" || state.nbPage.id === binding!.subjectId)) {
          const index = loaded.pages.findIndex((page) => page.id === state.nbPage!.id);
          if (index >= 0) loaded.pages[index] = state.nbPage;
        }
        Object.assign(loaded.databases, state.nbDatabases);
        loaded.notebook = state.nbList.find((nb) => nb.id === notebookId) ?? loaded.notebook;
      }
      return loaded;
    }

    async function project() {
      const at = version;
      const projection = await nativeProjection<SurfaceProjection>(projectId);
      if (disposed || at !== version || pending || notebookCollabState.composing) { refreshPending = true; return; }
      for (const entry of projection.entries) {
        if (entry.kind !== "page" && entry.kind !== "database") continue;
        const remote = entry.kind === "database" ? entry.entryId.slice(3) : entry.entryId;
        const local = binding!.remoteSubjectId ? remote : entry.kind === "page" && surface === "notebook-page" ? binding!.subjectId : `shared_${notebookId}_${remote}`;
        remoteIds.set(remote, local); localIds.set(local, remote);
      }
      const decoded = decodeNotebook(projection.entries, notebookId);
      const mapped = remap(decoded, remoteIds);
      const displayed = displayNotebookMedia(mapped, projectId, projection.localHashes);
      const previousSnapshot = snapshot;
      const current = useApp.getState();
      if (surface === "notebook-page") for (const page of displayed.pages) page.parentId = current.nbPages.find((existing) => existing.id === page.id)?.parentId ?? null;
      notebookCollabState.applying = true;
      try {
        // Update the editor/store synchronously before any disk await. New keystrokes then remain local edits.
        if (current.nbActiveId === notebookId) {
          const metas = displayed.pages.map(({ blocks: _blocks, ...meta }) => meta);
          const pages = surface === "notebook" ? metas : [...current.nbPages.filter((p) => p.id !== binding!.subjectId), ...metas];
          const page = displayed.pages.find((p) => p.id === current.nbActivePageId);
          const removedActivePage = surface === "notebook" && current.nbActivePageId && !page;
          useApp.setState({ nbPages: pages, ...(page ? { nbPage: page, nbDatabases: displayed.databases, nbDirty: false } : removedActivePage ? { nbPage: null, nbActivePageId: null, nbDatabases: {}, nbDirty: false } : {}),
            ...(surface === "notebook" ? { nbList: current.nbList.map((nb) => nb.id === notebookId ? { ...nb, ...displayed.notebook, id: notebookId } : nb) } : {}) });
          if (page) window.dispatchEvent(new CustomEvent("nr-notebook-projection", { detail: page }));
        }
        snapshot = displayed; sent = projection.entries; baseRevision = projection.revision;
        cachedPageMetas = useApp.getState().nbPages;
      } finally { notebookCollabState.applying = false; }
      // Persist only changed pages; unchanged notebook sections do not serialize on each keystroke.
      const api = notebookApi();
      for (const page of displayed.pages) {
        if (disposed || version !== at) break;
        const previous = await api.loadPage(page.id);
        if (version !== at) break;
        const persisted = (value: typeof page | undefined) => value && { blocks: value.blocks, title: value.title, parentId: value.parentId, orderIdx: value.orderIdx, icon: value.icon, cover: value.cover };
        if (JSON.stringify(persisted(previous?.page)) === JSON.stringify(persisted(page))) continue;
        const result = await api.savePage(page);
        if (!result.ok) throw new Error(result.error || "Could not persist shared page");
      }
      for (const db of Object.values(displayed.databases)) {
        const pageId = (db as unknown as { pageId?: string }).pageId;
        if (pageId && !disposed && version === at) {
          const result = await api.saveDatabase({ ...db, pageId });
          if (!result.ok) throw new Error(result.error || "Could not persist shared database");
        }
      }
      if (previousSnapshot && surface === "notebook" && version === at) {
        const live = new Set(displayed.pages.map((p) => p.id));
        for (const page of previousSnapshot.pages) if (!live.has(page.id) && version === at) await api.deletePage(page.id);
      }
      if (!mediaRunning && (forceMedia || getCollabCadence(surface).autoDownload)) {
        forceMedia = false;
        const missing = [...new Map(projection.entries.flatMap((entry) => Object.values(entry.media))
          .map(({ primary }) => [primary.contentHash, primary] as const)).values()]
          .filter((asset) => asset.contentHash && !projection.localHashes.includes(asset.contentHash));
        // Keep transfers off the text flush path. One bounded worker group owns this queue.
        mediaRunning = true;
        void (async () => {
          let cursor = 0;
          await Promise.all(Array.from({ length: Math.min(missing.length, getCollabCadence(surface).mediaConcurrency) }, async () => {
            while (!disposed && !closing && cursor < missing.length) {
              const asset = missing[cursor++];
              const resolved = await resolveMedia(projectId, { hash: asset.contentHash!, name: asset.displayName, mime: asset.mime, size: asset.size });
              if (resolved.status === "available") { refreshPending = true; schedule(); }
            }
          }));
        })().catch((cause) => { if (!disposed && !closing) setError(String(cause)); }).finally(() => {
          mediaRunning = false;
          if (refreshPending) schedule();
        });
      }
    }

    async function flush() {
      if (disposed || !lease || !snapshot) return;
      if (running) { refreshPending = true; return; }
      if (notebookCollabState.composing) { schedule(); return; }
      running = true;
      try {
        if (pending && role && role !== "viewer") {
          const at = version;
          const captured = await readLocal();
          if (disposed) return;
          const normalized = remap(captured, localIds);
          if (surface === "notebook-page") normalized.pages = normalized.pages.map((page) => ({ ...page, parentId: null }));
          const entries = await notebookEntries(normalized, projectId, sent, binding!);
          const meta = entries.find((e) => e.entryId === "notebook");
          if (meta && surface === "notebook-page") meta.fields = { ...sent.find((e) => e.entryId === "notebook")?.fields };
          if (meta) meta.fields.rootPageId = sent.find((e) => e.entryId === "notebook")?.fields.rootPageId ?? null;
          const ops = diffNotebook(sent, entries);
          if (ops.length) {
            const result = await applyOperations(projectId, ops, baseRevision);
            baseRevision = result.authoredRevision ?? result.revision;
          }
          sent = entries; snapshot = captured; pending = at !== version;
        }
        if (!pending) { refreshPending = false; await project(); }
        if (!disposed) setError(null);
      } catch (cause) { failed(cause); }
      finally { running = false; if (!disposed && !paused && (pending || refreshPending)) schedule(); }
    }
    function schedule() {
      if (timer || disposed || closing || paused) return;
      timer = setTimeout(() => { timer = undefined; activeFlush = flush(); }, getCollabCadence(surface).batchMs);
    }
    const unprefs = subscribeCollabPreferences(schedule);
    const retry = () => { paused = false; forceMedia = true; refreshPending = true; if (lease) schedule(); else void start().catch(failed); };
    window.addEventListener("nr-notebook-collab-retry", retry);
    const authTimer = setInterval(() => { void refreshNativeCollaborationAuth().catch(failed); }, 5 * 60_000);
    async function start() {
      if (starting || disposed || closing) return;
      starting = true;
      try {
      if (!(await refreshNativeCollaborationAuth())) throw new Error("Sign in required");
      const session = await openProject(projectId, binding!.subjectId, surface, "editor");
      if (disposed || closing) { await closeProject(projectId, session.leaseId); return; }
      lease = session.leaseId; setCurrentCollabProject(projectId);
      snapshot = await readLocal();
      await project();
      if (disposed || closing) return;
      role = session.role; notebookCollabState.role = role; announce();
      unstore = useApp.subscribe((state, previous) => {
        if (notebookCollabState.applying || role === "viewer" || state.nbActiveId !== notebookId) return;
        const changedPage = state.nbPage !== previous.nbPage && state.nbDirty;
        if (changedPage || state.nbPages !== previous.nbPages || state.nbDatabases !== previous.nbDatabases || state.nbList !== previous.nbList) {
          version++; pending = true; schedule();
        }
      });
      unsubscribe = await onChanged((event) => { if (event.projectId === projectId) { refreshPending = true; schedule(); } });
      if (disposed) { unsubscribe(); unstore(); }
      } catch (cause) {
        unsubscribe?.(); unstore?.(); unsubscribe = undefined; unstore = undefined;
        const failedLease = lease; lease = undefined;
        if (failedLease) await closeProject(projectId, failedLease).catch(() => {});
        throw cause;
      } finally { starting = false; }
    }
    void start().catch(failed);
    return () => {
      // Retain the lease until the final accepted local snapshot is submitted.
      unstore?.(); unsubscribe?.(); unprefs(); clearInterval(authTimer); clearTimeout(timer);
      window.removeEventListener("nr-notebook-collab-retry", retry);
      closing = true;
      const finish = async () => { await activeFlush; if (pending) await flush(); disposed = true; if (lease) await closeProject(projectId, lease); };
      void finish().catch(failed);
      releaseCollabProject(projectId);
      if (notebookCollabState.binding?.projectId === projectId) { notebookCollabState.binding = null; notebookCollabState.role = null; announce(); }
    };
  }, [binding?.projectId]);
  return { error };
}
