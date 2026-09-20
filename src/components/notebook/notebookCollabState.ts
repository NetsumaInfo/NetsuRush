import type { ProjectRole } from "@/lib/collab/types";
import type { NotebookCollabBinding } from "@/lib/bridge";
import { useSyncExternalStore } from "react";
export const notebookCollabState: { binding: NotebookCollabBinding | null; role: ProjectRole | null; applying: boolean; composing: boolean } = { binding: null, role: null, applying: false, composing: false };
export function openNotebookSharing(scope: "notebook" | "notebook-page", pageId?: string) {
  window.dispatchEvent(new CustomEvent("nr-notebook-share", { detail: { scope, pageId } }));
}
export function notebookCanEdit(notebookId?: string | null, pageId?: string | null): boolean {
  const { binding, role, applying } = notebookCollabState;
  if (applying || !binding || binding.notebookId !== notebookId) return true;
  if (binding.surface === "notebook-page" && pageId && binding.subjectId !== pageId) return true;
  return role === "owner" || role === "editor";
}
const subscribe = (listener: () => void) => {
  window.addEventListener("nr-notebook-collab-state", listener);
  return () => window.removeEventListener("nr-notebook-collab-state", listener);
};
export function useNotebookCanEdit(notebookId?: string | null, pageId?: string | null) {
  return useSyncExternalStore(subscribe, () => notebookCanEdit(notebookId, pageId), () => true);
}
