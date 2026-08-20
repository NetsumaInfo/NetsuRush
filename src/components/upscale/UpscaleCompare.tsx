import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X, MoveHorizontal, ZoomIn, RotateCcw, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { FrameCompare } from "./useUpscale";
import { useTranslation } from "react-i18next";

// Hauteur maximale du cadre en mode compact (popup d'upscale du board) : assez pour juger un rendu,
// assez basse pour que les boutons du dialogue restent visibles sans défilement.
const COMPACT_MAX_H = "58vh";
const MIN_SCALE = 1;
const MAX_SCALE = 10;
// Facteur de zoom par pixel de molette : un cran (~100 px) donne ×1,16, assez fin pour viser.
const ZOOM_PER_PX = 0.0015;

// Comparateur de résultats. Les traitements simples gardent le repli original/résultat ; l'upscale
// fournit plusieurs sorties modèle et choisit les deux dernières pour une vraie comparaison A/B.
// Le wipe (poignée) est dans l'espace ÉCRAN (fixe) ; le zoom/pan agit sur les images SOUS la poignée,
// identiquement aux deux côtés → navigation logique, seam stable quel que soit le zoom.
export function UpscaleCompare({ data, onClose, compact }: { data: FrameCompare; onClose: () => void; compact?: boolean }) {
  const { t } = useTranslation("upscale");
  const [pos, setPos] = useState(50);      // position du wipe, % de la boîte (espace écran)
  const [scale, setScale] = useState(1);
  const [pan, setPanState] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const mode = useRef<"wipe" | "pan" | null>(null);
  const last = useRef({ x: 0, y: 0 });
  // Miroir vivant de l'échelle et du déplacement (cf. `applyView`).
  const view = useRef({ s: 1, x: 0, y: 0 });
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
    view.current = { s: 1, x: 0, y: 0 };
    setScale(1); setPanState({ x: 0, y: 0 }); setPos(50);
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

  // Déplacement borné : au-delà du débord réel du zoom, on naviguerait dans du vide et l'image
  // sortirait du cadre sans moyen évident de la retrouver. À l'échelle 1 il n'y a rien à déplacer.
  const clampPan = useCallback((x: number, y: number, s: number) => {
    const r = boxRef.current?.getBoundingClientRect();
    if (!r || s <= 1) return { x: 0, y: 0 };
    const mx = (r.width * (s - 1)) / 2;
    const my = (r.height * (s - 1)) / 2;
    return { x: Math.max(-mx, Math.min(mx, x)), y: Math.max(-my, Math.min(my, y)) };
  }, []);
  // Échelle + déplacement écrits ENSEMBLE, depuis une référence et non depuis l'état : une rafale de
  // molette produit plusieurs événements avant le premier rendu, et les updaters de React sont
  // rejouables — un zoom qui lirait l'état y perdrait des crans ou appliquerait deux fois le même.
  const applyView = useCallback((s: number, x: number, y: number) => {
    const ns = Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));
    const p = clampPan(x, y, ns);
    view.current = { s: ns, ...p };
    setScale(ns);
    setPanState(p);
  }, [clampPan]);

  // Zoom ANCRÉ sur le curseur : le pixel visé reste sous la souris. Sans ça le zoom partait du centre
  // du cadre et le détail qu'on voulait inspecter fuyait hors champ à chaque cran de molette.
  // Repère : `transform: translate(t) scale(s)` autour du centre ⇒ un point local `p` s'affiche en
  // `s·p + t`. Pour figer le point sous le curseur (`q`) : `t' = q − s'·(q − t)/s`.
  const zoomAt = useCallback((clientX: number, clientY: number, next: number) => {
    const { s, x, y } = view.current;
    const ns = Math.max(MIN_SCALE, Math.min(MAX_SCALE, next));
    const r = boxRef.current?.getBoundingClientRect();
    if (!r || ns === s) return applyView(ns, x, y);
    const qx = clientX - (r.left + r.width / 2);
    const qy = clientY - (r.top + r.height / 2);
    applyView(ns, qx - ((qx - x) * ns) / s, qy - ((qy - y) * ns) / s);
  }, [applyView]);

  const reset = useCallback(() => { applyView(1, 0, 0); setPos(50); }, [applyView]);

  // Maj enfoncée = wipe même en zoom : comparer et inspecter sans avoir à dézoomer entre les deux.
  const onDownBg = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    last.current = { x: e.clientX, y: e.clientY };
    setDragging(true);
    if (scale > 1 && !e.shiftKey) { mode.current = "pan"; }
    else { mode.current = "wipe"; wipeFromX(e.clientX); }
  };
  const onDownHandle = (e: React.PointerEvent) => {
    e.stopPropagation(); e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    setDragging(true);
    mode.current = "wipe"; wipeFromX(e.clientX);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!mode.current) return;
    if (mode.current === "wipe") { wipeFromX(e.clientX); return; }
    const dx = e.clientX - last.current.x, dy = e.clientY - last.current.y;
    last.current = { x: e.clientX, y: e.clientY };
    const { s, x, y } = view.current;
    applyView(s, x + dx, y + dy);
  };
  const onUp = () => { mode.current = null; setDragging(false); };

  // Double-clic : zoom sur le point visé, et retour à l'échelle 1 au double-clic suivant.
  const onDoubleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    if (scale > 1) reset();
    else zoomAt(e.clientX, e.clientY, 2.5);
  };

  // Molette = zoom, posé en écouteur natif NON passif : `onWheel` de React l'est, donc son
  // `preventDefault` est ignoré et la popup défilait sous le curseur pendant qu'on zoomait. Le facteur
  // est exponentiel en `deltaY` → même geste au pavé tactile (petits deltas) qu'à la molette (crans).
  const wheel = useRef<(e: WheelEvent) => void>(() => {});
  wheel.current = (e) => {
    e.preventDefault();
    const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    zoomAt(e.clientX, e.clientY, view.current.s * Math.exp(-d * ZOOM_PER_PX));
  };
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => wheel.current(e);
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  const transform = `translate(${pan.x}px, ${pan.y}px) scale(${scale})`;
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
        className="relative mx-auto w-full select-none overflow-hidden rounded-lg bg-black"
        style={{
          aspectRatio: `${1 / ratio}`,
          // En popup, l'aperçu prend toute la largeur offerte — mais un média PORTRAIT deviendrait
          // alors plus haut que l'écran. On le borne en hauteur et on en redéduit la largeur, donc
          // le cadre reste au ratio de la source sans jamais déborder.
          ...(compact ? { maxHeight: COMPACT_MAX_H, width: `min(100%, calc(${COMPACT_MAX_H} / ${ratio}))` } : null),
          cursor: scale > 1 ? (dragging && mode.current === "pan" ? "grabbing" : "grab") : "ew-resize",
          ...checker,
        }}
        onDoubleClick={onDoubleClick}
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

        {/* Zoom courant + retour à l'échelle 1. En popup l'en-tête (et son bouton « réinitialiser »)
            n'existe pas : sans ça, un zoom accidentel n'a aucune sortie visible. */}
        {compact && scale > 1 && (
          <div className="absolute bottom-2 right-2 z-20 flex items-center gap-1">
            <span className="rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-white">{scale.toFixed(1)}×</span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="secondary" size="sm" className="h-5 w-5 p-0"
                    aria-label={t("compare.reset")}
                    onPointerDown={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                    onClick={reset}
                  />
                }
              >
                <RotateCcw className="h-3 w-3" />
              </TooltipTrigger>
              <TooltipContent>{t("compare.reset")}</TooltipContent>
            </Tooltip>
          </div>
        )}

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
