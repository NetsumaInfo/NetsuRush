// Bandeau « module en bêta » : dit qu'une partie des fonctions manque encore, et demande des
// testeurs. Posé en tête des modules incomplets (NetsuDraft, NetsuTalk, NetsuBridge, NetsuPilot).
// Masquable, et la décision est retenue PAR MODULE : masquer l'avertissement de NetsuPilot ne dit
// rien de NetsuBridge, dont la maturité est différente.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FlaskConical, X } from "lucide-react";
import { DiscordIcon } from "@/components/DiscordIcon";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { DISCORD_INVITE } from "@/lib/community";
import { nr } from "@/lib/bridge";
import { cn } from "@/lib/utils";
import { useApp } from "@/store";

const storageKey = (module: string) => `nr.beta.notice.${module}`;

function dismissed(module: string): boolean {
  try {
    return localStorage.getItem(storageKey(module)) === "1";
  } catch {
    return false;
  }
}

export function BetaNotice({ module, className }: { module: string; className?: string }) {
  const { t } = useTranslation("common");
  const openConsole = useApp((s) => s.openConsole);
  const [hidden, setHidden] = useState(() => dismissed(module));

  if (hidden) return null;

  const dismiss = () => {
    try { localStorage.setItem(storageKey(module), "1"); } catch { /* stockage indisponible : masqué pour cette session seulement */ }
    setHidden(true);
  };

  return (
    <div
      className={cn(
        "flex shrink-0 items-start gap-3 rounded-lg border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/10 px-3.5 py-3",
        className,
      )}
    >
      <FlaskConical className="mt-0.5 size-4 shrink-0 text-[var(--color-warn)]" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-[var(--color-warn)]">{t("beta.title")}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t("beta.body")}</p>
        <div className="mt-2.5 flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => void nr.openExternal(DISCORD_INVITE)}>
            <DiscordIcon className="size-3.5 text-[#5865F2]" /> {t("beta.discord")}
          </Button>
          <Button variant="ghost" size="sm" onClick={openConsole}>{t("beta.feedback")}</Button>
        </div>
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button variant="ghost" size="icon" className="size-7 shrink-0" onClick={dismiss} aria-label={t("beta.dismiss")} />
          }
        >
          <X className="size-3.5" />
        </TooltipTrigger>
        <TooltipContent>{t("beta.dismiss")}</TooltipContent>
      </Tooltip>
    </div>
  );
}
