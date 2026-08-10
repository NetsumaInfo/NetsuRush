import { FolderOpen } from "lucide-react";
import { Toggle } from "@/components/ui/toggle";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectGroupLabel, SelectItem } from "@/components/ui/select";
import { basename } from "@/lib/utils";
import type { AudioTrack } from "@/lib/bridge";
import { useTranslation } from "react-i18next";
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
