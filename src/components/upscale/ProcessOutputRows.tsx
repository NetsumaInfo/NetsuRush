import { Slider } from "@/components/ui/slider";
import { Row, Field, Section } from "./procSettingsParts";
import {
  PNG_BITS, PNG_LEVELS, SEQ_PADDINGS, outputKindFor, sequenceSample,
  type ImageOutputSettings, type ProcImageFormat, type ProcOutputKind,
} from "./imageOutput";
import { useSharedProcSources } from "./useProcSources";
import { useTranslation } from "react-i18next";

// Output block shared by the hub ops: video, still image or numbered image sequence, plus the PNG
// depth / compression and JPEG quality that go with the two image forms.

/** What the CURRENTLY previewed source will write, and what the batch as a whole needs. */
export function useOutputShape(v: ImageOutputSettings) {
  const { active, allStills, stillCount, sources } = useSharedProcSources();
  const kind: ProcOutputKind = outputKindFor(v, active);
  return {
    kind,
    // A still cannot be encoded as a video: its op always writes one image.
    allStills,
    // Mixed batch: the video sources still need their codec, the stills still write images.
    mixed: stillCount > 0 && stillCount < sources.length,
    writesVideo: !allStills && v.outputKind === "video",
    writesImages: allStills || stillCount > 0 || v.outputKind === "sequence",
  };
}

export function ProcessOutputRows({ v, patch, disabled, alphaOnly, videoOnly, videoOnlyNote }: {
  v: ImageOutputSettings;
  patch: (p: Partial<ImageOutputSettings>) => void;
  disabled?: boolean;
  // Cutout output: the carrier must keep an alpha channel, so JPEG is not on the menu.
  alphaOnly?: boolean;
  // Engine that can only write video (RTX VSR): the choice is locked here rather than refused by
  // the core after the user waited for the job.
  videoOnly?: boolean;
  videoOnlyNote?: string;
}) {
  const { t } = useTranslation("upscale");
  const { active, allStills } = useSharedProcSources();
  const shape = useOutputShape(v);
  const kind = videoOnly && shape.kind === "sequence" ? "video" : shape.kind;
  const { mixed } = shape;
  const writesImages = kind !== "video" && shape.writesImages;
  const format: ProcImageFormat = alphaOnly ? "png" : v.imageFormat;
  const base = (active?.name ?? "clip").replace(/\.[^.]+$/, "");

  return (
    <Section title={t("settings.sectionOutput")}>
      <Row label={t("settings.rowOutput")} hint={allStills ? t("settings.outputStillNote") : t("settings.outputHint")}>
        <Field
          value={kind === "image" ? "image" : videoOnly ? "video" : v.outputKind}
          disabled={disabled || allStills || videoOnly}
          onChange={(next) => patch({ outputKind: next === "sequence" ? "sequence" : "video" })}
          items={allStills
            ? [{ value: "image", label: t("settings.output.image") }]
            : [
              { value: "video", label: t("settings.output.video") },
              { value: "sequence", label: t("settings.output.sequence") },
            ]}
        />
      </Row>

      {videoOnly && videoOnlyNote && <p className="text-[11px] leading-snug text-muted-foreground">{videoOnlyNote}</p>}
      {mixed && <p className="text-[11px] leading-snug text-muted-foreground">{t("settings.outputMixedNote")}</p>}

      {writesImages && (
        <>
          {!alphaOnly && (
            <Row label={t("settings.rowImageFormat")}>
              <Field value={format} disabled={disabled}
                onChange={(next) => patch({ imageFormat: next === "jpeg" ? "jpeg" : "png" })}
                items={[
                  { value: "png", label: t("settings.imageFormat.png") },
                  { value: "jpeg", label: t("settings.imageFormat.jpeg") },
                ]} />
            </Row>
          )}

          {format === "png" ? (
            <>
              <Row label={t("settings.rowPngBits")} hint={t("settings.pngBitsNote")}>
                <Field value={String(v.pngBits)} disabled={disabled}
                  onChange={(next) => patch({ pngBits: Number(next) === 16 ? 16 : 8 })}
                  items={PNG_BITS.map((bits) => ({ value: String(bits), label: `${bits}-bit` }))} />
              </Row>
              <Row label={t("settings.rowPngCompression")} hint={t("settings.pngCompressionNote")}>
                <Field value={String(v.pngCompression)} disabled={disabled}
                  onChange={(next) => patch({ pngCompression: Number(next) })}
                  items={PNG_LEVELS.map((level) => ({ value: String(level), label: t(`settings.pngLevel.${level}`) }))} />
              </Row>
            </>
          ) : (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>{t("settings.rowJpegQuality")}</span>
                <span className="tabular-nums">{v.jpegQuality}</span>
              </div>
              <Slider min={50} max={100} step={1} value={[v.jpegQuality]} disabled={disabled}
                onValueChange={(next) => {
                  const n = Array.isArray(next) ? next[0] : next;
                  if (n != null) patch({ jpegQuality: n });
                }} />
              <p className="text-[11px] leading-snug text-muted-foreground">{t("settings.jpegQualityNote")}</p>
            </div>
          )}

          {kind === "sequence" && (
            <>
              <Row label={t("settings.rowSeqDigits")}>
                <Field value={String(v.seqPadding)} disabled={disabled}
                  onChange={(next) => patch({ seqPadding: Number(next) })}
                  items={SEQ_PADDINGS.map((digits) => ({ value: String(digits), label: t("settings.seqDigits", { n: digits }) }))} />
              </Row>
              <Row label={t("settings.rowSeqStart")}>
                <Field value={String(v.seqStart)} disabled={disabled}
                  onChange={(next) => patch({ seqStart: Number(next) })}
                  items={[0, 1, 100, 1000, 1001].map((start) => ({ value: String(start), label: String(start) }))} />
              </Row>
              <p className="text-[11px] leading-snug text-muted-foreground">
                {t("settings.seqFolderNote", { file: sequenceSample(base, { ...v, imageFormat: format }) })}
              </p>
            </>
          )}
        </>
      )}
    </Section>
  );
}
