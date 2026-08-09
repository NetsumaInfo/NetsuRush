import { useCallback, useEffect, useMemo, useState } from "react";
import { Trash2, Volume2, VolumeX } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useApp } from "@/store";
import { useCompatibility } from "@/hooks/useCompatibility";
import type { PreviewGenerationSettings, PreviewHeight, PreviewProxyEngine, PreviewProxyFormat, ThumbPreset } from "@/lib/bridge";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { VolumeSlider } from "@/components/player/VolumeSlider";
import { CompactSelect, SettingRow, type Choice } from "./rows";

const HEIGHTS: PreviewHeight[] = [360, 480, 520, 720];

// Les miniatures n'exposent PAS de hauteur : un seul cran porte la finesse et la vitesse de
// génération, la table des paramètres vivant côté core (`core/thumbPresets.js`). Les aperçus vidéo
// gardent leur propre réglage de résolution, qui n'a rien à voir.
const THUMB_PRESET_LABELS: { value: ThumbPreset; labelKey: string }[] = [
  { value: "light", labelKey: "playback.generation.qualityLow" },
  { value: "balanced", labelKey: "playback.generation.qualityStandard" },
  { value: "sharp", labelKey: "playback.generation.qualityHigh" },
];

export function PlaybackSettings() {
  const { t } = useTranslation("settings");
  const volume = useApp((s) => s.hoverVolume);
  const setVolume = useApp((s) => s.setHoverVolume);
  const muted = useApp((s) => s.hoverMuted);
  const setMuted = useApp((s) => s.setHoverMuted);
  const settings = useApp((s) => s.previewSettings);
  const setSettings = useApp((s) => s.setPreviewSettings);
  const resetSettings = useApp((s) => s.resetPreviewSettings);
  const clearCache = useApp((s) => s.clearCache);
  const cacheBusy = useApp((s) => s.cacheBusy);
  const { status } = useCompatibility();
  const [cacheChanged, setCacheChanged] = useState(false);
  const [cleared, setCleared] = useState(false);
  const playerVolume = useApp((s) => s.playerVolume);
  const setPlayerVolume = useApp((s) => s.setPlayerVolume);

  const formatChoices: Choice<PreviewProxyFormat>[] = [
    { value: "hevc", label: "H.265" },
    { value: "h264", label: "H.264" },
    { value: "webm", label: "WebM (VP8)" },
  ];

  const engineChoices = useMemo(() => {
    if (settings.proxy.format === "webm") return [{ value: "cpu" as const, label: t("compatibility.cpu") }];
    const key = settings.proxy.format === "hevc" ? "h265_main" : "h264_main";
    const encoders = status?.encoding.codecEncoderOptions[key] ?? [];
    const choices: Choice<PreviewProxyEngine>[] = [{ value: "auto", label: t("playback.generation.engineAuto") }];
    const add = (engine: PreviewProxyEngine, suffix: string, label: string) => {
      if (encoders.some((encoder) => encoder.endsWith(suffix))) choices.push({ value: engine, label });
    };
    add("nvenc", "_nvenc", `${t("compatibility.gpu")} NVIDIA`);
    add("amf", "_amf", `${t("compatibility.gpu")} AMD`);
    add("qsv", "_qsv", `${t("compatibility.gpu")} Intel`);
    choices.push({ value: "cpu", label: t("compatibility.cpu") });
    return choices;
  }, [settings.proxy.format, status, t]);

  const activeEngine = engineChoices.some((choice) => choice.value === settings.proxy.engine)
    ? settings.proxy.engine
    : engineChoices[0].value;
  // Un aperçu généré sans piste audio ne peut rien jouer ; un volume de lecteur à 0 coupe tout.
  const hoverAudioAvailable = settings.proxy.audio && playerVolume > 0;
  const hoverHint = !settings.proxy.audio
    ? t("playback.generation.audioUnavailable")
    : playerVolume === 0 ? t("playback.globalMuted") : t("playback.hoverVolumeHint");

  function apply(next: PreviewGenerationSettings) {
    setSettings(next);
    setCacheChanged(true);
    setCleared(false);
  }
  const patchProxy = useCallback((patch: Partial<PreviewGenerationSettings["proxy"]>) => {
    setSettings({ ...settings, proxy: { ...settings.proxy, ...patch } });
    setCacheChanged(true);
    setCleared(false);
  }, [setSettings, settings]);
  const patchThumbnail = (patch: Partial<PreviewGenerationSettings["thumbnail"]>) => apply({ ...settings, thumbnail: { ...settings.thumbnail, ...patch } });

  useEffect(() => {
    if (activeEngine !== settings.proxy.engine) patchProxy({ engine: activeEngine });
  }, [activeEngine, patchProxy, settings.proxy.engine]);

  async function removeOldCaches() {
    const result = await clearCache({ kinds: ["proxy", "thumb"] });
    if (result.ok) { setCacheChanged(false); setCleared(true); }
  }

  return (
    <section className="flex flex-col gap-7">
      <header>
        <h2 className="text-sm font-medium">{t("playback.title")}</h2>
        <p className="mt-1 max-w-[68ch] text-xs text-muted-foreground">{t("playback.subtitle")}</p>
      </header>

      <div>
        <h3 className="text-xs font-medium text-muted-foreground">{t("playback.generation.proxyTitle")}</h3>
        <div className="mt-2 divide-y divide-border rounded-lg border border-border">
          <SettingRow label={t("playback.generation.format")}>
            <CompactSelect value={settings.proxy.format} choices={formatChoices} onChange={(format) => patchProxy({ format, engine: format === "webm" ? "cpu" : "auto" })} />
          </SettingRow>
          <SettingRow label={t("playback.generation.engine")}>
            <CompactSelect value={activeEngine} choices={engineChoices} disabled={settings.proxy.format === "webm"} onChange={(engine) => patchProxy({ engine })} />
          </SettingRow>
          <SettingRow label={t("playback.generation.resolution")}>
            <CompactSelect value={settings.proxy.height} choices={HEIGHTS.map((height) => ({ value: height, label: `${height}p` }))} onChange={(height) => patchProxy({ height })} />
          </SettingRow>
          <SettingRow label={t("playback.generation.audio")}>
            <Toggle className="ml-auto flex" pressed={settings.proxy.audio} onPressedChange={(audio) => patchProxy({ audio })}>
              {settings.proxy.audio ? <Volume2 className="size-3.5" /> : <VolumeX className="size-3.5" />}
              {settings.proxy.audio ? t("playback.generation.enabled") : t("playback.generation.disabled")}
            </Toggle>
          </SettingRow>
        </div>
      </div>

      <div>
        <h3 className="text-xs font-medium text-muted-foreground">{t("playback.generation.thumbnailTitle")}</h3>
        <div className="mt-2 divide-y divide-border rounded-lg border border-border">
          <SettingRow label={t("playback.generation.format")} hint={t("playback.generation.thumbnailFormatHint")}>
            <CompactSelect value={settings.thumbnail.format} choices={[{ value: "webp", label: "WebP" }, { value: "jpeg", label: "JPEG" }]} onChange={(format) => patchThumbnail({ format })} />
          </SettingRow>
          <SettingRow label={t("playback.generation.quality")} hint={t("playback.generation.qualityHint")}>
            <CompactSelect
              value={settings.thumbnail.preset}
              choices={THUMB_PRESET_LABELS.map(({ value, labelKey }) => ({ value, label: t(labelKey) }))}
              onChange={(preset) => patchThumbnail({ preset })}
            />
          </SettingRow>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
        {cleared ? <p className="text-xs text-[var(--color-ok)]">{t("playback.generation.cacheCleared")}</p> : <span />}
        <div className="flex shrink-0 gap-2">
          <Button variant="ghost" size="sm" onClick={() => { resetSettings(); setCacheChanged(true); setCleared(false); }}>{t("playback.generation.reset")}</Button>
          <Button variant="outline" size="sm" disabled={!cacheChanged || cacheBusy === "purge"} onClick={() => void removeOldCaches()}>
            <Trash2 className="size-3.5" /> {t("playback.generation.clearOld")}
          </Button>
        </div>
      </div>

      <div>
        <h3 className="text-xs font-medium text-muted-foreground">{t("playback.soundTitle")}</h3>
        <div className="mt-2 divide-y divide-border rounded-lg border border-border">
          {/* Le volume des lecteurs vit ICI aussi : à 0 il coupe le son de TOUTE l'app (aperçus au
              survol compris) et cette page était le seul endroit où le constater sans pouvoir le
              rétablir — le réglage de survol y semblait cassé. */}
          <SettingRow label={t("playback.playerVolume")} hint={t("playback.playerVolumeHint")}>
            <VolumeSlider value={playerVolume} onChange={setPlayerVolume} showValue />
          </SettingRow>
          <SettingRow label={t("playback.hoverVolume")} hint={hoverHint}>
            <VolumeSlider
              value={volume}
              onChange={setVolume}
              muted={muted}
              onMutedChange={setMuted}
              disabled={!hoverAudioAvailable}
              showValue
            />
          </SettingRow>
        </div>
      </div>
    </section>
  );
}
