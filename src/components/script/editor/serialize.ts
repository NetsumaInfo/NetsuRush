// Pont Tiptap ⇄ modèle de blocs. Le document Tiptap (JSON ProseMirror) est la vérité PENDANT
// l'édition ; on le resérialise vers le modèle `ScriptBlock[]` (persistance SQLite/JSON + build
// timeline frame-accurate). Chaque nœud de bloc porte `blockId` (stable, posé par l'extension
// BlockId) ; le média est un nœud `mediaCard` rattaché POSITIONNELLEMENT au bloc qui le précède
// (règle de sérialisation : tout média placé sous un paragraphe lui est rattaché).

import type { JSONContent } from "@tiptap/core";
import type { ScriptBlock, ScriptBlockMedia, ScriptBlockType } from "@/lib/bridge";
import { makeBlock } from "../scriptShared";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Contenu inline Tiptap → HTML (le modèle stocke le texte en HTML : gras/italique/souligné/barré).
function inlineToHtml(content?: JSONContent[]): string {
  if (!content) return "";
  let html = "";
  for (const n of content) {
    if (n.type === "hardBreak") { html += "<br>"; continue; }
    if (n.type === "pageMention") {
      const pid = escapeHtml(String(n.attrs?.pageId ?? ""));
      const label = escapeHtml(String(n.attrs?.label ?? ""));
      html += `<span class="nb-mention" data-page-id="${pid}" data-label="${label}">@${label}</span>`;
      continue;
    }
    if (n.type !== "text" || !n.text) continue;
    let t = escapeHtml(n.text);
    for (const m of n.marks ?? []) {
      if (m.type === "bold") t = `<strong>${t}</strong>`;
      else if (m.type === "italic") t = `<em>${t}</em>`;
      else if (m.type === "underline") t = `<u>${t}</u>`;
      else if (m.type === "strike") t = `<s>${t}</s>`;
      else if (m.type === "mediaHl") {
        const mid = m.attrs?.mediaId ? ` data-media-id="${escapeHtml(String(m.attrs.mediaId))}"` : "";
        t = `<span class="nr-hl nr-hl-${m.attrs?.color ?? "blue"}"${mid}>${t}</span>`;
      }
    }
    html += t;
  }
  return html;
}

// HTML du modèle → contenu inline Tiptap (marks reconstruits depuis les balises).
function htmlToInline(html: string): JSONContent[] {
  const div = document.createElement("div");
  div.innerHTML = html || "";
  const out: JSONContent[] = [];
  const walk = (node: Node, marks: { type: string; attrs?: Record<string, unknown> }[]) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.textContent ?? "";
        if (text) out.push(marks.length ? { type: "text", text, marks: marks.map((m) => ({ ...m })) } : { type: "text", text });
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as HTMLElement;
        const tag = el.tagName.toLowerCase();
        if (tag === "br") { out.push({ type: "hardBreak" }); continue; }
        // @mention (nœud inline atome — pas un mark : ne PAS descendre dans ses enfants).
        if (tag === "span" && el.hasAttribute("data-page-id")) {
          out.push({
            type: "pageMention",
            attrs: {
              pageId: el.getAttribute("data-page-id") || "",
              label: el.getAttribute("data-label") || (el.textContent || "").replace(/^@/, ""),
            },
          });
          continue;
        }
        const nm: { type: string; attrs?: Record<string, unknown> }[] = [...marks];
        if (tag === "strong" || tag === "b") nm.push({ type: "bold" });
        else if (tag === "em" || tag === "i") nm.push({ type: "italic" });
        else if (tag === "u") nm.push({ type: "underline" });
        else if (tag === "s" || tag === "strike" || tag === "del") nm.push({ type: "strike" });
        else if (tag === "span" && el.classList.contains("nr-hl")) {
          const cm = /nr-hl-(\w+)/.exec(el.className);
          nm.push({ type: "mediaHl", attrs: { color: cm?.[1] ?? "blue", mediaId: el.getAttribute("data-media-id") } });
        }
        walk(el, nm);
      }
    }
  };
  walk(div, []);
  return out;
}

const mediaNode = (m: ScriptBlockMedia): JSONContent => ({ type: "mediaCard", attrs: { media: m } });

function blockBody(b: ScriptBlock): JSONContent[] {
  const inline = htmlToInline(b.text);
  return inline.length ? inline : [];
}

// bloc → nœud Tiptap (hors média, ajouté séparément par l'appelant).
function blockToNode(b: ScriptBlock): JSONContent {
  const attrs = { blockId: b.id, tags: b.tags };
  if (b.type === "heading") {
    const level = b.level && b.level >= 1 && b.level <= 3 ? b.level : 2;
    return { type: "heading", attrs: { ...attrs, level }, content: blockBody(b) };
  }
  if (b.type === "note") return { type: "comment", attrs, content: blockBody(b) };
  if (b.type === "storyboard") return { type: "storyboard", attrs: { ...attrs, data: b.data || "" } };
  if (b.type === "callout") {
    // Style de l'encadré (couleur + emoji) persisté dans `data` en JSON.
    let style: { color?: string; emoji?: string } = {};
    try { style = JSON.parse(b.data || "{}"); } catch { /* défauts */ }
    return { type: "callout", attrs: { ...attrs, color: style.color ?? "blue", emoji: style.emoji ?? "💡" }, content: blockBody(b) };
  }
  if (b.type === "divider") return { type: "divider", attrs: { ...attrs, style: b.data || "line" } };
  return { type: "paragraph", attrs, content: blockBody(b) };
}

// Groupe de blocs liste consécutifs (bullet OU numbered) → bulletList/orderedList Tiptap.
const LIST_NODE: Record<string, string> = { bullet: "bulletList", numbered: "orderedList" };

// Modèle `ScriptBlock[]` → document Tiptap. Les todos consécutifs sont groupés en une taskList ;
// le média d'un bloc est émis en nœuds `mediaCard` juste APRÈS le bloc (rattachement positionnel).
export function blocksToDoc(blocks: ScriptBlock[]): JSONContent {
  const content: JSONContent[] = [];
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i];
    if (b.type === "todo") {
      const items: JSONContent[] = [];
      const pending: JSONContent[] = [];
      while (i < blocks.length && blocks[i].type === "todo") {
        const tb = blocks[i];
        items.push({
          type: "taskItem",
          attrs: { checked: !!tb.checked, blockId: tb.id, tags: tb.tags },
          content: [{ type: "paragraph", content: blockBody(tb) }],
        });
        for (const m of tb.media) pending.push(mediaNode(m));
        i++;
      }
      content.push({ type: "taskList", content: items });
      content.push(...pending);
      continue;
    }
    if (b.type === "bullet" || b.type === "numbered") {
      const listType = b.type;
      const items: JSONContent[] = [];
      const pending: JSONContent[] = [];
      while (i < blocks.length && blocks[i].type === listType) {
        const lb = blocks[i];
        items.push({
          type: "listItem",
          attrs: { blockId: lb.id, tags: lb.tags },
          content: [{ type: "paragraph", content: blockBody(lb) }],
        });
        for (const m of lb.media) pending.push(mediaNode(m));
        i++;
      }
      content.push({ type: LIST_NODE[listType], content: items });
      content.push(...pending);
      continue;
    }
    content.push(blockToNode(b));
    for (const m of b.media) content.push(mediaNode(m));
    i++;
  }
  if (!content.length) content.push({ type: "paragraph" });
  return { type: "doc", content };
}

const TYPE_OF: Record<string, ScriptBlockType> = {
  paragraph: "text", heading: "heading", comment: "note", storyboard: "storyboard", callout: "callout", divider: "divider",
};

// Contenu de la colonne `data` selon le type : document vectoriel du storyboard (ou PNG legacy), style JSON de l'encadré,
// style du séparateur — sinon vide.
function blockData(type: ScriptBlockType, attrs: Record<string, unknown>): string {
  if (type === "storyboard") return String(attrs.data ?? "");
  if (type === "callout") return JSON.stringify({ color: String(attrs.color ?? "blue"), emoji: String(attrs.emoji ?? "💡") });
  if (type === "divider") return String(attrs.style ?? "line");
  return "";
}

function nodeToBlock(node: JSONContent): ScriptBlock {
  const type = TYPE_OF[node.type ?? "paragraph"] ?? "text";
  const base = makeBlock(type);
  const attrs = node.attrs ?? {};
  const level = type === "heading" && typeof attrs.level === "number" ? Math.min(3, Math.max(1, attrs.level)) : undefined;
  return {
    ...base,
    id: typeof attrs.blockId === "string" && attrs.blockId ? attrs.blockId : base.id,
    type,
    ...(level ? { level } : {}),
    text: type === "storyboard" || type === "divider" ? "" : inlineToHtml(node.content),
    data: blockData(type, attrs),
    tags: Array.isArray(attrs.tags) ? attrs.tags.filter((t: unknown): t is string => typeof t === "string") : [],
    media: [],
  };
}

// listItem → bloc liste (puce ou numérotée). Même mécanique que todoItemToBlock.
function listItemToBlock(item: JSONContent, type: "bullet" | "numbered"): ScriptBlock {
  const base = makeBlock(type);
  const attrs = item.attrs ?? {};
  const para = item.content?.find((c) => c.type === "paragraph");
  return {
    ...base,
    id: typeof attrs.blockId === "string" && attrs.blockId ? attrs.blockId : base.id,
    type,
    text: inlineToHtml(para?.content),
    tags: Array.isArray(attrs.tags) ? attrs.tags.filter((t: unknown): t is string => typeof t === "string") : [],
    media: [],
  };
}

function todoItemToBlock(item: JSONContent): ScriptBlock {
  const base = makeBlock("todo");
  const attrs = item.attrs ?? {};
  const para = item.content?.find((c) => c.type === "paragraph");
  return {
    ...base,
    id: typeof attrs.blockId === "string" && attrs.blockId ? attrs.blockId : base.id,
    type: "todo",
    text: inlineToHtml(para?.content),
    checked: !!attrs.checked,
    tags: Array.isArray(attrs.tags) ? attrs.tags.filter((t: unknown): t is string => typeof t === "string") : [],
    media: [],
  };
}

// Document Tiptap → modèle `ScriptBlock[]`. Un `mediaCard` se rattache au DERNIER bloc émis (le
// paragraphe au-dessus) ; s'il flotte tout en haut, il devient un bloc média autonome.
export function docToBlocks(doc: JSONContent | null): ScriptBlock[] {
  const out: ScriptBlock[] = [];
  const top = doc?.content ?? [];
  for (const node of top) {
    if (node.type === "taskList") {
      for (const item of node.content ?? []) out.push(todoItemToBlock(item));
      continue;
    }
    if (node.type === "bulletList" || node.type === "orderedList") {
      const t = node.type === "bulletList" ? "bullet" : "numbered";
      for (const item of node.content ?? []) out.push(listItemToBlock(item, t));
      continue;
    }
    if (node.type === "mediaCard") {
      const m = node.attrs?.media as ScriptBlockMedia | undefined;
      if (!m) continue;
      if (out.length) out[out.length - 1].media.push(m);
      else out.push({ ...makeBlock("text"), media: [m] });
      continue;
    }
    out.push(nodeToBlock(node));
  }
  return out.length ? out : [makeBlock("text")];
}
