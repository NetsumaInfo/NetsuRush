// Ce qui reste à faire à la main : réglages de menu à l'exécution ou actions qui ne tiennent pas dans
// une valeur, donc hors de portée de PrefsSection (symptôme → où agir dans Resolve). Tout réglage
// qu'on sait LIRE est affiché à sa vraie valeur là-bas, jamais conseillé à l'aveugle ici.
import { useTranslation } from "react-i18next";
import { Lightbulb } from "lucide-react";
import { Card } from "@/components/ui/card";
import { ADVICE, type Advice } from "./optimizeShared";

// `items` par défaut = la liste Resolve : l'appel historique reste littéral, les hôtes Adobe passent
// la leur (les conseils ne se recoupent pas d'un hôte à l'autre).
export function AdviceCards({ items = ADVICE }: { items?: Advice[] }) {
  const { t } = useTranslation("optimize");
  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <Lightbulb className="h-4 w-4 text-primary" /> {t("advice.heading")}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {items.map((a) => (
          <Card key={a.id} className="block p-3.5">
            <div className="text-sm font-medium">{t(`advice.items.${a.id}.title`)}</div>
            <div className="mt-0.5 text-xs text-primary">{t(`advice.items.${a.id}.where`)}</div>
            <p className="mt-1.5 text-xs text-muted-foreground">{t(`advice.items.${a.id}.body`)}</p>
          </Card>
        ))}
      </div>
    </div>
  );
}
