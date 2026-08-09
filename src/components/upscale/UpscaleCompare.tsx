import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X, MoveHorizontal, ZoomIn, RotateCcw, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { FrameCompare } from "./useUpscale";
import { useTranslation } from "react-i18next";

// Comparateur de résultats. Les traitements simples gardent le repli original/résultat ; l'upscale
// fournit plusieurs sorties modèle et choisit les deux dernières pour une vraie comparaison A/B.
// Le wipe (poignée) est dans l'espace ÉCRAN (fixe) ; le zoom/pan agit sur les images SOUS la poignée,
// identiquement aux deux côtés → navigation logique, seam stable quel que soit le zoom.
export function UpscaleCompare({ data, onClose, compact }: { data: FrameCompare; onClose: () => void; compact?: boolean }) {
  const { t } = useTranslation("upscale");
  const [pos, setPos] = useState(50);      // position du wipe, % de la boîte (espace écran)
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const mode = useRef<"wipe" | "pan" | null>(null);
  const last = useRef({ x: 0, y: 0 });
  // Une URL chargée reste chargée. Les anciens booléens étaient remis à false par un effet exécuté
  // après `onLoad` : les images étaient visibles (comme sur la capture) mais le voile tournait à vie.
  const [loadedUrls, setLoadedUrls] = useState<Set<string>>(() => new Set());
  const [failedUrls, setFailedUrls] = useState<Set<string>>(() => new Set());
  const hasModelComparison = (data.variants?.length ?? 0) >= 2;
  const variants = useMemo(() => hasModelComparison ? data.variants! : [
    { id: "original", label: t("compare.originalLabel"), url: data.origUrl },
    { id: "result", label: t("compare.resultLabel"), url: data.outUrl },
  ], [hasModelComparison, data.variants, data.origUrl, data.outUrl, t]);
  const preferredLeft = hasModelComparison ? data.leftId : undefined;
  const preferredRight = hasModelComparison ? data.rightId : undefined;
  const [leftId, setLeftId] = useState(preferredLeft ?? variants[0].id);
  const [rightId, setRightId] = useState(preferredRight ?? variants[Math.min(1, variants.length - 1)].id);
  const left = variants.find((v) => v.id === leftId) ?? variants[0];
  const right = variants.find((v) => v.id === rightId) ?? variants[Math.min(1, variants.length - 1)];

  useEffect(() => {
    setLeftId(preferredLeft ?? variants[0].id);
    setRightId(preferredRight ?? variants[Math.min(1, variants.length - 1)].id);
    setScale(1); setTx(0); setTy(0); setPos(50);
  }, [data.revision, preferredLeft, preferredRight, variants]);

  const markLoaded = useCallback((url: string) => setLoadedUrls((old) => {
    if (old.has(url)) return old;
    const next = new Set(old); next.add(url); return next;
  }), []);
  const markFailed = useCallback((url: string) => setFailedUrls((old) => {
    if (old.has(url)) return old;
    const next = new Set(old); next.add(url); return next;
  }), []);
  const origLoaded = loadedUrls.has(left.url);
  const upLoaded = loadedUrls.has(right.url);
  const imgErr = failedUrls.has(left.url) || failedUrls.has(right.url);

  const ratio = data.width && data.height ? data.height / data.width : 9 / 16;

  const wipeFromX = useCallback((clientX: number) => {
    const el = boxRef.current; if (!el) return;
    const r = el.getBoundingClientRect();
    setPos(Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100)));
  }, []);

  const onDownBg = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    last.current = { x: e.clientX, y: e.clientY };
    if (scale > 1) { mode.current = "pan"; }            // zoomé → on navigue (pan)
    else { mode.current = "wipe"; wipeFromX(e.clientX); } // pas zoomé → wipe
  };
  const onDownHandle = (e: React.PointerEvent) => {
    e.stopPropagation(); e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    mode.current = "wipe"; wipeFromX(e.clientX);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!mode.current) return;
    if (mode.current === "wipe") { wipeFromX(e.clientX); return; }
    setTx((v) => v + (e.clientX - last.current.x));
    setTy((v) => v + (e.clientY - last.current.y));
    last.current = { x: e.clientX, y: e.clientY };
  };
  const onUp = () => { mode.current = null; };

  const onWheel = (e: React.WheelEvent) => {
    const next = Math.max(1, Math.min(10, scale * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
    setScale(next);
    if (next === 1) { setTx(0); setTy(0); }
  };
  const reset = () => { setScale(1); setTx(0); setTy(0); setPos(50); };

  const transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  const imgStyle = { transform, transformOrigin: "center" as const };
  const imgCls = "absolute inset-0 h-full w-full object-contain";

  // Damier alpha : sortie détourée (removeBG) = PNG à canal alpha. Le côté « Après » est posé SUR
  // l'original opaque → sans fond dédié, les zones effacées révéleraient l'original (on ne verrait pas
  // le détourage). On glisse donc un damier SOUS le côté « Après » (dans le calque clippé) : le
  // transparent laisse voir le damier, pas l'original. Rien à changer côté « Avant » (opaque).
  const checker: React.CSSProperties = data.alpha ? {
    backgroundColor: "#1c1c1c",
    backgroundImage:
      "linear-gradient(45deg,#3a3a3a 25%,transparent 25%),linear-gradient(-45deg,#3a3a3a 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#3a3a3a 75%),linear-gradient(-45deg,transparent 75%,#3a3a3a 75%)",
    backgroundSize: "16px 16px",
    backgroundPosition: "0 0,0 8px,8px -8px,-8px 0",
  } : {};

  return (
    <div className="space-y-2">
      {!compact && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex flex-wrap items-center gap-2 text-xs font-medium text-muted-foreground">
            <span className="flex items-center gap-1"><MoveHorizontal className="h-3.5 w-3.5" /> {hasModelComparison ? t("compare.modelResults") : t("compare.beforeAfter")}</span>
            <span>· {data.width}×{data.height}</span>
            <span className="flex items-center gap-1"><ZoomIn className="h-3.5 w-3.5" /> {scale.toFixed(1)}×</span>
          </span>
          {variants.length > 1 && (
            <div className="flex min-w-0 flex-1 flex-wrap items-center justify-center gap-1.5">
              <Select value={left.id} onValueChange={(v) => setLeftId(String(v))}>
                <SelectTrigger size="sm" className="min-w-32 max-w-52 flex-1" aria-label={t("compare.leftModel")}><SelectValue>{left.label}</SelectValue></SelectTrigger>
                <SelectContent>{variants.map((v) => <SelectItem key={v.id} value={v.id}>{v.label}</SelectItem>)}</SelectContent>
              </Select>
              <MoveHorizontal className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <Select value={right.id} onValueChange={(v) => setRightId(String(v))}>
                <SelectTrigger size="sm" className="min-w-32 max-w-52 flex-1" aria-label={t("compare.rightModel")}><SelectValue>{right.label}</SelectValue></SelectTrigger>
                <SelectContent>{variants.map((v) => <SelectItem key={v.id} value={v.id}>{v.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          )}
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={reset}><RotateCcw className="h-4 w-4" /> {t("compare.reset")}</Button>
            <Button variant="ghost" size="sm" onClick={onClose}><X className="h-4 w-4" /> {t("compare.close")}</Button>
          </div>
        </div>
      )}

      <div
        ref={boxRef}
        className="relative w-full select-none overflow-hidden rounded-lg bg-black"
        style={{ aspectRatio: `${1 / ratio}`, cursor: scale > 1 ? "grab" : "ew-resize", ...checker }}
        onWheel={onWheel}
        onPointerDown={onDownBg}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onLostPointerCapture={onUp}
      >
        {/* résultat gauche — plein cadre, sous tout */}
        <img src={left.url} alt={left.label} draggable={false} className={imgCls} style={imgStyle}
          onLoad={() => markLoaded(left.url)} onError={() => markFailed(left.url)} />
        {/* résultat droit / détouré — révélé à DROITE de la poignée (clip l'espace écran à gauche). Le damier
            (si alpha) est porté par ce calque → visible seulement sous le côté « Après ». */}
        <div className="absolute inset-0" style={{ clipPath: `inset(0 0 0 ${pos}%)`, ...checker }}>
          <img src={right.url} alt={right.label} draggable={false} className={imgCls} style={imgStyle}
            onLoad={() => markLoaded(right.url)} onError={() => markFailed(right.url)} />
        </div>

        {/* chargement / erreur (sinon écran noir silencieux pendant le décodage des gros PNG) */}
        {!imgErr && (!origLoaded || !upLoaded) && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/50 text-xs text-white">
            <Spinner className="mr-2 h-4 w-4" /> {t("compare.loadingCompare")}
          </div>
        )}
        {imgErr && (
          <div className="absolute inset-0 flex items-center justify-center gap-1.5 bg-black/70 px-4 text-center text-xs text-white">
            <AlertTriangle className="h-4 w-4" /> {t("compare.previewMissing")}
          </div>
        )}

        <span className="pointer-events-none absolute left-2 top-2 max-w-[42%] truncate rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">{left.label}</span>
        <span className="pointer-events-none absolute right-2 top-2 max-w-[42%] truncate rounded bg-primary/80 px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground">{right.label}</span>

        {/* poignée (espace écran) */}
        <div className="absolute inset-y-0 z-10 w-0.5 -ml-px bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.5)]" style={{ left: `${pos}%` }}>
          <div
            onPointerDown={onDownHandle}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            onLostPointerCapture={onUp}
            className="absolute top-1/2 left-1/2 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize items-center justify-center rounded-full bg-white text-black shadow-lg"
          >
            <MoveHorizontal className="h-4 w-4" />
          </div>
        </div>
      </div>

      {!compact && (
        <p className="text-[11px] text-muted-foreground">
          {scale > 1 ? t("compare.hintZoomed") : t("compare.hintNotZoomed")}
        </p>
      )}
    </div>
  );
}
