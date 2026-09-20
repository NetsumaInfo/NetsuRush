import type { AudioTrack } from "@/lib/bridge";
import { type InterpSettings as InterpVals } from "./processShared";
import { Section, ProcessEncodingRows, ExportRows } from "./procSettingsParts";
import { ProcessOutputRows, useOutputShape } from "./ProcessOutputRows";
import { InterpModelSettings } from "./ProcessModelSettings";

interface Props {
  settings: InterpVals;
  patch: (p: Partial<InterpVals>) => void;
  audioTracks: AudioTrack[];
  outDir: string | null;
  chooseOut: () => Promise<string | null>;
  importBack: boolean;
  setImportBack: (b: boolean) => void;
  disabled?: boolean;
}

// Panneau de réglages du mode interpolation (RIFE) : modèle, facteur, fps cible optionnel, ralenti,
// puis codec/audio/export partagés.
export function InterpSettings({ settings, patch, audioTracks, outDir, chooseOut, importBack, setImportBack, disabled }: Props) {
  const { writesVideo } = useOutputShape(settings);

  return (
    <div className="space-y-5">
      <Section>
        <InterpModelSettings settings={settings} patch={patch} disabled={disabled} />
      </Section>

      <ProcessOutputRows v={settings} patch={patch} disabled={disabled} />
      {writesVideo && <ProcessEncodingRows v={settings} patch={patch} audioTracks={audioTracks} disabled={disabled} />}
      <ExportRows outDir={outDir} chooseOut={chooseOut} importBack={importBack} setImportBack={setImportBack} disabled={disabled} v={settings} />
    </div>
  );
}
