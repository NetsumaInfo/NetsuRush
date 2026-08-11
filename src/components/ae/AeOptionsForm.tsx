// Formulaire d'options de l'export AE (timeline, vidéo, transforms, imbriqué, audio, précompo, sortie).
// Règle de lecture du panneau : une question posée UNE fois, et une ligne qui n'agit pas est GRISÉE,
// jamais retirée — la mise en page ne saute pas et l'on voit toujours de quoi dépend le réglage.
import { useTranslation } from "react-i18next";
import { FolderOpen, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { UP_ABR } from "@/components/upscale/upscaleShared";
import { UpscalePane } from "@/components/upscale/UpscalePane";
import type { AeVideoMode, AeVideoContainer, AeAudioContainer, AePrecompNaming, AePrecompTarget, AeTransformMode, AeNestedMode, AeAudioRenderFmt } from "@/lib/bridge";
import { basename } from "@/lib/utils";
import type { AeCtl } from "./useAeExport";
import {
  VIDEO_MODES, AUDIO_MODES, AE_LOSSY, AUDIO_PRODUCES, AUDIO_RENDER_FORMATS, TRANSFORM_MODES,
  renderFmt, Section, Row, CodecRow, aeUsesCodec, aeWritesVideo,
  audioContainersFor, videoContainersFor,
} from "./aeShared";

interface FormProps {
  ae: AeCtl;
  /** NetsuBridge porte déjà le sélecteur de timeline source — on ne le double pas ici. */
  hideTimeline?: boolean;
  /** Idem pour le nom de la composition : la destination de NetsuBridge EST ce nom. */
  hideCompName?: boolean;
}

export function AeOptionsForm({ ae, hideTimeline = false, hideCompName = false }: FormProps) {
  const { t } = useTranslation("ae");
  const {
    timelines, timelinesError, timelineName, setTimelineName, loadTimelines,
    compName, setCompName,
    videoMode, setVideoMode, codec, setCodec, audio, setAudio, abr, setAbr,
    upscale, setUpscale, growing,
    handleSec, setHandleSec, precomp, setPrecomp,
    precompNaming, setPrecompNaming, precompTarget, setPrecompTarget, folders, setFolders,
    transformMode, setTransformMode,
    nestedMode, setNestedMode,
    audioRenderFmt, setAudioRenderFmt,
    videoContainer, setVideoContainer, audioContainer, setAudioContainer,
    outDir, chooseOut, producesFiles, outputReasons, needsDir, busy,
  } = ae;

  const shape = { videoMode, transformMode, nestedMode, audio };
  const mode = VIDEO_MODES.find((m) => m.id === videoMode);
  const tmode = TRANSFORM_MODES.find((m) => m.id === transformMode);
  const lossy = AE_LOSSY.has(audio);
  const nestedRender = nestedMode === "render";

  // Le codec sert au réencode ffmpeg ET au rendu Resolve d'une timeline imbriquée : un seul
  // sélecteur pour les deux.
  const codecUsed = aeUsesCodec(shape);
  const containerUsed = aeWritesVideo(shape);
  // Les poignées ne sont extraites que par le réencode plan par plan ; le bake coupe au cut exact.
  const handlesUsed = videoMode === "reencode";
  const videoContainers = videoContainersFor(codec, videoMode);
  const audioContainers = audioContainersFor(audio);
  // `copy` et `none` ne produisent aucun fichier son : le conteneur ne s'applique qu'aux autres.
  const audioContainerUsed = AUDIO_PRODUCES.has(audio);

  return (
    <Card className="block space-y-6 p-6">
      {!hideTimeline && (
      <Section title={t("sections.timeline")}>
        {timelinesError ? (
          <p className="text-xs text-destructive">{timelinesError}</p>
        ) : (
          <div className="flex items-center gap-2">
            <Select value={timelineName ?? ""} onValueChange={(v) => setTimelineName(String(v))}
              items={timelines.map((tl) => ({ value: tl.name, label: tl.current ? t("form.timelineOpen", { name: tl.name }) : tl.name }))}
              disabled={busy || !timelines.length}>
              <SelectTrigger className="flex-1"><SelectValue placeholder={t("form.noTimeline")} /></SelectTrigger>
              <SelectContent>
                {timelines.map((tl) => (
                  <SelectItem key={tl.name} value={tl.name}>{tl.current ? t("form.timelineOpen", { name: tl.name }) : tl.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Tooltip>
              <TooltipTrigger render={<Button variant="outline" size="icon" onClick={loadTimelines} disabled={busy}><RefreshCw className="h-4 w-4" /></Button>} />
              <TooltipContent>{t("form.refresh")}</TooltipContent>
            </Tooltip>
          </div>
        )}
      </Section>
      )}

      {!hideCompName && (
        <Section title={t("sections.compName")}>
          <Input
            value={compName}
            disabled={busy}
            placeholder={timelineName ?? t("form.compPlaceholder")}
            onChange={(e) => setCompName(e.target.value)}
          />
        </Section>
      )}

      <Section title={t("sections.video")}>
        <ToggleGroup className="w-full" value={[videoMode]}
          onValueChange={(v) => v[0] && setVideoMode(v[0] as AeVideoMode)}>
          {VIDEO_MODES.map((m) => (
            <ToggleGroupItem key={m.id} className="flex-1" value={m.id} disabled={busy || growing}>{t(m.label)}</ToggleGroupItem>
          ))}
        </ToggleGroup>
        {mode && <p className="text-[11px] leading-snug text-muted-foreground">{t(mode.hint)}</p>}
        {growing && <p className="text-[11px] leading-snug text-amber-400">{t("form.upscaleForcesReencode")}</p>}
        {/* Le bake IMPOSE le réencode côté core : le dire ici, sinon le mode affiché ment. */}
        {transformMode === "bake" && videoMode !== "reencode" && (
          <p className="text-[11px] leading-snug text-amber-400">{t("form.bakeForcesReencode")}</p>
        )}

        <CodecRow codec={codec} setCodec={setCodec} busy={busy} disabled={!codecUsed} />

        <Row label={t("form.container")} disabled={!containerUsed}>
          <Select value={videoContainer} onValueChange={(v) => setVideoContainer(v as AeVideoContainer)}
            items={videoContainers.map((c) => ({ value: c, label: c.toUpperCase() }))}
            disabled={busy || !containerUsed || videoContainers.length < 2}>
            <SelectTrigger className="w-[58%]"><SelectValue>{videoContainer.toUpperCase()}</SelectValue></SelectTrigger>
            <SelectContent>
              {videoContainers.map((c) => <SelectItem key={c} value={c}>{c.toUpperCase()}</SelectItem>)}
            </SelectContent>
          </Select>
        </Row>

        <Row label={t("form.handleSeconds")} disabled={!handlesUsed}>
          <Input type="number" min={0} step={0.5} value={handleSec} disabled={busy || !handlesUsed}
            onChange={(e) => setHandleSec(Math.max(0, Number(e.target.value) || 0))}
            className="w-24 text-right tabular-nums" />
        </Row>
      </Section>

      {/* Le volet porte son propre en-tête : une Section par-dessus répéterait le titre. */}
      <UpscalePane
        value={upscale}
        onChange={(patch) => setUpscale((u) => ({ ...u, ...patch }))}
        label={t("sections.upscale")}
        onLabel={t("form.yes")}
        offLabel={t("form.no")}
        disabled={busy}
      />

      <Section title={t("sections.transforms")}>
        <Select value={transformMode} onValueChange={(v) => setTransformMode(v as AeTransformMode)}
          items={TRANSFORM_MODES.map((m) => ({ value: m.id, label: t(m.label) }))} disabled={busy}>
          <SelectTrigger><SelectValue>{tmode && t(tmode.label)}</SelectValue></SelectTrigger>
          <SelectContent>
            {TRANSFORM_MODES.map((m) => <SelectItem key={m.id} value={m.id}>{t(m.label)}</SelectItem>)}
          </SelectContent>
        </Select>
        {tmode && <p className="text-[11px] leading-snug text-muted-foreground">{t(tmode.hint)}</p>}
      </Section>

      <Section title={t("sections.nested")}>
        <Row label={t("form.mode")}>
          <ToggleGroup value={[nestedMode]}
            onValueChange={(v) => v[0] && setNestedMode(v[0] as AeNestedMode)}>
            <ToggleGroupItem value="flatten" disabled={busy}>{t("form.nestedFlatten")}</ToggleGroupItem>
            <ToggleGroupItem value="comp" disabled={busy}>{t("form.nestedComp")}</ToggleGroupItem>
            <ToggleGroupItem value="render" disabled={busy}>{t("form.nestedRender")}</ToggleGroupItem>
          </ToggleGroup>
        </Row>
        <p className="text-[11px] leading-snug text-muted-foreground">
          {nestedMode === "comp"
            ? t("form.nestedHintComp")
            : nestedRender
            ? t("form.nestedHintRender")
            : t("form.nestedHintFlatten")}
        </p>
        {/* Le rendu Resolve reprend le codec ci-dessus : format déduit, jamais un second choix. */}
        <Row label={t("form.outputFormat")} disabled={!nestedRender}>
          <span className="text-xs font-medium tabular-nums">{renderFmt(codec)}</span>
        </Row>
        <Row label={t("form.audioFormat")} disabled={!nestedRender}>
          <Select value={audioRenderFmt} onValueChange={(v) => setAudioRenderFmt(v as AeAudioRenderFmt)}
            items={AUDIO_RENDER_FORMATS.map((f) => ({ value: f.id, label: f.label }))} disabled={busy || !nestedRender}>
            <SelectTrigger className="w-[58%]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {AUDIO_RENDER_FORMATS.map((f) => <SelectItem key={f.id} value={f.id}>{f.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </Row>
      </Section>

      <Section title={t("sections.audio")}>
        <Row label={t("form.mode")}>
          <Select value={audio} onValueChange={(v) => setAudio(v as typeof audio)}
            items={AUDIO_MODES.map((a) => ({ value: a.id, label: t(a.label) }))} disabled={busy}>
            <SelectTrigger className="w-[58%]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {AUDIO_MODES.map((a) => <SelectItem key={a.id} value={a.id}>{t(a.label)}</SelectItem>)}
            </SelectContent>
          </Select>
        </Row>
        <Row label={t("form.container")} disabled={!audioContainerUsed}>
          <Select value={audioContainer} onValueChange={(v) => setAudioContainer(v as AeAudioContainer)}
            items={audioContainers.map((c) => ({ value: c, label: c.toUpperCase() }))}
            disabled={busy || !audioContainerUsed || audioContainers.length < 2}>
            <SelectTrigger className="w-[58%]"><SelectValue>{audioContainer.toUpperCase()}</SelectValue></SelectTrigger>
            <SelectContent>
              {audioContainers.map((c) => <SelectItem key={c} value={c}>{c.toUpperCase()}</SelectItem>)}
            </SelectContent>
          </Select>
        </Row>
        <Row label={t("form.bitrate")} disabled={!lossy}>
          <Select value={String(abr)} onValueChange={(v) => setAbr(Number(v))}
            items={UP_ABR.map((b) => ({ value: String(b), label: `${b} kbps` }))} disabled={busy || !lossy}>
            <SelectTrigger className="w-[58%]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {UP_ABR.map((b) => <SelectItem key={b} value={String(b)}>{b} kbps</SelectItem>)}
            </SelectContent>
          </Select>
        </Row>
      </Section>

      <Section title={t("sections.precomp")}>
        <Row label={t("form.precompEach")}>
          <Toggle pressed={precomp} onPressedChange={setPrecomp} disabled={busy}>
            {precomp ? t("form.yes") : t("form.no")}
          </Toggle>
        </Row>
        <Row label={t("form.target")} disabled={!precomp}>
          <ToggleGroup value={[precompTarget]}
            onValueChange={(v) => v[0] && setPrecompTarget(v[0] as AePrecompTarget)}>
            <ToggleGroupItem value="video" disabled={busy || !precomp}>{t("form.targetVideo")}</ToggleGroupItem>
            <ToggleGroupItem value="image" disabled={busy || !precomp}>{t("form.targetImage")}</ToggleGroupItem>
            <ToggleGroupItem value="both" disabled={busy || !precomp}>{t("form.targetBoth")}</ToggleGroupItem>
          </ToggleGroup>
        </Row>
        <Row label={t("form.precompNaming")} disabled={!precomp}>
          <ToggleGroup value={[precompNaming]}
            onValueChange={(v) => v[0] && setPrecompNaming(v[0] as AePrecompNaming)}>
            <ToggleGroupItem value="file" disabled={busy || !precomp}>{t("form.namingFile")}</ToggleGroupItem>
            <ToggleGroupItem value="number" disabled={busy || !precomp}>{t("form.namingNumber")}</ToggleGroupItem>
          </ToggleGroup>
        </Row>
      </Section>

      <Section title={t("sections.organization")}>
        <Row label={t("form.foldersLabel")}>
          <Toggle pressed={folders} onPressedChange={setFolders} disabled={busy}>
            {folders ? t("form.yes") : t("form.no")}
          </Toggle>
        </Row>
      </Section>

      {/* Montrée seulement quand un fichier est réellement écrit, et elle dit lequel. */}
      {producesFiles && (
        <Section title={t("sections.outDir")}>
          <p className="text-[11px] leading-snug text-muted-foreground">
            {t("form.outDirWhy", {
              reasons: outputReasons.map((r) => t(`outDirReasons.${r}`)).join(" · "),
            })}
          </p>
          <Row label={outDir ? basename(outDir) : t("form.none")}>
            <Button variant={needsDir ? "destructive" : "outline"} size="sm" onClick={chooseOut} disabled={busy}>
              <FolderOpen className="h-4 w-4" /> {t("form.choose")}
            </Button>
          </Row>
        </Section>
      )}
    </Card>
  );
}
