import { useTranslation } from "react-i18next";
import { Hourglass } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { GateFrame } from "./GateFrame";
import { authClient } from "@/lib/authClient";
import { clearAuthStamp } from "@/lib/offlineAuth";

// Affiché seulement si l'accès est REFUSÉ (mode allowlist : OPEN_BETA=false et rôle « pending »).
// En beta ouverte (P0) cet écran ne se montre jamais.
export function NoAccessScreen({ role, onSkip }: { role: string | null; onSkip: () => void }) {
  const { t } = useTranslation("auth");
  async function signOut() {
    clearAuthStamp();
    try {
      await authClient.signOut();
    } catch {
      /* best-effort */
    }
  }

  return (
    <GateFrame>
      <Card className="gate-in w-full items-center gap-6 p-8 text-center">
        <div className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <Hourglass className="size-6" />
        </div>
        <div className="space-y-1.5">
          <h1 className="text-lg font-semibold tracking-tight">{t("noAccess.title")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("noAccess.desc", { roleSuffix: role ? ` (${role})` : "" })}
          </p>
        </div>
        <Button variant="outline" className="w-full" onClick={() => void signOut()}>
          {t("noAccess.signOut")}
        </Button>
        <Button variant="ghost" className="w-full" onClick={onSkip}>
          {t("login.skip")}
        </Button>
      </Card>
    </GateFrame>
  );
}
