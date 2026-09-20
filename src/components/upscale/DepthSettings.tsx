import type { AudioTrack } from "@/lib/bridge";
import { type DepthSettings as DepthVals } from "./processShared";
import { Section, ProcessEncodingRows, ExportRows } from "./procSettingsParts";
import { ProcessOutputRows, useOutputShape } from "./ProcessOutputRows";
import { DepthModelSettings } from "./ProcessModelSettings";

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
  const { writesVideo } = useOutputShape(settings);

  return (
    <div className="space-y-5">
      <Section>
        <DepthModelSettings settings={settings} patch={patch} disabled={disabled} />
      </Section>

      <ProcessOutputRows v={settings} patch={patch} disabled={disabled} />
      {writesVideo && <ProcessEncodingRows v={settings} patch={patch} audioTracks={audioTracks} disabled={disabled} />}
      <ExportRows outDir={outDir} chooseOut={chooseOut} importBack={importBack} setImportBack={setImportBack} disabled={disabled} v={settings} />
    </div>
  );
}
