import { useRef } from "react";
import { AlertTriangle, FolderOpen, ListOrdered, RotateCcw } from "lucide-react";
import { Toggle } from "@/components/ui/toggle";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import { useSharedProcSources } from "./useProcSources";
import { DEFAULT_IMAGE_OUTPUT, outputKindFor, outputSample, type ImageOutputSettings } from "./imageOutput";
import { NAME_TOKENS, numberedPattern, type NameToken } from "./outputNaming";

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


// Shared export block: destination folder, Media Pool import, and the ONE naming pattern that names
// every output. Per-media names are set by renaming a media in the selection tray, not by a list of
// controls here - the pattern covers the batch, a rename covers the exception.
export function ExportRows({ outDir, chooseOut, importBack, setImportBack, disabled, hint, v }: {
  outDir: string | null;
  chooseOut: () => Promise<string | null>;
  importBack: boolean;
  setImportBack: (b: boolean) => void;
  disabled?: boolean;
  hint?: string;
  // Encoding + image settings of the active op, so the preview shows the REAL final file name.
  v?: ProcessExportSettings;
}) {
  const { t } = useTranslation("upscale");
  const {
    sources, active, outputPattern, setOutputPattern, nameReport, setSourceName,
  } = useSharedProcSources();
  const patternRef = useRef<HTMLInputElement | null>(null);
  const image: ImageOutputSettings = v ?? DEFAULT_IMAGE_OUTPUT;
  const container = v?.exportContainer ?? "mp4";

  // Caret-aware insertion: a token lands where the user was typing, not always at the end.
  const insertToken = (token: NameToken) => {
    const field = patternRef.current;
    const text = `{${token}}`;
    if (!field) { setOutputPattern(`${outputPattern}${text}`); return; }
    const start = field.selectionStart ?? outputPattern.length;
    const end = field.selectionEnd ?? start;
    const next = `${outputPattern.slice(0, start)}${text}${outputPattern.slice(end)}`;
    setOutputPattern(next);
    requestAnimationFrame(() => {
      field.focus();
      const caret = start + text.length;
      field.setSelectionRange(caret, caret);
    });
  };

  const activeIndex = active ? sources.findIndex((s) => s.uid === active.uid) : -1;
  const previewBase = nameReport.names[activeIndex >= 0 ? activeIndex : 0] ?? "";
  const preview = previewBase
    ? outputSample(previewBase, outputKindFor(image, active), image, container)
    : null;
  const renamed = sources.filter((s) => s.outName);

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

      <div className="space-y-1.5">
        <HintLabel label={t("settings.rowOutputName")} hint={t("settings.namingPatternNote")}
          className="block text-xs font-medium text-muted-foreground" />
        <Input
          ref={patternRef}
          value={outputPattern}
          onChange={(e) => setOutputPattern(e.target.value)}
          placeholder={t("settings.namingPlaceholder")}
          disabled={disabled}
          aria-label={t("settings.rowOutputName")}
          spellCheck={false}
        />
        <div className="flex flex-wrap gap-1">
          {NAME_TOKENS.map((token) => (
            <Tooltip key={token}>
              <TooltipTrigger render={<button
                type="button"
                onClick={() => insertToken(token)}
                disabled={disabled}
                className="rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:border-primary hover:text-foreground disabled:opacity-50"
              >{`{${token}}`}</button>} />
              <TooltipContent>{t(`settings.token.${token}`)}</TooltipContent>
            </Tooltip>
          ))}
        </div>
        {preview && (
          <Tooltip>
            <TooltipTrigger render={<p className="truncate font-mono text-[11px] text-muted-foreground" />}>
              {preview}
            </TooltipTrigger>
            <TooltipContent>{preview}</TooltipContent>
          </Tooltip>
        )}
      </div>

      {/* Two sources landing on the same name would overwrite each other: say WHICH name, and offer
          the one-click repair (a counter in the pattern) instead of a bare warning. */}
      {nameReport.collisions.length > 0 && (
        <Card className="block space-y-1.5 border-destructive/40 p-2.5 text-[11px] leading-snug text-destructive">
          <p className="flex items-start gap-1.5 font-medium">
            <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
            {t("settings.namingCollision", { count: nameReport.collisions.length })}
          </p>
          <ul className="space-y-0.5 pl-5">
            {nameReport.collisions.slice(0, 4).map((clash) => (
              <li key={clash.name} className="truncate font-mono">
                {clash.name} <span className="font-sans opacity-80">({t("settings.namingCollisionSources", { count: clash.indexes.length })})</span>
              </li>
            ))}
          </ul>
          <Button variant="outline" size="sm" className="w-full" disabled={disabled}
            onClick={() => setOutputPattern(numberedPattern(outputPattern))}>
            <ListOrdered className="h-3.5 w-3.5" /> {t("settings.namingNumber")}
          </Button>
        </Card>
      )}
      {nameReport.empty.length > 0 && (
        <p className="text-[11px] leading-snug text-destructive">{t("errors.emptyOutputName")}</p>
      )}

      {renamed.length > 0 && (
        <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span className="truncate">{t("settings.namingRenamed", { count: renamed.length })}</span>
          <Button variant="ghost" size="sm" disabled={disabled}
            onClick={() => renamed.forEach((source) => setSourceName(source, null))}>
            <RotateCcw className="h-3.5 w-3.5" /> {t("settings.namingResetAll")}
          </Button>
        </div>
      )}

      {hint && <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p>}
    </Section>
  );
}
