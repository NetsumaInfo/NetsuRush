// Onglet NetsuBoost : aide à la performance de l'hôte actif.
//
// Deux corps, choisis par `activeHost`, jamais entrelacés : la panoplie Resolve (diagnostic, mémoire
// de session, réglages, GPU, processus, file de rendu, points de restauration, cache) et celle des
// hôtes Adobe (`boost/`). Les leviers n'ont presque rien en commun — Resolve se pilote par un pont
// Python, Premiere et After Effects par un panneau CEP et par le disque — et le chemin Resolve porte
// des pièges déjà corrigés (fermeture de projet silencieuse, préférences patchées fenêtre fermée)
// qu'on ne veut pas rouvrir en y glissant des conditions d'hôte.
//
// AUCUN levier ne crée de cache ni ne lance de rendu, des deux côtés : c'est une exigence produit.
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Gauge, RefreshCw, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApp } from "@/store";
import { isAdobeHost } from "@/lib/host";
import { DiagnosticCards } from "./DiagnosticCards";
import { GpuSection } from "./GpuSection";
import { ProcessSection } from "./ProcessSection";
import { StopTasksSection } from "./StopTasksSection";
import { MemorySection } from "./MemorySection";
import { PrefsSection } from "./PrefsSection";
import { SnapshotSection } from "./SnapshotSection";
import { CleanupSection } from "./CleanupSection";
import { AdviceCards } from "./AdviceCards";
import { NoiseSection } from "./NoiseSection";
import { WatchdogCard } from "./WatchdogCard";
import { BoostPanel } from "./boost/BoostPanel";

function PanelHeader({
  version,
  loading,
  onDiagnose,
}: {
  version?: string | null;
  loading: boolean;
  onDiagnose: () => void;
}) {
  const { t } = useTranslation("optimize");
  return (
    <header className="flex items-center justify-between">
      {/* La version est celle de l'hôte, pas du projet : elle vit ici, affichée une fois, plutôt que
          serrée dans la carte Projet où elle se faisait tronquer. */}
      <div className="flex items-baseline gap-2">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <Gauge className="h-5 w-5 text-primary" /> {t("panel.title")}
        </h1>
        {version && <span className="text-xs text-muted-foreground">{t("diagnostic.version", { version })}</span>}
      </div>
      <Button variant="outline" size="sm" onClick={onDiagnose} disabled={loading}>
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        {t("panel.diagnose")}
      </Button>
    </header>
  );
}

function ResolveBoost() {
  const { t } = useTranslation("optimize");
  const diag = useApp((s) => s.optDiag);
  const loading = useApp((s) => s.optDiagLoading);
  const error = useApp((s) => s.optDiagError);
  const runDiagnose = useApp((s) => s.runDiagnose);

  // Sonde Resolve à l'ouverture si on n'a pas encore de diagnostic.
  useEffect(() => {
    if (!diag) void runDiagnose();
  }, [diag, runDiagnose]);

  return (
    <>
      <PanelHeader
        version={diag?.connected ? diag.version : null}
        loading={loading}
        onDiagnose={() => runDiagnose()}
      />
      {error && <p className="text-sm text-destructive">{t("panel.diagError", { error })}</p>}
      <DiagnosticCards diag={diag} />
      <MemorySection diag={diag} onChanged={() => runDiagnose()} />
      <PrefsSection diag={diag} onChanged={() => runDiagnose()} />
      <GpuSection />
      <ProcessSection />
      <StopTasksSection diag={diag} onChanged={() => runDiagnose()} />
      <SnapshotSection diag={diag} />
      <CleanupSection cacheRoots={diag?.cacheRoots || []} />
      <AdviceCards />
    </>
  );
}

function AdobeBoost({ app }: { app: "ppro" | "aeft" }) {
  const { t } = useTranslation("optimize");
  const diag = useApp((s) => s.boostDiag[app] ?? null);
  const loading = useApp((s) => s.boostLoading);
  const error = useApp((s) => s.boostError);
  const runBoostDiagnose = useApp((s) => s.runBoostDiagnose);

  return (
    <>
      <PanelHeader
        version={diag?.live?.appVersion ?? null}
        loading={loading}
        onDiagnose={() => runBoostDiagnose(app)}
      />
      {error && <p className="text-sm text-destructive">{t("panel.diagError", { error })}</p>}
      <BoostPanel app={app} />
    </>
  );
}

export function OptimizePanel() {
  const activeHost = useApp((s) => s.activeHost);

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-6">
      {isAdobeHost(activeHost) ? <AdobeBoost app={activeHost} /> : <ResolveBoost />}
      {/* Le bruit d'arrière-plan et la pression mémoire sont des problèmes WINDOWS : ils ne dépendent
          pas de l'hôte, donc ces deux sections vivent en dehors de la bascule Resolve/Adobe. */}
      <WatchdogCard />
      <NoiseSection />
    </div>
  );
}
