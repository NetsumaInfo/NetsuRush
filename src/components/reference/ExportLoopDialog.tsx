// Export of a video item as a looping animated image: animated WebP (default) or GIF.
//
// The export follows what the board shows of the clip — its loop bounds, crop and mirror — and is
// written where the user chooses. The item itself is left untouched.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Repeat } from "lucide-react";
import { nr, type LoopFormat } from "@/lib/bridge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { fmtBytes } from "@/lib/utils";
import { errorText } from "@/lib/errorText";
import { isCoreFileRef, type BoardItem } from "./referenceShared";
import { MiniSelect } from "./inspectorControls";
import { useBoard } from "./useReferenceBoard";
import { ensureLocalMedia } from "./boardUpscale";
import {
  LOOP_FORMATS, LOOP_FPS, LOOP_QUALITY_DEFAULT, LOOP_WIDTHS, MAX_LOOP_SEC, loopFileName, loopSpan,
} from "./boardLoopExport";

const LOSSLESS_ID = "loop-export-lossless";
const GIF_FINE_ID = "loop-export-gif-fine";

export function ExportLoopDialog({
  item,
  open,
  onOpenChange,
}: {
  item: BoardItem;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { t } = useTranslation("reference");
  const setNotice = useBoard((s) => s.setNotice);
  const [format, setFormat] = useState<LoopFormat>("webp");
  const [width, setWidth] = useState(0);
  const [fps, setFps] = useState(0);
  const [quality, setQuality] = useState(LOOP_QUALITY_DEFAULT);
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [lossless, setLossless] = useState(false);
  const [gifFine, setGifFine] = useState(true);
  // undefined = being measured, null = no estimate available.
  const [estimate, setEstimate] = useState<number | null | undefined>(null);

  const span = loopSpan(item);
  const tooLong = span.sec != null && span.sec > MAX_LOOP_SEC;
  const { in: spanIn, end: spanEnd } = span;
  const { ref, crop, flipH, flipV } = item;

  // Estimated weight, re-measured when a setting changes. Only for a file already on disk: fetching
  // a remote medium is the export's job, not a side effect of opening the dialog.
  useEffect(() => {
    const api = nr.reference;
    if (!open || busy || tooLong || !api || !isCoreFileRef(ref)) return setEstimate(null);
    let live = true;
    setEstimate(undefined);
    const timer = setTimeout(() => {
      void api.estimateLoop({
        path: ref, format, in: spanIn, end: spanEnd,
        fps: fps || undefined, width: width || undefined,
        quality: format === "webp" ? quality : undefined,
        lossless: format === "webp" && lossless,
        gifPalette: gifFine ? "frame" : "global",
        crop, flipH, flipV,
      }).then((r) => {
        if (live && !r.stale) setEstimate(r.ok && r.bytes ? r.bytes : null);
      }).catch(() => { if (live) setEstimate(null); });
    }, 350);
    return () => { live = false; clearTimeout(timer); };
  }, [open, busy, tooLong, ref, format, width, fps, quality, lossless, gifFine, spanIn, spanEnd, crop, flipH, flipV]);

  useEffect(() => {
    if (!busy) return;
    return nr.reference?.onLoopProgress((p) => setPct(p.pct));
  }, [busy]);

  async function run() {
    const api = nr.reference;
    if (!api) return setError(t("upscale.moduleUnavailable"));
    setError(null);
    const out = await nr.saveFile(loopFileName(item.title, format), [format]);
    if (!out) return;
    setBusy(true);
    setPct(0);
    try {
      const input = await ensureLocalMedia(item.ref);
      if (!input) return setError(t("upscale.remoteFail"));
      const r = await api.exportLoop({
        path: input, out, format,
        in: span.in, end: span.end,
        fps: fps || undefined, width: width || undefined,
        quality: format === "webp" ? quality : undefined,
        lossless: format === "webp" && lossless,
        gifPalette: gifFine ? "frame" : "global",
        crop: item.crop, flipH: item.flipH, flipV: item.flipV,
      });
      if (r.cancelled) return;
      if (!r.ok) return setError(r.error || t("exportLoop.failed"));
      setNotice({ kind: "ok", text: t("exportLoop.done", { size: fmtBytes(r.bytes) }) });
      onOpenChange(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  // Closing while an export runs stops it: nothing would be left to report its end to.
  function close() {
    if (busy) void nr.reference?.cancelExportLoop();
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) close(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Repeat className="size-4" /> {t("exportLoop.title")}
          </DialogTitle>
          <DialogDescription>{t("exportLoop.subtitle")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <ToggleGroup value={[format]} onValueChange={(v) => v[0] && setFormat(v[0] as LoopFormat)}>
              {LOOP_FORMATS.map((f) => (
                <ToggleGroupItem key={f} value={f} disabled={busy}>{f === "webp" ? "WebP" : "GIF"}</ToggleGroupItem>
              ))}
            </ToggleGroup>
            <p className="text-xs leading-snug text-muted-foreground">{t(`exportLoop.hint.${format}`)}</p>
          </div>

          <div className={`flex gap-3 ${busy ? "pointer-events-none opacity-60" : ""}`}>
            <div className="flex-1 space-y-1.5">
              <span className="text-xs text-muted-foreground">{t("exportLoop.width")}</span>
              <MiniSelect
                ariaLabel={t("exportLoop.width")} className="w-full"
                value={width}
                onChange={(v) => setWidth(Number(v))}
                items={LOOP_WIDTHS.map((w) => ({ value: String(w), label: w ? `${w} px` : t("exportLoop.source") }))}
              />
            </div>
            <div className="flex-1 space-y-1.5">
              <span className="text-xs text-muted-foreground">{t("exportLoop.fps")}</span>
              <MiniSelect
                ariaLabel={t("exportLoop.fps")} className="w-full"
                value={fps}
                onChange={(v) => setFps(Number(v))}
                items={LOOP_FPS.map((f) => ({ value: String(f), label: f ? String(f) : t("exportLoop.source") }))}
              />
            </div>
          </div>

          {format === "webp" && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Checkbox id={LOSSLESS_ID} checked={lossless} disabled={busy} onCheckedChange={(v) => setLossless(!!v)} />
                <Label htmlFor={LOSSLESS_ID} className="text-sm font-normal">{t("exportLoop.lossless")}</Label>
              </div>
              {!lossless && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">{t("exportLoop.quality")}</span>
                    <span className="text-xs tabular-nums text-muted-foreground">{quality}</span>
                  </div>
                  <Slider
                    value={[quality]}
                    min={40} max={100} step={5} disabled={busy}
                    onValueChange={(v) => setQuality(Array.isArray(v) ? v[0] : v)}
                  />
                </div>
              )}
            </div>
          )}

          {format === "gif" && (
            <div className="flex items-center gap-2">
              <Checkbox id={GIF_FINE_ID} checked={gifFine} disabled={busy} onCheckedChange={(v) => setGifFine(!!v)} />
              <Label htmlFor={GIF_FINE_ID} className="text-sm font-normal">{t("exportLoop.gifFine")}</Label>
            </div>
          )}

          <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
            {span.sec != null && (
              <span className={tooLong ? "text-destructive" : undefined}>
                {tooLong
                  ? t("exportLoop.tooLong", { max: MAX_LOOP_SEC })
                  : t("exportLoop.duration", { sec: span.sec.toFixed(1) })}
              </span>
            )}
            {estimate !== null && !busy && (
              <span className="ml-auto flex items-center gap-1.5 tabular-nums">
                {estimate === undefined
                  ? <><Spinner className="size-3" /> {t("exportLoop.estimating")}</>
                  : t("exportLoop.estimate", { size: fmtBytes(estimate) })}
              </span>
            )}
          </div>
          {busy && <Progress value={pct} />}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={close}>{t("common:action.cancel")}</Button>
          <Button onClick={() => void run()} disabled={busy || tooLong}>
            {busy ? t("exportLoop.exporting") : t("exportLoop.export")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
