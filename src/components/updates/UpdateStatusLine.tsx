import { CheckCircle2, Download, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { UpdateInfo, UpdatePhase } from "@/store/updater";
import { cn } from "@/lib/utils";

// Clé i18n de l'état courant. Source UNIQUE : les Paramètres l'affichent en clair, l'écran
// d'installation la met en infobulle — deux formulations divergeraient.
export function updateStatusKey(phase: UpdatePhase) {
  if (phase === "checking") return "updates.checking";
  if (phase === "available") return "updates.available";
  if (phase === "downloading") return "updates.downloading";
  if (phase === "error") return "updates.failed";
  if (phase === "current") return "updates.current";
  return "updates.ready";
}

// Libellé + pastille de l'état de mise à jour.
export function UpdateStatusLine({ phase, info, className }: { phase: UpdatePhase; info: UpdateInfo | null; className?: string }) {
  const { t } = useTranslation("settings");
  const Icon = phase === "available" ? Download : phase === "error" ? TriangleAlert : CheckCircle2;
  const tone = phase === "available" ? "text-primary" : phase === "error" ? "text-destructive" : "text-[var(--color-ok)]";
  return (
    <div className={cn("flex min-w-0 items-center gap-2 text-sm", className)}>
      <Icon className={cn("size-4 shrink-0", tone)} />
      <span className="truncate">{t(updateStatusKey(phase), { version: info?.version })}</span>
    </div>
  );
}
