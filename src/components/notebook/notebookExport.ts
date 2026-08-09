// Export / import de pages du Carnet (menu ⋯ du document + menu du carnet). Conversions Markdown/HTML
// via un éditeur BlockNote JETABLE jamais monté (les sérialiseurs n'exigent pas de vue) ; écriture sur
// disque via le core (notebook:writeExport) ; lecture de .md via un input fichier natif (marche aussi
// sous Tauri : le File du WebView2 porte le contenu).
// AVANT conversion, les blocs custom (équation, encadré, bascule, médias, database…) sont TRADUITS en
// blocs standards équivalents (prepareForExport) — sinon les sérialiseurs lossy les laissaient tomber :
// un export ne perdait ni les équations ni les databases, maintenant il les garde en $$tex$$ / tableau.
import { BlockNoteEditor } from "@blocknote/core";
import i18n from "@/i18n";
import { notebookSchema } from "./notebookSchema";
import {
  cellValueFor, formatDate, formatNumber, formatTimestamp,
  type ChecklistItem, type Database, type NoteBlock,
} from "./notebookShared";

// Éditeur headless pour les conversions (custom blocks du schéma inclus).
function headless() {
  return BlockNoteEditor.create({ schema: notebookSchema });
}

// ---- Traduction des blocs custom → blocs standards -----------------------------------------------
export interface ExportContext {
  databases?: Record<string, Database>;      // databases de la page (bloc /database → tableau)
  pageTitle?: (id: string) => string | null; // titre live d'une sous-page / mention
}

type AnyBlock = Record<string, any>;

function textRun(text: string, styles: Record<string, boolean> = {}): AnyBlock {
  return { type: "text", text, styles };
}

// Contenu inline : mentions/dates custom → texte ou lien standards.
function mapInline(content: unknown, ctx: ExportContext): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((c) => {
    if (!c || typeof c !== "object") return c;
    const cc = c as AnyBlock;
    if (cc.type === "pageMention") {
      const title = ctx.pageTitle?.(String(cc.props?.pageId || "")) || cc.props?.label || "page";
      return textRun(`@${title}`);
    }
    if (cc.type === "dateMention") return textRun(String(cc.props?.date || ""));
    if (cc.type === "linkMention") {
      const url = String(cc.props?.url || "");
      const title = String(cc.props?.title || url);
      return { type: "link", href: url, content: [textRun(title)] };
    }
    return c;
  });
}

// Cellule de database → texte d'affichage (mêmes règles que les vues).
function cellText(db: Database, fieldId: string, rowId: string): string {
  const field = db.fields.find((f) => f.id === fieldId);
  const row = db.rows.find((r) => r.id === rowId);
  if (!field || !row) return "";
  const v = cellValueFor(field, row);
  switch (field.type) {
    case "number": return formatNumber(v, field.numberFormat);
    case "date": return formatDate(v, field.dateFormat, field.includeTime);
    case "checkbox": return v ? "✓" : "";
    case "select": return field.options?.find((o) => o.id === v)?.label || "";
    case "multiSelect": return (Array.isArray(v) ? v : []).map((id) => field.options?.find((o) => o.id === id)?.label || "").filter(Boolean).join(", ");
    case "checklist": {
      const items = (Array.isArray(v) ? v : []) as ChecklistItem[];
      return items.length ? `${items.filter((i) => i.done).length}/${items.length}` : "";
    }
    case "createdTime": case "lastEditedTime": return formatTimestamp(v);
    default: return v == null ? "" : String(v);
  }
}

// Database → bloc table BlockNote (1re ligne = noms de champs).
function databaseToTable(db: Database): AnyBlock {
  const fields = db.fields;
  const header = { cells: fields.map((f) => [textRun(f.name, { bold: true })]) };
  const rows = db.rows.map((r) => ({ cells: fields.map((f) => [textRun(cellText(db, f.id, r.id))]) }));
  return { type: "table", content: { type: "tableContent", rows: [header, ...rows] } };
}

function parseGalleryUrls(raw: unknown): string[] {
  try { const a = JSON.parse(String(raw ?? "[]")); return Array.isArray(a) ? a.map(String) : []; } catch { return []; }
}

// Un bloc custom → son (ses) équivalent(s) standard(s). Les blocs standards passent tels quels
// (contenu inline traduit) ; enfants traités récursivement.
function mapBlock(b: NoteBlock, ctx: ExportContext): AnyBlock[] {
  const blk = b as AnyBlock;
  const props = (blk.props || {}) as AnyBlock;
  const children = Array.isArray(blk.children) ? prepareForExport(blk.children as NoteBlock[], ctx) : [];
  const inline = mapInline(blk.content, ctx);
  switch (blk.type) {
    case "equation": {
      const tex = String(props.tex || "").trim();
      return tex ? [{ type: "paragraph", content: [textRun(`$$${tex}$$`)], children }] : [];
    }
    case "callout": {
      const emoji = String(props.emoji || "");
      const content = [textRun(emoji ? `${emoji} ` : ""), ...(Array.isArray(inline) ? inline : [])];
      return [{ type: "quote", content, children }];
    }
    case "toggle":
      return [{ type: "bulletListItem", content: inline, children }];
    case "divider":
      return [{ type: "paragraph", content: [textRun("---")], children }];
    case "youtube": {
      const id = String(props.videoId || "");
      const url = id ? `https://youtu.be/${id}` : "";
      return url ? [{ type: "paragraph", content: [{ type: "link", href: url, content: [textRun(url)] }], children }] : [];
    }
    case "embed": case "bookmark": case "video": case "audio": case "file": {
      const url = String(props.url || "");
      const name = String(props.name || props.title || "") || url;
      return url ? [{ type: "paragraph", content: [{ type: "link", href: url, content: [textRun(name)] }], children }] : [];
    }
    case "gallery":
      return parseGalleryUrls(props.urls).map((url) => ({ type: "image", props: { url } }));
    case "subpage": {
      const title = ctx.pageTitle?.(String(props.pageId || "")) || i18n.t("notebook:tree.subpage");
      return [{ type: "paragraph", content: [textRun(`📄 ${title}`)], children }];
    }
    case "database": {
      const db = ctx.databases?.[String(props.dbId || "")];
      return db ? [databaseToTable(db)] : [];
    }
    default:
      return [{ ...blk, content: inline, children }];
  }
}

export function prepareForExport(blocks: NoteBlock[], ctx: ExportContext = {}): NoteBlock[] {
  const out: AnyBlock[] = [];
  for (const b of blocks || []) {
    if (!b || typeof b !== "object") continue;
    out.push(...mapBlock(b, ctx));
  }
  return out as NoteBlock[];
}

// ---- Conversions ----------------------------------------------------------------------------------
export async function blocksToMarkdown(blocks: NoteBlock[], ctx: ExportContext = {}): Promise<string> {
  return headless().blocksToMarkdownLossy(prepareForExport(blocks, ctx) as never);
}

export async function blocksToHtml(blocks: NoteBlock[], ctx: ExportContext = {}): Promise<string> {
  return headless().blocksToHTMLLossy(prepareForExport(blocks, ctx) as never);
}

// Export HTML AUTONOME : document complet stylé (sombre, typo de l'app) avec en-tête icône + titre —
// s'ouvre tel quel dans un navigateur, prêt à partager.
export async function blocksToStandaloneHtml(blocks: NoteBlock[], title: string, icon: string | null, ctx: ExportContext = {}, language = "fr"): Promise<string> {
  const body = await blocksToHtml(blocks, ctx);
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const iconHtml = icon && !icon.startsWith("lucide:") && !/^(https?:|blob:|data:)/.test(icon) ? `<span class="icon">${esc(icon)}</span> ` : "";
  return `<!doctype html>
<html lang="${esc(language)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0 auto; max-width: 760px; padding: 48px 24px 96px; background: #0a0b0e; color: #e3e4e8;
         font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  h1.doc-title { font-size: 2rem; margin: 0 0 1.5rem; }
  h1.doc-title .icon { margin-right: 8px; }
  a { color: #4f86f7; }
  blockquote { border-inline-start: 3px solid #4f86f7; margin-inline: 0; padding-inline-start: 14px; color: #888d99; }
  code { background: rgba(227, 228, 232, 0.1); border-radius: 4px; padding: 1px 5px; font-size: 0.88em; }
  pre code { display: block; padding: 12px; overflow-x: auto; }
  img { max-width: 100%; border-radius: 8px; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { border: 1px solid #262a34; padding: 6px 10px; text-align: left; }
  th { background: #1a1d25; }
  hr { border: none; border-top: 1px solid #262a34; }
</style>
</head>
<body>
<h1 class="doc-title">${iconHtml}${esc(title)}</h1>
${body}
</body>
</html>`;
}

export async function markdownToBlocks(md: string): Promise<NoteBlock[]> {
  return (await headless().tryParseMarkdownToBlocks(md)) as unknown as NoteBlock[];
}

// Nom de fichier sûr depuis un titre de page (caractères interdits Windows → _).
export function safeFileName(title: string): string {
  return (String(title || "").replace(/[\\/:*?"<>|]+/g, "_").trim() || i18n.t("notebook:panel.untitled")).slice(0, 80);
}

// Sélecteur de fichiers natif : résout [{name(sans ext), text}] — [] si annulé.
export function pickMarkdownFiles(): Promise<{ name: string; text: string }[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".md,.markdown,.txt";
    input.multiple = true;
    input.onchange = async () => {
      const out: { name: string; text: string }[] = [];
      for (const f of Array.from(input.files || [])) {
        out.push({ name: f.name.replace(/\.(md|markdown|txt)$/i, ""), text: await f.text() });
      }
      resolve(out);
    };
    input.oncancel = () => resolve([]);
    input.click();
  });
}

// Sélecteur du format commun .netsu. Les anciennes archives .nrnote restent acceptées.
export function pickNetsuFile(): Promise<ArrayBuffer | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".netsu,.nrnote";
    input.onchange = async () => {
      const f = input.files?.[0];
      resolve(f ? await f.arrayBuffer() : null);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}
