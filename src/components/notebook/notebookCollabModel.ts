import type { CollabOp, SurfaceEntryProjection } from "@/lib/collab/types";
import type { NotebookMeta, NotebookPage, NoteBlock, Database } from "./notebookShared";

export type NotebookSnapshot = { notebook: NotebookMeta; pages: NotebookPage[]; databases: Record<string, Database> };
type Span = { insert: string; attributes?: Record<string, string> | null };
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function inlineSpans(content: unknown[]): Span[] {
  return content.flatMap((raw): Span[] => {
    if (typeof raw === "string") return [{ insert: raw }];
    const item = record(raw);
    if (item.type === "link") return inlineSpans(Array.isArray(item.content) ? item.content : []).map((span) => ({ ...span, attributes: { ...span.attributes, link: JSON.stringify(item.href) } }));
    if (item.type === "text") return [{ insert: String(item.text ?? ""), attributes: Object.fromEntries(Object.entries(record(item.styles)).map(([key, value]) => [key, JSON.stringify(value)])) }];
    return [{ insert: "\uFFFC", attributes: { inline: JSON.stringify(item) } }];
  });
}

export function encodeNotebook(snapshot: NotebookSnapshot): SurfaceEntryProjection[] {
  const entries: SurfaceEntryProjection[] = [];
  const make = (entryId: string, kind: SurfaceEntryProjection["kind"], fields: Record<string, unknown>) => {
    const entry: SurfaceEntryProjection = { entryId, kind, fields, texts: {}, richTexts: {}, media: {} };
    entries.push(entry); return entry;
  };
  const { id: _id, updatedAt: _updated, scriptId: _script, ...meta } = snapshot.notebook;
  make("notebook", "notebook", meta);
  for (const page of snapshot.pages) {
    const { blocks, id, notebookId: _nb, updatedAt: _ts, ...meta } = page;
    make(id, "page", meta);
    const visit = (blocks: NoteBlock[], parentBlockId: string | null) => blocks.forEach((block, order) => {
      const { id: blockId, children, content, ...shape } = block;
      if (typeof blockId !== "string") throw new Error("Notebook block has no stable id");
      const entry = make(blockId, "block", { ...shape, pageId: page.id, parentBlockId, order });
      if (Array.isArray(content)) {
        const spans = inlineSpans(content);
        entry.richTexts!.content = spans;
        entry.texts.content = spans.map((span) => span.insert).join("");
      } else if (content && typeof content === "object" && record(content).type === "tableContent") {
        const table = record(content); const rows = Array.isArray(table.rows) ? table.rows : [];
        entry.fields.table = { ...table, rows: rows.map((row, r) => ({ ...record(row), cells: (Array.isArray(record(row).cells) ? record(row).cells as unknown[] : []).map((cell, c) => {
          const key = `cell_${r}_${c}`; const spans = inlineSpans(Array.isArray(cell) ? cell : []);
          entry.richTexts![key] = spans; entry.texts[key] = spans.map((span) => span.insert).join(""); return key;
        }) })) };
      } else if (content !== undefined) entry.fields.content = content;
      if (Array.isArray(children)) visit(children as NoteBlock[], blockId);
    });
    visit(blocks, null);
  }
  for (const [id, database] of Object.entries(snapshot.databases)) {
    const contains = (blocks: NoteBlock[]): boolean => blocks.some((block) => record(block.props).dbId === id || (Array.isArray(block.children) && contains(block.children as NoteBlock[])));
    const pageId = snapshot.pages.find((page) => contains(page.blocks))?.id;
    if (pageId) make(`db_${id}`, "database", { ...database, pageId });
  }
  return entries;
}

function inlineContent(spans: Span[]): unknown[] {
  const result: unknown[] = [];
  for (const span of spans) {
    const styles: Record<string, unknown> = {}; let link: string | undefined; let inline: unknown;
    for (const [key, raw] of Object.entries(span.attributes ?? {})) {
      if (raw === null) continue;
      let value: unknown; try { value = JSON.parse(raw); } catch { continue; }
      if (key === "inline") inline = value; else if (key === "link") link = String(value); else styles[key] = value;
    }
    if (inline) { for (const char of span.insert) result.push(char === "\uFFFC" ? inline : { type: "text", text: char, styles }); continue; }
    const text = { type: "text", text: span.insert, styles };
    result.push(link ? { type: "link", href: link, content: [text] } : text);
  }
  return result;
}

export function decodeNotebook(entries: SurfaceEntryProjection[], notebookId: string): NotebookSnapshot {
  const notebook = { ...entries.find((entry) => entry.kind === "notebook")?.fields, id: notebookId, updatedAt: 0 } as unknown as NotebookMeta;
  const blocks = entries.filter((entry) => entry.kind === "block");
  const build = (pageId: string, parent: string | null, visited = new Set<string>()): NoteBlock[] => blocks
    .filter((entry) => entry.fields.pageId === pageId && (entry.fields.parentBlockId ?? null) === parent && !visited.has(entry.entryId))
    .sort((a, b) => Number(a.fields.order) - Number(b.fields.order) || a.entryId.localeCompare(b.entryId))
    .map((entry) => {
      const { pageId: _page, parentBlockId: _parent, order: _order, table, ...shape } = entry.fields;
      const nextVisited = new Set(visited).add(entry.entryId);
      const block: NoteBlock = { ...shape, id: entry.entryId, children: build(pageId, entry.entryId, nextVisited) };
      if (Object.prototype.hasOwnProperty.call(entry.texts, "content")) block.content = inlineContent(entry.richTexts?.content ?? [{ insert: entry.texts.content }]);
      if (table) block.content = { ...record(table), rows: (record(table).rows as Record<string, unknown>[]).map((row) => ({ ...row, cells: (row.cells as string[]).map((key) => inlineContent(entry.richTexts?.[key] ?? [{ insert: entry.texts[key] ?? "" }])) })) };
      return block;
    });
  const pages = entries.filter((entry) => entry.kind === "page").map((entry) => ({ ...entry.fields, id: entry.entryId, notebookId, updatedAt: 0, blocks: build(entry.entryId, null) } as unknown as NotebookPage));
  const databases = Object.fromEntries(entries.filter((entry) => entry.kind === "database").map((entry) => [entry.entryId.slice(3), entry.fields as unknown as Database]));
  return { notebook, pages, databases };
}

function textOperations(entryId: string, field: string, before: string, after: string): CollabOp[] {
  const a = Array.from(before), b = Array.from(after); let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const ops: CollabOp[] = [];
  if (endA > start) ops.push({ type: "surfaceTextDelete", entryId, field, index: start, length: endA - start });
  if (endB > start) ops.push({ type: "surfaceTextInsert", entryId, field, index: start, text: b.slice(start, endB).join("") });
  return ops;
}

export function diffNotebook(before: SurfaceEntryProjection[], after: SurfaceEntryProjection[]): CollabOp[] {
  const previous = new Map(before.map((entry) => [entry.entryId, entry])); const next = new Set(after.map((entry) => entry.entryId)); const ops: CollabOp[] = [];
  for (const entry of after) {
    const old = previous.get(entry.entryId);
    if (!old) ops.push({ type: "surfaceRestoreEntry", entryId: entry.entryId });
    const fields = Object.fromEntries(Object.entries(entry.fields).filter(([key, value]) => !old || !equal(old.fields[key], value)));
    for (const key of Object.keys(old?.fields ?? {})) if (!(key in entry.fields)) fields[key] = null;
    if (!old || Object.keys(fields).length) ops.push({ type: "surfaceSetEntry", entryId: entry.entryId, kind: entry.kind, fields });
    for (const field of new Set([...Object.keys(old?.texts ?? {}), ...Object.keys(entry.texts)])) {
      const from = old?.texts[field] ?? "", to = entry.texts[field] ?? "";
      ops.push(...textOperations(entry.entryId, field, from, to));
      if (!equal(old?.richTexts?.[field], entry.richTexts?.[field]) && to.length) {
        // Only formatting differences emit marks. Text insertion inherits its surrounding Loro marks.
        const oldFormats = old?.richTexts?.[field]?.map((span) => span.attributes ?? {}) ?? [];
        const spans = entry.richTexts?.[field] ?? [{ insert: to }];
        if (from === to || !equal(oldFormats, spans.map((span) => span.attributes ?? {}))) {
          let start = 0;
          const allKeys = new Set([...oldFormats.flatMap((attrs) => Object.keys(attrs)), ...spans.flatMap((span) => Object.keys(span.attributes ?? {}))]);
          for (const span of spans) {
            const end = start + Array.from(span.insert).length;
            if (end > start) for (const style of allKeys) ops.push({ type: "surfaceTextFormat", entryId: entry.entryId, field, start, end, style, value: span.attributes?.[style] ?? null });
            start = end;
          }
        }
      }
    }
    for (const field of new Set([...Object.keys(old?.media ?? {}), ...Object.keys(entry.media)])) if (!equal(old?.media[field], entry.media[field])) ops.push({ type: "surfaceSetMedia", entryId: entry.entryId, field, manifest: entry.media[field] ?? null });
  }
  for (const entry of before) if (!next.has(entry.entryId)) ops.push({ type: "surfaceDeleteEntry", entryId: entry.entryId });
  return ops;
}
