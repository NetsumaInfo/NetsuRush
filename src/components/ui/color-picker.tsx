"use client"

// Sélecteur de couleur — flavor Base UI (Popover), thémé sur la DA de l'app (tokens shadcn).
// Déclencheur = pastille de la couleur courante. Popover : aire saturation/luminosité + teinte
// (+ alpha optionnel), champ hexadécimal, et grille de préréglages. Valeur = chaîne CSS
// (`#rrggbb`, `rgba(...)` si alpha < 1, ou `"transparent"`). Aucune anim JS (interdit board).

import * as React from "react"
import { Popover } from "@base-ui/react/popover"
import { cn } from "@/lib/utils"
import { useTranslation } from "react-i18next"

// --- Conversions couleur ---------------------------------------------------------------------
function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v))
}

function hsbToRgb(h: number, s: number, b: number) {
  s /= 100
  b /= 100
  const k = (n: number) => (n + h / 60) % 6
  const f = (n: number) => b * (1 - s * Math.max(0, Math.min(k(n), 4 - k(n), 1)))
  return { r: Math.round(255 * f(5)), g: Math.round(255 * f(3)), b: Math.round(255 * f(1)) }
}

function rgbToHsb(r: number, g: number, b: number) {
  r /= 255
  g /= 255
  b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d) {
    if (max === r) h = 60 * (((g - b) / d) % 6)
    else if (max === g) h = 60 * ((b - r) / d + 2)
    else h = 60 * ((r - g) / d + 4)
  }
  return { h: (h + 360) % 360, s: max === 0 ? 0 : (d / max) * 100, b: max * 100 }
}

interface Hsba { h: number; s: number; b: number; a: number }

// Parse une chaîne CSS en HSBA. Renvoie null si non interprétable (var(--…), transparent, vide).
function parse(input: string): Hsba | null {
  const v = input?.trim().toLowerCase()
  if (!v || v === "transparent" || v.startsWith("var(")) return null
  const hex = v.match(/^#?([a-f\d]{3}|[a-f\d]{6})$/i)
  if (hex) {
    const f = hex[1].length === 3 ? hex[1].split("").map((x) => x + x).join("") : hex[1]
    return { ...rgbToHsb(parseInt(f.slice(0, 2), 16), parseInt(f.slice(2, 4), 16), parseInt(f.slice(4, 6), 16)), a: 1 }
  }
  const rgb = v.match(/^rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\)$/i)
  if (rgb) return { ...rgbToHsb(+rgb[1], +rgb[2], +rgb[3]), a: rgb[4] != null ? +rgb[4] : 1 }
  return null
}

function toHex(c: Hsba) {
  const { r, g, b } = hsbToRgb(c.h, c.s, c.b)
  return `#${[r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("")}`
}
function toCss(c: Hsba) {
  if (c.a >= 1) return toHex(c)
  const { r, g, b } = hsbToRgb(c.h, c.s, c.b)
  return `rgba(${r}, ${g}, ${b}, ${c.a.toFixed(2)})`
}

const CHECKER =
  "[background:repeating-conic-gradient(#777_0_25%,#bbb_0_50%)] [background-size:8px_8px]"

// Pastille d'affichage d'une couleur (gère "transparent").
function ColorSwatch({ value, className }: { value: string; className?: string }) {
  const transparent = !value || value === "transparent"
  return (
    <span
      className={cn("inline-block rounded-full border border-border", transparent && CHECKER, className)}
      style={transparent ? undefined : { background: value }}
    />
  )
}

const DEFAULT_PRESETS = [
  "#ffffff", "#1f2937", "#ef4444", "#f59e0b", "#10b981",
  "#3b82f6", "#8b5cf6", "#ec4899", "#60a5fa", "#a7f3d0",
]

export function ColorPicker({
  value,
  onChange,
  presets = DEFAULT_PRESETS,
  allowAlpha = false,
  allowTransparent = false,
  ariaLabel,
  className,
  side = "top",
}: {
  value: string
  onChange: (value: string) => void
  presets?: string[]
  allowAlpha?: boolean
  allowTransparent?: boolean
  ariaLabel?: string
  className?: string
  side?: "top" | "bottom" | "left" | "right"
}) {
  const { t } = useTranslation("common")
  const resolvedAriaLabel = ariaLabel ?? t("color.choose")
  const isTransparent = !value || value === "transparent"
  const color = parse(value) ?? { h: 210, s: 80, b: 90, a: 1 }

  const set = (next: Partial<Hsba>) => {
    const merged = { ...color, ...next }
    onChange(allowAlpha ? toCss(merged) : toHex(merged))
  }

  // Drag générique : convertit un pointeur en fraction [0,1] sur l'axe demandé.
  const dragTrack = (
    e: React.PointerEvent<HTMLDivElement>,
    onFrac: (fx: number, fy: number) => void,
  ) => {
    const el = e.currentTarget
    const move = (cx: number, cy: number) => {
      const box = el.getBoundingClientRect()
      onFrac(clamp((cx - box.left) / box.width, 0, 1), clamp((cy - box.top) / box.height, 0, 1))
    }
    try { el.setPointerCapture(e.pointerId) } catch { /* best-effort */ }
    move(e.clientX, e.clientY)
    const onMove = (ev: PointerEvent) => move(ev.clientX, ev.clientY)
    const onUp = () => {
      el.removeEventListener("pointermove", onMove)
      el.removeEventListener("pointerup", onUp)
    }
    el.addEventListener("pointermove", onMove)
    el.addEventListener("pointerup", onUp)
  }

  const { r, g, b } = hsbToRgb(color.h, color.s, color.b)

  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label={resolvedAriaLabel}
        className={cn(
          "size-6 shrink-0 rounded-full border border-border outline-none ring-offset-card transition focus-visible:ring-2 focus-visible:ring-primary data-[popup-open]:ring-2 data-[popup-open]:ring-primary",
          isTransparent && CHECKER,
          className,
        )}
        style={isTransparent ? undefined : { background: value }}
      />
      <Popover.Portal>
        <Popover.Positioner side={side} sideOffset={8} className="z-50 outline-none">
          <Popover.Popup className="w-60 origin-[var(--transform-origin)] rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-xl outline-none data-[starting-style]:scale-98 data-[starting-style]:opacity-0 transition-[transform,opacity]">
            {/* aire saturation (x) / luminosité (y) */}
            <div
              className="relative h-36 w-full cursor-crosshair touch-none rounded-lg"
              style={{
                background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${color.h} 100% 50%))`,
              }}
              onPointerDown={(e) =>
                dragTrack(e, (fx, fy) => set({ s: fx * 100, b: (1 - fy) * 100 }))
              }
            >
              <span
                className="pointer-events-none absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
                style={{ left: `${color.s}%`, top: `${100 - color.b}%`, background: toHex(color) }}
              />
            </div>

            {/* teinte */}
            <div
              className="relative mt-3 h-3 w-full cursor-pointer touch-none rounded-full"
              style={{
                background:
                  "linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)",
              }}
              onPointerDown={(e) => dragTrack(e, (fx) => set({ h: fx * 360 }))}
            >
              <span
                className="pointer-events-none absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
                style={{ left: `${(color.h / 360) * 100}%`, background: `hsl(${color.h} 100% 50%)` }}
              />
            </div>

            {/* alpha (optionnel) */}
            {allowAlpha && (
              <div
                className={cn("relative mt-3 h-3 w-full cursor-pointer touch-none rounded-full", CHECKER)}
                onPointerDown={(e) => dragTrack(e, (fx) => set({ a: fx }))}
              >
                <div
                  className="absolute inset-0 rounded-full"
                  style={{ background: `linear-gradient(to right, transparent, rgb(${r} ${g} ${b}))` }}
                />
                <span
                  className="pointer-events-none absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
                  style={{ left: `${color.a * 100}%`, background: toCss(color) }}
                />
              </div>
            )}

            {/* hex + préréglages */}
            <div className="mt-3 flex items-center gap-2">
              <ColorSwatch value={value} className="size-7" />
              <input
                aria-label={t("color.hexValue")}
                defaultValue={toHex(color)}
                key={toHex(color)}
                onChange={(e) => {
                  const p = parse(e.target.value)
                  if (p) set({ h: p.h, s: p.s, b: p.b })
                }}
                className="h-7 w-full min-w-0 rounded-md border border-border bg-background px-2 text-xs uppercase outline-none focus:ring-1 focus:ring-primary"
              />
            </div>

            <div className="mt-3 flex flex-wrap gap-1.5">
              {allowTransparent && (
                <button
                  type="button"
                  aria-label={t("color.transparent")}
                  onClick={() => onChange("transparent")}
                  className={cn(
                    "size-5 rounded-full border border-border",
                    CHECKER,
                    isTransparent && "ring-2 ring-primary ring-offset-1 ring-offset-popover",
                  )}
                />
              )}
              {presets.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={t("color.swatch", { color: c })}
                  onClick={() => onChange(c)}
                  className={cn(
                    "size-5 rounded-full border border-border",
                    !isTransparent && value.toLowerCase() === c.toLowerCase() &&
                      "ring-2 ring-primary ring-offset-1 ring-offset-popover",
                  )}
                  style={{ background: c }}
                />
              ))}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
