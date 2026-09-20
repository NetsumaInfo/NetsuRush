// « Traitement » d'un profil d'export : le plan est agrandi, interpolé ou converti en depth map
// PENDANT l'export, par le moteur du panneau Traitements. Ce fichier n'ajoute que l'emballage —
// interrupteur, type d'op, résumé du volet fermé — les réglages eux-mêmes sont les MÊMES composants
// que le hub (aucune copie : un réglage ajouté là-bas apparaît ici).
//
// DEUX volets, exécutés dans l'ordre : « Traitement 1 » puis « Traitement 2 ». Un même traitement ne
// peut pas être choisi deux fois (le second sélecteur ne propose plus l'op du premier) : le repasser
// paierait le GPU deux fois pour ce qu'une passe a déjà fait.
//
// Les réglages de chaque op sont gardés séparément : deux ops ont un `model` qui ne veut pas dire la
// même chose, et changer de type ne doit pas jeter ce que l'autre avait réglé.
import { useTranslation } from "react-i18next";
import { Toggle } from "@/components/ui/toggle";
import { SettingsPane } from "@/components/upscale/UpscalePane";
import { Row, Field } from "@/components/upscale/procSettingsParts";
import { UpscaleModelSettings } from "@/components/upscale/UpscaleModelSettings";
import { InterpModelSettings, DepthModelSettings } from "@/components/upscale/ProcessModelSettings";
import { DEFAULT_SETTINGS } from "@/components/upscale/upscaleShared";
import { DEFAULT_INTERP, DEFAULT_DEPTH } from "@/components/upscale/processShared";
import {
  EXPORT_PROCESS_KINDS, EXPORT_PROCESS_MAX_STEPS, exportProcessKinds, exportProcessStepLabel,
  type ExportProcess, type ExportProcessKind,
} from "@/features/export/profiles";

export function ExportProcessPane({ value, onChange, open, onOpen, disabled }: {
  value: ExportProcess | undefined;
  onChange: (patch: ExportProcess) => void;
  // Volet déplié, par rang (null = tous fermés). Piloté par l'écran hôte : un seul volet ouvert à la
  // fois dans un panneau qui en compte d'autres.
  open: number | null;
  onOpen: (index: number | null) => void;
  disabled?: boolean;
}) {
  const enabled = !!value?.enabled;
  const kinds = exportProcessKinds(value);

  // Le second volet n'apparaît qu'une fois le premier allumé : un « traitement 2 » sans traitement 1
  // n'a pas de rang, et l'ordre est ce que la chaîne exécute.
  const steps = enabled ? [0, 1] : [0];

  return (
    <div className="flex flex-col gap-2">
      {steps.map((index) => (
        <ProcessStepPane
          key={index}
          index={index}
          value={value}
          kinds={kinds}
          paneEnabled={index === 0 ? enabled : kinds.length > index}
          open={open === index}
          onOpen={(on) => onOpen(on ? index : null)}
          disabled={disabled}
          onChange={onChange}
        />
      ))}
    </div>
  );
}

function ProcessStepPane({ index, value, kinds, paneEnabled, open, onOpen, disabled, onChange }: {
  index: number;
  value: ExportProcess | undefined;
  kinds: ExportProcessKind[];
  paneEnabled: boolean;
  open: boolean;
  onOpen: (open: boolean) => void;
  disabled?: boolean;
  onChange: (patch: ExportProcess) => void;
}) {
  const { t } = useTranslation("export");
  const { t: tOps } = useTranslation("upscale");
  const kind = kinds[index] ?? EXPORT_PROCESS_KINDS.find((k) => !kinds.includes(k)) ?? EXPORT_PROCESS_KINDS[0];

  // Réglages effectifs : les défauts du hub, écrasés par ce que le profil a retenu. Seul le patch
  // est stocké — un profil ne recopie pas la table de défauts du panneau Traitements.
  const upscale = { ...DEFAULT_SETTINGS, ...value?.upscale };
  const interpolate = { ...DEFAULT_INTERP, ...value?.interpolate };
  const depth = { ...DEFAULT_DEPTH, ...value?.depth };
  const patchOp = <K extends ExportProcessKind>(k: K, p: Partial<ExportProcess[K]>) =>
    onChange({ [k]: { ...(value?.[k] ?? {}), ...p } } as ExportProcess);

  // Allumer le 1er volet allume le traitement ; le 2e ajoute (ou retire) une passe à la chaîne.
  const toggle = (on: boolean) => {
    if (index === 0) return onChange({ enabled: on });
    onChange({ kinds: on ? [...kinds, kind].slice(0, EXPORT_PROCESS_MAX_STEPS) : kinds.slice(0, index) });
  };
  const setKind = (k: ExportProcessKind) => {
    const next = [...kinds];
    next[index] = k;
    // La même op deux fois n'a pas de sens : l'autre passe reprend celle qu'on vient de libérer.
    const clash = next.findIndex((v, i) => i !== index && v === k);
    if (clash >= 0) next[clash] = kinds[index];
    onChange({ kinds: next });
  };

  return (
    <SettingsPane
      label={t("editor.processStep", { n: index + 1 })}
      summary={open || !paneEnabled ? null : exportProcessStepLabel(value, kind)}
      open={open && paneEnabled}
      onToggle={() => onOpen(!open)}
      control={
        <Toggle size="sm" variant="outline" pressed={paneEnabled} disabled={disabled}
          onPressedChange={toggle}
          className="shrink-0 text-xs text-muted-foreground aria-pressed:border-primary aria-pressed:bg-primary/15 aria-pressed:text-primary">
          {paneEnabled ? t("toggle.yes") : t("toggle.no")}
        </Toggle>
      }
    >
      <Row label={t("editor.processKind")}>
        <Field
          value={kind}
          disabled={disabled}
          onChange={(v) => setKind(v as ExportProcessKind)}
          items={EXPORT_PROCESS_KINDS.map((k) => ({ value: k, label: tOps(`ops.${k}`) }))}
        />
      </Row>
      {kind === "upscale" && <UpscaleModelSettings settings={upscale} patch={(p) => patchOp("upscale", p)} disabled={disabled} />}
      {kind === "interpolate" && <InterpModelSettings settings={interpolate} patch={(p) => patchOp("interpolate", p)} disabled={disabled} />}
      {kind === "depth" && <DepthModelSettings settings={depth} patch={(p) => patchOp("depth", p)} disabled={disabled} />}
    </SettingsPane>
  );
}
