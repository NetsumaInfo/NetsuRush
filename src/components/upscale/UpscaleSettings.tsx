import type { AudioTrack } from "@/lib/bridge";
import { Section, ProcessEncodingRows, ExportRows } from "./procSettingsParts";
import { ProcessOutputRows, useOutputShape } from "./ProcessOutputRows";
import { UpscaleModelSettings } from "./UpscaleModelSettings";
import { isRtxShader, type UpSettings } from "./upscaleShared";
import { useTranslation } from "react-i18next";

interface Props {
  settings: UpSettings;
  patch: (p: Partial<UpSettings>) => void;
  audioTracks: AudioTrack[];
  outDir: string | null;
  chooseOut: () => Promise<string | null>;
  importBack: boolean;
  setImportBack: (b: boolean) => void;
  disabled?: boolean;
}

export function UpscaleSettings({ settings, patch, audioTracks, outDir, chooseOut, importBack, setImportBack, disabled }: Props) {
  const { t } = useTranslation("upscale");
  const { writesVideo } = useOutputShape(settings);
  // Le CLI RTX Video SDK n'écrit que du MP4 : le choix est verrouillé ici, pas refusé après coup.
  const rtxOnly = settings.mode !== "restore" && settings.engine === "turbo" && isRtxShader(settings.shader);
  return (
    <div className="space-y-5">
      <Section>
        <UpscaleModelSettings settings={settings} patch={patch} disabled={disabled} />
      </Section>

      <ProcessOutputRows v={settings} patch={patch} disabled={disabled}
        videoOnly={rtxOnly} videoOnlyNote={t("settings.outputRtxNote")} />
      {(writesVideo || rtxOnly) && <ProcessEncodingRows v={settings} patch={patch} audioTracks={audioTracks} disabled={disabled} />}
      <ExportRows outDir={outDir} chooseOut={chooseOut} importBack={importBack} setImportBack={setImportBack} disabled={disabled} v={settings} />
    </div>
  );
}
