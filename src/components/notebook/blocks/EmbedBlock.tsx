// Bloc custom « Intégration » (embed) — colle un lien Vimeo/Dailymotion/Twitch/Twitter/TikTok/… →
// iframe reconstruite par le moteur d'embeds partagé (embeds.ts). État vide = champ à coller.
import { useEffect, useRef, useState } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import { createReactBlockSpec } from "@blocknote/react";
import { Globe } from "lucide-react";
import i18n from "@/i18n";
import { nr } from "@/lib/bridge";
import { parseVideoEmbed, embedSrc, isImageUrl, isVideoUrl } from "@/components/reference/embeds";
import { BlockConvertMenu } from "./BlockConvertMenu";
import { EmptyLinkInput } from "./EmptyLinkInput";
import { LinkPreviewCard, type CardMeta } from "./LinkPreviewCard";
import { ResizableMediaFrame } from "./ResizableMediaFrame";
import { VideoPlayer } from "./VideoBlock";

// Site non-iframable (X-Frame-Options) → belle carte d'aperçu verticale (OpenGraph résolu côté core).
function SiteCard({ url, editor, block, width, initialMeta, onResize, onMeta }: { url: string; editor: BlockNoteEditor<any, any, any>; block: unknown; width?: number; initialMeta?: Partial<CardMeta>; onResize?: (width: number) => void; onMeta?: (meta: CardMeta) => void }) {
  const [meta, setMeta] = useState<CardMeta>({ url, ...initialMeta });
  const fetched = useRef(false);
  useEffect(() => {
    if (fetched.current || !nr.notebook) return;
    fetched.current = true;
    void nr.notebook.linkMeta(url).then((r) => { if (r.ok && r.meta) { setMeta(r.meta); onMeta?.(r.meta); } });
  }, [url, onMeta]);
  return (
    <ResizableMediaFrame width={width} onResize={(w) => onResize?.(w)} className="my-1">
      <LinkPreviewCard meta={meta} layout="vertical" menu={<BlockConvertMenu editor={editor} block={block} url={url} />} />
    </ResizableMediaFrame>
  );
}

export const embedSpec = createReactBlockSpec(
  {
    type: "embed",
    propSchema: { url: { default: "" }, width: { default: 0 }, height: { default: 0 }, trimStart: { default: 0 }, trimEnd: { default: 0 }, title: { default: "" }, description: { default: "" }, image: { default: "" }, favicon: { default: "" }, siteName: { default: "" } },
    content: "none",
  },
  {
    render: ({ block, editor }) => {
      const url = String(block.props.url || "");
      const width = Number(block.props.width) || 0;
      const height = Number(block.props.height) || 0;
      const trimStart = Number(block.props.trimStart) || 0;
      const trimEnd = Number(block.props.trimEnd) || 0;
      const resize = (w: number, h?: number) => editor.updateBlock(block, { type: "embed", props: { width: w, ...(h ? { height: h } : {}) } } as never);
      if (!url) {
        return (
          <EmptyLinkInput
            icon={<Globe className="h-4 w-4 text-primary" />}
            placeholder={i18n.t("notebook:blocks.embed.pastePlaceholder")}
            onSubmit={(v) => editor.updateBlock(block, { type: "embed", props: { url: v } })}
          />
        );
      }
      // Lien média DIRECT (image/vidéo) → on l'affiche tel quel (pas d'iframe).
      if (isImageUrl(url)) {
        return (
          <ResizableMediaFrame width={width} onResize={(w) => resize(w)} className="my-1 overflow-hidden rounded-lg border border-border">
            <BlockConvertMenu editor={editor} block={block} url={url} />
            <img src={url} alt="" className="block max-h-[520px] w-full object-contain" draggable={false} />
          </ResizableMediaFrame>
        );
      }
      if (isVideoUrl(url)) {
        return (
          <VideoPlayer
            url={url}
            width={width}
            trimStart={trimStart}
            trimEnd={trimEnd}
            onResize={(w) => resize(w)}
            onTrim={(trim) => editor.updateBlock(block, { type: "embed", props: trim } as never)}
          />
        );
      }
      // Provider CONNU (YouTube via bloc dédié, Vimeo, X, TikTok, Twitch…) → iframe. Un site web
      // quelconque bloque le framing (X-Frame-Options) → iframe blanc : on retombe sur une carte.
      const info = parseVideoEmbed(url, false);
      if (!info) {
        const initialMeta: Partial<CardMeta> = {
          title: String(block.props.title || ""), description: String(block.props.description || ""),
          image: String(block.props.image || ""), favicon: String(block.props.favicon || ""), siteName: String(block.props.siteName || ""),
        };
        return <SiteCard url={url} editor={editor} block={block} width={width} initialMeta={initialMeta} onResize={(w) => resize(w)} onMeta={(meta) => editor.updateBlock(block, { type: "embed", props: meta } as never)} />;
      }
      const initialWidth = width || info.size?.w || 0;
      const initialHeight = height || info.size?.h || 0;
      return (
        <ResizableMediaFrame width={initialWidth} height={initialHeight} ratio={info.size ? undefined : 16 / 9} onResize={(w, h) => resize(w, h)} className="my-1 overflow-hidden rounded-lg border border-border">
          <BlockConvertMenu editor={editor} block={block} url={url} />
          <iframe
            src={embedSrc(url)}
            title={i18n.t("notebook:blocks.embed.iframeTitle")}
            allow="autoplay; encrypted-media; picture-in-picture; clipboard-write"
            allowFullScreen
            className="h-full w-full border-0"
          />
        </ResizableMediaFrame>
      );
    },
  },
)();
