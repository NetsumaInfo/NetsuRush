import { describe, expect, it } from "vitest";
import { loopExportable, loopFileName, loopSpan } from "../src/components/reference/boardLoopExport";

describe("board loop export", () => {
  it("offers the export on videos the core can read as a file", () => {
    expect(loopExportable({ kind: "video", ref: "C:/rush/a.mp4" })).toBe(true);
    expect(loopExportable({ kind: "video", ref: "https://example.com/a.mp4" })).toBe(true);
    expect(loopExportable({ kind: "video", ref: "blob:abc" })).toBe(false);
    expect(loopExportable({ kind: "image", ref: "C:/rush/a.png" })).toBe(false);
  });

  it("covers the loop bounds, else the whole file", () => {
    expect(loopSpan({ trimIn: 2, trimOut: 5, dur: 30 })).toEqual({ in: 2, end: 5, sec: 3 });
    expect(loopSpan({ dur: 30 })).toEqual({ in: undefined, end: undefined, sec: 30 });
    expect(loopSpan({ trimIn: 4, dur: 30 })).toEqual({ in: 4, end: undefined, sec: 26 });
    expect(loopSpan({}).sec).toBeNull();
  });

  it("proposes a file name without the source extension or forbidden characters", () => {
    expect(loopFileName("cut: 01.mp4", "webp")).toBe("cut_ 01.webp");
    expect(loopFileName(undefined, "gif")).toBe("loop.gif");
  });
});

import { loopRuns, loopSourceKind } from "../src/components/reference/boardLoopRender";
import type { BoardItem } from "../src/components/reference/referenceShared";

describe("whole-board loop export", () => {
  const item = (id: string, kind: string, z: number, extra: Record<string, unknown> = {}) =>
    ({ id, kind, z, ref: `C:/m/${id}`, x: 0, y: 0, w: 10, h: 10, ...extra }) as unknown as BoardItem;

  it("knows how each moving item reaches the core", () => {
    expect(loopSourceKind(item("v", "video", 1))).toBe("file");
    expect(loopSourceKind(item("v", "video", 1, { ref: "https://example.com/a.mp4" }))).toBe("fetch");
    expect(loopSourceKind(item("g", "image", 1, { ref: "C:/m/anim.GIF" }))).toBe("file");
    expect(loopSourceKind(item("p", "image", 1, { ref: "C:/m/still.png" }))).toBeNull();
    expect(loopSourceKind(item("y", "youtube", 1, { ref: "dQw4w9WgXcQ" }))).toBe("stream");
    expect(loopSourceKind(item("y", "youtube", 1, { localMedia: { kind: "video", ref: "C:/m/y.mp4", src: "" } }))).toBe("file");
    expect(loopSourceKind(item("s", "sequence", 1, { frames: ["C:/m/1.jpg", "C:/m/2.jpg"] }))).toBe("frames");
    expect(loopSourceKind(item("s", "sequence", 1, { frames: ["C:/m/1.jpg"] }))).toBeNull();
    expect(loopSourceKind(item("b", "video", 1, { ref: "blob:abc" }))).toBeNull();
    expect(loopSourceKind(item("m", "video", 1, { missing: { name: "a.mp4", size: 0, kind: "video" } }))).toBeNull();
    expect(loopSourceKind(item("t", "text", 1))).toBeNull();
  });

  it("cuts the z order at each clip", () => {
    const items = [
      item("top", "text", 5), item("v2", "video", 4), item("mid", "image", 3),
      item("v1", "video", 2), item("bg", "image", 1), item("ink", "draw", 9),
    ];
    const runs = loopRuns(items, undefined, (it) => it.kind === "video");
    expect(runs.map((r) => [r.still, r.clip?.id])).toEqual([
      [["bg"], "v1"], [["mid"], "v2"], [["top"], undefined],
    ]);
  });

  it("paints what could not be made readable as a still, and honours the selection scope", () => {
    const items = [item("lost", "video", 1), item("v", "video", 2), item("img", "image", 3)];
    const readable = (it: BoardItem) => it.id === "v";
    expect(loopRuns(items, undefined, readable).map((r) => [r.still, r.clip?.id])).toEqual([[["lost"], "v"], [["img"], undefined]]);
    expect(loopRuns(items, new Set(["img"]), readable)).toEqual([{ still: ["img"] }]);
  });
});
