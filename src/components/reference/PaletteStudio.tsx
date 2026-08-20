// Palette studio: a floating panel over the board to BUILD a palette rather than only extract
// one. HSV color wheel with one draggable handle per swatch, the nine harmony rules of a
// classic wheel, per-swatch lock / tones / brightness, randomize, and a seed taken from the
// board's own media. The result is posed on the board as a regular palette block — or written
// back into an existing one.
//
// NOT a dialog: no backdrop, no modal trap. Picking colors means looking at the references
// underneath, so the board stays sharp, pannable and zoomable while the panel is open. The
// panel is dragged by its header to uncover whatever it hides.
//
// No JS-driven animation (board rule): the wheel is pure CSS gradients, handles are absolutely
// positioned, drags write state directly.

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  Lock, LockOpen, Plus, X, Pipette, Images, LayoutGrid, ChevronLeft, ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { useBoard } from "./useReferenceBoard";
import { extractPalette, PALETTE_MAX } from "./palette";
import {
  HARMONY_RULES, type HarmonyRule, type Slot, type Hsv,
  hsvFromHex, hexFromHsv, applyRule, followAnchor, tonesOf,
} from "./harmonies";
import { HarmonyIcon } from "./harmonyIcons";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { COLOR_FORMATS, COLOR_FORMAT_LABEL, clipboardColor, formatColor, parseColor, hexFromRgb, type ColorFormat } from "./colorFormat";
import { makePaletteItem, paletteSize, screenToBoard, type BoardItem } from "./referenceShared";
import i18n from "@/i18n";

const WHEEL = 236;         // wheel diameter (px)
const PANEL = 720;         // panel width (px)
const MARGIN = 16;         // keep the panel this far from the window edges
// Resting top: the panel opens in the top-right corner, just clear of the window chrome (title
// bar + board toolbar) so it never covers the button it was opened from. The corner is held by
// CSS `right`/`top`, NOT by measured coordinates — a computed `left` freezes on window resize
// and lets the panel hang off the edge.
const TOP = 96;
const MIN_SLOTS = 2;
const DEFAULT_SLOTS = 5;
// Past this count a swatch is narrower than a hex string: the per-swatch value would render
// truncated. The active swatch's value moves to the tone row instead, always legible.
const HEX_ON_SWATCH_MAX = 7;

// Screen eyedropper. Chromium exposes it and the Tauri WebView2 shell inherits it; it samples
// ANY pixel of the desktop, not just the page, which is the whole point — grabbing a color out
// of Photoshop or a video player without leaving the board. Absent elsewhere, hence the guard.
interface EyeDropperCtor {
  new (): { open(): Promise<{ sRGBHex: string }> };
}
const eyeDropper = (): EyeDropperCtor | null =>
  (window as unknown as { EyeDropper?: EyeDropperCtor }).EyeDropper ?? null;

// Text color readable on a swatch (same heuristic as the palette block).
function readableOn(hsv: Hsv): string {
  const hex = hexFromHsv(hsv);
  const n = parseInt(hex.slice(1), 16);
  const lum = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  return lum > 0.55 ? "#0b0b0e" : "#ffffff";
}

function freshSlots(): Slot[] {
  const base: Slot = { h: Math.random() * 360, s: 0.7, v: 0.9, locked: false };
  const slots = Array.from({ length: DEFAULT_SLOTS }, () => ({ ...base }));
  return applyRule("analogous", slots, 0);
}

// The HSV disk. Hue 0 sits at 3 o'clock and grows clockwise — matching both the CSS conic
// gradient below and the atan2 of the drag handler, which share that convention.
function Wheel({ slots, active, onPick, onDrag }: {
  slots: Slot[];
  active: number;
  onPick: (i: number) => void;
  onDrag: (i: number, h: number, s: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Pointer → (hue, saturation) in wheel space.
  const toHs = useCallback((cx: number, cy: number) => {
    const box = ref.current!.getBoundingClientRect();
    const dx = cx - (box.left + box.width / 2);
    const dy = cy - (box.top + box.height / 2);
    const h = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
    const s = Math.min(1, Math.hypot(dx, dy) / (box.width / 2));
    return { h, s };
  }, []);

  const startDrag = (i: number) => (e: React.PointerEvent) => {
    e.stopPropagation();
    onPick(i);
    const el = ref.current;
    if (!el) return;
    try { el.setPointerCapture(e.pointerId); } catch { /* best-effort */ }
    const move = (ev: PointerEvent) => {
      const { h, s } = toHs(ev.clientX, ev.clientY);
      onDrag(i, h, s);
    };
    // `pointercancel` too: a pen or a finger drag does not always end on `pointerup` — the browser
    // fires cancel instead when it claims the gesture (palm rejection, the pen leaving range).
    // Listening for `pointerup` alone leaves the handle glued to the pointer for good.
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    const { h, s } = toHs(e.clientX, e.clientY);
    onDrag(i, h, s);
  };

  return (
    <div
      ref={ref}
      className="relative shrink-0 touch-none rounded-full shadow-inner ring-1 ring-border"
      style={{
        width: WHEEL,
        height: WHEEL,
        background:
          "radial-gradient(circle closest-side, #fff, rgba(255,255,255,0) 100%)," +
          "conic-gradient(from 90deg, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)",
      }}
      // Clicking the disk itself re-aims the ACTIVE handle.
      onPointerDown={(e) => {
        if (e.target !== e.currentTarget) return;
        startDrag(active)(e);
      }}
    >
      {slots.map((slot, i) => {
        const r = (WHEEL / 2) * slot.s;
        const a = (slot.h * Math.PI) / 180;
        return (
          <button
            key={i}
            type="button"
            aria-label={hexFromHsv(slot)}
            onPointerDown={startDrag(i)}
            className={cn(
              "absolute z-10 size-6 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border-2 shadow-md",
              i === active ? "border-white ring-2 ring-primary" : "border-white/90",
              slot.locked && "cursor-not-allowed opacity-80",
            )}
            style={{
              left: WHEEL / 2 + Math.cos(a) * r,
              top: WHEEL / 2 + Math.sin(a) * r,
              background: hexFromHsv(slot),
            }}
          />
        );
      })}
    </div>
  );
}

// Mounted ONCE, high in the tree, and driven by the store — never by the toolbar or the
// inspector, which come and go with the selection.
// Saturation × brightness pad + hue rail, for editing the active swatch with sliders instead of
// the wheel. INLINE, not a popover: inside a floating panel a popover has nowhere to go and gets
// flipped straight onto the wheel and the swatches — you lose sight of the color you are setting.
function SvPicker({ color, disabled, onChange }: {
  color: Hsv;
  disabled?: boolean;
  onChange: (patch: Partial<Hsv>) => void;
}) {
  const drag = (e: React.PointerEvent<HTMLDivElement>, onFrac: (fx: number, fy: number) => void) => {
    if (disabled) return;
    const el = e.currentTarget;
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    const move = (cx: number, cy: number) => {
      const b = el.getBoundingClientRect();
      onFrac(clamp((cx - b.left) / b.width), clamp((cy - b.top) / b.height));
    };
    try { el.setPointerCapture(e.pointerId); } catch { /* best-effort */ }
    move(e.clientX, e.clientY);
    const mv = (ev: PointerEvent) => move(ev.clientX, ev.clientY);
    const up = () => {
      el.removeEventListener("pointermove", mv);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", mv);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  return (
    <div className={cn("flex flex-col gap-2", disabled && "pointer-events-none opacity-50")}>
      <div
        className="relative h-20 w-full cursor-crosshair touch-none rounded-md ring-1 ring-border"
        style={{
          background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${color.h} 100% 50%))`,
        }}
        onPointerDown={(e) => drag(e, (fx, fy) => onChange({ s: fx, v: 1 - fy }))}
      >
        <span
          className="pointer-events-none absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
          style={{ left: `${color.s * 100}%`, top: `${(1 - color.v) * 100}%`, background: hexFromHsv(color) }}
        />
      </div>
      <div
        className="relative h-3 w-full cursor-pointer touch-none rounded-full"
        style={{ background: "linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)" }}
        onPointerDown={(e) => drag(e, (fx) => onChange({ h: fx * 360 }))}
      >
        <span
          className="pointer-events-none absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
          style={{ left: `${(color.h / 360) * 100}%`, background: `hsl(${color.h} 100% 50%)` }}
        />
      </div>
    </div>
  );
}

export function PaletteStudio() {
  const { t } = useTranslation("reference");
  const studio = useBoard((s) => s.studio);
  const open = studio !== null;
  const targetId = studio?.targetId ?? null;
  const close = useCallback(() => useBoard.getState().setStudio(null), []);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [rule, setRule] = useState<HarmonyRule>("analogous");
  const [active, setActive] = useState(0);
  const [seeding, setSeeding] = useState(false);
  // Notation of the editable value field — the same five the palette block speaks, so what you
  // read here is what you paste into a stylesheet, a Resolve node or Photoshop.
  const [format, setFormat] = useState<ColorFormat>("hex");
  // Raw text while typing. An intermediate state like "#12" parses to nothing; without a draft
  // the field would fight the user and snap back on every keystroke.
  const [draft, setDraft] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);   // slider picker unfolded under the value row
  // Panel position. null = anchored top right; a drag pins it to explicit coordinates.
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Snapshot of the palette as it was when the panel opened — what "reset" restores. Kept
  // verbatim rather than recomputed: a fresh set is randomly seeded, so recomputing would hand
  // back a DIFFERENT palette instead of undoing the session's edits.
  const opening = useRef<{ slots: Slot[]; rule: HarmonyRule } | null>(null);

  // Build the working palette each time the studio opens. Editing an existing block starts from
  // ITS colors; opening from the toolbar starts from a fresh analogous set. Read once, at open:
  // the panel is a workbench, it must not track the block while you work on it.
  useEffect(() => {
    if (!open) return;
    const seed = targetId ? useBoard.getState().items.find((it) => it.id === targetId)?.colors : null;
    const start = seed?.length
      ? { slots: seed.map((hex) => ({ ...hsvFromHex(hex), locked: false })), rule: "custom" as HarmonyRule }
      : { slots: freshSlots(), rule: "analogous" as HarmonyRule };
    opening.current = start;
    setSlots(start.slots);
    setRule(start.rule);
    setActive(0);
    setSeeding(false);
    setPicking(false);
    setPos(null);
  }, [open, targetId]);

  const reset = () => {
    const start = opening.current;
    if (!start) return;
    setSlots(start.slots);
    setRule(start.rule);
    setActive(0);
  };

  // Switching swatch drops any half-typed value: the field now describes another color.
  useEffect(() => setDraft(null), [active]);

  // A dragged panel holds absolute coordinates, which a window resize can push off-screen (the
  // default anchor is CSS `right`, which follows on its own). Pull it back in.
  useEffect(() => {
    if (!open) return;
    const onResize = () => {
      const el = panelRef.current;
      if (!el) return;
      setPos((p) => p && {
        x: Math.max(MARGIN, Math.min(p.x, window.innerWidth - el.offsetWidth - MARGIN)),
        y: Math.max(MARGIN, Math.min(p.y, window.innerHeight - el.offsetHeight - MARGIN)),
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open]);

  // Escape closes. Bound while open only, so the board keeps its own shortcuts otherwise.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); close(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, close]);

  // Header drag. Coordinates are clamped so the panel can never be pushed off-window.
  const startPanelDrag = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    const box = panelRef.current?.getBoundingClientRect();
    if (!box) return;
    const dx = e.clientX - box.left;
    const dy = e.clientY - box.top;
    const el = e.currentTarget as HTMLElement;
    try { el.setPointerCapture(e.pointerId); } catch { /* best-effort */ }
    const move = (ev: PointerEvent) => {
      setPos({
        x: Math.max(MARGIN, Math.min(window.innerWidth - box.width - MARGIN, ev.clientX - dx)),
        y: Math.max(MARGIN, Math.min(window.innerHeight - box.height - MARGIN, ev.clientY - dy)),
      });
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  const activeSlot = slots[active] as Slot | undefined;

  const drag = (i: number, h: number, s: number) => {
    setSlots((prev) => {
      if (prev[i]?.locked) return prev;
      const next = prev.map((sl, k) => (k === i ? { ...sl, h, s } : sl));
      return followAnchor(rule, next, i);
    });
  };

  const pickRule = (r: HarmonyRule) => {
    setRule(r);
    setSlots((prev) => applyRule(r, prev, active));
  };

  const patchActive = (patch: Partial<Slot>) =>
    setSlots((prev) => prev.map((sl, i) => (i === active ? { ...sl, ...patch } : sl)));

  // Clicking a swatch selects it; clicking the one already selected copies its value. No extra
  // control on the swatch for that — the strip stays a strip of colors.
  const tapSwatch = (i: number) => {
    if (i !== active) { setActive(i); return; }
    const hex = clipboardColor(hexFromHsv(slots[i]).toUpperCase());
    navigator.clipboard.writeText(hex).then(
      () => useBoard.getState().setNotice({ kind: "ok", text: i18n.t("reference:palette.copied", { hex }) }),
      () => useBoard.getState().setNotice({ kind: "error", text: i18n.t("reference:palette.copyFailed") }),
    );
  };

  // Edit the active swatch and let the harmony follow, exactly as after a handle drag. Shared by
  // the slider picker, the value field and the screen eyedropper — one path, one behaviour.
  const editActive = (patch: Partial<Hsv>) => {
    setSlots((prev) => {
      if (prev[active]?.locked) return prev;
      const next = prev.map((sl, i) => (i === active ? { ...sl, ...patch } : sl));
      return followAnchor(rule, next, active);
    });
  };

  const setActiveRgb = (rgb: { r: number; g: number; b: number }) =>
    editActive(hsvFromHex(hexFromRgb(rgb)));

  // Sample any pixel on the desktop into the active swatch; the harmony then follows it, exactly
  // as if its handle had been dragged there. Cancelling the picker throws — nothing to report.
  const pickFromScreen = async () => {
    const Ctor = eyeDropper();
    if (!Ctor || slots[active]?.locked) return;
    try {
      const { sRGBHex } = await new Ctor().open();
      const picked = hsvFromHex(sRGBHex);
      setSlots((prev) => {
        const next = prev.map((sl, i) => (i === active ? { ...sl, ...picked } : sl));
        return followAnchor(rule, next, active);
      });
    } catch { /* picker dismissed */ }
  };

  const add = () => {
    setSlots((prev) => {
      if (prev.length >= PALETTE_MAX) return prev;
      const from = prev[active] ?? prev[prev.length - 1];
      const next = [...prev, { ...from, h: (from.h + 30) % 360, locked: false }];
      return applyRule(rule, next, active);
    });
  };

  const remove = (i: number) => {
    setSlots((prev) => (prev.length <= MIN_SLOTS ? prev : prev.filter((_, k) => k !== i)));
    setActive((a) => Math.max(0, Math.min(a > i ? a - 1 : a, slots.length - 2)));
  };

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= slots.length) return;
    setSlots((prev) => {
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
    setActive(j);
  };

  // Fill the wheel from real media: the extractor weighs each source by its DISPLAYED area, so
  // what comes back is what the board actually looks like, not a flat average of the files.
  const seedFrom = async (src: BoardItem[], emptyKey: string) => {
    if (seeding) return;
    const st = useBoard.getState();
    if (!src.length) {
      st.setNotice({ kind: "error", text: i18n.t(emptyKey) });
      return;
    }
    setSeeding(true);
    try {
      const res = await extractPalette(src, Math.max(3, Math.min(PALETTE_MAX, slots.length)));
      if (!res.colors.length) {
        st.setNotice({ kind: "error", text: i18n.t(res.coreDown ? "reference:palette.failedCore" : "reference:palette.failed") });
        return;
      }
      setSlots(res.colors.map((hex) => ({ ...hsvFromHex(hex), locked: false })));
      setRule("custom");
      setActive(0);
      st.setNotice({ kind: "ok", text: i18n.t("reference:palette.done", { count: res.colors.length }) });
    } finally {
      setSeeding(false);
    }
  };

  // Media the extractor can read: an iframe or a note has no pixels to sample.
  const mediaOf = (items: BoardItem[]) =>
    items.filter((it) => (it.kind === "image" || it.kind === "video" || it.kind === "sequence") && !it.missing);

  // The images picked on the board. Selecting the palette block itself — the usual case, since
  // it is what you just clicked — is NOT a source: say so instead of claiming the board is empty.
  const seedFromSelection = () => {
    const st = useBoard.getState();
    const picked = st.items.filter((it) => st.selectedIds.includes(it.id));
    return seedFrom(mediaOf(picked), "reference:palette.studio.noSelection");
  };

  // The whole moodboard: every readable image, video and sequence on the scene at once.
  const seedFromWholeBoard = () =>
    seedFrom(mediaOf(useBoard.getState().items), "reference:palette.studio.noMedia");

  // Place a new palette block at the center of the current view, or write the colors back
  // into the block being edited (resized so the swatches keep their breathing room).
  const commit = () => {
    const st = useBoard.getState();
    const colors = slots.map(hexFromHsv);
    if (targetId) {
      const block = st.items.find((it) => it.id === targetId);
      if (block) {
        st.patchItem(targetId, { colors, ...paletteSize(colors.length, block.paletteLayout ?? "row") });
        st.setNotice({ kind: "ok", text: t("palette.studio.applied", { count: colors.length }) });
        close();
        return;
      }
    }
    const c = screenToBoard(st.view, window.innerWidth / 2, window.innerHeight / 2);
    const item = makePaletteItem(0, 0, colors);
    item.x = c.x - item.w / 2;
    item.y = c.y - item.h / 2;
    st.addItem(item);
    st.setNotice({ kind: "ok", text: t("palette.studio.placed", { count: colors.length }) });
    close();
  };

  if (!open) return null;

  // Portalled to <body>: the callers mount the studio inside the toolbar and the inspector,
  // both of which open a stacking context (backdrop blur, transforms). Nested, the panel would
  // paint and hit-test UNDER the board however high its z-index.
  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={t("palette.studio.title")}
      // Opaque, and no backdrop-filter: a translucent 720 px panel would blur a live board and
      // cost GPU time the video decoding needs.
      className="fixed z-50 flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-2xl shadow-black/50"
      style={{
        width: PANEL,
        maxWidth: `calc(100vw - ${MARGIN * 2}px)`,
        // Unfolding the slider picker makes the panel taller; cap it so growth scrolls inside
        // rather than running past the bottom of the window.
        maxHeight: `calc(100vh - ${TOP + MARGIN}px)`,
        overflowY: "auto",
        ...(pos ? { left: pos.x, top: pos.y } : { right: MARGIN, top: TOP }),
      }}
      // The board owns the wheel/pointer gestures underneath: stop ours from reaching it.
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      {/* Header doubles as the drag handle — the panel must be movable to uncover a reference.
          `touch-none`: the panel scrolls when it grows, and without it a pen or a finger on the
          header scrolls that content instead of moving the panel. */}
      <div
        className="flex cursor-grab touch-none items-start justify-between gap-3 active:cursor-grabbing"
        onPointerDown={startPanelDrag}
      >
        <h2 className="min-w-0 truncate font-heading text-sm font-medium">{t("palette.studio.title")}</h2>
        <Button variant="ghost" size="icon-sm" aria-label={t("palette.studio.close")} onClick={close}>
          <X />
        </Button>
      </div>

      {/* Harmony rules as pictograms: the geometry reads faster than the term. The icons come
          FIRST and the selected rule's name trails them — a name that grows or shrinks must never
          push the buttons sideways under the cursor. */}
      <div className="flex flex-wrap items-center gap-1">
        {HARMONY_RULES.map((r) => (
          <Tooltip key={r}>
            <TooltipTrigger
              render={
                <Button
                  variant={rule === r ? "default" : "outline"}
                  size="icon"
                  aria-label={t(`palette.studio.rule.${r}`)}
                  aria-pressed={rule === r}
                  onClick={() => pickRule(r)}
                />
              }
            >
              <HarmonyIcon rule={r} className="size-7" />
            </TooltipTrigger>
            <TooltipContent>{t(`palette.studio.rule.${r}`)}</TooltipContent>
          </Tooltip>
        ))}
        <span className="ml-2 min-w-0 truncate text-[11px] font-medium text-foreground">
          {t(`palette.studio.rule.${rule}`)}
        </span>
      </div>

      <div className="flex gap-4">
        <div className="flex shrink-0 flex-col items-center gap-3" style={{ width: WHEEL }}>
          <Wheel slots={slots} active={active} onPick={setActive} onDrag={drag} />
          {/* Brightness of the active swatch — the wheel only carries hue/saturation. */}
          <div className="flex w-full items-center gap-2">
            <span className="shrink-0 text-[11px] text-muted-foreground">{t("palette.studio.brightness")}</span>
            <Slider
              aria-label={t("palette.studio.brightness")}
              value={[Math.round((activeSlot?.v ?? 1) * 100)]}
              min={5}
              max={100}
              step={1}
              disabled={!activeSlot || activeSlot.locked}
              onValueChange={(v) => patchActive({ v: (Array.isArray(v) ? v[0] : v) / 100 })}
            />
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {/* Swatch strip: click = active; lock, reorder and remove live on each swatch. The
              floor matters — without it the strip is what `flex-1` sacrifices when the slider
              picker unfolds, and the palette collapses into a thin band. */}
          <div className="flex min-h-40 min-w-0 flex-1 gap-1">
            {slots.map((slot, i) => {
              const hex = hexFromHsv(slot);
              const ink = readableOn(slot);
              return (
                <div
                  key={i}
                  role="button"
                  tabIndex={0}
                  aria-label={hex}
                  onClick={() => tapSwatch(i)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") tapSwatch(i); }}
                  // `@container`: the controls below size themselves against THIS swatch, whose
                  // width is whatever a twelfth of the strip happens to be — not against the window.
                  className={cn(
                    "group relative flex min-w-0 flex-1 cursor-pointer flex-col justify-end overflow-hidden rounded-md ring-1 ring-black/10 @container",
                    i === active && "ring-2 ring-primary",
                  )}
                  style={{ background: hex }}
                >
                  {/* Lock and remove, side by side — but two 18 px buttons need 44 px of swatch and a
                      full strip leaves ~30 px, where they pile up into one unclickable stack. Under
                      48 px they go one ABOVE the other instead. `hoverless:` keeps them out on the
                      active swatch for pointers that never hover: on a tablet the hover-only reveal
                      never fires, so the cross simply does not exist. Tap a swatch, get its controls. */}
                  <div
                    className={cn(
                      "absolute inset-x-0 top-0 flex flex-col items-center gap-0.5 p-0.5 opacity-0 transition-opacity",
                      "group-hover:opacity-100 focus-within:opacity-100",
                      "@min-[48px]:flex-row @min-[48px]:justify-between @min-[48px]:gap-0 @min-[48px]:p-1",
                      i === active && "hoverless:opacity-100",
                    )}
                  >
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            aria-label={t(slot.locked ? "palette.studio.unlock" : "palette.studio.lock")}
                            aria-pressed={slot.locked}
                            className="rounded p-0.5 hover:bg-black/15"
                            style={{ color: ink }}
                            onClick={(e) => {
                              e.stopPropagation();
                              setSlots((prev) => prev.map((sl, k) => (k === i ? { ...sl, locked: !sl.locked } : sl)));
                            }}
                          />
                        }
                      >
                        {slot.locked ? <Lock className="size-3.5" /> : <LockOpen className="size-3.5" />}
                      </TooltipTrigger>
                      <TooltipContent>{t(slot.locked ? "palette.studio.unlock" : "palette.studio.lock")}</TooltipContent>
                    </Tooltip>
                    <button
                      type="button"
                      aria-label={t("palette.studio.removeSwatch")}
                      className="rounded p-0.5 hover:bg-black/15 disabled:opacity-30"
                      style={{ color: ink }}
                      disabled={slots.length <= MIN_SLOTS}
                      onClick={(e) => { e.stopPropagation(); remove(i); }}
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                  {/* The padlock stays visible when engaged, even without hover — except where the
                      row above is permanently out, which would show the same padlock twice. */}
                  {slot.locked && (
                    <Lock
                      className={cn("absolute left-1 top-1 size-3.5 group-hover:opacity-0", i === active && "hoverless:opacity-0")}
                      style={{ color: ink }}
                    />
                  )}
                  {i === active && (
                    <div className="absolute inset-x-0 top-1/2 flex -translate-y-1/2 flex-col items-center gap-0.5 @min-[48px]:flex-row @min-[48px]:justify-between @min-[48px]:gap-0 @min-[48px]:px-0.5">
                      <button
                        type="button"
                        aria-label={t("palette.studio.moveLeft")}
                        className="rounded p-0.5 opacity-0 hover:bg-black/15 group-hover:opacity-100 hoverless:opacity-100 disabled:invisible"
                        style={{ color: ink }}
                        disabled={i === 0}
                        onClick={(e) => { e.stopPropagation(); move(i, -1); }}
                      >
                        <ChevronLeft className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label={t("palette.studio.moveRight")}
                        className="rounded p-0.5 opacity-0 hover:bg-black/15 group-hover:opacity-100 hoverless:opacity-100 disabled:invisible"
                        style={{ color: ink }}
                        disabled={i === slots.length - 1}
                        onClick={(e) => { e.stopPropagation(); move(i, 1); }}
                      >
                        <ChevronRight className="size-3.5" />
                      </button>
                    </div>
                  )}
                  {/* Dense strips drop the values, except on the swatch being edited. */}
                  {(slots.length <= HEX_ON_SWATCH_MAX || i === active) && (
                    <span
                      className="pointer-events-none w-full truncate px-1 pb-1 text-center text-[10px] font-medium uppercase tracking-tight"
                      style={{ color: ink }}
                    >
                      {hex}
                    </span>
                  )}
                </div>
              );
            })}
            {slots.length < PALETTE_MAX && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={t("palette.studio.addSwatch")}
                      onClick={add}
                      className="flex w-7 shrink-0 items-center justify-center rounded-md border border-dashed border-border text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                    />
                  }
                >
                  <Plus className="size-4" />
                </TooltipTrigger>
                <TooltipContent>{t("palette.studio.addSwatch")}</TooltipContent>
              </Tooltip>
            )}
          </div>

          {/* Tone ramp of the active swatch: pick a lighter/deeper variant of the same hue. */}
          {activeSlot && (
            <div className="flex min-w-0 items-center gap-2">
              <div className="flex min-w-0 flex-1 gap-1" role="group" aria-label={t("palette.studio.tones")}>
                {tonesOf(activeSlot).map((tone, i) => (
                  <button
                    key={i}
                    type="button"
                    aria-label={hexFromHsv(tone)}
                    className="h-6 min-w-0 flex-1 rounded ring-1 ring-black/10"
                    style={{ background: hexFromHsv(tone) }}
                    disabled={activeSlot.locked}
                    onClick={() => patchActive({ h: tone.h, s: tone.s, v: tone.v })}
                  />
                ))}
              </div>
            </div>
          )}

          {/* The active swatch, editable by hand. Three ways in, all landing on the same color:
              the picker popup (saturation/brightness area + hue slider), the notation selector,
              and the text field — which READS all five notations, not just hex. */}
          {activeSlot && (() => {
            const hex = hexFromHsv(activeSlot);
            const shown = draft ?? formatColor(hex, format);
            return (
              <div className="flex min-w-0 items-center gap-1.5">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-label={t("palette.studio.pick")}
                        aria-pressed={picking}
                        onClick={() => setPicking((v) => !v)}
                        className={cn(
                          "size-7 shrink-0 rounded-md border border-border outline-none transition focus-visible:ring-2 focus-visible:ring-primary",
                          picking && "ring-2 ring-primary",
                        )}
                        style={{ background: hex }}
                      />
                    }
                  />
                  <TooltipContent>{t("palette.studio.pick")}</TooltipContent>
                </Tooltip>
                <Select value={format} onValueChange={(v) => { setDraft(null); setFormat(String(v) as ColorFormat); }}>
                  <SelectTrigger size="sm" className="w-24 shrink-0" aria-label={t("palette.studio.notation")}>
                    <SelectValue>{COLOR_FORMAT_LABEL[format]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {COLOR_FORMATS.map((f) => (
                      <SelectItem key={f} value={f}>{COLOR_FORMAT_LABEL[f]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <input
                  aria-label={t("palette.studio.value")}
                  value={shown}
                  spellCheck={false}
                  disabled={activeSlot.locked}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    const p = parseColor(e.target.value);
                    if (p) setActiveRgb(p);
                  }}
                  // Dropping the draft on blur re-formats whatever was typed into the selected
                  // notation — paste `rgb(...)` while reading OKLCH and it settles as OKLCH.
                  onBlur={() => setDraft(null)}
                  onKeyDown={(e) => { if (e.key === "Enter") setDraft(null); e.stopPropagation(); }}
                  className="h-7 min-w-0 flex-1 rounded-md border border-border bg-card px-2 font-mono text-xs uppercase text-foreground outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
                />
              </div>
            );
          })()}

          {picking && activeSlot && (
            <SvPicker color={activeSlot} disabled={activeSlot.locked} onChange={editActive} />
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          {/* Screen eyedropper — only where the platform provides one. */}
          {eyeDropper() && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label={t("palette.studio.pickScreen")}
                    disabled={activeSlot?.locked}
                    onClick={() => void pickFromScreen()}
                  />
                }
              >
                <Pipette />
              </TooltipTrigger>
              <TooltipContent>{t("palette.studio.pickScreen")}</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label={t("palette.studio.fromSelection")}
                  disabled={seeding}
                  onClick={() => void seedFromSelection()}
                />
              }
            >
              {seeding ? <Spinner /> : <Images />}
            </TooltipTrigger>
            <TooltipContent>{t("palette.studio.fromSelection")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label={t("palette.studio.fromBoard")}
                  disabled={seeding}
                  onClick={() => void seedFromWholeBoard()}
                />
              }
            >
              <LayoutGrid />
            </TooltipTrigger>
            <TooltipContent>{t("palette.studio.fromBoard")}</TooltipContent>
          </Tooltip>
        </div>
        {/* Paired with the action: undo the whole session, or commit it. Both spelled out —
            losing every edit is not something to trigger from a guessed pictogram. */}
        <div className="flex items-center gap-1.5">
          <Button variant="outline" size="sm" disabled={seeding} onClick={reset}>
            {t("palette.studio.reset")}
          </Button>
          <Button size="sm" onClick={commit}>
            {t(targetId ? "palette.studio.apply" : "palette.studio.place")}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
