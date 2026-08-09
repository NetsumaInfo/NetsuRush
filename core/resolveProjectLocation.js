// @ts-check
// Capture/restauration de l'emplacement d'un projet Resolve dans le Project Manager.
// Un nom de projet seul ne suffit pas : deux projets peuvent porter le même nom et le projet courant
// peut vivre dans un sous-dossier ou une autre base de données.

const { t } = require('./i18n');

async function captureResolveProjectLocation(pm) {
  const folder = [];
  let database = null;
  try { database = await pm.GetCurrentDatabase(); } catch (_) {}
  if (!pm.GetCurrentFolder || !pm.GotoParentFolder || !pm.GotoRootFolder || !pm.OpenFolder) {
    return { ok: true, folder, database };
  }
  try {
    for (let i = 0; i < 64; i++) {
      const current = await pm.GetCurrentFolder();
      const moved = await pm.GotoParentFolder();
      if (!moved) break;
      if (current) folder.unshift(String(current));
    }
    if (!(await pm.GotoRootFolder())) return { ok: false, error: t('projectFolderRestoreFailed') };
    for (const name of folder) {
      if (!(await pm.OpenFolder(name))) return { ok: false, error: t('projectFolderRestoreFailed') };
    }
    return { ok: true, folder, database };
  } catch (e) {
    return { ok: false, error: `${t('projectFolderRestoreFailed')} : ${String(e && e.message || e)}` };
  }
}

async function openResolveProjectLocation(pm, folder, database) {
  try {
    if (database && pm.SetCurrentDatabase) {
      const current = pm.GetCurrentDatabase ? await pm.GetCurrentDatabase() : null;
      if (JSON.stringify(current || null) !== JSON.stringify(database)) {
        if (!(await pm.SetCurrentDatabase(database))) return { ok: false, error: t('projectDatabaseOpenFailed') };
      }
    }
    if (pm.GotoRootFolder && !(await pm.GotoRootFolder())) {
      return { ok: false, error: t('projectFolderOpenFailed') };
    }
    for (const name of folder || []) {
      if (!pm.OpenFolder || !(await pm.OpenFolder(name))) {
        return { ok: false, error: `${t('projectFolderOpenFailed')} : ${name}` };
      }
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `${t('projectFolderOpenFailed')} : ${String(e && e.message || e)}` };
  }
}

module.exports = { captureResolveProjectLocation, openResolveProjectLocation };
