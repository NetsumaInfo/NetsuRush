// Constantes d'options + petits composants de présentation partagés par le formulaire d'export AE.
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectGroupLabel, SelectItem } from "@/components/ui/select";
import { UP_FAMILIES, GPU_CODECS, codecLabel, familyOf, variantsFor } from "@/components/upscale/upscaleShared";
import { cn } from "@/lib/utils";
import type { AeVideoMode, AeAudioMode, AeVideoContainer, AeAudioContainer, AeNestedMode, AeTransformMode, AeAudioRenderFmt, UpscaleCodec } from "@/lib/bridge";
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

/**
 * Conteneurs qui portent RÉELLEMENT ce qui va être écrit. En remux le flux source est recopié tel
 * quel (`-c:v copy`) : le codec choisi ne s'applique pas et les deux conteneurs restent ouverts.
 * Sur un réencode en revanche, ProRes et DNxHR n'existent qu'en MOV — les offrir en MP4 laissait
 * choisir un couple que ffmpeg refuse, d'autant que le conteneur restait appliqué depuis un mode
 * où la ligne était cachée.
 */
export function videoContainersFor(codec: UpscaleCodec, videoMode: AeVideoMode): AeVideoContainer[] {
  if (videoMode === "remux") return ["mov", "mp4"];
  const family = familyOf(codec);
  return family === "prores" || family === "dnxhr" ? ["mov"] : ["mov", "mp4"];
}

/**
 * Conteneurs qui acceptent le traitement audio choisi. `pcm` ne rentre ni en M4A ni dans un flux
 * copié ; `copy`/`remux`/`aac` sortent un flux AAC, que seul le M4A porte.
 */
export function audioContainersFor(audio: AeAudioMode): AeAudioContainer[] {
  return audio === "pcm" ? ["wav", "aiff"] : ["m4a"];
}

/** Sous-ensemble d'options qui décide, à lui seul, de ce qui est écrit sur le disque. */
export interface AeOutputShape {
  videoMode: AeVideoMode;
  transformMode: AeTransformMode;
  nestedMode: AeNestedMode;
  audio: AeAudioMode;
}

/**
 * Pourquoi un dossier de sortie est nécessaire — la liste, pas un simple booléen : le panneau doit
 * pouvoir DIRE ce qui écrit, sinon le dossier est réclamé sans raison visible.
 * `bake` cuit la vitesse dans un fichier : c'est un réencode, il comptait pour rien ici et le refus
 * ne tombait qu'au lancement, côté core.
 */
export function aeOutputReasons(o: AeOutputShape): string[] {
  const reasons: string[] = [];
  if (o.videoMode === "reencode") reasons.push("reencode");
  else if (o.videoMode === "remux") reasons.push("remux");
  if (o.transformMode === "bake") reasons.push("bake");
  if (o.nestedMode === "render") reasons.push("nestedRender");
  if (AUDIO_PRODUCES.has(o.audio)) reasons.push("audio");
  return reasons;
}

export const aeProducesFiles = (o: AeOutputShape) => aeOutputReasons(o).length > 0;

/** Un réencode plan par plan a lieu (ffmpeg) → codec, poignées et conteneur vidéo ont un effet. */
export const aeReencodes = (o: AeOutputShape) => o.videoMode === "reencode" || o.transformMode === "bake";

/** Un fichier VIDÉO est écrit → le conteneur vidéo s'applique. */
export const aeWritesVideo = (o: AeOutputShape) => o.videoMode !== "copy" || o.transformMode === "bake";

/** Le codec sert : réencode ffmpeg des plans, ou rendu Resolve d'une timeline imbriquée. */
export const aeUsesCodec = (o: AeOutputShape) => aeReencodes(o) || o.nestedMode === "render";
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
export function CodecRow({ codec, setCodec, busy, disabled }: { codec: UpscaleCodec; setCodec: (c: UpscaleCodec) => void; busy: boolean; disabled?: boolean }) {
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
    <Row label={t("form.codec")} disabled={disabled}>
      <Select value={codec} onValueChange={(v) => setCodec(v as UpscaleCodec)} items={items} disabled={busy || disabled}>
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
