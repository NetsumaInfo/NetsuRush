// Page « Nettoyage » : ce qui se vide TOUT SEUL, et l'entretien. Séparée de « Stockage » qui répond à
// une autre question — là c'est « combien et où », ici c'est « qu'est-ce que je délègue à l'app ».
// Réglages qu'on pose une fois, pas une vue qu'on consulte.
import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useApp } from "@/store";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { CachePolicies } from "./CachePolicies";
import { MaintenanceSection } from "./MaintenanceSection";

export function CleanupSettings() {
  const { settings, loadSettings, setPolicy, overview, loadCache } = useApp(
    useShallow((s) => ({
      settings: s.cacheSettings,
      loadSettings: s.loadCacheSettings,
      setPolicy: s.setCachePolicy,
      overview: s.cacheOverview,
      loadCache: s.loadCache,
    })),
  );

  useEffect(() => { void loadSettings(); }, [loadSettings]);
  // La maintenance lit la taille de la base dans l'aperçu : on le charge si l'utilisateur arrive
  // directement ici sans passer par Stockage.
  useEffect(() => { if (!overview) void loadCache(); }, [overview, loadCache]);

  if (!settings) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <CachePolicies settings={settings} onChange={(p) => void setPolicy(p)} />
      <Separator />
      <MaintenanceSection />
    </div>
  );
}
