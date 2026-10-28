import { NetsuIcon } from "@/components/ui/netsu-icon";
import { useTranslation } from "react-i18next";
import type { UpdateInfo, UpdatePhase } from "@/store/updater";
import { cn } from "@/lib/utils";

// Clé i18n de l'état courant. Source UNIQUE : les Paramètres l'affichent en clair, l'écran
// d'installation la met en infobulle — deux formulations divergeraient.
function updateStatusKey(phase: UpdatePhase) {
  if (phase === "checking") return "updates.checking";
  if (phase === "available") return "updates.available";
  if (phase === "downloading") return "updates.downloading";
  if (phase === "downloaded") return "updates.downloaded";
  if (phase === "installing") return "updates.installing";
  if (phase === "error") return "updates.failed";
  if (phase === "current") return "updates.current";
  return "updates.ready";
}

// Libellé + pastille de l'état de mise à jour.
export function UpdateStatusLine({ phase, info, className }: { phase: UpdatePhase; info: UpdateInfo | null; className?: string }) {
  const { t } = useTranslation("settings");
  const pending = phase === "available" || phase === "downloading" || phase === "downloaded" || phase === "installing";
  const icon = pending ? "download" : phase === "error" ? "warning" : "status-ok";
  const tone = pending ? "text-primary" : phase === "error" ? "text-destructive" : "text-[var(--color-ok)]";
  return (
    <div className={cn("flex min-w-0 items-center gap-2 text-sm", className)}>
      <NetsuIcon name={icon} className={cn("size-4 shrink-0", tone)} />
      <span className="truncate">{t(updateStatusKey(phase), { version: info?.version })}</span>
    </div>
  );
}
