import { collectionApi, collectionBackend } from "@/lib/collab/collection/session";
import { registerCollabSurface } from "@/lib/collab/surfaces";
import { api } from "@/lib/convexApi";
import type { ProjectRole } from "@/lib/collab/types";
import i18n from "@/i18n";

/** Role granted by the invitation, so the adopted collection knows it before anyone opens it. */
async function grantedRole(projectId: string): Promise<ProjectRole | undefined> {
  try {
    const backend = await collectionBackend();
    const access = await backend.query(api.projects.getProjectAccess, { projectId }) as { role: ProjectRole } | null;
    return access?.role;
  } catch { return undefined; }
}

registerCollabSurface({
  id: "collection", labelKey: "surface.collection",
  async listBindings() {
    return (await collectionApi().list()).flatMap((collection) => collection.collaboration?.projectId ? [{
      projectId: collection.collaboration.projectId, subjectId: collection.id, name: collection.name,
    }] : []);
  },
  async adopt(projectId, suggestedName) {
    const existing = (await collectionApi().list()).find((c) => c.collaboration?.projectId === projectId);
    if (existing) return { projectId, subjectId: existing.id, name: existing.name };
    const name = suggestedName || i18n.t("collab:invites.shared");
    const result = await collectionApi().save({ name, collaboration: { projectId, role: await grantedRole(projectId) } });
    if (!result.ok || !result.id) throw new Error(result.error || "Could not adopt shared collection");
    return { projectId, subjectId: result.id, name };
  },
  async forget(binding) { await collectionApi().delete(binding.subjectId); },
  onRemoved() { void import("@/store").then(({ useApp }) => { useApp.getState().closeCollection(); void useApp.getState().loadCollections(); }); },
  open(binding) { void import("@/store").then(({ useApp }) => { useApp.getState().setTab("derush"); useApp.getState().setDerushSection("collections"); useApp.getState().openCollection(binding.subjectId); }); },
});
