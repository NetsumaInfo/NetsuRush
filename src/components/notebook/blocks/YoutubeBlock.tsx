// Bloc custom « YouTube » — colle un lien YouTube (watch/youtu.be/shorts) → iframe 16:9 embarquée.
// État vide (pas encore de videoId) = champ pour coller le lien. createReactBlockSpec
// renvoie un CRÉATEUR (v0.51) → invoqué pour obtenir le BlockSpec.
import { createReactBlockSpec } from "@blocknote/react";
import { Youtube } from "lucide-react";
import i18n from "@/i18n";
import { youtubeId } from "@/components/reference/embeds";
import { BlockConvertMenu } from "./BlockConvertMenu";
import { EmptyLinkInput } from "./EmptyLinkInput";
import { ResizableMediaFrame } from "./ResizableMediaFrame";

export const youtubeSpec = createReactBlockSpec(
  {
    type: "youtube",
    propSchema: { videoId: { default: "" }, width: { default: 0 }, height: { default: 0 } },
    content: "none",
  },
  {
    render: ({ block, editor }) => {
      const id = String(block.props.videoId || "");
      const width = Number(block.props.width) || 0;
      const height = Number(block.props.height) || 0;
      if (!id) {
        return (
          <EmptyLinkInput
            icon={<Youtube className="h-4 w-4 text-red-500" />}
            placeholder={i18n.t("notebook:blocks.youtube.pastePlaceholder")}
            onSubmit={(v) => { const y = youtubeId(v); if (y) editor.updateBlock(block, { type: "youtube", props: { videoId: y } }); }}
          />
        );
      }
      return (
        <ResizableMediaFrame
          width={width}
          height={height}
          ratio={16 / 9}
          onResize={(w, h) => editor.updateBlock(block, { type: "youtube", props: { width: w, height: h || Math.round(w / (16 / 9)) } } as never)}
          className="my-1 overflow-hidden rounded-lg border border-border"
        >
          <BlockConvertMenu editor={editor} block={block} url={`https://youtu.be/${id}`} />
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${id}`}
            title="YouTube"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            className="h-full w-full border-0"
          />
        </ResizableMediaFrame>
      );
    },
  },
)();
