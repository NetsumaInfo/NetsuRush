// Panneau latéral DROIT du détail collection — MÊME intégration que le lecteur du Découpage
// (CutStudio) : lecteur MONTÉ EN PERMANENCE dans une Card aspect-video, largeur RÉGLABLE (poignée
// pilotée par le parent), puis identité du plan + bloc d'export. Pas d'en-tête texte : la fermeture
// se fait par le bouton « Lecteur » de la barre du haut, comme dans le Découpage.
//
// Le lecteur ne se démonte JAMAIS entre deux plans (`src` passe simplement de null à l'URL du
// proxy) : le remonter redéclenchait un squelette puis une lecture qui repartait toute seule à
// chaque changement de plan. Sans plan ouvert, `ScenePlayer` rend son état vide — exactement ce
// que montre le Découpage tant qu'aucun plan n'a été ouvert.
//
// Le bloc d'export est le MÊME que celui du Découpage (piste audio, timeline visée, mode d'insertion,
// bouton de profil, progression) : les deux vues lisent et écrivent le profil ACTIF, donc les réglages
// ne peuvent pas diverger d'un module à l'autre.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { type CollectionShot, type ExportClipInput } from "@/lib/bridge";
import { useApp } from "@/store";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { ScenePlayer, type ScenePlayerApi } from "@/components/player/ScenePlayer";
import { ExportButton } from "@/components/export/ExportButton";
import { ExportAudioSelect } from "@/components/export/ExportAudioSelect";
import { TimelineInsertionSelect } from "@/components/rushes/TimelineInsertionSelect";
import { fmt } from "@/components/rushes/cutStudioShared";
import { getActiveExportProfile } from "@/features/export/profiles";

// Proxy HEVC de la portée exacte du plan ouvert. Résolu ici, servi au lecteur : la valeur nulle
// (aucun plan, ou encode en cours) est un état normal du lecteur, pas un composant à démonter.
function useShotProxy(
  shot: CollectionShot | null,
  getProxy: (path: string, inSec: number, outSec: number, prio: "high" | "low") => Promise<string | null>,
): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const path = shot?.path, inSec = shot?.in, outSec = shot?.out;
  useEffect(() => {
    setUrl(null);
    if (path == null || inSec == null || outSec == null) return;
    let alive = true;
    getProxy(path, inSec, outSec, "high").then((u) => { if (alive) setUrl(u); }).catch(() => {});
    return () => { alive = false; };
  }, [path, inSec, outSec, getProxy]);
  return url;
}

export function CollectionSidePanel({
  width, narrow, shot, position, total, name, exportClips, onTimelineImport, getProxy, playerApi,
}: {
  width: number;
  /** Vue étroite (panneau CEP, fenêtre épinglée) : le lecteur passe en tête, pleine largeur. */
  narrow: boolean;
  shot: CollectionShot | null;
  /** Rang du plan ouvert dans la grille affichée (1-based, 0 = aucun) et total — repère « n/N ». */
  position: number;
  total: number;
  /** Nom de la collection : base des fichiers exportés. */
  name: string;
  exportClips: () => ExportClipInput[];
  onTimelineImport: () => void;
  getProxy: (path: string, inSec: number, outSec: number, prio: "high" | "low") => Promise<string | null>;
  playerApi: React.MutableRefObject<ScenePlayerApi | null>;
}) {
  const { t } = useTranslation("collections");
  const profiles = useApp((s) => s.exportProfiles);
  const activeProfileId = useApp((s) => s.activeExportProfileId);
  const exportBusy = useApp((s) => s.exportBusy);
  const exportProgress = useApp((s) => s.exportProgress);
  const activeProfile = getActiveExportProfile(profiles, activeProfileId);
  const url = useShotProxy(shot, getProxy);

  return (
    <aside style={narrow ? undefined : { width }}
      className={"flex min-h-0 flex-col gap-3 overflow-y-auto overflow-x-hidden py-3 "
        + (narrow ? "max-h-[55%] w-full pl-0" : "h-full shrink-0 pl-5")}>
      <Card className="shrink-0 overflow-hidden p-0">
        <div className="relative aspect-video">
          {/* shortcuts={false} : la vue pilote déjà le clavier (Ctrl+Z = annuler un retrait). */}
          <ScenePlayer src={url} loop apiRef={playerApi} shortcuts={false} />
          {shot && total > 0 && (
            <div className="absolute left-2 top-2 rounded nr-chip px-2 py-0.5 text-xs tabular-nums">{position}/{total}</div>
          )}
        </div>
      </Card>

      {/* Identité du plan ouvert : nom et durée du plan qu'on est en train de regarder. */}
      {shot && (
        <div className="min-w-0 px-0.5">
          <div className="truncate text-xs font-medium leading-tight">{shot.name}</div>
          <div className="text-[11px] leading-tight tabular-nums text-muted-foreground">{fmt(shot.out - shot.in)}</div>
        </div>
      )}

      <div className="space-y-2">
        <div className="px-0.5 pt-1 text-[11px] font-semibold text-muted-foreground">{t("sidePanel.export")}</div>
        {/* Les plans d'une collection viennent de fichiers différents : aucune source à sonder ici, le
            menu propose donc les pistes par numéro et par langue (résolues par fichier à l'export). */}
        <ExportAudioSelect profile={activeProfile} size="sm" />
        {/* La timeline VISÉE reste dans la barre du haut : elle doit rester réglable panneau fermé. */}
        <TimelineInsertionSelect className="w-full min-w-0" />
        <ExportButton clips={exportClips} baseName={name} onTimelineImport={onTimelineImport} className="w-full" />
        {exportBusy && <Progress value={exportProgress} />}
      </div>
    </aside>
  );
}
