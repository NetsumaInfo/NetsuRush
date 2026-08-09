// Logique « Coller comme » / « Convertir en » d'un lien — SOURCE UNIQUE partagée par
// le menu de collage (PasteAsMenu) et le menu de conversion d'un bloc média (BlockConvertMenu).
// 4 formes : Mention (puce inline), URL (lien inline), Signet (carte), Intégration (iframe / YouTube).
import type { BlockNoteEditor } from "@blocknote/core";
import i18n from "@/i18n";
import { youtubeId } from "@/components/reference/embeds";
import { insertOrUpdate } from "./notebookSchema";

export type LinkAs = "mention" | "url" | "bookmark" | "embed";

// Métadonnées d'affichage des 4 options (l'icône est choisie par clé côté composant).
export const LINK_AS_OPTIONS: { key: LinkAs; label: string; desc: string }[] = [
  { key: "mention", get label() { return i18n.t("notebook:paste.mention.label"); }, get desc() { return i18n.t("notebook:paste.mention.desc"); } },
  { key: "url", get label() { return i18n.t("notebook:paste.url.label"); }, get desc() { return i18n.t("notebook:paste.url.desc"); } },
  { key: "bookmark", get label() { return i18n.t("notebook:paste.bookmark.label"); }, get desc() { return i18n.t("notebook:paste.bookmark.desc"); } },
  { key: "embed", get label() { return i18n.t("notebook:paste.embed.label"); }, get desc() { return i18n.t("notebook:paste.embed.desc"); } },
];

type Ed = BlockNoteEditor<any, any, any>;

// Colle un lien SOUS la forme choisie à la position du curseur.
export function applyPasteAs(editor: Ed, url: string, kind: LinkAs): void {
  const yt = youtubeId(url);
  switch (kind) {
    case "mention":
      editor.insertInlineContent([{ type: "linkMention", props: { url } } as never, " "]);
      break;
    case "url":
      editor.insertInlineContent([{ type: "link", href: url, content: url } as never, " "]);
      break;
    case "bookmark":
      insertOrUpdate(editor, { type: "bookmark", props: { url } });
      break;
    case "embed":
      insertOrUpdate(editor, yt ? { type: "youtube", props: { videoId: yt } } : { type: "embed", props: { url } });
      break;
  }
}

// Convertit un bloc média EXISTANT (youtube/embed/bookmark) vers une autre forme, en réutilisant son url.
export function convertBlockTo(editor: Ed, block: unknown, url: string, kind: LinkAs): void {
  const yt = youtubeId(url);
  const b = block as never;
  switch (kind) {
    case "bookmark":
      editor.updateBlock(b, { type: "bookmark", props: { url } });
      break;
    case "embed":
      editor.updateBlock(b, yt ? { type: "youtube", props: { videoId: yt } } : { type: "embed", props: { url } });
      break;
    case "url":
      editor.replaceBlocks([b], [{ type: "paragraph", content: [{ type: "link", href: url, content: url }] } as never]);
      break;
    case "mention":
      editor.replaceBlocks([b], [{ type: "paragraph", content: [{ type: "linkMention", props: { url } }] } as never]);
      break;
  }
}
