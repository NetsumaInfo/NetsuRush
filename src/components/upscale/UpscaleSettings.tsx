import type { AudioTrack } from "@/lib/bridge";
import { Section, ProcessEncodingRows, ExportRows } from "./procSettingsParts";
import { UpscaleModelSettings } from "./UpscaleModelSettings";
import type { UpSettings } from "./upscaleShared";

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
  return (
    <div className="space-y-5">
      <Section>
        <UpscaleModelSettings settings={settings} patch={patch} disabled={disabled} />
      </Section>

      <ProcessEncodingRows v={settings} patch={patch} audioTracks={audioTracks} disabled={disabled} />
      <ExportRows outDir={outDir} chooseOut={chooseOut} importBack={importBack} setImportBack={setImportBack} disabled={disabled} />
    </div>
  );
}
