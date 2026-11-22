// Hook partagé du flux « Télécharger » : applique le PROFIL ACTIF à une liste de plans.
// Utilisé par le Derush (CutStudio) et la Recherche (SearchResults). Choisit le dossier de
// sortie, appelle nr.exportClips, suit la progression SSE, annonce la réussite en pastille et garde
// l'erreur dans le store (les vues l'affichent tant qu'elle n'est pas levée).
import { useEffect } from "react";
import i18n from "@/i18n";
import { useApp } from "@/store";
import { nr, type ExportClipInput } from "@/lib/bridge";
import type { ExportProfile } from "@/features/export/profiles";
import { getActiveExportProfile, getExportProfileIssues } from "@/features/export/profiles";
import { lastExportDir, rememberExportDir } from "@/features/export/lastDir";
import { dirname, joinPath } from "@/lib/utils";
import { toast } from "@/components/ui/toast";

interface DownloadArgs {
  clips: ExportClipInput[];
  baseName: string;
  merge?: boolean;
  // Force un profil précis (ex. bouton de vignette) ; défaut = profil actif.
  profileId?: string;
}

interface DownloadResult {
  ok: boolean;
  error?: string;
}

// Nom proposé dans le dialogue : résolu par le CORE, avec le plan réel en contexte — donc le même
// nom que le fichier aurait porté sans dialogue. Le core injoignable ne doit pas bloquer l'export :
// on retombe alors sur « <base>.<conteneur> ».
async function suggestName(profile: ExportProfile, baseName: string, clips: ExportClipInput[], merge: boolean): Promise<string> {
  try {
    // A busy core (thumbnail or proxy work queued) must not hold the dialog back: after a short wait
    // the click opens it with the fallback name.
    const preview = await Promise.race([
      nr.exportPreviewName({ profile, baseName, clip: clips[0], total: clips.length, index: 1 }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 800)),
    ]);
    if (!preview) throw new Error("timeout");
    const name = merge ? preview.merged : preview.name;
    if (name) return name;
  } catch { /* repli ci-dessous */ }
  return `${baseName || "export"}.${profile.container}`;
}

// Covers the save dialog too, before `exportBusy` is set: module-level because every button mounts its
// own copy of the hook.
let downloading = false;

export function useExport() {
  const profiles = useApp((s) => s.exportProfiles);
  const activeId = useApp((s) => s.activeExportProfileId);
  const busy = useApp((s) => s.exportBusy);
  const progress = useApp((s) => s.exportProgress);
  const setExportBusy = useApp((s) => s.setExportBusy);
  const setExportProgress = useApp((s) => s.setExportProgress);
  const setExportError = useApp((s) => s.setExportError);

  useEffect(() => nr.onExportProgress((p) => setExportProgress(p.pct)), [setExportProgress]);

  async function download(args: DownloadArgs): Promise<DownloadResult> {
    // Lock read from the store, not from this render: a double click fired before React re-rendered
    // used to open two dialogs and start two exports.
    if (!args.clips.length || downloading || useApp.getState().exportBusy) return { ok: false };
    downloading = true;
    try {
      return await run(args);
    } catch (e) {
      // A core that drops mid-export must not leave the buttons disabled for the rest of the session.
      const message = e instanceof Error && e.message ? e.message : i18n.t("export:notice.exportFailed");
      setExportError(message);
      return { ok: false, error: message };
    } finally {
      downloading = false;
      setExportBusy(null);
    }
  }

  async function run({ clips, baseName, merge, profileId }: DownloadArgs): Promise<DownloadResult> {
    const profile = getActiveExportProfile(profiles, profileId ?? activeId);
    const shouldMerge = (merge || profile.mergeEnabled) && clips.length > 1;

    // Garde-fou : un profil incomplet ne part pas (le bouton est déjà désactivé, mais l'export est
    // aussi appelé par les boutons de vignette → la règle vit ici, pas seulement dans le rendu).
    const issues = getExportProfileIssues(profile);
    if (issues.length) {
      const message = i18n.t("export:issue.profileIncomplete", { issue: issues[0].message });
      setExportError(message);
      return { ok: false, error: message };
    }

    // UN seul fichier en sortie (un plan, ou une fusion) → dialogue « enregistrer sous » : le nom
    // proposé est celui que le gabarit du profil produirait, et l'utilisateur pose le fichier
    // exactement où il veut. Plusieurs fichiers → sélecteur de DOSSIER, un nom par fichier n'aurait
    // pas de sens. Les deux s'ouvrent sur le dernier dossier utilisé.
    const single = shouldMerge || clips.length === 1;
    const previous = lastExportDir();
    let dir = "";
    let savePath: string | undefined;
    if (single) {
      const suggested = await suggestName(profile, baseName, clips, shouldMerge);
      const chosen = await nr.saveFile(joinPath(previous, suggested), [profile.container]);
      if (chosen) { savePath = chosen; dir = dirname(chosen); }
    } else {
      dir = (await nr.chooseDir(previous)) || "";
    }
    // Annulation du sélecteur : la destination est OBLIGATOIRE → on le DIT. Sans ça le clic ne
    // produisait rien du tout (ni fichier, ni message) et l'export passait pour cassé.
    if (!dir) {
      const message = i18n.t("export:notice.cancelled");
      setExportError(message);
      return { ok: false, error: message };
    }
    rememberExportDir(dir);

    // Tâche lourde → propose de fermer le logiciel de montage (libérer RAM/GPU).
    useApp.getState().offerCloseForRam();
    setExportError(null);
    setExportProgress(0);
    setExportBusy(shouldMerge ? i18n.t("export:notice.merging") : i18n.t("export:notice.exporting"));

    const r = await nr.exportClips({ clips, dir, savePath, baseName, profile, merge: shouldMerge });
    if (r.ok) {
      const n = r.files?.length ?? 0;
      const failed = r.failed ? i18n.t("export:notice.failedSuffix", { count: r.failed }) : "";
      toast.ok(i18n.t("export:notice.exported", { count: n, profile: profile.name, dir, failed }));
      return { ok: true };
    }
    setExportError(r.error || i18n.t("export:notice.exportFailed"));
    return { ok: false, error: r.error };
  }

  return { download, busy, progress };
}
