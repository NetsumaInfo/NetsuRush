// Ligne d'activité d'un appel d'outil — style « IDE » : une ligne compacte, discrète, repliable
// (chevron → arguments + résultat). Le libellé HUMAIN est dérivé du nom + arguments côté UI (zéro
// token modèle). État : en cours (spinner + liseré), ok (✓), erreur (✗). Pas d'anim JS.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ChevronRight, Check, X, Loader2, Dot, Copy, Braces, ChevronsUpDown } from "lucide-react";
import type { UiToolCall } from "@/store/chat";
import { cn } from "@/lib/utils";
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
} from "@/components/ui/context-menu";

// Copie une valeur d'appel d'outil : string brute telle quelle, sinon JSON indenté.
const asText = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));

const short = (v: unknown) => {
  try { const s = typeof v === "string" ? v : JSON.stringify(v); return s.length > 600 ? s.slice(0, 600) + "…" : s; }
  catch { return String(v); }
};

// Verbe d'action lisible selon l'outil + ses arguments (passé/présent géré par l'appelant).
function describe(name: string, input: unknown, t: TFunction<"chat">): string {
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
    default: return name;
  }
}

export function ToolCallCard({ tool }: { tool: UiToolCall }) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const state = !tool.done ? "run" : tool.ok === false ? "err" : "ok";
  const label = describe(tool.name, tool.input, t);

  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div className="animate-in fade-in-0 text-xs" />}>
      <button type="button"
        onClick={() => setOpen((o) => !o)}
        className="group flex w-full items-center gap-1.5 py-0.5 text-left text-muted-foreground transition-colors hover:text-foreground"
      >
        <span className="flex size-3.5 shrink-0 items-center justify-center">
          {state === "run" && <Loader2 className="size-3 animate-spin text-primary" />}
          {state === "ok" && <Check className="size-3 text-[var(--color-ok)]" />}
          {state === "err" && <X className="size-3 text-destructive" />}
        </span>
        <span className={cn("truncate", state === "run" && "text-foreground")}>{label}</span>
        {state === "run" && <span className="shrink-0 opacity-70">{t("toolcard.running")}<span className="animate-pulse">…</span></span>}
        {state === "err" && <span className="shrink-0 text-destructive/80">{t("toolcard.failed")}</span>}
        <ChevronRight className={cn("ml-auto size-3 shrink-0 opacity-0 transition-all group-hover:opacity-50", open && "rotate-90 opacity-50")} />
      </button>

      {/* liseré sous la ligne pendant l'exécution */}
      {state === "run" && (
        <div className="h-px w-full bg-primary/40" />
      )}

      {open && (
        <div className="mb-1 ml-5 mt-1 space-y-1.5 rounded-md border border-border bg-muted/40 px-2.5 py-2 animate-in fade-in-0">
          <div className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground"><Dot className="size-3" />{tool.name}</div>
          <div>
            <div className="mb-0.5 text-[10px] text-muted-foreground">{t("toolcard.arguments")}</div>
            <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] text-foreground/80">{short(tool.input)}</pre>
          </div>
          {tool.done && (
            <div>
              <div className="mb-0.5 text-[10px] text-muted-foreground">{t("toolcard.result")}</div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] text-foreground/80">{short(tool.result)}</pre>
            </div>
          )}
        </div>
      )}
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-48">
        <ContextMenuItem onClick={() => navigator.clipboard.writeText(tool.name)}>
          <Dot /> {t("toolcard.copyName")}
        </ContextMenuItem>
        {tool.input != null && (
          <ContextMenuItem onClick={() => navigator.clipboard.writeText(JSON.stringify(tool.input, null, 2))}>
            <Braces /> {t("toolcard.copyArgs")}
          </ContextMenuItem>
        )}
        {tool.done && tool.result != null && (
          <ContextMenuItem onClick={() => navigator.clipboard.writeText(asText(tool.result))}>
            <Copy /> {t("toolcard.copyResult")}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => setOpen((o) => !o)}>
          <ChevronsUpDown /> {open ? t("toolcard.collapse") : t("toolcard.expand")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
