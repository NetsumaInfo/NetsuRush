// NetsuBoost sur hôte Adobe. Compose les sections des quatre phases et porte l'invariant de la
// première : le panneau CEP absent DÉGRADE la vue, il ne la bloque pas. Les données disque et la
// table des processus n'ont besoin de personne ; seules les purges, les réglages et les proxies
// exigent l'application ouverte avec son panneau.
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { PlugZap } from "lucide-react";
import { Card } from "@/components/ui/card";
import type { AdobeApp } from "@/lib/bridge";
import { useApp } from "@/store";
import { AdviceCards } from "../AdviceCards";
import { ADVICE_AEFT, ADVICE_PPRO } from "../optimizeShared";
import { BoostStatusCards } from "./BoostStatusCards";
import { BoostCacheSection } from "./BoostCacheSection";
import { BoostProcessSection } from "./BoostProcessSection";
import { BoostPurgeSection } from "./BoostPurgeSection";
import { BoostPrefsSection } from "./BoostPrefsSection";
import { BoostProxySection } from "./BoostProxySection";

export function BoostPanel({ app }: { app: AdobeApp }) {
  const { t } = useTranslation("optimize");
  const diag = useApp((s) => s.boostDiag[app] ?? null);
  const runBoostDiagnose = useApp((s) => s.runBoostDiagnose);
  const initBoostProgress = useApp((s) => s.initBoostProgress);

  // L'abonnement vit ici et non dans l'App : l'onglet est chargé en `lazy`, un écouteur permanent pour
  // une vue rarement ouverte serait du bruit.
  useEffect(() => initBoostProgress(), [initBoostProgress]);

  useEffect(() => {
    if (!diag) void runBoostDiagnose(app);
  }, [app, diag, runBoostDiagnose]);

  const refresh = () => runBoostDiagnose(app);

  return (
    <div className="space-y-5">
      {diag && !diag.panelConnected && (
        <Card className="block border-amber-500/30 p-4 text-sm">
          <div className="flex items-center gap-2 font-medium text-amber-500">
            <PlugZap className="h-4 w-4" /> {t("boost.degraded.title")}
          </div>
          <p className="mt-1 text-muted-foreground">{t("boost.degraded.body")}</p>
        </Card>
      )}

      <BoostStatusCards diag={diag} app={app} />
      <BoostCacheSection diag={diag} app={app} onChanged={refresh} />
      <BoostProcessSection onChanged={refresh} />
      <BoostPurgeSection diag={diag} app={app} onChanged={refresh} />
      <BoostPrefsSection diag={diag} app={app} />
      <BoostProxySection diag={diag} app={app} />
      <AdviceCards items={app === "ppro" ? ADVICE_PPRO : ADVICE_AEFT} />
    </div>
  );
}
