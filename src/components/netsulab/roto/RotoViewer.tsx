import { useCallback, useMemo, useRef, useState } from "react";
import { nr } from "@/lib/bridge";
import { colorOf } from "./rotoShared";
import type { RotoSession } from "./useRotoSession";
import { useTranslation } from "react-i18next";

// Zone image du Roto Studio : frame + overlay de masque + points, avec ZOOM (molette, 1×→8×,
// centré sur le curseur) et PAN (glisser clic milieu, ou clic gauche zoomé + Alt) pour poser des
// points au pixel près. Double-clic = recadrer. Survol Maj = preview du masque « et si » (Ctrl+Maj
// = point d'exclusion). Coordonnées normalisées 0..1 lues sur le rect TRANSFORMÉ (le zoom est
// transparent pour la pose de points). Aucune anim JS — une transform CSS pilotée par état.
export function RotoViewer({ s, shown, stopPlayback }: {
  s: RotoSession; shown: string | null; stopPlayback: () => void;
}) {
  const { t } = useTranslation("roto");
  const contentRef = useRef<HTMLDivElement>(null);
  const [z, setZ] = useState({ k: 1, x: 0, y: 0 });
  const drag = useRef<{ px: number; py: number; x: number; y: number; moved: boolean } | null>(null);
  // Glisser d'un point posé : {obj, index} en cours + position live normalisée. pointGesture = un
  // geste sur un point a démarré (le clic de fin ne doit PAS poser un nouveau point).
  const ptDrag = useRef<{ obj: number; index: number; moved: boolean } | null>(null);
  const pointGesture = useRef(false);
  const [ptLive, setPtLive] = useState<{ x: number; y: number } | null>(null);

  // Points de la frame courante + index PAR objet (clé de déplacement/retrait, cohérente avec la table).
  const pts = useMemo(() => {
    const per: Record<number, number> = {};
    return s.points.map((p) => {
      const index = per[p.obj] ?? 0; per[p.obj] = index + 1;
      return { x: p.x, y: p.y, label: p.label, obj: p.obj, index };
    });
  }, [s.points]);

  // Point posé sous le curseur (seuil ~16 px écran sur le rect transformé) → glisser/sélection.
  const hitPoint = useCallback((nx: number, ny: number, w: number, h: number) => {
    let best: { obj: number; index: number } | null = null, bestD = 16 * 16;
    for (const p of pts) {
      const dx = (p.x - nx) * w, dy = (p.y - ny) * h, d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = { obj: p.obj, index: p.index }; }
    }
    return best;
  }, [pts]);

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const outer = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - outer.left, py = e.clientY - outer.top;
    setZ((cur) => {
      const k = Math.min(8, Math.max(1, cur.k * (e.deltaY < 0 ? 1.25 : 0.8)));
      if (k === 1) return { k: 1, x: 0, y: 0 };
      // Garde le point sous le curseur immobile : c = (p - t)/k ; t' = p - c·k'.
      const cx = (px - cur.x) / cur.k, cy = (py - cur.y) / cur.k;
      return { k, x: px - cx * k, y: py - cy * k };
    });
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    const pan = e.button === 1 || (e.button === 0 && e.altKey && z.k > 1);
    if (pan) {
      e.preventDefault();
      drag.current = { px: e.clientX, py: e.clientY, x: z.x, y: z.y, moved: false };
      try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* */ }
      return;
    }
    // Clic gauche SUR un point posé → sélection + glisser (sinon on laisse le clic poser un point).
    if (e.button === 0 && contentRef.current && s.dims && !e.shiftKey) {
      const r = contentRef.current.getBoundingClientRect();
      const nx = (e.clientX - r.left) / r.width, ny = (e.clientY - r.top) / r.height;
      const hit = hitPoint(nx, ny, r.width, r.height);
      if (hit) {
        e.preventDefault();
        stopPlayback();
        s.selectPoint({ f: s.frame, obj: hit.obj, index: hit.index });
        ptDrag.current = { ...hit, moved: false };
        pointGesture.current = true;
        setPtLive({ x: nx, y: ny });
        try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* */ }
      }
    }
  }, [z, s, hitPoint, stopPlayback]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const pd = ptDrag.current;
    if (pd && contentRef.current) {
      const r = contentRef.current.getBoundingClientRect();
      const nx = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      const ny = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
      pd.moved = true;
      setPtLive({ x: nx, y: ny });
      return;
    }
    const d = drag.current;
    if (d) {
      const dx = e.clientX - d.px, dy = e.clientY - d.py;
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
      setZ((cur) => ({ ...cur, x: d.x + dx, y: d.y + dy }));
      return;
    }
    // Survol Maj → preview du point candidat (debounce dans la session). Ctrl inverse la polarité.
    if (e.shiftKey && contentRef.current) {
      const r = contentRef.current.getBoundingClientRect();
      const nx = (e.clientX - r.left) / r.width, ny = (e.clientY - r.top) / r.height;
      const lbl = (e.ctrlKey ? (s.pointLabel ? 0 : 1) : s.pointLabel) as 0 | 1;
      if (nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1) s.previewPoint(nx, ny, lbl);
    } else if (s.previewSrc) s.clearPreview();
  }, [s]);

  const onPointerUp = useCallback(() => {
    const pd = ptDrag.current;
    if (pd) {
      ptDrag.current = null;
      const live = ptLive; setPtLive(null);
      if (pd.moved && live) void s.movePoint(s.frame, pd.obj, pd.index, live.x, live.y);
      return;
    }
    drag.current = null;
  }, [s, ptLive]);

  const place = useCallback((e: React.MouseEvent, label: 0 | 1) => {
    e.preventDefault();
    e.stopPropagation();   // le clic droit pose un point → pas le menu custom global du fond de vue
    if (pointGesture.current) { pointGesture.current = false; return; }   // sélection/glisser d'un point, pas une pose
    if (drag.current?.moved) return;   // fin de pan, pas un clic
    const el = contentRef.current; if (!el) return;
    stopPlayback();   // fige la lecture pour poser un point sur l'image courante
    const r = el.getBoundingClientRect();
    const nx = (e.clientX - r.left) / r.width, ny = (e.clientY - r.top) / r.height;
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return;
    void s.addPoint(nx, ny, label);
  }, [s, stopPlayback]);

  return (
    <div
      className="relative max-h-[62vh] w-full min-w-0 max-w-full overflow-hidden rounded-lg border border-border bg-black"
      style={{ aspectRatio: s.dims && s.dims.w ? `${s.dims.w}/${s.dims.h}` : "16/9", touchAction: "none" }}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => { drag.current = null; ptDrag.current = null; setPtLive(null); s.clearPreview(); }}
      onDoubleClick={() => setZ({ k: 1, x: 0, y: 0 })}
      onClick={(e) => place(e, s.pointLabel)}
      onContextMenu={(e) => place(e, 0)}
    >
      <div
        ref={contentRef}
        className="absolute inset-0"
        style={{ transform: `translate(${z.x}px, ${z.y}px) scale(${z.k})`, transformOrigin: "0 0" }}
      >
        {/* Damier sous le mode Alpha (le PNG plein est RGBA → l'alpha se lit dessus). */}
        {s.overlayFull && s.view.mode === "alpha" && (
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundImage:
                "conic-gradient(#3a3a3a 0 25%, #262626 0 50%, #3a3a3a 0 75%, #262626 0)",
              backgroundSize: "16px 16px",
            }}
          />
        )}
        {/* En rendu pleine image (matte/alpha/fond couleur), l'overlay REMPLACE la frame. */}
        {shown && !(s.overlayFull && s.overlaySrc) && (
          <img src={shown} alt="" className="h-full w-full object-contain" draggable={false} />
        )}
        {s.overlaySrc && (
          <img
            src={s.overlaySrc} alt=""
            className="pointer-events-none absolute inset-0 h-full w-full object-contain"
            style={s.view.mode === "edit" ? { opacity: s.view.opacity / 100 } : undefined}
          />
        )}
        {/* Matte union LIVE pendant la propagation : PNG N&B tout juste écrit, servi /media, teinté
            via mask-image luminance (Chromium 120+) — le daemon reste libre de suivre. */}
        {s.liveMatte && (
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundColor: "rgba(34, 197, 94, 0.45)",
              maskImage: `url("${s.liveMatte}")`,
              maskMode: "luminance",
              maskSize: "100% 100%",
              maskRepeat: "no-repeat",
            } as React.CSSProperties}
          />
        )}
        {s.previewSrc && (
          <img src={s.previewSrc} alt="" className="pointer-events-none absolute inset-0 h-full w-full object-contain opacity-80" />
        )}
        {/* Points : cliquables (sélection) et glissables. Le point sélectionné porte un halo (lueur). */}
        <svg className="pointer-events-none absolute inset-0 h-full w-full">
          {pts.map((p, i) => {
            const dr0 = ptDrag.current;
            const dragging = !!dr0 && dr0.obj === p.obj && dr0.index === p.index && !!ptLive;
            const x = dragging && ptLive ? ptLive.x : p.x;
            const y = dragging && ptLive ? ptLive.y : p.y;
            const sel = s.selectedPoint?.f === s.frame && s.selectedPoint.obj === p.obj && s.selectedPoint.index === p.index;
            const col = colorOf(p.obj);
            return (
              <g key={i}>
                {sel && (
                  <circle cx={`${x * 100}%`} cy={`${y * 100}%`} r={10 / z.k}
                    fill="none" stroke="white" strokeWidth={2 / z.k} opacity={0.9}
                    style={{ filter: `drop-shadow(0 0 ${4 / z.k}px white)` }} />
                )}
                <circle cx={`${x * 100}%`} cy={`${y * 100}%`} r={(sel ? 7 : 6) / z.k}
                  fill={p.label ? col : "transparent"}
                  stroke={p.label ? "white" : col} strokeWidth={2 / z.k}
                  strokeDasharray={p.label ? undefined : `${3 / z.k} ${2 / z.k}`} />
              </g>
            );
          })}
        </svg>
      </div>
      {z.k > 1 && (
        <span className="pointer-events-none absolute right-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] tabular-nums text-white">
          {z.k.toFixed(1)}{t("viewer.zoomSuffix")}
        </span>
      )}
    </div>
  );
}

// URL d'une frame extraite (JPEG /media) — partagée avec la timeline (filmstrip + hover).
export const rotoFrameUrl = (dir: string, f: number) =>
  nr.mediaUrl(`${dir}/${String(f).padStart(5, "0")}.jpg`);
