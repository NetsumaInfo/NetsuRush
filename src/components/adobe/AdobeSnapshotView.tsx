// Vue du snapshot projet poussé par le panneau CEP : rushs + séquences/comps (clips en secondes).
import { Copy, Clock, Send } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { basename } from "@/lib/utils";
import { useApp } from "@/store";
import type { AdobeClip, AdobeSequence, AdobeSnapshot } from "@/lib/bridge";

const copy = (s: string) => { void navigator.clipboard.writeText(s); };

/** s → "h:mm:ss.cc" court (les fps voyagent dans la séquence si besoin de frames). */
function fmtSec(s: number | null): string {
  if (s === null || !isFinite(s)) return "—";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(2).padStart(5, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

// Ligne de plan de séquence : clic droit = copie chemin source + timecodes (lecture seule).
function ClipRow({ t, c }: { t: { kind: "video" | "audio"; index: number }; c: AdobeClip }) {
  const { t: tr } = useTranslation("adobe");
  const timecodes = tr("snapshot.timecodes", {
    tlStart: fmtSec(c.tlStart), tlEnd: fmtSec(c.tlEnd), srcIn: fmtSec(c.srcIn), srcOut: fmtSec(c.srcOut),
  });
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<tr className="border-t border-border/60" />}>
        <td className="px-3 py-1 text-muted-foreground">{t.kind === "video" ? "V" : "A"}{t.index}</td>
        <Tooltip>
          <TooltipTrigger render={<td className="max-w-48 truncate px-3 py-1">{c.name || (c.path ? basename(c.path) : "—")}</td>} />
          <TooltipContent>{c.path ?? c.name}</TooltipContent>
        </Tooltip>
        <td className="px-3 py-1 tabular-nums">{fmtSec(c.tlStart)} → {fmtSec(c.tlEnd)}</td>
        <td className="px-3 py-1 tabular-nums text-muted-foreground">{fmtSec(c.srcIn)} → {fmtSec(c.srcOut)}</td>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-48">
        {c.path && <ContextMenuItem onClick={() => copy(c.path!)}><Copy /> {tr("snapshot.copySourcePath")}</ContextMenuItem>}
        <ContextMenuItem onClick={() => copy(timecodes)}><Clock /> {tr("snapshot.copyTimecodes")}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// Ligne de rush : clic droit = copie nom/chemin + envoi vers NetsuLab (bac de traitements).
function RushRow({ r }: { r: AdobeSnapshot["rushes"][number] }) {
  const { t } = useTranslation("adobe");
  const nlAddSources = useApp((s) => s.nlAddSources);
  const setTab = useApp((s) => s.setTab);
  const label = r.name || basename(r.path);
  const toNetsulab = () => { nlAddSources([{ name: label, path: r.path }]); setTab("upscale"); };
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div className="flex items-center gap-2 text-[11px]" />}>
        <Tooltip>
          <TooltipTrigger render={<span className="truncate">{label}</span>} />
          <TooltipContent>{r.path}</TooltipContent>
        </Tooltip>
        <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
          {r.fps ? `${Math.round(r.fps * 1000) / 1000} i/s` : ""}
          {r.w && r.h ? ` · ${r.w}×${r.h}` : ""}
          {r.dur ? ` · ${fmtSec(r.dur)}` : ""}
        </span>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-48">
        <ContextMenuItem onClick={() => copy(label)}><Copy /> {t("snapshot.copyName")}</ContextMenuItem>
        {r.path && <ContextMenuItem onClick={() => copy(r.path)}><Copy /> {t("snapshot.copyPath")}</ContextMenuItem>}
        {r.path && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={toNetsulab}><Send /> {t("snapshot.sendToNetsulab")}</ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function SequenceBlock({ seq }: { seq: AdobeSequence }) {
  const { t } = useTranslation("adobe");
  const nClips = seq.tracks.reduce((n, t) => n + t.clips.length, 0);
  return (
    <div className="rounded-md border border-border">
      <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-2">
        <span className="text-xs font-semibold">{seq.name}</span>
        <span className="text-[11px] text-muted-foreground">
          {seq.fps ? `${Math.round(seq.fps * 1000) / 1000} i/s` : ""}
          {seq.w && seq.h ? ` · ${seq.w}×${seq.h}` : ""}
        </span>
        <Badge variant="outline" className="ml-auto text-[10px]">{t("snapshot.shotsCount", { n: nClips })}</Badge>
      </div>
      <div className="max-h-64 overflow-y-auto">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="px-3 py-1 font-medium">{t("snapshot.thTrack")}</th>
              <th className="px-3 py-1 font-medium">{t("snapshot.thShot")}</th>
              <th className="px-3 py-1 font-medium">{t("snapshot.thTimeline")}</th>
              <th className="px-3 py-1 font-medium">{t("snapshot.thSource")}</th>
            </tr>
          </thead>
          <tbody>
            {seq.tracks.flatMap((t) =>
              t.clips.map((c, i) => <ClipRow key={`${t.kind}${t.index}-${i}`} t={t} c={c} />),
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function AdobeSnapshotView({ snap }: { snap: AdobeSnapshot | null | undefined }) {
  const { t } = useTranslation("adobe");
  if (!snap) {
    return (
      <Card className="block p-6 text-center text-sm text-muted-foreground">
        {t("snapshot.noProject")}
      </Card>
    );
  }
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{snap.project}</span>
        <span>· v{snap.appVersion}</span>
        <span>· {t("snapshot.receivedAt", { time: new Date(snap.at).toLocaleTimeString() })}</span>
      </div>

      <Card className="block p-4">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-xs font-semibold text-muted-foreground">{t("snapshot.rushes")}</span>
          <Badge variant="outline" className="text-[10px]">{snap.rushes.length}</Badge>
        </div>
        {snap.rushes.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("snapshot.noFileMedia")}</p>
        ) : (
          <div className="max-h-48 space-y-0.5 overflow-y-auto">
            {snap.rushes.map((r) => <RushRow key={r.path || r.name} r={r} />)}
          </div>
        )}
      </Card>

      <div className="space-y-3">
        {snap.sequences.map((seq) => (
          <SequenceBlock key={`${seq.name}-${seq.fps ?? ""}-${seq.w ?? ""}x${seq.h ?? ""}`} seq={seq} />
        ))}
      </div>
    </div>
  );
}
