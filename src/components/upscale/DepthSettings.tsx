import { Toggle } from "@/components/ui/toggle";
import type { AudioTrack } from "@/lib/bridge";
import {
  DEPTH_MODELS, DEPTH_COLORS, type DepthSettings as DepthVals,
} from "./processShared";
import { Section, Row, Field, ProcessEncodingRows, ExportRows } from "./procSettingsParts";
import { ProcessOutputRows, useOutputShape } from "./ProcessOutputRows";
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
  const { writesVideo } = useOutputShape(settings);

  return (
    <div className="space-y-5">
      <Section>
        <ModelPicker items={models} value={settings.model} disabled={disabled}
          onChange={(id) => patch({ model: id as DepthVals["model"] })}
          empty={t("modelPicker.emptyDepth")} />

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

      <ProcessOutputRows v={settings} patch={patch} disabled={disabled} />
      {writesVideo && <ProcessEncodingRows v={settings} patch={patch} audioTracks={audioTracks} disabled={disabled} />}
      <ExportRows outDir={outDir} chooseOut={chooseOut} importBack={importBack} setImportBack={setImportBack} disabled={disabled} v={settings} />
    </div>
  );
}
