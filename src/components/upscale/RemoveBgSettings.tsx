import { Toggle } from "@/components/ui/toggle";
import { Slider } from "@/components/ui/slider";
import { SEG_MODELS, type SegSettings as SegVals } from "./processShared";
import { Section, Row, ProcessEncodingRows, ExportRows } from "./procSettingsParts";
import { ProcessOutputRows, useOutputShape } from "./ProcessOutputRows";
import { ModelPicker, useModelOptions } from "./ModelPicker";
import { useTranslation } from "react-i18next";
import type { AudioTrack } from "@/lib/bridge";
import type { ExportCodec } from "@/features/export/profiles";

const ALPHA_EXPORT_CODECS = new Set<ExportCodec>(["prores_4444", "vp9"]);

interface Props {
  settings: SegVals;
  patch: (p: Partial<SegVals>) => void;
  audioTracks: AudioTrack[];
  outDir: string | null;
  chooseOut: () => Promise<string | null>;
  importBack: boolean;
  setImportBack: (b: boolean) => void;
  disabled?: boolean;
}

// Panneau de réglages du mode removeBG (détourage) : modèle + format alpha + export.
// Pas de codec/audio (sortie alpha dédiée : ProRes 4444 / séquence PNG / WebM VP9).
export function RemoveBgSettings({ settings, patch, audioTracks, outDir, chooseOut, importBack, setImportBack, disabled }: Props) {
  const { t } = useTranslation("upscale");
  const models = useModelOptions(SEG_MODELS, settings.model);
  const { writesVideo } = useOutputShape(settings);
  const sliderRow = (label: string, key: "despeckle" | "edgeSmoothing" | "edgeOffset",
    min: number, max: number, step: number, unit = "") => (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{label}</span>
        <span className="tabular-nums">{settings[key]}{unit}</span>
      </div>
      <Slider min={min} max={max} step={step} value={[settings[key]]} disabled={disabled}
        onValueChange={(v) => {
          const n = Array.isArray(v) ? v[0] : v;
          if (n != null) patch({ [key]: n });
        }} />
    </div>
  );

  return (
    <div className="space-y-5">
      <Section>
        <ModelPicker items={models} value={settings.model} disabled={disabled}
          onChange={(id) => patch({ model: id as SegVals["model"] })}
          empty={t("modelPicker.emptyRemovebg")} />
      </Section>

      {/* La sortie détourée porte TOUJOURS un alpha : la séquence est PNG RGBA, la vidéo est
          arbitrée entre ProRes 4444 et WebM VP9 par le codec choisi juste en dessous. */}
      <ProcessOutputRows v={settings} patch={patch} disabled={disabled} alphaOnly />

      <Section>
        <Row label={t("settings.rowDeadFrames")}>
          <Toggle pressed={settings.dedup} onPressedChange={(on) => patch({ dedup: on })} disabled={disabled}>
            {settings.dedup ? t("settings.deadFramesRemove") : t("settings.deadFramesKeep")}
          </Toggle>
        </Row>
      </Section>

      {writesVideo && (
        <ProcessEncodingRows v={settings} patch={patch} audioTracks={audioTracks}
          allowedCodecs={ALPHA_EXPORT_CODECS} disabled={disabled} />
      )}

      <Section title={t("settings.matteCleanupTitle")}>
        <div className="space-y-2.5">
          {sliderRow(t("settings.rowMatteNoise"), "despeckle", 0, 30, 1)}
          {sliderRow(t("settings.rowMatteSmoothing"), "edgeSmoothing", 0, 10, 1, " px")}
          {sliderRow(t("settings.rowMatteOffset"), "edgeOffset", -20, 20, 1, " px")}
        </div>
      </Section>

      <ExportRows
        outDir={outDir} chooseOut={chooseOut} importBack={importBack} setImportBack={setImportBack} disabled={disabled}
        v={settings} hint={t("settings.removeBgHint")}
      />
    </div>
  );
}
