import type { DrawShape } from "@/components/reference/referenceShared";
import { ShapeView } from "@/components/reference/ShapeView";

export const STORYBOARD_WIDTH = 1280;
export const STORYBOARD_HEIGHT = 720;

export interface StoryboardDocument {
  version: 2;
  background?: string;
  shapes: DrawShape[];
}

export function parseStoryboardData(data: string): StoryboardDocument {
  if (!data) return { version: 2, shapes: [] };
  if (data.startsWith("data:image/")) return { version: 2, background: data, shapes: [] };
  try {
    const parsed = JSON.parse(data) as { v?: number; background?: unknown; shapes?: unknown };
    if (parsed.v !== 2 || !Array.isArray(parsed.shapes)) throw new Error("unsupported storyboard data");
    return {
      version: 2,
      background: typeof parsed.background === "string" ? parsed.background : undefined,
      shapes: parsed.shapes as DrawShape[],
    };
  } catch {
    return { version: 2, shapes: [] };
  }
}

export function serializeStoryboardData(doc: StoryboardDocument): string {
  if (!doc.background && doc.shapes.length === 0) return "";
  return JSON.stringify({ v: 2, ...(doc.background ? { background: doc.background } : {}), shapes: doc.shapes });
}

export function StoryboardArtwork({ data, className }: { data: string; className?: string }) {
  const doc = parseStoryboardData(data);
  return (
    <svg className={className} viewBox={`0 0 ${STORYBOARD_WIDTH} ${STORYBOARD_HEIGHT}`} preserveAspectRatio="xMidYMid meet" aria-hidden>
      {doc.background && <image href={doc.background} x={0} y={0} width={STORYBOARD_WIDTH} height={STORYBOARD_HEIGHT} preserveAspectRatio="none" />}
      {doc.shapes.map((shape) => <ShapeView key={shape.id} s={shape} />)}
    </svg>
  );
}
