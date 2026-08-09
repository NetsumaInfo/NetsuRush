import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import NumberFlow from "@number-flow/react";
import { Square } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

type Busy = { file: string; pct: number; done: number; total: number; phase: string; ts: number };

// Délai de silence au-delà duquel une phase est déclarée bloquée. Seule l'indexation rend compte
// plan par plan : la découpe (OmniShotCut ne dit rien pendant l'extraction), le chargement des poids
// et la préparation de l'index restent muets des dizaines de secondes. Les juger sur le même délai
// affichait « Bloqué » EN ROUGE au milieu d'un travail parfaitement normal.
const STALL_MS: Record<string, number> = { embed: 12_000 };
const STALL_QUIET_MS = 120_000;

// Progression d'indexation + détection de blocage.
// onCancel : demande d'arrêt (boucle stoppée au prochain clip) ; canceling : arrêt en cours.
export function IndexProgress({ busy, onCancel, canceling, kindLabel }: { busy: Busy; onCancel?: () => void; canceling?: boolean; kindLabel?: string }) {
  const { t } = useTranslation("search");
  // Tic régulier → réévalue le stall pendant l'indexation.
  const [, forceTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 1500);
    return () => clearInterval(id);
  }, []);
  const stalled = Date.now() - busy.ts > (STALL_MS[busy.phase] ?? STALL_QUIET_MS);

  // Pastille de phase : ce que fait vraiment l'indexation (ou "Bloqué · <phase>" si figé).
  const pname = busy.phase === "detect" ? t("indexProgress.phaseDetect") : busy.phase === "model" ? t("indexProgress.phaseModel")
    : busy.phase === "embed" ? t("indexProgress.phaseEmbed") : t("indexProgress.phasePrep");
  const ph = stalled
    ? { t: t("indexProgress.stalled", { phase: pname }), dot: "bg-destructive animate-pulse", cls: "text-destructive bg-destructive/15" }
    : busy.phase === "detect" ? { t: t("indexProgress.detecting"), dot: "bg-primary", cls: "text-primary bg-primary/15" }
    : busy.phase === "model" ? { t: t("indexProgress.loadingModel"), dot: "bg-primary animate-pulse", cls: "text-primary bg-primary/15" }
    : busy.phase === "embed" ? { t: t("indexProgress.indexing"), dot: "bg-primary", cls: "text-primary bg-primary/15" }
    : { t: t("indexProgress.preparing"), dot: "bg-muted-foreground/60", cls: "text-muted-foreground bg-muted" };

  return (
    <Card className="block p-3">
      <div className="mb-1.5 flex items-center justify-between gap-2 text-xs">
        <div className="flex min-w-0 items-center gap-2">
          {kindLabel && <span className="shrink-0 rounded-full bg-foreground/10 px-1.5 py-0.5 text-[10px] font-semibold">{kindLabel}</span>}
          <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium", ph.cls)}>
            <span className={cn("h-1.5 w-1.5 rounded-full", ph.dot)} />
            {ph.t}
          </span>
          <span className="truncate text-muted-foreground">{busy.file}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="tabular-nums text-muted-foreground"><NumberFlow value={busy.done + 1} />/<NumberFlow value={busy.total} /></span>
          {onCancel && (
            <Button
              size="sm" variant="ghost"
              onClick={onCancel} disabled={canceling}
              className="h-6 gap-1 px-2 text-[11px] text-muted-foreground hover:text-destructive"
            >
              {canceling ? <Spinner className="h-3 w-3" /> : <Square className="h-3 w-3 fill-current" />}
              {canceling ? t("indexProgress.stopping") : t("indexProgress.stop")}
            </Button>
          )}
        </div>
      </div>
      <Progress value={busy.pct} className={cn(stalled && "[&_[data-slot=progress-indicator]]:bg-red-400")} />
    </Card>
  );
}
