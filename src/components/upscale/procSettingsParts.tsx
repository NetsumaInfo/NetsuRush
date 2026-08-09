import { ChevronRight, FolderOpen } from "lucide-react";
import { Toggle } from "@/components/ui/toggle";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectGroupLabel, SelectItem } from "@/components/ui/select";
import { basename } from "@/lib/utils";
import type { AudioTrack, UpscaleCodec, AudioMode } from "@/lib/bridge";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCompatibility } from "@/hooks/useCompatibility";
import { useApp } from "@/store";
import {
  EXPORT_AUDIO_OPTIONS,
  EXPORT_SPEED_OPTIONS,
  getExportCodecLabel,
  type ExportAudioMode,
  type ExportCodec,
  type ExportContainer,
  type ExportEncoderMode,
} from "@/features/export/profiles";
import { useExportEncodingFields } from "@/features/export/encodingFields";
import {
  isProcessExportProfile, matchProcessExportProfile, processEncodingPatch, processEncodingValue,
  processExportFromProfile, type ProcessExportSettings,
} from "./processExport";
import { useSharedProcSources, type OutputNamingMode } from "./useProcSources";
import {
  UP_AUDIO, UP_ABR, variantsFor,
  ENCODER_CODECS, GPU_CODECS, LOSSY_AUDIO, profilesFor, compatibleProfilesFor, coerceProfile, profileDepth, type UpscaleFamily,
} from "./upscaleShared";

// Helpers partagés par les panneaux de réglages des modes du hub (interp/depth/upscale) :
// Section/Row, le bloc Codec vidéo, le bloc Audio et le bloc Export. Évite de dupliquer 3×
// les mêmes sélecteurs codec/audio/export.

export function Section({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      {title && <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>}
      {children}
    </section>
  );
}

// Explication d'un réglage : portée par son LIBELLÉ, au survol. Un paragraphe sous chaque contrôle
// allonge le panneau au-delà de l'écran, et une icône d'aide par ligne ajoute autant de bruit que le
// paragraphe qu'elle remplace. Le libellé existe déjà : il suffit de le rendre survolable.
export function HintLabel({ label, hint, className }: { label: string; hint?: React.ReactNode; className?: string }) {
  if (!hint) return <span className={className}>{label}</span>;
  return (
    <Tooltip>
      <TooltipTrigger render={<span tabIndex={0} className={cn("cursor-help outline-none", className)} />}>{label}</TooltipTrigger>
      <TooltipContent className="max-w-64">{hint}</TooltipContent>
    </Tooltip>
  );
}

export function Row({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      {/* Le libellé cède avant le contrôle : sans `min-w-0`, un libellé long garde sa largeur
          intrinsèque et le contrôle le CHEVAUCHE au lieu de rester dans le panneau. */}
      <HintLabel label={label} hint={hint} className="min-w-0 truncate text-xs font-medium text-muted-foreground" />
      {children}
    </div>
  );
}

// Section repliable : un panneau de réglages long se parcourt
// par blocs plutôt qu'en scrollant une liste plate. L'état ouvert/fermé est PERSISTÉ par clé, sinon
// il repartirait à zéro à chaque changement de moteur ou de source.
export function CollapsibleSection({ id, title, icon: Icon, badge, defaultOpen = true, children }: {
  id: string;
  title: string;
  icon?: React.ComponentType<{ className?: string }>;
  badge?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const storageKey = `nr.section.${id}`;
  const [open, setOpen] = useState(() => {
    const stored = typeof localStorage === "undefined" ? null : localStorage.getItem(storageKey);
    return stored == null ? defaultOpen : stored === "1";
  });
  const toggle = () => setOpen((value) => {
    try { localStorage.setItem(storageKey, value ? "0" : "1"); } catch { /* stockage indisponible : l'état reste mémoire */ }
    return !value;
  });
  return (
    <section className="rounded-lg border border-border/70 bg-card/30">
      <button type="button" onClick={toggle} aria-expanded={open}
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left">
        <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        {Icon && <Icon className="size-3.5 shrink-0 text-primary" />}
        <span className="min-w-0 flex-1 truncate text-xs font-semibold">{title}</span>
        {badge && <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">{badge}</span>}
      </button>
      {open && <div className="space-y-3 border-t border-border/60 px-2.5 py-3">{children}</div>}
    </section>
  );
}

// Rangée de préréglages : une intention en un clic (« Léger », « Fort »…), avant d'aller toucher les
// curseurs. `active` est déterminé par comparaison des valeurs, donc bouger un curseur désélectionne
// naturellement le préréglage.
export function PresetRow<T>({ label, presets, active, onPick, disabled }: {
  label: string;
  presets: { id: string; label: string; hint?: string; values: T }[];
  active: string | null;
  onPick: (values: T) => void;
  disabled?: boolean;
}) {
  return (
    <StackRow label={label} hint={presets.find((preset) => preset.id === active)?.hint}>
      <div className="grid grid-cols-2 gap-1">
        {presets.map((preset) => (
          <Button key={preset.id} type="button" size="sm" disabled={disabled}
            variant={preset.id === active ? "default" : "outline"}
            className="h-7 justify-center px-2 text-[11px]"
            onClick={() => onPick(preset.values)}>
            {preset.label}
          </Button>
        ))}
      </div>
    </StackRow>
  );
}

// Rangée empilée : libellé (+ valeur alignée à droite) au-dessus du contrôle pleine largeur.
// Nécessaire dès que le libellé est long : la `Row` côte-à-côte réduit alors le contrôle à un
// moignon dans un panneau de 320 px.
export function StackRow({ label, value, hint, children }: {
  label: string; value?: string; hint?: string; children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 text-xs font-medium text-muted-foreground">{label}</span>
        {value && <span className="shrink-0 text-xs tabular-nums text-foreground">{value}</span>}
      </div>
      {children}
      {hint && <p className="text-[10px] leading-snug text-muted-foreground">{hint}</p>}
    </div>
  );
}

// Curseur pleine largeur avec sa valeur lisible dans l'entête de la rangée (pas de bulle flottante :
// elle recouvrirait le libellé au-dessus).
export function SliderRow({ label, value, onChange, min = 0, max = 1, step = 0.01, unit = "", decimals, hint, disabled }: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number; max?: number; step?: number;
  unit?: string;
  decimals?: number;
  hint?: string;
  disabled?: boolean;
}) {
  const digits = decimals ?? (step < 0.1 ? 2 : step < 1 ? 1 : 0);
  return (
    <StackRow label={label} value={`${value.toFixed(digits)}${unit}`} hint={hint}>
      <Slider value={[value]} min={min} max={max} step={step} disabled={disabled}
        onValueChange={(v) => onChange(Array.isArray(v) ? v[0] : Number(v))} aria-label={label} />
    </StackRow>
  );
}

// Sélecteur compact réutilisable (largeur bornée pour ne pas déborder le panneau).
export function Field({ value, onChange, items, disabled, className }: {
  value: string;
  onChange: (v: string) => void;
  items: { value: string; label: string }[];
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(String(v))} items={items} disabled={disabled}>
      <SelectTrigger className={className ?? "w-[58%]"}><SelectValue /></SelectTrigger>
      <SelectContent>
        {items.map((it) => <SelectItem key={it.value} value={it.value}>{it.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

const CODEC_GROUPS: { key: string; fams: UpscaleFamily[] }[] = [
  { key: "settings.groupDiffusion", fams: ["h264", "hevc"] },
  { key: "settings.groupEditing", fams: ["prores", "dnxhr"] },
];

// Champs encodage vidéo partagés (upscale/interp/depth) : codec + qualité/vitesse/profil (si encodeur).
export interface CodecValues {
  codec: UpscaleCodec;
  quality: number;
  preset: string;
  bitDepth: 8 | 10;   // dérivé du profil (compat legacy)
  profile: string;    // profil codec réel (-profile:v)
}
export function CodecRows({ v, patch, disabled }: {
  v: CodecValues;
  patch: (p: Partial<CodecValues>) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation("upscale");
  const { status } = useCompatibility();
  const isEncoder = ENCODER_CODECS.has(v.codec);
  const isGpu = GPU_CODECS.has(v.codec);
  // Changer de codec : re-valider le profil (les profils diffèrent par codec) + garder bitDepth cohérent.
  const onCodec = useCallback((c: UpscaleCodec) => {
    const profile = coerceProfile(c, v.profile);
    patch({ codec: c, profile, bitDepth: profileDepth(c, profile) });
  }, [patch, v.profile]);
  const onProfile = (p: string) => patch({ profile: p, bitDepth: profileDepth(v.codec, p) });
  const profileOptions = useMemo(() => compatibleProfilesFor(v.codec, status), [status, v.codec]);
  const codecItems = CODEC_GROUPS.flatMap((g) => g.fams.flatMap((fam) => variantsFor(fam, status)))
    .map((item) => ({ value: item.id, label: item.label }));

  useEffect(() => {
    if (!status || !isGpu) return;
    if (profileOptions.length === 0) {
      onCodec(v.codec.startsWith("h264_") ? "x264" : "x265");
      return;
    }
    if (!profileOptions.some((option) => option.value === v.profile)) {
      const next = profileOptions[0].value;
      patch({ profile: next, bitDepth: profileDepth(v.codec, next) });
    }
  }, [isGpu, onCodec, patch, profileOptions, status, v.codec, v.profile]);

  return (
    <Section title={t("settings.sectionCodec")}>
      <Row label={t("settings.rowCodec")}>
        <Select value={v.codec} onValueChange={(c) => onCodec(c as UpscaleCodec)}
          items={codecItems} disabled={disabled}>
          <SelectTrigger className="w-[58%]"><SelectValue /></SelectTrigger>
          <SelectContent>
            {CODEC_GROUPS.map((g) => (
              <SelectGroup key={g.key}>
                <SelectGroupLabel>{t(g.key)}</SelectGroupLabel>
                {g.fams.flatMap((fam) => variantsFor(fam, status)).map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </Row>

      {isEncoder && (
        <>
          <ProfileRow codec={v.codec} value={v.profile} onChange={onProfile} disabled={disabled} items={profileOptions} />
        </>
      )}
    </Section>
  );
}

// Valeur du sélecteur de profil quand les réglages ne correspondent à aucun profil enregistré.
const CUSTOM_PROFILE = "custom";

// Même taxonomie et mêmes garde-fous que Paramètres généraux › Profils d'export. NetsuLab encode
// toujours un nouveau fichier : seules les lignes propres au workflow/timeline sont absentes.
export function ProcessEncodingRows({ v, patch, audioTracks, disabled, allowedCodecs }: {
  v: ProcessExportSettings;
  patch: (p: Partial<ProcessExportSettings>) => void;
  audioTracks: AudioTrack[];
  disabled?: boolean;
  allowedCodecs?: ReadonlySet<ExportCodec>;
}) {
  const { t } = useTranslation("upscale");
  const { t: te } = useTranslation("export");
  // Les profils d'export généraux s'appliquent ICI aussi : un préréglage réglé une fois dans les
  // Paramètres sert le derush, la recherche ET le hub. Seuls les profils de ré-encodage ont un sens.
  const profiles = useApp((s) => s.exportProfiles);
  // Mêmes garde-fous que l'éditeur de profil et l'archivage d'une collection (source unique).
  const fields = useExportEncodingFields(
    processEncodingValue(v),
    (encoding) => patch(processEncodingPatch(encoding)),
    { allowedCodecs },
  );
  const exportProfiles = profiles.filter(isProcessExportProfile);
  // Aucun profil ne correspond aux réglages courants (l'utilisateur a bougé un curseur) → « Personnalisé »,
  // proposé seulement dans ce cas : il n'y a rien à « appliquer » quand un profil correspond déjà.
  const matchedProfileId = matchProcessExportProfile(profiles, v);
  const profileItems = [
    ...exportProfiles.map((profile) => ({ value: profile.id, label: profile.name })),
    ...(matchedProfileId ? [] : [{ value: CUSTOM_PROFILE, label: te("editor.profileCustom") }]),
  ];
  const trackItems = [
    { value: "-1", label: te("audioSelect.all", { defaultValue: "Toutes les pistes" }) },
    { value: "none", label: te("audioSelect.none", { defaultValue: "Aucune" }) },
    ...audioTracks.map((track) => ({
      value: String(track.index),
      label: `${track.index + 1} · ${track.title || track.lang || track.codec}${track.channels ? ` · ${track.channels} ch` : ""}`,
    })),
  ];

  const trackValue = v.exportAudioMode === "none" ? "none" : String(v.audioTrack);

  return (
    <Section title={t("settings.sectionCodec")}>
      {exportProfiles.length > 0 && (
        <Row label={te("editor.profile")}>
          <Field value={matchedProfileId ?? CUSTOM_PROFILE} disabled={disabled}
            onChange={(id) => {
              const profile = exportProfiles.find((p) => p.id === id);
              if (profile) patch(processExportFromProfile(profile));
            }} items={profileItems} />
        </Row>
      )}
      <Row label={te("editor.optimization")}>
        <Field value={fields.encoderMode} disabled={disabled}
          onChange={(value) => fields.pickEncoderMode(value as ExportEncoderMode)} items={fields.encoderItems} />
      </Row>
      <Row label={te("editor.speed")}>
        <Field value={fields.speed} disabled={disabled || !fields.speedSettable}
          onChange={(value) => patch({ exportSpeed: value as ProcessExportSettings["exportSpeed"] })}
          items={EXPORT_SPEED_OPTIONS} />
      </Row>
      <Row label={te("editor.codec")}>
        <Select value={v.exportCodec} onValueChange={(value) => fields.pickCodec(value as ExportCodec)}
          items={fields.codecOptions} disabled={disabled}>
          <SelectTrigger className="w-[58%]"><SelectValue>{getExportCodecLabel(v.exportCodec)}</SelectValue></SelectTrigger>
          <SelectContent>
            {fields.codecGroups.map((group) => (
              <SelectGroup key={group.key}>
                <SelectGroupLabel>{group.label}</SelectGroupLabel>
                {group.options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </Row>
      <Row label={te("editor.audio")}>
        <Field value={trackValue} disabled={disabled}
          onChange={(value) => value === "none"
            ? patch({ exportAudioMode: "none" })
            : patch({ audioTrack: Number(value), exportAudioMode: v.exportAudioMode === "none" ? "copy" : v.exportAudioMode })}
          items={trackItems} />
      </Row>
      <Row label={te("editor.audioCodec")}>
        <Select
          value={v.exportAudioMode === "none" ? (fields.audioOptions[0]?.value ?? "copy") : v.exportAudioMode}
          onValueChange={(value) => patch({ exportAudioMode: value as ExportAudioMode })}
          items={fields.audioOptions.length ? fields.audioOptions : EXPORT_AUDIO_OPTIONS}
          disabled={disabled || v.exportAudioMode === "none"}>
          <SelectTrigger className="w-[58%]"><SelectValue /></SelectTrigger>
          <SelectContent>
            {fields.audioLoneOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
            {fields.audioGroups.map((group) => (
              <SelectGroup key={group.family}>
                <SelectGroupLabel>{group.label}</SelectGroupLabel>
                {group.options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </Row>
      <Row label={te("editor.container")}>
        <Field value={v.exportContainer} disabled={disabled}
          onChange={(value) => fields.pickContainer(value as ExportContainer)} items={fields.containerOptions} />
      </Row>
    </Section>
  );
}

// Profil codec réel (-profile:v) : Main/High/High 10/High 4:2:2… selon le codec. Porte le
// sous-échantillonnage chroma + la profondeur (remplace l'ancien toggle 8/10-bit).
export function ProfileRow({ codec, value, onChange, disabled, items }: {
  codec: UpscaleCodec; value: string; onChange: (p: string) => void; disabled?: boolean; items?: { value: string; label: string }[];
}) {
  const { t } = useTranslation("upscale");
  const opts = items ?? profilesFor(codec);
  if (!opts.length) return null;
  const safe = opts.some((o) => o.value === value) ? value : (opts[0]?.value ?? "");
  return (
    <Row label={t("settings.rowProfile")}>
      <Field value={safe} disabled={disabled} onChange={onChange} items={opts} />
    </Row>
  );
}

// Bloc Audio partagé (interp/depth).
export interface AudioValues {
  audio: AudioMode;
  abr: number;
  audioTrack: number;
}
export function AudioRows({ v, patch, audioTracks, disabled }: {
  v: AudioValues;
  patch: (p: Partial<AudioValues>) => void;
  audioTracks: AudioTrack[];
  disabled?: boolean;
}) {
  const { t } = useTranslation("upscale");
  const lossy = LOSSY_AUDIO.has(v.audio);
  const trackLabel = (track: AudioTrack) => t("settings.trackLabel", {
    n: track.index + 1, codec: track.codec, channels: track.channels ? ` ${track.channels}ch` : "", lang: track.lang ? ` · ${track.lang}` : "",
  });
  return (
    <Section title={t("settings.sectionAudio")}>
      <Row label={t("settings.rowMode")}>
        <Field value={v.audio} disabled={disabled}
          onChange={(val) => patch({ audio: val as AudioMode })}
          items={UP_AUDIO.map((a) => ({ value: a.id, label: t(`audio.${a.id}`, { defaultValue: a.label }) }))} />
      </Row>
      {lossy && (
        <Row label={t("settings.rowBitrate")}>
          <Field value={String(v.abr)} disabled={disabled}
            onChange={(val) => patch({ abr: Number(val) })}
            items={UP_ABR.map((b) => ({ value: String(b), label: t("settings.kbps", { n: b }) }))} />
        </Row>
      )}
      {v.audio !== "none" && audioTracks.length > 1 && (
        <Row label={t("settings.rowTrack")}>
          <Field value={String(v.audioTrack)} disabled={disabled}
            onChange={(val) => patch({ audioTrack: Number(val) })}
            items={audioTracks.map((t) => ({ value: String(t.index), label: trackLabel(t) }))} />
        </Row>
      )}
    </Section>
  );
}

// Bloc Export partagé (dossier + import Media Pool) — `hint` optionnel sous le toggle d'import.
export function ExportRows({ outDir, chooseOut, importBack, setImportBack, disabled, hint }: {
  outDir: string | null;
  chooseOut: () => Promise<string | null>;
  importBack: boolean;
  setImportBack: (b: boolean) => void;
  disabled?: boolean;
  hint?: string;
}) {
  const { t } = useTranslation("upscale");
  const {
    sources, outputNaming, setOutputNaming, setOutputNamingOverride,
    outputNamingOverrideFor, outputNameFor, outputNamingProblem,
  } = useSharedProcSources();
  const namingItems = (["original", "prefix", "suffix", "custom"] as OutputNamingMode[])
    .map((value) => ({ value, label: t(`settings.naming.${value}`) }));
  const needsValue = outputNaming.mode !== "original";
  return (
    <Section title={t("settings.sectionExport")}>
      <Row label={t("settings.rowFolder")}>
        <Button variant="outline" size="sm" className="max-w-[58%]" onClick={chooseOut} disabled={disabled}>
          <FolderOpen className="h-4 w-4" /> <span className="truncate">{outDir ? basename(outDir) : t("settings.choose")}</span>
        </Button>
      </Row>
      <Row label={t("settings.rowImportPool")}>
        <Toggle pressed={importBack} onPressedChange={setImportBack} disabled={disabled}>
          {importBack ? t("settings.yes") : t("settings.no")}
        </Toggle>
      </Row>
      <Row label={sources.length > 1 ? t("settings.rowDefaultNaming") : t("settings.rowOutputName")}>
        <Field value={outputNaming.mode} disabled={disabled}
          onChange={(mode) => setOutputNaming({ ...outputNaming, mode: mode as OutputNamingMode })}
          items={namingItems} />
      </Row>
      {needsValue && (
        <Input
          value={outputNaming.value}
          onChange={(e) => setOutputNaming({ ...outputNaming, value: e.target.value })}
          placeholder={t(`settings.namingPlaceholder.${outputNaming.mode}`)}
          disabled={disabled}
          aria-label={t("settings.rowOutputName")}
        />
      )}
      {sources.length > 1 && (
        <div className="space-y-2">
          <p className="text-[11px] font-medium text-muted-foreground">{t("settings.perMediaNames")}</p>
          <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
            {sources.map((source) => {
              const override = outputNamingOverrideFor(source);
              const sourceId = source.uid ?? `${source.path}#${source.in ?? "all"}-${source.out ?? "all"}`;
              const mode = override?.mode ?? "default";
              const items = [
                { value: "default", label: t("settings.naming.default") },
                ...namingItems,
              ];
              return (
                <div key={sourceId} className="space-y-1.5 rounded-md border border-border/70 bg-muted/20 p-2">
                  <div className="min-w-0">
                    <Tooltip>
                      <TooltipTrigger render={<p className="truncate text-[11px] font-medium text-foreground" />}>
                        {source.name}
                      </TooltipTrigger>
                      <TooltipContent>{source.name}</TooltipContent>
                    </Tooltip>
                    {source.in != null && source.out != null && (
                      <p className="text-[10px] tabular-nums text-muted-foreground">{source.in.toFixed(2)}–{source.out.toFixed(2)} s</p>
                    )}
                  </div>
                  <Field value={mode} disabled={disabled} items={items} onChange={(nextMode) => {
                    if (nextMode === "default") setOutputNamingOverride(source, null);
                    else setOutputNamingOverride(source, {
                      mode: nextMode as OutputNamingMode,
                      value: override?.value ?? "",
                    });
                  }} />
                  {override && override.mode !== "original" && (
                    <Input
                      value={override.value}
                      onChange={(e) => setOutputNamingOverride(source, { ...override, value: e.target.value })}
                      placeholder={t(`settings.namingPlaceholder.${override.mode}`)}
                      disabled={disabled}
                      aria-label={t("settings.nameForMedia", { name: source.name })}
                    />
                  )}
                  <Tooltip>
                    <TooltipTrigger render={<p className="truncate text-[10px] text-muted-foreground" />}>
                      {override ? t("settings.resultingName") : t("settings.inheritedName")} : {outputNameFor(source)}
                    </TooltipTrigger>
                    <TooltipContent>{outputNameFor(source)}</TooltipContent>
                  </Tooltip>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {outputNamingProblem && (
        <p className="text-[11px] leading-snug text-destructive">{t(`errors.${outputNamingProblem}`)}</p>
      )}
      {hint && <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p>}
    </Section>
  );
}
