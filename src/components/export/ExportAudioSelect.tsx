// Menu audio de l'export — le MÊME dans le panneau de droite et dans les Réglages d'export : il lit
// et écrit le profil actif, donc les deux vues ne peuvent pas diverger.
// Toujours rendu (même sur un fichier mono-piste) : couper le son reste utile, et le panneau ne doit
// pas sauter d'un clip à l'autre.
import { useMemo } from "react";
import { Volume2 } from "lucide-react";
import { useApp } from "@/store";
import { type AudioTrack } from "@/lib/bridge";
import { useTranslation } from "react-i18next";
import { Select, SelectContent, SelectGroup, SelectGroupLabel, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { type ExportProfile, coerceAudioSelect, audioLanguageLabel } from "@/features/export/profiles";
import { exportAudioItems, exportAudioValue, applyExportAudioValue, audioTrackLabel, resolveLanguageTrack } from "@/features/export/audioSelect";
import { useAudioTracks } from "./useAudioTracks";

export function ExportAudioSelect({ profile, sourcePath, size }: {
  profile: ExportProfile;
  sourcePath?: string;
  size?: "sm";
}) {
  const { t } = useTranslation("export");
  const update = useApp((s) => s.updateExportProfile);
  const tracks = useAudioTracks(sourcePath);

  const value = exportAudioValue(profile);
  const items = useMemo(() => exportAudioItems({ workflow: profile.workflow, tracks }), [profile.workflow, tracks]);
  const groups = useMemo(() => {
    const out: { group?: string; items: typeof items }[] = [];
    for (const it of items) {
      const last = out[out.length - 1];
      if (last && last.group === it.group) last.items.push(it);
      else out.push({ group: it.group, items: [it] });
    }
    return out;
  }, [items]);

  const display = triggerLabel(profile, tracks, value, t);
  const small = size === "sm";

  return (
    <div className="flex flex-col gap-1">
      <Select value={value} onValueChange={(v) => v && update(profile.id, applyExportAudioValue(profile, v as string))}>
        <SelectTrigger size={small ? "sm" : undefined} className={small ? "h-8 text-xs" : undefined}>
          <Volume2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <SelectValue className="min-w-0 flex-1">{display}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {groups.map((g, i) => (
            <SelectGroup key={g.group ?? i}>
              {g.group && <SelectGroupLabel>{g.group}</SelectGroupLabel>}
              {g.items.map((it) => <SelectItem key={it.value} value={it.value}>{it.label}</SelectItem>)}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

// Le déclencheur dit à quoi le réglage se résout SUR CETTE SOURCE : une règle par langue affiche la
// piste qu'elle a trouvée (ou son échec), pas un libellé opaque.
function triggerLabel(profile: ExportProfile, tracks: AudioTrack[], value: string, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (value === "none") return t("audio.noAudio");
  if (value === "auto") return t("audio.allTracks");
  const sel = coerceAudioSelect(profile.audioSelect);
  if (sel.mode === "track") {
    const hit = tracks.find((x) => x.index === sel.track);
    return hit ? audioTrackLabel(hit) : t("audio.trackN", { n: (sel.track ?? 0) + 1 });
  }
  const lang = audioLanguageLabel(sel.language);
  if (!tracks.length) return lang;
  const hit = resolveLanguageTrack(tracks, sel.language);
  return hit ? t("audio.langResolved", { lang, n: hit.index + 1 }) : t("audio.langUnresolved", { lang });
}
