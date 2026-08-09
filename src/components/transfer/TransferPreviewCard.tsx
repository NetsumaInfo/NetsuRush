// Aperçu de ce que NetsuRush a LU dans la timeline source, avant tout montage.
import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckCircle2, Type } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { basename } from "@/lib/utils";
import type { TransferPreview } from "@/lib/bridge";
import { previewDuration } from "./transferShared";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-sm font-medium tabular-nums text-foreground">{value}</div>
      <div className="truncate text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}

export function TransferPreviewCard({ preview, busy }: { preview: TransferPreview | null; busy: boolean }) {
  const { t } = useTranslation("transfer");

  if (busy && !preview) {
    return (
      <Card className="block p-4">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-9" />)}
        </div>
      </Card>
    );
  }
  if (!preview) return null;
  if (!preview.ok) {
    return (
      <Card className="block border-destructive/40 p-3 text-xs text-destructive">
        <AlertTriangle className="mr-1.5 inline size-3.5" /> {preview.error}
      </Card>
    );
  }

  const duration = previewDuration(preview);
  const missing = preview.missing ?? [];
  const mediaLess = preview.mediaLess ?? [];
  return (
    <Card className="block space-y-3 p-4">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label={t("preview.clips")} value={String(preview.clips ?? 0)} />
        <Stat label={t("preview.tracks")} value={`${preview.videoTracks ?? 0} V · ${preview.audioTracks ?? 0} A`} />
        <Stat label={t("preview.duration")} value={duration ?? "—"} />
        <Stat label={t("preview.fps")} value={preview.fps ? preview.fps.toFixed(3).replace(/\.?0+$/, "") : "—"} />
      </div>
      {preview.fidelity && (
        <div className="flex items-start gap-2 border-t border-border pt-3 text-xs">
          {preview.fidelity.faithful
            ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-[var(--color-ok)]" />
            : <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-400" />}
          <div className="min-w-0">
            <p className="font-medium text-foreground">
              {preview.fidelity.faithful ? t("preview.fidelityExact") : t("preview.fidelityLimited")}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {t("preview.fidelityCounts", {
                exact: preview.fidelity.exact,
                approximated: preview.fidelity.approximated,
                unsupported: preview.fidelity.unsupported + preview.fidelity.deferred + preview.fidelity.bakeAvailable,
              })}
            </p>
          </div>
        </div>
      )}
      {preview.animation?.available === false && (
        // Sans cet avertissement, un export refusé par Resolve rendrait un document SANS image clé,
        // et l'aperçu annoncerait sereinement « équivalence native » sur une timeline animée.
        <div className="flex items-start gap-2 border-t border-border pt-3 text-xs">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-400" />
          <p className="min-w-0 text-[11px] text-muted-foreground">{t("preview.animationUnavailable")}</p>
        </div>
      )}
      {missing.length > 0 && (
        <div className="space-y-1 border-t border-border pt-3">
          <p className="text-xs font-medium text-foreground">{t("preview.missing", { count: missing.length })}</p>
          <p className="truncate text-[11px] text-muted-foreground">{missing.slice(0, 4).map(basename).join(" · ")}</p>
        </div>
      )}
      {(preview.graphics ?? 0) > 0 && (
        // Un titre ne VOYAGE pas : il est recréé chez la cible. Le dire évite de chercher un
        // fichier qui n'a jamais existé, et prépare aux écarts de police.
        <div className="flex items-start gap-2 border-t border-border pt-3 text-xs">
          <Type className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <p className="min-w-0 text-[11px] text-muted-foreground">{t("preview.graphics", { count: preview.graphics })}</p>
        </div>
      )}
      {mediaLess.length > 0 && (
        // Un calque d'effet n'est pas un fichier PERDU : le dire ainsi laissait croire à un projet
        // cassé alors que tout est à sa place.
        <div className="space-y-1 border-t border-border pt-3">
          <p className="text-xs font-medium text-foreground">{t("preview.mediaLess", { count: mediaLess.length })}</p>
          <p className="truncate text-[11px] text-muted-foreground">{mediaLess.slice(0, 4).join(" · ")}</p>
        </div>
      )}
    </Card>
  );
}
