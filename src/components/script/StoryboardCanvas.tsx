// Surface vectorielle du storyboard. Elle réutilise le modèle, le rendu SVG, la géométrie et les
// contrôles de style de Netboard, tout en gardant son propre historique pour ne jamais modifier une
// scène du board de référence. Les anciens storyboards PNG restent visibles comme fond éditable.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Circle, Diamond, Eraser, Highlighter, MoveUpRight, Pen, Redo2, Slash, Square, Trash2, Type, Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ColorPicker } from "@/components/ui/color-picker";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DrawStyleControls } from "@/components/reference/DrawStyleControls";
import { hitShape } from "@/components/reference/drawGeometry";
import { ShapeView } from "@/components/reference/ShapeView";
import {
  DRAW_TOOL_DEFS, uid, type DashStyle, type DrawShape, type DrawTool, type RouteStyle,
} from "@/components/reference/referenceShared";
import {
  parseStoryboardData, serializeStoryboardData, STORYBOARD_HEIGHT, STORYBOARD_WIDTH, type StoryboardDocument,
} from "./storyboardDocument";

type StoryboardTool = Exclude<DrawTool, "select"> | "text";
type PenState = { tool: StoryboardTool; color: string; width: number; dash: DashStyle; route: RouteStyle; op: number };

const TOOL_ICON: Record<StoryboardTool, typeof Pen> = {
  pen: Pen,
  marker: Highlighter,
  line: Slash,
  arrow: MoveUpRight,
  rect: Square,
  ellipse: Circle,
  diamond: Diamond,
  eraser: Eraser,
  text: Type,
};
const TOOLS = DRAW_TOOL_DEFS.map((definition) => ({ tool: definition.tool as StoryboardTool, labelKey: definition.labelKey }));
const COLORS = ["#ffffff", "#3b82f6", "#f59e0b", "#f43f5e", "#10b981", "#a855f7", "#111827"];

interface Props {
  data: string;
  onCommit: (data: string) => void;
}

function ToolButton({ active, disabled, label, icon: Icon, onClick }: {
  active?: boolean;
  disabled?: boolean;
  label: string;
  icon: typeof Pen;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button size="icon-sm" variant={active ? "default" : "ghost"} disabled={disabled} aria-label={label} aria-pressed={active} onClick={onClick} />}>
        <Icon />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function StoryboardCanvas({ data, onCommit }: Props) {
  const { t } = useTranslation("script");
  const { t: tReference } = useTranslation("reference");
  const initial = useRef(parseStoryboardData(data));
  const surfaceRef = useRef<HTMLDivElement>(null);
  const shapesRef = useRef<DrawShape[]>(initial.current.shapes);
  const backgroundRef = useRef(initial.current.background);
  const draftRef = useRef<DrawShape | null>(null);
  const gestureBefore = useRef<StoryboardDocument | null>(null);
  const drawing = useRef(false);
  const lastCommit = useRef<string | null>(null);
  const [shapes, setShapesState] = useState<DrawShape[]>(initial.current.shapes);
  const [draft, setDraftState] = useState<DrawShape | null>(null);
  const [past, setPast] = useState<StoryboardDocument[]>([]);
  const [future, setFuture] = useState<StoryboardDocument[]>([]);
  const [textDraft, setTextDraft] = useState<{ x: number; y: number; value: string } | null>(null);
  const [pen, setPen] = useState<PenState>({ tool: "pen", color: "#ffffff", width: 5, dash: "solid", route: "straight", op: 1 });

  const setShapes = (next: DrawShape[]) => {
    shapesRef.current = next;
    setShapesState(next);
  };
  const setDraft = (next: DrawShape | null) => {
    draftRef.current = next;
    setDraftState(next);
  };
  const snapshot = (): StoryboardDocument => ({ version: 2, background: backgroundRef.current, shapes: shapesRef.current });
  const emitDocument = (next: StoryboardDocument) => {
    backgroundRef.current = next.background;
    setShapes(next.shapes);
    const encoded = serializeStoryboardData(next);
    lastCommit.current = encoded;
    onCommit(encoded);
  };
  const emit = (next: DrawShape[]) => emitDocument({ version: 2, background: backgroundRef.current, shapes: next });
  const remember = (before: StoryboardDocument) => {
    setPast((entries) => [...entries.slice(-99), before]);
    setFuture([]);
  };

  useEffect(() => {
    if (data === lastCommit.current) return;
    const parsed = parseStoryboardData(data);
    backgroundRef.current = parsed.background;
    setShapes(parsed.shapes);
    setDraft(null);
    setPast([]);
    setFuture([]);
  }, [data]);

  const point = (event: React.PointerEvent) => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: ((event.clientX - rect.left) / rect.width) * STORYBOARD_WIDTH,
      y: ((event.clientY - rect.top) / rect.height) * STORYBOARD_HEIGHT,
    };
  };

  const eraseAt = (x: number, y: number) => {
    const threshold = pen.width + 18;
    setShapes(shapesRef.current.filter((shape) => !hitShape(shape, x, y, threshold)));
  };

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const { x, y } = point(event);
    if (pen.tool === "text") {
      setTextDraft({ x, y, value: "" });
      return;
    }
    drawing.current = true;
    gestureBefore.current = snapshot();
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* best-effort */ }
    if (pen.tool === "eraser") {
      eraseAt(x, y);
      return;
    }
    const opacity = pen.tool === "marker" ? (pen.op < 1 ? pen.op : 0.45) : (pen.op < 1 ? pen.op : undefined);
    const base = { id: uid(), c: pen.color, w: pen.tool === "marker" ? pen.width * 2.4 : pen.width, dash: pen.dash, op: opacity };
    if (pen.tool === "pen" || pen.tool === "marker") setDraft({ ...base, t: "pen", p: [x, y] });
    else if (pen.tool === "arrow") setDraft({ ...base, t: "arrow", p: [x, y, x, y], h1: "none", h2: "arrow", route: pen.route });
    else if (pen.tool === "line") setDraft({ ...base, t: "line", p: [x, y, x, y], route: pen.route });
    else setDraft({ ...base, t: pen.tool, p: [x, y, x, y] });
  };

  const onPointerMove = (event: React.PointerEvent) => {
    if (!drawing.current) return;
    const { x, y } = point(event);
    if (pen.tool === "eraser") {
      eraseAt(x, y);
      return;
    }
    const current = draftRef.current;
    if (!current) return;
    if (current.t === "pen") {
      const length = current.p.length;
      if (length >= 2 && Math.hypot(x - current.p[length - 2], y - current.p[length - 1]) < 2) return;
      setDraft({ ...current, p: [...current.p, x, y] });
      return;
    }
    let endX = x;
    let endY = y;
    if (event.shiftKey && (current.t === "line" || current.t === "arrow")) {
      const dx = x - current.p[0];
      const dy = y - current.p[1];
      const length = Math.hypot(dx, dy);
      const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 12)) * (Math.PI / 12);
      endX = current.p[0] + Math.cos(angle) * length;
      endY = current.p[1] + Math.sin(angle) * length;
    } else if (event.shiftKey && (current.t === "rect" || current.t === "ellipse" || current.t === "diamond")) {
      const dx = x - current.p[0];
      const dy = y - current.p[1];
      const side = Math.max(Math.abs(dx), Math.abs(dy));
      endX = current.p[0] + Math.sign(dx || 1) * side;
      endY = current.p[1] + Math.sign(dy || 1) * side;
    }
    setDraft({ ...current, p: [current.p[0], current.p[1], endX, endY] });
  };

  const finishGesture = (event?: React.PointerEvent) => {
    if (!drawing.current) return;
    drawing.current = false;
    if (event) {
      try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* noop */ }
    }
    const before = gestureBefore.current ?? snapshot();
    gestureBefore.current = null;
    if (pen.tool === "eraser") {
      if (before.shapes !== shapesRef.current) {
        remember(before);
        emit(shapesRef.current);
      }
      return;
    }
    const current = draftRef.current;
    setDraft(null);
    if (!current) return;
    const valid = current.t === "pen"
      ? current.p.length >= 4
      : Math.hypot(current.p[2] - current.p[0], current.p[3] - current.p[1]) > 4;
    if (!valid) return;
    const next = [...shapesRef.current, current];
    remember(before);
    emit(next);
  };

  const commitText = () => {
    if (!textDraft) return;
    const value = textDraft.value.trim();
    if (value) {
      const before = snapshot();
      const next = [...before.shapes, { id: uid(), t: "text", c: pen.color, w: Math.max(22, pen.width * 5), p: [textDraft.x, textDraft.y], text: value } satisfies DrawShape];
      remember(before);
      emit(next);
    }
    setTextDraft(null);
  };

  const undo = () => {
    const previous = past[past.length - 1];
    if (!previous) return;
    setPast((entries) => entries.slice(0, -1));
    setFuture((entries) => [...entries, snapshot()]);
    emitDocument(previous);
  };
  const redo = () => {
    const next = future[future.length - 1];
    if (!next) return;
    setFuture((entries) => entries.slice(0, -1));
    setPast((entries) => [...entries, snapshot()]);
    emitDocument(next);
  };
  const clear = () => {
    if (!shapesRef.current.length && !backgroundRef.current) return;
    remember(snapshot());
    emitDocument({ version: 2, shapes: [] });
  };

  const connector = pen.tool === "arrow" || pen.tool === "line";
  const styleable = pen.tool !== "eraser" && pen.tool !== "text";

  return (
    <div className="storyboard-wrap" onClick={(event) => event.stopPropagation()}>
      <div className="storyboard-tools">
        <div className="storyboard-tools-scroll">
          {TOOLS.map(({ tool, labelKey }) => (
            <ToolButton key={tool} icon={TOOL_ICON[tool]} label={tReference(labelKey)} active={pen.tool === tool} onClick={() => setPen((current) => ({ ...current, tool }))} />
          ))}
          <ToolButton icon={Type} label={tReference("toolbar.addText")} active={pen.tool === "text"} onClick={() => setPen((current) => ({ ...current, tool: "text" }))} />
          <Separator orientation="vertical" className="h-6" />
          {styleable && (
            <DrawStyleControls
              widthPx={pen.width}
              dash={pen.dash}
              route={pen.route}
              showRoute={connector}
              opacity={pen.op}
              onWidthPx={(width) => setPen((current) => ({ ...current, width }))}
              onDash={(dash) => setPen((current) => ({ ...current, dash }))}
              onRoute={(route) => setPen((current) => ({ ...current, route }))}
              onOpacity={(op) => setPen((current) => ({ ...current, op }))}
            />
          )}
          <Separator orientation="vertical" className="h-6" />
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex" />}>
              <ColorPicker value={pen.color} onChange={(color) => setPen((current) => ({ ...current, color }))} ariaLabel={tReference("draw.strokeColor")} presets={COLORS} side="bottom" />
            </TooltipTrigger>
            <TooltipContent>{tReference("draw.strokeColor")}</TooltipContent>
          </Tooltip>
          <Separator orientation="vertical" className="h-6" />
          <ToolButton icon={Undo2} label={tReference("actions.undo")} disabled={!past.length} onClick={undo} />
          <ToolButton icon={Redo2} label={tReference("actions.redo")} disabled={!future.length} onClick={redo} />
          <ToolButton icon={Trash2} label={t("storyboard.clear")} disabled={!shapes.length && !backgroundRef.current} onClick={clear} />
        </div>
      </div>

      <div
        ref={surfaceRef}
        className="storyboard-surface"
        style={{ cursor: pen.tool === "eraser" ? "cell" : pen.tool === "text" ? "text" : "crosshair" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishGesture}
        onPointerCancel={finishGesture}
        onLostPointerCapture={() => finishGesture()}
      >
        <svg viewBox={`0 0 ${STORYBOARD_WIDTH} ${STORYBOARD_HEIGHT}`} preserveAspectRatio="none">
          {backgroundRef.current && <image href={backgroundRef.current} x={0} y={0} width={STORYBOARD_WIDTH} height={STORYBOARD_HEIGHT} preserveAspectRatio="none" />}
          {shapes.map((shape) => <ShapeView key={shape.id} s={shape} />)}
          {draft && <ShapeView s={draft} />}
        </svg>
        {textDraft && (
          <textarea
            autoFocus
            aria-label={t("storyboard.clickToDraw")}
            className="storyboard-text-input"
            style={{ left: `${(textDraft.x / STORYBOARD_WIDTH) * 100}%`, top: `${(textDraft.y / STORYBOARD_HEIGHT) * 100}%`, color: pen.color }}
            value={textDraft.value}
            onPointerDown={(event) => event.stopPropagation()}
            onChange={(event) => setTextDraft({ ...textDraft, value: event.target.value })}
            onBlur={commitText}
            onKeyDown={(event) => {
              if (event.key === "Escape") { event.preventDefault(); setTextDraft(null); }
              else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); commitText(); }
            }}
          />
        )}
      </div>
    </div>
  );
}
