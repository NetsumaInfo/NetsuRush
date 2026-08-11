// Rangées de réglages de l'archivage d'une collection. Extraites de FolderEditor : la section
// archivage porte déjà le format, le codec, l'audio et la synchro — y empiler l'upscale rendait le
// fichier illisible.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { HardDrive, Hourglass } from "lucide-react";
import { nr, type CollectionArchiveUpscale } from "@/lib/bridge";
import { Spinner } from "@/components/ui/spinner";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { UpscaleModelSettings } from "@/components/upscale/UpscaleModelSettings";
import { paneUpSettings } from "@/components/upscale/UpscalePane";

// Rangée d'un réglage d'archivage : libellé à largeur fixe + contrôle qui prend le reste.
export function ArchiveRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-[11px] text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

/**
 * État de la file d'archivage, par collection. UN seul abonnement pour toute la liste : un par carte
 * ouvrirait autant de flux SSE qu'il y a de dossiers.
 */
export function useArchiveQueue(): Map<string, "pending" | "running"> {
  const [busy, setBusy] = useState<Map<string, "pending" | "running">>(new Map());
  useEffect(() => {
    const apply = (s: { entries: { collId: string; status: string }[] }) => setBusy(new Map(
      s.entries.flatMap((e) => (e.status === "pending" || e.status === "running" ? [[e.collId, e.status] as const] : [])),
    ));
    void nr.collections?.queueState?.().then(apply);
    return nr.collections?.onQueue?.(apply);
  }, []);
  return busy;
}

/**
 * Pastille d'état d'archivage d'une carte de collection : sur disque, en attente, ou en cours. Sans
 * elle, un archivage différé travaillerait sans que rien ne le dise.
 */
export function ArchiveBadge({ archived, status }: { archived?: boolean; status?: "pending" | "running" }) {
  const { t } = useTranslation("collections");
  if (!status) return archived ? <HardDrive className="size-3 text-primary" /> : null;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>
        {status === "running"
          ? <Spinner className="size-3 text-primary" />
          : <Hourglass className="size-3 text-amber-500" />}
      </TooltipTrigger>
      <TooltipContent>{t(status === "running" ? "archive.queueRunning" : "archive.queuePending")}</TooltipContent>
    </Tooltip>
  );
}

/**
 * En-tête d'un volet repliable de l'archivage. Les réglages d'archivage sont trop nombreux pour
 * tenir dépliés ensemble : un seul volet reste ouvert à la fois, et le résumé à droite dit ce que
 * porte le volet fermé — sans lui, replier reviendrait à cacher. Le volet est le même que celui du
 * transfert NetsuBridge : un emballage de plus n'aurait fait que les laisser diverger.
 */
export { SettingsPane as ArchivePane } from "@/components/upscale/UpscalePane";

/** Bouton Activé/Désactivé de l'upscale — vit dans l'en-tête du volet, comme celui de l'archive. */
export function ArchiveUpscaleToggle({ value, onChange }: { value: CollectionArchiveUpscale | undefined; onChange: (patch: Partial<CollectionArchiveUpscale>) => void }) {
  const { t } = useTranslation("collections");
  const enabled = !!value?.enabled;
  return (
    <Toggle size="sm" variant="outline" pressed={enabled} onPressedChange={(on) => onChange({ enabled: on })}
      className="shrink-0 text-xs text-muted-foreground aria-pressed:border-primary aria-pressed:bg-primary/15 aria-pressed:text-primary">
      {enabled ? t("editor.on") : t("editor.off")}
    </Toggle>
  );
}

/** Résumé du volet upscale replié : traitement retenu + échelle. */
export { UpscaleSummary as ArchiveUpscaleSummary } from "@/components/upscale/UpscalePane";

/**
 * Réglages d'upscale à l'archivage : le MÊME bloc que le panneau Traitements (mode, moteur, modèle,
 * échelle, débruitage, nettoyage, réglages experts), plus le moment d'exécution, propre à l'archivage.
 */
export function ArchiveUpscaleRows({
  value, onChange,
}: {
  value: CollectionArchiveUpscale | undefined;
  onChange: (patch: Partial<CollectionArchiveUpscale>) => void;
}) {
  const { t } = useTranslation("collections");
  return (
    <div className="space-y-3">
      <UpscaleModelSettings settings={paneUpSettings(value)} patch={onChange} />
      {/* Quand travailler. Un upscale prend le GPU pour des minutes par plan : lancé au moment où
          l'on range un rush, il ralentit la lecture des aperçus et le montage dans l'hôte. */}
      <ArchiveRow label={t("archive.upscaleMode")}>
        <ToggleGroup className="flex-1" value={[value?.when ?? "idle"]}
          onValueChange={(v) => (v[0] === "now" || v[0] === "idle") && onChange({ when: v[0] })}>
          <ToggleGroupItem value="now" className="flex-1 text-xs">{t("archive.upscaleModeNow")}</ToggleGroupItem>
          <ToggleGroupItem value="idle" className="flex-1 text-xs">{t("archive.upscaleModeIdle")}</ToggleGroupItem>
        </ToggleGroup>
      </ArchiveRow>
    </div>
  );
}
