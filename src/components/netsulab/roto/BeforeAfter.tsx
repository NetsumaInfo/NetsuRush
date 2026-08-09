import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

// Comparateur AVANT / APRÈS : deux images superposées, un curseur vertical glissant révèle l'après
// par-dessus l'avant. Aucune anim JS — une position en état pilote un clip-path. Le damier sous
// l'après lit l'alpha (matte fin / suppression peuvent être transparents).
const CHECKER = "conic-gradient(#3a3a3a 0 25%, #262626 0 50%, #3a3a3a 0 75%, #262626 0)";

export function BeforeAfter({ before, after }: { before: string | null; after: string }) {
  const { t } = useTranslation("roto");
  const [pos, setPos] = useState(50);   // % révélé de l'après (0 = tout avant, 100 = tout après)
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const move = useCallback((clientX: number) => {
    const el = ref.current; if (!el) return;
    const r = el.getBoundingClientRect();
    setPos(Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100)));
  }, []);

  // Sans image « avant » (frame source indisponible) : on montre l'après seul sur damier.
  if (!before) {
    return (
      <div className="overflow-hidden rounded-md border border-border" style={{ backgroundImage: CHECKER, backgroundSize: "16px 16px" }}>
        <img src={after} alt="" className="block max-h-[70vh] w-full object-contain" draggable={false} />
      </div>
    );
  }

  return (
    <div
      ref={ref}
      className="relative select-none overflow-hidden rounded-md border border-border"
      style={{ touchAction: "none" }}
      onPointerDown={(e) => { dragging.current = true; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); move(e.clientX); }}
      onPointerMove={(e) => { if (dragging.current) move(e.clientX); }}
      onPointerUp={() => { dragging.current = false; }}
      onPointerCancel={() => { dragging.current = false; }}
      onLostPointerCapture={() => { dragging.current = false; }}
    >
      {/* Avant (dessous) */}
      <img src={before} alt="" className="block max-h-[70vh] w-full object-contain" draggable={false} />
      {/* Après (dessus, damier pour l'alpha), clippé à la position du curseur */}
      <div className="absolute inset-0" style={{ backgroundImage: CHECKER, backgroundSize: "16px 16px", clipPath: `inset(0 0 0 ${pos}%)` }}>
        <img src={after} alt="" className="absolute inset-0 h-full w-full object-contain" draggable={false} />
      </div>
      {/* Poignée */}
      <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-white/90" style={{ left: `${pos}%` }}>
        <span className="absolute left-1/2 top-1/2 flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white text-[10px] font-bold text-black shadow">⇔</span>
      </div>
      <span className="pointer-events-none absolute left-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">{t("compare.before")}</span>
      <span className="pointer-events-none absolute right-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">{t("compare.after")}</span>
    </div>
  );
}
