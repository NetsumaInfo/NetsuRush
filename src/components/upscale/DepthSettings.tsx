import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { AudioTrack } from "@/lib/bridge";
import {
  DEPTH_MODELS, DEPTH_BITS, DEPTH_COLORS, type DepthSettings as DepthVals,
} from "./processShared";
import { Section, Row, Field, ProcessEncodingRows, ExportRows } from "./procSettingsParts";
import { ModelPicker, useModelOptions } from "./ModelPicker";
import { useTranslation } from "react-i18next";

interface Props {
  settings: DepthVals;
  patch: (p: Partial<DepthVals>) => void;
  audioTracks: AudioTrack[];
  outDir: string | null;
  chooseOut: () => Promise<string | null>;
  importBack: boolean;
  setImportBack: (b: boolean) => void;
  disabled?: boolean;
}

// Panneau de réglages du mode depth : modèle, profondeur 8/16-bit, colormap, puis codec/audio/export.
export function DepthSettings({ settings, patch, audioTracks, outDir, chooseOut, importBack, setImportBack, disabled }: Props) {
  const { t } = useTranslation("upscale");
  const models = useModelOptions(DEPTH_MODELS, settings.model);

  return (
    <div className="space-y-5">
      <Section>
        <ModelPicker items={models} value={settings.model} disabled={disabled}
          onChange={(id) => patch({ model: id as DepthVals["model"] })}
          empty={t("modelPicker.emptyDepth")} />
        <Row label={t("settings.rowDepth")}>
          <ToggleGroup value={[String(settings.bits)]} onValueChange={(v) => v[0] && patch({ bits: Number(v[0]) as DepthVals["bits"] })}>
            {DEPTH_BITS.map((b) => <ToggleGroupItem key={b.id} value={String(b.id)} disabled={disabled}>{b.label}</ToggleGroupItem>)}
          </ToggleGroup>
        </Row>

        <Row label={t("settings.rowColormap")}>
          <Field value={settings.colormap} disabled={disabled}
            onChange={(v) => patch({ colormap: v as DepthVals["colormap"] })}
            items={DEPTH_COLORS.map((c) => ({ value: c.id, label: t(`depthColor.${c.id}`, { defaultValue: c.label }) }))} />
        </Row>

        <Row label={t("settings.rowDeadFrames")}>
          <Toggle pressed={settings.dedup} onPressedChange={(on) => patch({ dedup: on })} disabled={disabled}>
            {settings.dedup ? t("settings.deadFramesRemove") : t("settings.deadFramesKeep")}
          </Toggle>
        </Row>
      </Section>

      <ProcessEncodingRows v={settings} patch={patch} audioTracks={audioTracks} disabled={disabled} />
      <ExportRows outDir={outDir} chooseOut={chooseOut} importBack={importBack} setImportBack={setImportBack} disabled={disabled} />
    </div>
  );
}
