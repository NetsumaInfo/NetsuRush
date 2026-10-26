// Export du board en IMAGE (PNG/JPG), en SVG, ou en BOUCLE ANIMÉE (WebP animé, GIF).
//
// Le rendu ne capture pas le DOM : il repart du modèle (cf. `boardRender`). La taille proposée est
// celle du contenu plus une marge de 3 %, et le ratio est verrouillé — on choisit une définition,
// pas un cadrage. Le SVG, lui, sort à sa taille naturelle : c'est du vectoriel, il se redimensionne
// après coup sans rien perdre.
//
// A looping export plays whatever moves on the board — videos, YouTube, GIFs, image sequences — and
// paints everything else once (cf. `boardLoopRender`).

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileImage, FileCode2, Repeat } from "lucide-react";
import { nr } from "@/lib/bridge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import { fmtBytes } from "@/lib/utils";
import { MiniSelect } from "./inspectorControls";
import { useBoard } from "./useReferenceBoard";
import { defaultExportSize, renderBoardCanvas, renderBoardSvg } from "./boardRender";
import { animatedItems, buildBoardLoopStack, loopLength } from "./boardLoopRender";
import { LOOP_QUALITY_DEFAULT, MAX_LOOP_SEC } from "./boardLoopExport";
import { errorText } from "@/lib/errorText";

type Format = "png" | "jpg" | "svg" | "webp" | "gif";

const FORMATS: { id: Format; label: string; icon: typeof FileImage }[] = [
  { id: "png", label: "PNG", icon: FileImage },
  { id: "jpg", label: "JPG", icon: FileImage },
  { id: "svg", label: "SVG", icon: FileCode2 },
  { id: "webp", label: "WebP", icon: Repeat },
  { id: "gif", label: "GIF", icon: Repeat },
];
const BOARD_LOOP_FPS = [30, 24, 15, 12];
// A board is far larger than a clip: past this width an animated export weighs more than it shows.
const LOOP_DEFAULT_WIDTH = 1280;

export function ExportImageDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { t } = useTranslation("reference");
  const items = useBoard((s) => s.items);
  const selectedIds = useBoard((s) => s.selectedIds);
  const sceneName = useBoard((s) => s.sceneName);
  const setNotice = useBoard((s) => s.setNotice);

  const [format, setFormat] = useState<Format>("png");
  const [selectionOnly, setSelectionOnly] = useState(false);
  const [transparent, setTransparent] = useState(false);
  const [width, setWidth] = useState(0);
  const [busy, setBusy] = useState(false);
  const [fps, setFps] = useState(24);
  const [duration, setDuration] = useState(0);
  // Longest loop found on the board, in seconds; null while unknown. The length follows it until
  // the user types one of their own.
  const [longest, setLongest] = useState<number | null>(null);
  const [ownDuration, setOwnDuration] = useState(false);
  const [seamless, setSeamless] = useState(true);
  const [preparing, setPreparing] = useState(false);
  const [quality, setQuality] = useState(LOOP_QUALITY_DEFAULT);
  const [lossless, setLossless] = useState(false);
  const [gifFine, setGifFine] = useState(true);
  const [pct, setPct] = useState(0);

  const animated = format === "webp" || format === "gif";
  const only = useMemo(
    () => (selectionOnly && selectedIds.length ? new Set(selectedIds) : undefined),
    [selectionOnly, selectedIds],
  );
  const natural = useMemo(() => defaultExportSize(items, only), [items, only]);
  const ratio = natural.h ? natural.w / natural.h : 1;
  const height = Math.max(1, Math.round((width || natural.w) / ratio));
  const videos = useMemo(() => (animated ? animatedItems(items, only) : []), [animated, items, only]);
  const tooLong = duration > MAX_LOOP_SEC;

  // La taille naturelle change avec le contenu ou la portée : on repart d'elle à chaque ouverture.
  useEffect(() => {
    if (open) setWidth(animated ? Math.min(natural.w, LOOP_DEFAULT_WIDTH) : natural.w);
  }, [open, natural.w, animated]);
  useEffect(() => { if (!selectedIds.length) setSelectionOnly(false); }, [selectedIds.length]);

  // Proposed length = the longest loop on the board: every clip then shows its whole range at
  // least once, the shorter ones replaying theirs. A medium still to be downloaded has no known
  // length yet: the core measures it at export time, and widens the length if nobody typed one.
  useEffect(() => {
    if (!open || !videos.length) return setLongest(null);
    let live = true;
    void Promise.all(videos.map((it) => loopLength(it).catch(() => null))).then((lengths) => {
      const max = Math.max(0, ...lengths.map((len) => len ?? 0));
      if (live) setLongest(max > 0 ? max : null);
    });
    return () => { live = false; };
  }, [open, videos]);
  const proposed = longest ? Math.round(Math.min(MAX_LOOP_SEC, longest) * 10) / 10 : 0;
  useEffect(() => { if (!ownDuration) setDuration(proposed); }, [ownDuration, proposed]);
  useEffect(() => { if (open) setOwnDuration(false); }, [open]);

  useEffect(() => {
    if (!busy || !animated) return;
    return nr.reference?.onLoopProgress((p) => setPct(p.pct));
  }, [busy, animated]);

  const run = async () => {
    setBusy(true);
    setPct(0);
    try {
      const base = (sceneName || "board").replace(/[\\/:*?"<>|]+/g, "_");
      const dest = await nr.saveFile(`${base}.${format}`, [format]);
      if (!dest) return;

      const background = transparent && (format === "png" || format === "webp") ? null : "var(--color-bg)";
      // Le fond du board est une variable CSS : le canvas veut une couleur réelle.
      const resolved = background
        ? getComputedStyle(document.documentElement).getPropertyValue("--color-bg").trim() || "#0b0b0e"
        : null;

      // Sans pont applicatif (mode navigateur), il n'y a pas d'écriture disque : le dire plutôt que
      // laisser l'assertion exploser sur un objet absent.
      const api = nr.reference;
      if (!api) throw new Error(t("exportImage.noBridge"));

      if (animated) {
        setPreparing(true);
        const { stack, clips } = await buildBoardLoopStack(items, { width, background: resolved, only })
          .finally(() => setPreparing(false));
        if (!clips) throw new Error(t("exportImage.noVideo"));
        const res = await api.exportBoardLoop({
          out: dest, format, fps, stack, seamless,
          duration: ownDuration && duration > 0 ? duration : undefined,
          quality: format === "webp" ? quality : undefined,
          lossless: format === "webp" && lossless,
          gifPalette: gifFine ? "frame" : "global",
        });
        if (res.cancelled) return;
        if (!res.ok) throw new Error(res.error || "export failed");
        setNotice({ kind: "ok", text: t("exportImage.doneSize", { size: fmtBytes(res.bytes) }) });
        onOpenChange(false);
        return;
      }

      if (format === "svg") {
        const svg = await renderBoardSvg(items, { background: resolved, only });
        const res = await api.writeFile(dest, svg, "utf8");
        if (!res.ok) throw new Error(res.error || "write failed");
      } else {
        const canvas = await renderBoardCanvas(items, { width, background: resolved, only });
        const dataUrl = canvas.toDataURL(format === "jpg" ? "image/jpeg" : "image/png", 0.92);
        const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
        const res = await api.writeFile(dest, b64, "base64");
        if (!res.ok) throw new Error(res.error || "write failed");
      }
      setNotice({ kind: "ok", text: t("exportImage.done") });
      onOpenChange(false);
    } catch (e) {
      setNotice({ kind: "error", text: t("exportImage.failed", { error: errorText(e) }) });
    } finally {
      setBusy(false);
    }
  };

  // An animated export can run for a while: leaving the dialog stops it.
  const close = () => {
    if (busy && animated) void nr.reference?.cancelExportLoop();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) close(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("exportImage.title")}</DialogTitle>
          <DialogDescription>{t("exportImage.subtitle")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex gap-1.5">
            {FORMATS.map(({ id, label, icon: Icon }) => (
              <Button
                key={id} size="sm" className="flex-1 gap-1.5 px-2" disabled={busy}
                variant={format === id ? "default" : "outline"}
                onClick={() => setFormat(id)}
              >
                <Icon className="size-3.5" /> {label}
              </Button>
            ))}
          </div>

          {format !== "svg" && (
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Label htmlFor="nr-export-w" className="text-xs text-muted-foreground">{t("exportImage.width")}</Label>
                <Input
                  id="nr-export-w"
                  type="number"
                  min={16}
                  max={20000}
                  value={width || ""}
                  onChange={(e) => setWidth(Math.max(0, Number(e.target.value) || 0))}
                />
              </div>
              <span className="pb-2 text-muted-foreground">×</span>
              <div className="flex-1">
                <Label className="text-xs text-muted-foreground">{t("exportImage.height")}</Label>
                <Input value={height} readOnly tabIndex={-1} />
              </div>
            </div>
          )}

          {animated && (
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Label htmlFor="nr-export-dur" className="text-xs text-muted-foreground">{t("exportImage.duration")}</Label>
                <Input
                  id="nr-export-dur"
                  type="number"
                  min={0.5}
                  max={MAX_LOOP_SEC}
                  step={0.5}
                  value={duration || ""}
                  onChange={(e) => { setOwnDuration(true); setDuration(Math.max(0, Number(e.target.value) || 0)); }}
                />
              </div>
              <div className="flex-1">
                <Label className="text-xs text-muted-foreground">{t("exportLoop.fps")}</Label>
                <MiniSelect
                  ariaLabel={t("exportLoop.fps")} className="w-full"
                  value={fps}
                  onChange={(v) => setFps(Number(v))}
                  items={BOARD_LOOP_FPS.map((f) => ({ value: String(f), label: String(f) }))}
                />
              </div>
            </div>
          )}

          {animated && longest != null && (
            <button
              type="button" disabled={busy}
              className="-mt-2 self-start text-left text-xs text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => setOwnDuration(false)}
            >
              {t("exportImage.longest", { sec: longest.toFixed(1) })}
            </button>
          )}

          {format === "webp" && !lossless && (
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

          <div className="flex flex-col gap-2">
            {!!selectedIds.length && (
              <div className="flex items-center gap-2">
                <Checkbox id="nr-export-sel" checked={selectionOnly} onCheckedChange={(v) => setSelectionOnly(!!v)} />
                <Label htmlFor="nr-export-sel" className="text-sm font-normal">
                  {t("exportImage.selectionOnly", { count: selectedIds.length })}
                </Label>
              </div>
            )}
            {(format === "png" || format === "webp") && (
              <div className="flex items-center gap-2">
                <Checkbox id="nr-export-bg" checked={transparent} onCheckedChange={(v) => setTransparent(!!v)} />
                <Label htmlFor="nr-export-bg" className="text-sm font-normal">{t("exportImage.transparent")}</Label>
              </div>
            )}
            {animated && (
              <div className="flex items-center gap-2">
                <Checkbox id="nr-export-seamless" checked={seamless} onCheckedChange={(v) => setSeamless(!!v)} />
                <Label htmlFor="nr-export-seamless" className="text-sm font-normal">{t("exportImage.seamless")}</Label>
              </div>
            )}
            {format === "gif" && (
              <div className="flex items-center gap-2">
                <Checkbox id="nr-export-gif-fine" checked={gifFine} onCheckedChange={(v) => setGifFine(!!v)} />
                <Label htmlFor="nr-export-gif-fine" className="text-sm font-normal">{t("exportLoop.gifFine")}</Label>
              </div>
            )}
            {format === "webp" && (
              <div className="flex items-center gap-2">
                <Checkbox id="nr-export-lossless" checked={lossless} onCheckedChange={(v) => setLossless(!!v)} />
                <Label htmlFor="nr-export-lossless" className="text-sm font-normal">{t("exportLoop.lossless")}</Label>
              </div>
            )}
          </div>

          {animated && !videos.length ? (
            <p className="text-xs leading-snug text-destructive">{t("exportImage.noVideo")}</p>
          ) : animated && tooLong ? (
            <p className="text-xs leading-snug text-destructive">{t("exportLoop.tooLong", { max: MAX_LOOP_SEC })}</p>
          ) : (
            <p className="text-xs leading-snug text-muted-foreground">
              {t(animated ? "exportImage.hintLoop" : "exportImage.hint")}
            </p>
          )}
          {busy && animated && (preparing
            ? <p className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner className="size-3" /> {t("exportImage.preparing")}</p>
            : <Progress value={pct} />)}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={close} disabled={busy && !animated}>{t("common:action.cancel")}</Button>
          <Button onClick={() => void run()} disabled={busy || (animated && (!videos.length || tooLong || (ownDuration && !(duration > 0))))}>
            {busy && <Spinner />}
            {t("exportImage.export")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
