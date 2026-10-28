// Schéma BlockNote du Carnet : blocs par défaut + blocs custom (callout, toggle, database) + inline
// custom (@mention de page). SOURCE UNIQUE du schéma, partagée par l'éditeur et le rendu lecture seule.
// Fournit aussi les entrées de menu slash custom et un helper insert-ou-remplace.
import { createElement } from "react";
import i18n from "@/i18n";
import { BlockNoteSchema, defaultBlockSpecs, defaultInlineContentSpecs, type BlockNoteEditor } from "@blocknote/core";
import type { DefaultReactSuggestionItem } from "@blocknote/react";
import { Youtube } from "lucide-react";
import { NetsuIcon } from "@/components/ui/netsu-icon";
import { calloutSpec } from "./blocks/CalloutBlock";
import { toggleSpec } from "./blocks/ToggleBlock";
import { databaseSpec } from "./blocks/DatabaseBlock";
import { subpageSpec } from "./blocks/SubpageRef";
import { pageMentionSpec } from "./blocks/PageMention";
import { linkMentionSpec } from "./blocks/LinkMention";
import { dateMentionSpec } from "./blocks/DateMention";
import { youtubeSpec } from "./blocks/YoutubeBlock";
import { embedSpec } from "./blocks/EmbedBlock";
import { bookmarkSpec } from "./blocks/BookmarkBlock";
import { gallerySpec } from "./blocks/GalleryBlock";
import { videoSpec } from "./blocks/VideoBlock";
import { fileSpec } from "./blocks/FileBlock";
import { audioSpec } from "./blocks/AudioBlock";
import { equationSpec } from "./blocks/EquationBlock";
import { dividerSpec } from "./blocks/DividerBlock";

export const notebookSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    video: videoSpec, // remplace le bloc vidéo par défaut (moche) par notre lecteur maison
    audio: audioSpec, // idem : lecteur audio harmonisé (forme d'onde) au lieu du natif <audio controls>
    file: fileSpec,   // idem : PDF/Word/Excel/ZIP… en carte de téléchargement + aperçu PDF
    callout: calloutSpec,
    toggle: toggleSpec,
    database: databaseSpec,
    subpage: subpageSpec,
    youtube: youtubeSpec,
    embed: embedSpec,
    bookmark: bookmarkSpec,
    gallery: gallerySpec,
    equation: equationSpec,
    divider: dividerSpec,
  },
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    pageMention: pageMentionSpec,
    linkMention: linkMentionSpec,
    dateMention: dateMentionSpec,
  },
});

// Insère un nouveau bloc, ou remplace le bloc courant s'il est un paragraphe vide.
export function insertOrUpdate(editor: BlockNoteEditor<any, any, any>, block: any) {
  const cur = editor.getTextCursorPosition().block;
  const content = cur.content as unknown[] | undefined;
  const empty = cur.type === "paragraph" && (!content || content.length === 0);
  if (empty) editor.updateBlock(cur, block);
  else editor.insertBlocks([block], cur, "after");
}

// Entrées de menu slash custom (fusionnées avec getDefaultReactSlashMenuItems côté éditeur).
// onInsertDatabase = fabrique une database vierge dans le store et renvoie son id (store-free ici).
// onCreateSubpage = crée une page ENFANT (sans naviguer) et renvoie son id → bloc sous-page.
export function noteSlashItems(
  editor: BlockNoteEditor<any, any, any>,
  onInsertDatabase: () => string,
  onCreateSubpage: () => Promise<string | null>,
): DefaultReactSuggestionItem[] {
  const tr = (key: string) => i18n.t(`notebook:slash.${key}`);
  const aliases = (key: string) => tr(`${key}.aliases`).split("|");
  return [
    {
      title: tr("subpage.title"), subtext: tr("subpage.desc"), aliases: aliases("subpage"), group: tr("groups.blocks"),
      icon: createElement(NetsuIcon, { name: "file-plus", className: "h-[18px] w-[18px]" }),
      onItemClick: () => {
        void onCreateSubpage().then((id) => {
          if (id) insertOrUpdate(editor, { type: "subpage", props: { pageId: id } });
        });
      },
    },
    {
      title: tr("callout.title"), subtext: tr("callout.desc"), aliases: aliases("callout"), group: tr("groups.blocks"),
      icon: createElement(NetsuIcon, { name: "callout", className: "size-[18px]" }),
      onItemClick: () => insertOrUpdate(editor, { type: "callout", props: { color: "blue", emoji: "💡" } }),
    },
    {
      title: tr("toggle.title"), subtext: tr("toggle.desc"), aliases: aliases("toggle"), group: tr("groups.blocks"),
      icon: createElement(NetsuIcon, { name: "toggle-block", className: "size-[18px]" }),
      onItemClick: () => insertOrUpdate(editor, { type: "toggle", props: { open: true } }),
    },
    {
      title: tr("database.title"), subtext: tr("database.desc"), aliases: aliases("database"), group: tr("groups.blocks"),
      icon: createElement(NetsuIcon, { name: "table", className: "size-[18px]" }),
      onItemClick: () => {
        const dbId = onInsertDatabase();
        insertOrUpdate(editor, { type: "database", props: { dbId } });
      },
    },
    {
      title: tr("equation.title"), subtext: tr("equation.desc"), aliases: aliases("equation"), group: tr("groups.blocks"),
      icon: createElement(NetsuIcon, { name: "equation", className: "size-[18px]" }),
      onItemClick: () => insertOrUpdate(editor, { type: "equation", props: { tex: "" } }),
    },
    {
      title: tr("divider.title"), subtext: tr("divider.desc"), aliases: aliases("divider"), group: tr("groups.blocks"),
      icon: createElement(NetsuIcon, { name: "divider", className: "size-[18px]" }),
      onItemClick: () => insertOrUpdate(editor, { type: "divider", props: { style: "line" } }),
    },
    {
      title: "YouTube", subtext: tr("youtube.desc"), aliases: aliases("youtube"), group: tr("groups.media"),
      icon: createElement(Youtube, { size: 18 }),
      onItemClick: () => insertOrUpdate(editor, { type: "youtube", props: { videoId: "" } }),
    },
    {
      title: tr("embed.title"), subtext: "Vimeo, X, TikTok, Twitch…", aliases: aliases("embed"), group: tr("groups.media"),
      icon: createElement(NetsuIcon, { name: "web", className: "size-[18px]" }),
      onItemClick: () => insertOrUpdate(editor, { type: "embed", props: { url: "" } }),
    },
    {
      title: tr("bookmark.title"), subtext: tr("bookmark.desc"), aliases: aliases("bookmark"), group: tr("groups.media"),
      icon: createElement(NetsuIcon, { name: "bookmark", className: "size-[18px]" }),
      onItemClick: () => insertOrUpdate(editor, { type: "bookmark", props: { url: "" } }),
    },
    {
      title: tr("video.title"), subtext: tr("video.desc"), aliases: aliases("video"), group: tr("groups.media"),
      icon: createElement(NetsuIcon, { name: "video", className: "size-[18px]" }),
      onItemClick: () => insertOrUpdate(editor, { type: "video", props: { url: "" } }),
    },
    {
      title: "Audio", subtext: tr("audio.desc"), aliases: aliases("audio"), group: tr("groups.media"),
      icon: createElement(NetsuIcon, { name: "music", className: "size-[18px]" }),
      onItemClick: () => insertOrUpdate(editor, { type: "audio", props: { url: "" } }),
    },
    {
      title: tr("file.title"), subtext: tr("file.desc"), aliases: aliases("file"), group: tr("groups.media"),
      icon: createElement(NetsuIcon, { name: "attach-file", className: "size-[18px]" }),
      onItemClick: () => insertOrUpdate(editor, { type: "file", props: { url: "" } }),
    },
    {
      title: tr("gallery.title"), subtext: tr("gallery.desc"), aliases: aliases("gallery"), group: tr("groups.media"),
      icon: createElement(NetsuIcon, { name: "gallery", className: "size-[18px]" }),
      onItemClick: () => insertOrUpdate(editor, { type: "gallery", props: { urls: "[]" } }),
    },
    {
      title: tr("date.title"), subtext: tr("date.desc"), aliases: aliases("date"), group: tr("groups.insert"),
      icon: createElement(NetsuIcon, { name: "calendar", className: "size-[18px]" }),
      onItemClick: () => editor.insertInlineContent([{ type: "dateMention", props: { date: todayIso() } }, " "] as never),
    },
  ];
}

// Date du jour au format ISO (YYYY-MM-DD) pour la puce @date par défaut.
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
