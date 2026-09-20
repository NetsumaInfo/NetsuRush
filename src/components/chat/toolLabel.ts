// Le NOM HUMAIN d'un appel d'outil, dérivé du nom technique et de ses arguments.
//
// Vit à part parce que deux surfaces l'utilisent — la trace de l'agent et le menu contextuel — et
// parce qu'il ne coûte pas un seul token de modèle : c'est une table, pas une génération.
import type { TFunction } from "i18next";

// Verbe d'action lisible selon l'outil + ses arguments (passé/présent géré par l'appelant).
export function toolLabel(name: string, input: unknown, t: TFunction<"chat">): string {
  const a = (input || {}) as Record<string, any>;
  const q = (s: unknown) => (s ? t("tool.quoted", { value: String(s) }) : "");
  switch (name) {
    case "resolve_status": return t("tool.resolveStatus");
    case "list_media_pool": return t("tool.listMediaPool");
    case "search_clips": return t("tool.searchClips", { q: q(a.text) });
    case "index_clip": return t("tool.indexClip");
    case "detect_scenes": return t("tool.detectScenes");
    case "cached_scenes": return t("tool.cachedScenes");
    case "list_timelines": return t("tool.listTimelines");
    case "read_timeline": return t("tool.readTimeline");
    case "build_timeline": return t("tool.buildTimeline", { q: q(a.name) });
    case "cut_timeline": return t("tool.cutTimeline");
    case "probe_media": return t("tool.probeMedia");
    case "make_thumbnail": return t("tool.makeThumbnail");
    case "upscale_media": return t("tool.upscaleMedia");
    case "export_to_after_effects": return t("tool.exportAe");
    case "import_media": return t("tool.importMedia");
    case "board": return t("tool.board", { suffix: a.action ? ` · ${a.action}` : "" });
    case "resolve_app": return a.action === "switch_page" ? t("tool.page", { page: a.page || "" }).trim() : t("tool.resolveApp");
    case "resolve_viewer":
      return a.action === "grab_still" ? t("tool.grabStill")
        : a.action === "set_timecode" ? t("tool.setTimecode")
        : t("tool.viewer");
    case "resolve_timeline": {
      const m: Record<string, string> = {
        remove_audio: t("tool.removeAudio"), duplicate: t("tool.duplicate"),
        add_marker: t("tool.addMarker"), set_timecode: t("tool.setTimecode"),
        add_track: t("tool.addTrack"), delete_track: t("tool.deleteTrack"),
      };
      return m[a.action] || t("tool.timelineFallback", { action: a.action || "info" });
    }
    case "resolve_media_pool": return t("tool.mediaPool", { action: a.action || "list" });
    case "resolve_render": return t("tool.render", { action: a.action || "info" });
    case "resolve_timeline_item": return t("tool.timelineItem", { action: a.action || "info" });
    case "resolve_project": return t("tool.project", { action: a.action || "info" });
    case "resolve_call": return t("tool.resolveCall", { root: a.root || "" }).trim();
    default:
      // Les outils du serveur MCP de Blackmagic sont DÉCOUVERTS au démarrage :
      // les nommer un par un ici ferait une table qui vieillit à chaque version
      // de Resolve. Le préfixe suffit à les rendre lisibles.
      if (name.startsWith("bmd_")) return t("tool.bmd", { action: name.slice(4).replace(/_/g, " ") });
      return name;
  }
}
