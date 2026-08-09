import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Download, AlertTriangle } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useApp } from "@/store";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";

// Bandeau affiché quand les modèles de visage manquent : bouton de téléchargement inline (via le
// gestionnaire de modèles) + barre de progression. Se masque dès que les moteurs sont prêts.
export function FaceModelsBanner() {
  const { t } = useTranslation("search");
  const { faceEngines, faceModelsDl, checkFaceEngines, downloadFaceModels } = useApp(useShallow((s) => ({
    faceEngines: s.faceEngines, faceModelsDl: s.faceModelsDl,
    checkFaceEngines: s.checkFaceEngines, downloadFaceModels: s.downloadFaceModels,
  })));

  useEffect(() => { if (!faceEngines) void checkFaceEngines(); }, [faceEngines, checkFaceEngines]);

  if (!faceEngines || faceEngines.ready) return null;   // moteurs prêts (ou statut inconnu) → rien

  const dl = faceModelsDl;
  const stageLabel = dl?.stage === "install" ? t("faceModelsBanner.installing") : t("faceModelsBanner.downloading");

  return (
    <div className="space-y-2 rounded-lg border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/10 p-3">
      <div className="flex items-center gap-2 text-xs">
        <AlertTriangle className="h-4 w-4 text-[var(--color-warn)]" />
        <span className="font-medium">{t("faceModelsBanner.missing")}</span>
        <span className="text-muted-foreground">
          {faceEngines.real ? "" : t("faceModelsBanner.realLower")}{!faceEngines.real && !faceEngines.anime ? " + " : ""}{faceEngines.anime ? "" : t("faceModelsBanner.animeLower")}
        </span>
        <div className="flex-1" />
        <Button size="sm" disabled={!!dl} onClick={() => downloadFaceModels()}>
          {dl ? <Spinner className="h-3.5 w-3.5" /> : <Download className="h-3.5 w-3.5" />} {t("faceModelsBanner.download")}
        </Button>
      </div>
      {dl && (
        <div className="space-y-1">
          <Progress value={dl.pct} />
          <div className="text-[11px] text-muted-foreground">{stageLabel} {dl.pct != null ? `${Math.round(dl.pct)}%` : ""}</div>
        </div>
      )}
      {!dl && (
        <p className="text-[11px] text-muted-foreground">
          {t("faceModelsBanner.hint")}
        </p>
      )}
    </div>
  );
}
