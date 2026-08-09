// Éditeur de rognage : overlay centré (indépendant du zoom du board) montrant le média entier
// avec un rectangle de crop déplaçable/redimensionnable (coins). Confirmer → stocke le crop
// normalisé et ajuste le ratio de l'item pour éviter toute distortion.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, X, Maximize } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useBoard } from "./useReferenceBoard";
import type { BoardItem } from "./referenceShared";

type Corner = "nw" | "ne" | "sw" | "se";
interface Rect { x: number; y: number; w: number; h: number } // normalisé 0..1

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function Editor({ item }: { item: BoardItem }) {
  const { t } = useTranslation("reference");
  const patchItem = useBoard((s) => s.patchItem);
  const updateItem = useBoard((s) => s.updateItem);
  const setCropping = useBoard((s) => s.setCropping);
  const boxRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<Rect>(item.crop ?? { x: 0, y: 0, w: 1, h: 1 });
  const drag = useRef<{ mode: "move" | Corner; sx: number; sy: number; orig: Rect } | null>(null);
  // Retrait des écouteurs `window` du glissé en cours (posé par startDrag, joué par onUp ET au démontage).
  const detach = useRef<() => void>(() => {});

  // Boîte d'affichage au ratio du média (pas de letterbox → mapping direct du crop).
  const aspect = item.natW && item.natH ? item.natW / item.natH : item.w / item.h;
  const maxW = Math.min(window.innerWidth * 0.8, 900);
  const maxH = window.innerHeight * 0.62;
  const boxW = Math.min(maxW, maxH * aspect);
  const boxH = boxW / aspect;

  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    const box = boxRef.current;
    if (!d || !box) return;
    const dx = (e.clientX - d.sx) / box.clientWidth;
    const dy = (e.clientY - d.sy) / box.clientHeight;
    const o = d.orig;
    if (d.mode === "move") {
      setRect({ ...o, x: clamp01(Math.min(o.x + dx, 1 - o.w)), y: clamp01(Math.min(o.y + dy, 1 - o.h)) });
      return;
    }
    let { x, y, w, h } = o;
    const minS = 0.05;
    if (d.mode.includes("w")) { const nx = clamp01(o.x + dx); w = o.x + o.w - nx; x = nx; }
    if (d.mode.includes("e")) { w = clamp01(o.x + o.w + dx) - x; }
    if (d.mode.includes("n")) { const ny = clamp01(o.y + dy); h = o.y + o.h - ny; y = ny; }
    if (d.mode.includes("s")) { h = clamp01(o.y + o.h + dy) - y; }
    if (w < minS) w = minS;
    if (h < minS) h = minS;
    setRect({ x, y, w, h });
  };
  const onUp = () => { drag.current = null; detach.current(); };
  const startDrag = (mode: "move" | Corner, e: React.PointerEvent) => {
    e.stopPropagation();
    drag.current = { mode, sx: e.clientX, sy: e.clientY, orig: rect };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    // Les handlers sont recréés à chaque rendu et un glissé re-rend (setRect) : on mémorise le
    // retrait de CETTE paire, seule capable de se désinscrire elle-même.
    detach.current = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  };
  // Démontage en plein glissé (Échap, item sorti du champ par le culling, fin du rognage) : sans ce
  // nettoyage la paire restait sur `window`, retenant le composant et appelant setRect après coup.
  useEffect(() => () => detach.current(), []);

  const confirm = () => {
    const full = rect.x === 0 && rect.y === 0 && rect.w === 1 && rect.h === 1;
    patchItem(item.id, { crop: full ? undefined : rect });
    // Ajuste le ratio de l'item à la région rognée (évite la distortion).
    if (!full && item.natW && item.natH) {
      const ar = (rect.w * item.natW) / (rect.h * item.natH);
      updateItem(item.id, { h: item.w / ar });
    }
    setCropping(null);
  };

  const corners: { c: Corner; cls: string }[] = [
    { c: "nw", cls: "-top-1.5 -left-1.5 cursor-nwse-resize" },
    { c: "ne", cls: "-top-1.5 -right-1.5 cursor-nesw-resize" },
    { c: "sw", cls: "-bottom-1.5 -left-1.5 cursor-nesw-resize" },
    { c: "se", cls: "-bottom-1.5 -right-1.5 cursor-nwse-resize" },
  ];

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/70 backdrop-blur-sm">
      <div ref={boxRef} className="relative select-none" style={{ width: boxW, height: boxH }}>
        {item.kind === "image" ? (
          <img src={item.src} alt="" draggable={false} className="h-full w-full object-fill" />
        ) : (
          <video src={item.src} muted className="h-full w-full object-fill" />
        )}
        {/* rectangle de crop : l'image de base transparaît dedans, l'extérieur est assombri
            par le boxShadow géant (pas de voile séparé ni de copie de l'image). */}
        <div
          onPointerDown={(e) => startDrag("move", e)}
          className="absolute cursor-move ring-2 ring-primary"
          style={{
            left: `${rect.x * 100}%`, top: `${rect.y * 100}%`,
            width: `${rect.w * 100}%`, height: `${rect.h * 100}%`,
            boxShadow: "0 0 0 2000px rgba(0,0,0,0.55)",
          }}
        >
          {corners.map(({ c, cls }) => (
            <span
              key={c}
              onPointerDown={(e) => startDrag(c, e)}
              className={`absolute size-3 rounded-full border border-background bg-primary ${cls}`}
            />
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => setRect({ x: 0, y: 0, w: 1, h: 1 })}>
          <Maximize className="size-4" /> {t("common:action.reset")}
        </Button>
        <Button variant="outline" size="sm" onClick={() => setCropping(null)}>
          <X className="size-4" /> {t("common:action.cancel")}
        </Button>
        <Button size="sm" onClick={confirm}>
          <Check className="size-4" /> {t("actions.crop")}
        </Button>
      </div>
    </div>
  );
}

export function CropOverlay() {
  const id = useBoard((s) => s.croppingId);
  const item = useBoard((s) => s.items.find((i) => i.id === s.croppingId) ?? null);
  if (!id || !item) return null;
  // key={id} → réinitialise l'état interne (rect) quand on rogne un autre item.
  return <Editor key={id} item={item} />;
}
