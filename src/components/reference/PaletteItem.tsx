// Bloc PALETTE posé sur le board : bande de pastilles extraites d'une sélection de médias.
// Clic sur une pastille → valeur hex dans le presse-papiers. Le bloc est un item comme un autre
// (déplaçable, redimensionnable, persisté dans la scène et le .netsu).

import { useTranslation } from "react-i18next";
import { useBoard } from "./useReferenceBoard";
import type { BoardItem } from "./referenceShared";

// Contraste du texte posé SUR une pastille : luminance relative approchée (sRGB pondéré), au-delà
// de 0,55 on écrit en noir. Suffisant pour une valeur hex de 10 px, et sans dépendance.
function readableOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "#ffffff";
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.55 ? "#0b0b0e" : "#ffffff";
}

export function PaletteContent({ item }: { item: BoardItem }) {
  const { t } = useTranslation("reference");
  const setNotice = useBoard((s) => s.setNotice);
  const colors = item.colors ?? [];

  const copy = (hex: string) => {
    navigator.clipboard.writeText(hex).then(
      () => setNotice({ kind: "ok", text: t("palette.copied", { hex }) }),
      () => setNotice({ kind: "error", text: t("palette.copyFailed") }),
    );
  };

  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden rounded-lg border border-border"
      style={{ background: "var(--color-surface)" }}
    >
      {item.title && (
        <div className="shrink-0 truncate px-2.5 pt-1.5 text-[11px] font-medium text-muted-foreground">
          {item.title}
        </div>
      )}
      <div className="flex min-h-0 flex-1 gap-1 p-1.5">
        {colors.length === 0 && (
          <div className="flex flex-1 items-center justify-center text-[11px] text-muted-foreground">
            {t("palette.empty")}
          </div>
        )}
        {colors.map((hex, i) => (
          <button
            key={`${hex}-${i}`}
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => copy(hex)}
            aria-label={hex}
            className="group relative flex min-w-0 flex-1 items-end justify-center rounded-md ring-1 ring-black/10 transition-transform hover:scale-[1.02]"
            style={{ background: hex }}
          >
            {item.showHex !== false && (
              <span
                className="pointer-events-none w-full truncate px-1 pb-1 text-center text-[10px] font-medium uppercase tracking-tight"
                style={{ color: readableOn(hex) }}
              >
                {hex}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
