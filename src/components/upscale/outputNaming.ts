import type { UpSource } from "./upscaleShared";

// Output naming for the process hub: ONE pattern shared by every source, tokens resolved at run
// time, and an exact per-media name when the pattern is not the right tool (stored on the source
// itself, see `UpSource.outName`). One field on screen, never a per-media list.

export const NAME_TOKENS = ["name", "op", "scale", "model", "date", "n", "nn", "nnn"] as const;
export type NameToken = (typeof NAME_TOKENS)[number];

// Supplied by the active op: what {op}, {scale} and {model} stand for in THIS run.
export interface NamingTokens {
  op: string;      // upscaled | restored | turbo | rtx | interp | depth | alpha | chain
  scale: string;   // "4x", "2x"... empty when the op does not resize
  model: string;   // model / shader identifier actually used
}

export const EMPTY_TOKENS: NamingTokens = { op: "", scale: "", model: "" };
export const DEFAULT_PATTERN = "{name}_{op}_{scale}";

// Characters Windows rejects in a file name, plus path separators.
const FORBIDDEN = /[\\/:*?"<>|]/g;
// An empty token ({scale} on a depth map) would leave "clip_depth_": collapse the separators.
const RUNS = /[_\-.\s]{2,}/g;
const EDGES = /^[_\-.\s]+|[_\-.\s]+$/g;

function isoDate(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Cleans a file name (no extension): forbidden characters, redundant separators. */
export function sanitizeOutputName(value: string): string {
  return value.replace(FORBIDDEN, "").replace(RUNS, (m) => m[0]).replace(EDGES, "").trim();
}

/** Output name (no extension) of one source: exact name carried by the media, else the pattern. */
export function resolveOutputName(
  source: UpSource, index: number, pattern: string, tokens: NamingTokens, at = Date.now(),
): string {
  const original = source.name.replace(/\.[^.]+$/, "");
  const exact = source.outName?.trim();
  if (exact) return sanitizeOutputName(exact) || original;
  const values: Record<NameToken, string> = {
    name: original,
    op: tokens.op,
    scale: tokens.scale,
    model: tokens.model,
    date: isoDate(at),
    n: String(index + 1),
    nn: String(index + 1).padStart(2, "0"),
    nnn: String(index + 1).padStart(3, "0"),
  };
  const filled = (pattern || DEFAULT_PATTERN).replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in values ? values[key as NameToken] : whole);
  return sanitizeOutputName(filled) || original;
}

export interface NamingReport {
  /** Resolved name of every source, in tray order. */
  names: string[];
  /** Names produced by SEVERAL sources - one output would overwrite the other. */
  collisions: { name: string; indexes: number[] }[];
  /** Sources whose pattern resolves to nothing usable. */
  empty: number[];
  problem: "duplicateOutputNames" | "emptyOutputName" | null;
}

/**
 * Resolves the names of ALL sources and reports the clashes. Two sources landing on the same name
 * would write the same file: the second job would silently overwrite the first, hence a report
 * that names the offenders (which name, which sources) instead of a bare flag.
 */
export function reviewOutputNames(
  sources: UpSource[], pattern: string, tokens: NamingTokens, at = Date.now(),
): NamingReport {
  const names = sources.map((source, i) => resolveOutputName(source, i, pattern, tokens, at));
  const byName = new Map<string, number[]>();
  const empty: number[] = [];
  names.forEach((name, i) => {
    if (!name) { empty.push(i); return; }
    const key = name.toLocaleLowerCase();
    const seen = byName.get(key);
    if (seen) seen.push(i); else byName.set(key, [i]);
  });
  const collisions = [...byName.entries()]
    .filter(([, indexes]) => indexes.length > 1)
    .map(([, indexes]) => ({ name: names[indexes[0]], indexes }));
  return {
    names,
    collisions,
    empty,
    problem: empty.length ? "emptyOutputName" : collisions.length ? "duplicateOutputNames" : null,
  };
}

/** Appends a counter to the pattern - one-click fix when several sources collide. */
export function numberedPattern(pattern: string): string {
  const base = pattern || DEFAULT_PATTERN;
  return /\{n{1,3}\}/.test(base) ? base : `${base}_{nn}`;
}
