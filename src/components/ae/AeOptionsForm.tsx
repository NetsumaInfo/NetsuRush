// Formulaire d'options de l'export AE (timeline, vidéo, transforms, imbriqué, audio, précompo, sortie).
import { useTranslation } from "react-i18next";
import { FolderOpen, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectGroupLabel, SelectItem } from "@/components/ui/select";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { UP_VARIANTS, UP_ABR, codecLabel } from "@/components/upscale/upscaleShared";
import type { AeVideoMode, AeVideoContainer, AeAudioContainer, AePrecompNaming, AePrecompTarget, AeTransformMode, AeNestedMode, AeAudioRenderFmt } from "@/lib/bridge";
import { basename } from "@/lib/utils";
import type { AeCtl } from "./useAeExport";
import {
  VIDEO_MODES, AUDIO_MODES, AE_LOSSY, AUDIO_PRODUCES, VIDEO_CONTAINERS, AUDIO_CONTAINERS,
  AUDIO_RENDER_FORMATS, TRANSFORM_MODES, MONTAGE, renderFmt, Section, Row, CodecRow,
} from "./aeShared";

// `hideTimeline` : NetsuBridge porte déjà le sélecteur de timeline source — on ne le double pas ici.
export function AeOptionsForm({ ae, hideTimeline = false }: { ae: AeCtl; hideTimeline?: boolean }) {
  const { t } = useTranslation("ae");
  const {
    timelines, timelinesError, timelineName, setTimelineName, loadTimelines,
    compName, setCompName,
    videoMode, setVideoMode, codec, setCodec, audio, setAudio, abr, setAbr,
    handleSec, setHandleSec, precomp, setPrecomp,
    precompNaming, setPrecompNaming, precompTarget, setPrecompTarget, folders, setFolders,
    transformMode, setTransformMode,
    nestedMode, setNestedMode,
    audioRenderFmt, setAudioRenderFmt,
    individualRender, setIndividualRender,
    videoContainer, setVideoContainer, audioContainer, setAudioContainer,
    outDir, chooseOut, producesFiles, busy,
  } = ae;

  const mode = VIDEO_MODES.find((m) => m.id === videoMode);
  const tmode = TRANSFORM_MODES.find((m) => m.id === transformMode);
  const lossy = AE_LOSSY.has(audio);
  const needsDir = producesFiles && !outDir;   // dossier obligatoire dès qu'on produit des fichiers

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

      <Section title={t("sections.compName")}>
        <Input
          value={compName}
          disabled={busy}
          placeholder={timelineName ?? t("form.compPlaceholder")}
          onChange={(e) => setCompName(e.target.value)}
        />
      </Section>

      <Section title={t("sections.video")}>
        <ToggleGroup className="w-full" value={[videoMode]}
          onValueChange={(v) => v[0] && setVideoMode(v[0] as AeVideoMode)}>
          {VIDEO_MODES.map((m) => (
            <ToggleGroupItem key={m.id} className="flex-1" value={m.id} disabled={busy || individualRender}>{t(m.label)}</ToggleGroupItem>
          ))}
        </ToggleGroup>
        {mode && !individualRender && <p className="text-[11px] leading-snug text-muted-foreground">{t(mode.hint)}</p>}

        <Row label={t("form.individualRender")}>
          <Toggle pressed={individualRender} onPressedChange={setIndividualRender} disabled={busy}>
            {individualRender ? t("form.yes") : t("form.no")}
          </Toggle>
        </Row>
        {individualRender && (
          <p className="text-[11px] leading-snug text-muted-foreground">{t("form.individualHint")}</p>
        )}

        {(videoMode === "reencode" || individualRender) && (
          <Row label={t("form.codec")}>
            <Select value={codec} onValueChange={(v) => setCodec(v as typeof codec)}
              items={MONTAGE.map((c) => ({ value: c.id, label: c.label }))} disabled={busy}>
              <SelectTrigger className="w-[58%]"><SelectValue>{codecLabel(codec)}</SelectValue></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectGroupLabel>ProRes</SelectGroupLabel>
                  {UP_VARIANTS.prores.map((c) => <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>)}
                </SelectGroup>
                <SelectGroup>
                  <SelectGroupLabel>DNxHR</SelectGroupLabel>
                  {UP_VARIANTS.dnxhr.map((c) => <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>)}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Row>
        )}

        {videoMode === "remux" && !individualRender && (
          <Row label={t("form.container")}>
            <Select value={videoContainer} onValueChange={(v) => setVideoContainer(v as AeVideoContainer)}
              items={VIDEO_CONTAINERS.map((c) => ({ value: c, label: c.toUpperCase() }))} disabled={busy}>
              <SelectTrigger className="w-[58%]"><SelectValue>{videoContainer.toUpperCase()}</SelectValue></SelectTrigger>
              <SelectContent>
                {VIDEO_CONTAINERS.map((c) => <SelectItem key={c} value={c}>{c.toUpperCase()}</SelectItem>)}
              </SelectContent>
            </Select>
          </Row>
        )}
      </Section>

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
            : nestedMode === "render"
            ? t("form.nestedHintRender")
            : t("form.nestedHintFlatten")}
        </p>
        {nestedMode === "render" && (
          <>
            <CodecRow codec={codec} setCodec={setCodec} busy={busy} />
            <Row label={t("form.outputFormat")}><span className="text-xs font-medium tabular-nums">{renderFmt(codec)}</span></Row>
            <Row label={t("form.audioFormat")}>
              <Select value={audioRenderFmt} onValueChange={(v) => setAudioRenderFmt(v as AeAudioRenderFmt)}
                items={AUDIO_RENDER_FORMATS.map((f) => ({ value: f.id, label: f.label }))} disabled={busy}>
                <SelectTrigger className="w-[58%]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {AUDIO_RENDER_FORMATS.map((f) => <SelectItem key={f.id} value={f.id}>{f.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </Row>
          </>
        )}
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
        {AUDIO_PRODUCES.has(audio) && (
          <Row label={t("form.container")}>
            <Select value={audioContainer} onValueChange={(v) => setAudioContainer(v as AeAudioContainer)}
              items={AUDIO_CONTAINERS.map((c) => ({ value: c, label: c.toUpperCase() }))} disabled={busy}>
              <SelectTrigger className="w-[58%]"><SelectValue>{audioContainer.toUpperCase()}</SelectValue></SelectTrigger>
              <SelectContent>
                {AUDIO_CONTAINERS.map((c) => <SelectItem key={c} value={c}>{c.toUpperCase()}</SelectItem>)}
              </SelectContent>
            </Select>
          </Row>
        )}
        {lossy && (
          <Row label={t("form.bitrate")}>
            <Select value={String(abr)} onValueChange={(v) => setAbr(Number(v))}
              items={UP_ABR.map((b) => ({ value: String(b), label: `${b} kbps` }))} disabled={busy}>
              <SelectTrigger className="w-[58%]"><SelectValue /></SelectTrigger>
              <SelectContent>
                {UP_ABR.map((b) => <SelectItem key={b} value={String(b)}>{b} kbps</SelectItem>)}
              </SelectContent>
            </Select>
          </Row>
        )}
      </Section>

      {videoMode === "reencode" && (
        <Section title={t("sections.handles")}>
          <Row label={t("form.handleSeconds")}>
            <Input type="number" min={0} step={0.5} value={handleSec} disabled={busy}
              onChange={(e) => setHandleSec(Math.max(0, Number(e.target.value) || 0))}
              className="w-24 text-right tabular-nums" />
          </Row>
        </Section>
      )}

      <Section title={t("sections.precomp")}>
        <Row label={t("form.precompEach")}>
          <Toggle pressed={precomp} onPressedChange={setPrecomp} disabled={busy}>
            {precomp ? t("form.yes") : t("form.no")}
          </Toggle>
        </Row>
        {precomp && (
          <>
            <Row label={t("form.target")}>
              <ToggleGroup value={[precompTarget]}
                onValueChange={(v) => v[0] && setPrecompTarget(v[0] as AePrecompTarget)}>
                <ToggleGroupItem value="video" disabled={busy}>{t("form.targetVideo")}</ToggleGroupItem>
                <ToggleGroupItem value="image" disabled={busy}>{t("form.targetImage")}</ToggleGroupItem>
                <ToggleGroupItem value="both" disabled={busy}>{t("form.targetBoth")}</ToggleGroupItem>
              </ToggleGroup>
            </Row>
            <Row label={t("form.precompNaming")}>
              <ToggleGroup value={[precompNaming]}
                onValueChange={(v) => v[0] && setPrecompNaming(v[0] as AePrecompNaming)}>
                <ToggleGroupItem value="file" disabled={busy}>{t("form.namingFile")}</ToggleGroupItem>
                <ToggleGroupItem value="number" disabled={busy}>{t("form.namingNumber")}</ToggleGroupItem>
              </ToggleGroup>
            </Row>
          </>
        )}
      </Section>

      <Section title={t("sections.organization")}>
        <Row label={t("form.foldersLabel")}>
          <Toggle pressed={folders} onPressedChange={setFolders} disabled={busy}>
            {folders ? t("form.yes") : t("form.no")}
          </Toggle>
        </Row>
      </Section>

      {producesFiles && (
        <Section title={t("sections.outDir")}>
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
