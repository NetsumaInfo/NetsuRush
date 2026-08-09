import { useTranslation } from "react-i18next";
import { siDiscord } from "simple-icons";
import { WifiOff } from "lucide-react";
import { BrandIcon } from "@/components/BrandIcon";
import { BetaBadge } from "@/components/BetaBadge";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { GateFrame } from "./GateFrame";
import { useDiscordLogin } from "./useDiscordLogin";

// Écran de connexion facultative : Discord ou poursuite locale sans compte.
export function LoginScreen({ offline = false, onSkip }: { offline?: boolean; onSkip: () => void }) {
  const { t } = useTranslation(["auth", "common"]);
  const { login, busy, error, reset } = useDiscordLogin();

  return (
    <GateFrame>
      <Card className="gate-in w-full items-center gap-6 p-8 text-center">
        <div className="relative">
          <BrandIcon className="size-16" />
          <BetaBadge className="absolute -bottom-1 left-1/2 -translate-x-1/2 bg-card" />
        </div>

        <h1 className="text-xl font-semibold tracking-tight text-foreground">{t("login.welcome")}</h1>

        {offline && (
          <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3 text-left text-xs text-muted-foreground">
            <WifiOff className="size-4 shrink-0" />
            <span>{t("login.offlineTooLong")}</span>
          </div>
        )}

        {error && (
          <div className="w-full break-words rounded-md border border-destructive/40 bg-destructive/10 p-3 text-left text-xs text-destructive">
            {error}
          </div>
        )}

        <Button
          onClick={busy ? reset : () => void login()}
          className="neon-btn w-full gap-2 bg-[#5865F2] text-white hover:bg-[#4752c4]"
        >
          <svg viewBox="0 0 24 24" className="size-4" aria-hidden="true">
            <path d={siDiscord.path} fill="currentColor" />
          </svg>
          {busy ? t("login.waitingDiscord") : t("login.signInDiscord")}
        </Button>

        {!busy && (
          <div className="w-full space-y-1.5">
            <Button variant="ghost" className="w-full" onClick={onSkip}>
              {t("login.skip")}
            </Button>
            <p className="text-xs text-muted-foreground">{t("login.skipHint")}</p>
          </div>
        )}

        {busy && (
          <button type="button" className="text-xs text-muted-foreground underline hover:text-foreground" onClick={reset}>
            {t("common:action.retry")}
          </button>
        )}
      </Card>
    </GateFrame>
  );
}
