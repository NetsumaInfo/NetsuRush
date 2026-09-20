import { nr, type NotebookCollabBinding } from "@/lib/bridge";
import { registerCollabSurface } from "@/lib/collab/surfaces";
import i18n from "@/i18n";

export async function notebookBindings(): Promise<NotebookCollabBinding[]> { return await nr.notebook?.collaborationBindings() ?? []; }
for (const surface of ["notebook", "notebook-page"] as const) registerCollabSurface({
  id: surface, labelKey: `surface.${surface}`,
  listBindings: async () => (await notebookBindings()).filter((binding) => binding.surface === surface && !binding.pending),
  async adopt(projectId, suggestedName) {
    const existing = (await notebookBindings()).find((binding) => binding.projectId === projectId);
    if (existing) return existing;
    const name = suggestedName || i18n.t("collab:invites.shared");
    const saved = await nr.notebook?.saveNotebook({ title: name });
    if (!saved?.ok || !saved.id) throw new Error(saved?.error || i18n.t("collab:projects.failed"));
    let subjectId = saved.id;
    if (surface === "notebook-page") {
      const page = await nr.notebook?.savePage({ notebookId: saved.id, title: name, blocks: [] });
      if (!page?.ok || !page.id) throw new Error(page?.error || i18n.t("collab:projects.failed"));
      subjectId = page.id;
    }
    const binding = { projectId, surface, subjectId, notebookId: saved.id, name, remoteSubjectId: "" };
    const bound = await nr.notebook?.setCollaborationBinding(binding, projectId);
    if (!bound?.ok) throw new Error(i18n.t("collab:projects.failed"));
    return binding;
  },
  async forget(binding) {
    const local = (await notebookBindings()).find((item) => item.projectId === binding.projectId);
    if (local) {
      if (surface === "notebook") await nr.notebook?.deleteNotebook(local.notebookId);
      else await nr.notebook?.deletePage(local.subjectId);
    }
    await nr.notebook?.setCollaborationBinding(null, binding.projectId);
  },
  onRemoved() { void import("@/store").then(({ useApp }) => { useApp.setState({ nbActiveId: null, nbActivePageId: null, nbPage: null, nbPages: [] }); void useApp.getState().nbLoadList(); }); },
  async open(binding) {
    const { useApp } = await import("@/store");
    const local = (await notebookBindings()).find((item) => item.projectId === binding.projectId);
    if (!local) return;
    if (local.sourcePath) {
      const opened = await nr.notebook?.openProject(local.sourcePath);
      if (!opened?.ok) throw new Error(opened?.error || i18n.t("collab:projects.failed"));
    }
    await useApp.getState().nbLoadList();
    useApp.setState({ tab: "notebook" });
    await useApp.getState().nbOpenNotebook(local.notebookId);
    if (surface === "notebook-page") await useApp.getState().nbOpenPage(local.subjectId);
  },
});
