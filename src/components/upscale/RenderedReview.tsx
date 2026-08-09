import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Columns2, FileOutput, X } from "lucide-react";
import { nr, type PlayInfo } from "@/lib/bridge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { FrameCompare, RenderReview } from "./useProcSources";
import { UpscalePlayer } from "./UpscalePlayer";
import { useTranslation } from "react-i18next";

type ReviewSide = "before" | "after";

export function RenderedReview({
  review, reviews, sourceDuration, sourceNative, sourceFps, onSelect, onClose, onCompare,
}: {
  review: RenderReview;
  reviews: RenderReview[];
  sourceDuration: number;
  sourceNative: boolean;
  sourceFps: number;
  onSelect: (id: string) => void;
  onClose: () => void;
  onCompare: (data: FrameCompare) => void;
}) {
  const { t } = useTranslation("upscale");
  const [side, setSide] = useState<ReviewSide>("after");
  const [outputInfo, setOutputInfo] = useState<PlayInfo | null>(null);
  const [progress, setProgress] = useState(0);
  const [goto, setGoto] = useState<{ t: number; n: number } | null>(null);
  const [comparing, setComparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nonce = useRef(0);

  useEffect(() => {
    let active = true;
    setSide("after"); setProgress(0); setGoto(null); setError(null); setOutputInfo(null);
    nr.playInfo(review.outputPath)
      .then((info) => { if (active) { setOutputInfo(info); if (info.error) setError(info.error); } })
      .catch((e) => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [review.id, review.outputPath]);

  const beforeStart = review.sourceStart || 0;
  const beforeEnd = review.sourceEnd ?? sourceDuration;
  const beforeDuration = Math.max(0, beforeEnd - beforeStart) || sourceDuration;
  const afterDuration = outputInfo?.duration || beforeDuration;
  const timeFor = (target: ReviewSide, p: number) => target === "before"
    ? beforeStart + p * beforeDuration
    : p * afterDuration;

  const switchSide = (next: ReviewSide) => {
    if (next === side) return;
    setSide(next);
    setGoto({ t: timeFor(next, progress), n: ++nonce.current });
  };

  const onTime = (time: number) => {
    const p = side === "before"
      ? (time - beforeStart) / Math.max(beforeDuration, 0.001)
      : time / Math.max(afterDuration, 0.001);
    setProgress(Math.max(0, Math.min(1, p)));
  };

  const compare = async () => {
    if (comparing) return;
    setComparing(true); setError(null);
    try {
      const r = await nr.compareRenderFrames({
        beforePath: review.sourcePath,
        afterPath: review.outputPath,
        beforeTime: timeFor("before", progress),
        afterTime: timeFor("after", progress),
      });
      if (!r.ok || !r.before || !r.after) {
        setError(r.error || t("review.compareFailed"));
        return;
      }
      onCompare({
        origUrl: nr.mediaUrl(r.before), outUrl: nr.mediaUrl(r.after),
        width: r.width || 0, height: r.height || 0,
        time: timeFor("before", progress), alpha: review.alpha,
        sourceKey: review.id, configKey: "render-review", revision: Date.now(),
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setComparing(false);
    }
  };

  const path = side === "after" ? review.outputPath : review.sourcePath;
  const duration = side === "after" ? afterDuration : sourceDuration;
  const native = side === "after" ? !!outputInfo?.native : sourceNative;
  const fps = side === "after" ? (outputInfo?.fps || sourceFps) : sourceFps;
  const trimmedSource = side === "before" && (beforeStart > 0 || review.sourceEnd != null);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-ok)]/30 bg-[var(--color-ok)]/5 p-2">
        <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-[var(--color-ok)]">
          <CheckCircle2 className="size-4 shrink-0" /> {t("review.ready")}
        </span>
        <Select value={review.id} onValueChange={(v) => onSelect(String(v))}>
          <SelectTrigger size="sm" className="min-w-44 flex-1" aria-label={t("review.chooseRender")}>
            <FileOutput className="size-3.5 text-muted-foreground" />
            <SelectValue>{review.outputName}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {reviews.map((item) => <SelectItem key={item.id} value={item.id}>{item.outputName}</SelectItem>)}
          </SelectContent>
        </Select>
        <ToggleGroup size="sm" value={[side]} onValueChange={(v) => v[0] && switchSide(v[0] as ReviewSide)}>
          <ToggleGroupItem value="before">{t("compare.before")}</ToggleGroupItem>
          <ToggleGroupItem value="after">{t("compare.after")}</ToggleGroupItem>
        </ToggleGroup>
        <Tooltip>
          <TooltipTrigger render={<Button variant="outline" size="sm" onClick={compare} disabled={comparing || !outputInfo}>
            {comparing ? <Spinner className="size-4" /> : <Columns2 className="size-4" />} {t("review.compareFrame")}
          </Button>} />
          <TooltipContent>{t("review.compareFrameTip")}</TooltipContent>
        </Tooltip>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t("review.backToSource")}>
          <X className="size-4" />
        </Button>
      </div>

      <UpscalePlayer
        key={`${review.id}:${side}`}
        path={path}
        mediaKey={`${review.id}:${side}`}
        duration={duration}
        native={native}
        fps={fps}
        rangeMode={trimmedSource}
        rangeEditable={false}
        rangeIn={trimmedSource ? beforeStart : 0}
        rangeOut={trimmedSource ? beforeEnd : duration}
        onRange={() => {}}
        onTime={onTime}
        goto={goto}
      />

      <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
        <span className="truncate">{side === "after" ? review.outputName : review.sourceName}</span>
        <span className="shrink-0 tabular-nums">{t(`review.mode.${review.mode}`)} · {Math.round(progress * 100)}%</span>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
