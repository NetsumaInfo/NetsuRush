// Bloc PALETTE posé sur le board : bande de pastilles extraites d'une sélection de médias.
// Clic sur une pastille → sa valeur dans le presse-papiers, DANS LE FORMAT AFFICHÉ (hex, rgb, hsl,
// hsb, oklch), au `#` près que `clipboardColor` retire d'un hex. Le bloc est un item comme un autre
// (déplaçable, redimensionnable, persisté dans la scène et le .netsu).

import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useBoard } from "./useReferenceBoard";
import { clipboardColor, formatColor } from "./colorFormat";
import { paletteGrid, type BoardItem } from "./referenceShared";

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
  const format = item.colorFormat ?? "hex";
  const grid = paletteGrid(colors.length, item.paletteLayout ?? "row");

  const copy = (shown: string) => {
    const value = clipboardColor(shown);
    navigator.clipboard.writeText(value).then(
      () => setNotice({ kind: "ok", text: t("palette.copied", { hex: value }) }),
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
      {/* Une grille CSS couvre les trois dispositions d'un seul jeu de règles : bande (1 ligne),
          colonne (1 colonne) ou carré. Mêmes colonnes/lignes que le rendu d'export. */}
      <div
        className="grid min-h-0 flex-1 gap-1 p-1.5"
        style={{
          gridTemplateColumns: `repeat(${grid.cols}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${grid.rows}, minmax(0, 1fr))`,
        }}
      >
        {colors.length === 0 && (
          <div className="flex flex-1 items-center justify-center text-[11px] text-muted-foreground">
            {t("palette.empty")}
          </div>
        )}
        {colors.map((hex, i) => {
          const value = formatColor(hex, format);
          return (
            <button
              key={`${hex}-${i}`}
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => copy(value)}
              aria-label={value}
              className="group relative flex min-h-0 min-w-0 items-end justify-center rounded-md ring-1 ring-black/10 transition-transform hover:scale-[1.02]"
              style={{ background: hex }}
            >
              {item.showHex !== false && (
                <span
                  // `rgb(238, 64, 99)` est trois fois plus long qu'un hex : au-delà, la valeur passe
                  // d'un cran en dessous pour rester lisible entière plutôt que tronquée.
                  className={cn(
                    "pointer-events-none w-full truncate px-1 pb-1 text-center font-medium tracking-tight",
                    format === "hex" ? "text-[10px] uppercase" : "text-[9px]",
                  )}
                  style={{ color: readableOn(hex) }}
                >
                  {value}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
