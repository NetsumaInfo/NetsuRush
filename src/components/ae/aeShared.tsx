// Constantes d'options + petits composants de présentation partagés par le formulaire d'export AE.
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectGroupLabel, SelectItem } from "@/components/ui/select";
import { UP_VARIANTS, UP_FAMILIES, GPU_CODECS, codecLabel, familyOf, variantsFor } from "@/components/upscale/upscaleShared";
import { cn } from "@/lib/utils";
import type { AeVideoMode, AeAudioMode, AeVideoContainer, AeAudioContainer, AeTransformMode, AeAudioRenderFmt, UpscaleCodec } from "@/lib/bridge";
import { useCompatibility } from "@/hooks/useCompatibility";

// label/hint = clés i18n (ns « ae »), résolues au rendu via t() par le consommateur.
export const VIDEO_MODES: { id: AeVideoMode; label: string; hint: string }[] = [
  { id: "copy", label: "videoModes.copy.label", hint: "videoModes.copy.hint" },
  { id: "remux", label: "videoModes.remux.label", hint: "videoModes.remux.hint" },
  { id: "reencode", label: "videoModes.reencode.label", hint: "videoModes.reencode.hint" },
];

// Audio = réglage INDÉPENDANT de la vidéo (s'applique aux pistes son dédiées + audio embarqué).
export const AUDIO_MODES: { id: AeAudioMode; label: string }[] = [
  { id: "copy", label: "audioModes.copy" },
  { id: "remux", label: "audioModes.remux" },
  { id: "aac", label: "audioModes.aac" },
  { id: "pcm", label: "audioModes.pcm" },
  { id: "none", label: "audioModes.none" },
];
export const AE_LOSSY = new Set<AeAudioMode>(["aac"]);
export const AUDIO_PRODUCES = new Set<AeAudioMode>(["remux", "aac", "pcm"]);

// Conteneurs importables par After Effects uniquement.
export const VIDEO_CONTAINERS: AeVideoContainer[] = ["mov", "mp4"];
export const AUDIO_CONTAINERS: AeAudioContainer[] = ["m4a", "wav", "aiff"];
// Format du rendu Resolve quand la timeline imbriquée est audio seule.
export const AUDIO_RENDER_FORMATS: { id: AeAudioRenderFmt; label: string }[] = [
  { id: "wav", label: "WAV (PCM)" },
  { id: "aiff", label: "AIFF (PCM)" },
  { id: "aac", label: "AAC (M4A)" },
];

export const TRANSFORM_MODES: { id: AeTransformMode; label: string; hint: string }[] = [
  { id: "none", label: "transformModes.none.label", hint: "transformModes.none.hint" },
  { id: "ae", label: "transformModes.ae.label", hint: "transformModes.ae.hint" },
  { id: "bake", label: "transformModes.bake.label", hint: "transformModes.bake.hint" },
];

export const MONTAGE = [...UP_VARIANTS.prores, ...UP_VARIANTS.dnxhr];

// Format de sortie déduit du codec (le rendu Resolve / réencode produit toujours un conteneur AE-safe).
export const renderFmt = (codec: UpscaleCodec) => (["h264", "hevc"].includes(familyOf(codec)) ? "MP4" : "MOV");

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2.5">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

// `disabled` grise la ligne sans la retirer : une ligne qui disparaît fait sauter la mise en page à
// chaque changement de flux.
export function Row({ label, disabled, children }: { label: string; disabled?: boolean; children: React.ReactNode }) {
  return (
    <div className={cn("flex items-center justify-between gap-3 transition-opacity", disabled && "opacity-40")}>
      {/* Le libellé cède avant le contrôle : sans `min-w-0`, un libellé long garde sa largeur
          intrinsèque et le contrôle le CHEVAUCHE au lieu de rester dans le panneau. */}
      <span className="min-w-0 truncate text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

// Sélecteur de codec groupé par famille (ProRes / DNxHR = MOV · H.264 / HEVC = MP4).
export function CodecRow({ codec, setCodec, busy }: { codec: UpscaleCodec; setCodec: (c: UpscaleCodec) => void; busy: boolean }) {
  const { t } = useTranslation("ae");
  const { status } = useCompatibility();
  const items = UP_FAMILIES.flatMap((family) => variantsFor(family.id, status))
    .map((item) => ({ value: item.id, label: item.label }));
  useEffect(() => {
    if (!status) return;
    if (GPU_CODECS.has(codec) && !variantsFor(familyOf(codec), status).some((item) => item.id === codec)) {
      setCodec(familyOf(codec) === "h264" ? "x264" : "x265");
    }
  }, [status, codec, setCodec]);
  return (
    <Row label={t("form.codec")}>
      <Select value={codec} onValueChange={(v) => setCodec(v as UpscaleCodec)} items={items} disabled={busy}>
        <SelectTrigger className="w-[58%]"><SelectValue>{codecLabel(codec, status)}</SelectValue></SelectTrigger>
        <SelectContent>
          {UP_FAMILIES.map((f) => (
            <SelectGroup key={f.id}>
              <SelectGroupLabel>{f.label}</SelectGroupLabel>
              {variantsFor(f.id, status).map((c) => <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>)}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
    </Row>
  );
}
