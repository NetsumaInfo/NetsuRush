// Bloc custom « Signet » (bookmark) — colle un lien de site web → carte titre/description/image/favicon
// (OpenGraph récupéré côté core). Le snapshot des métadonnées est persisté dans les props (pas de
// re-fetch au rechargement). État vide = champ à coller ; carte cliquable → ouvre le lien externe.
import { useEffect, useRef } from "react";
import { createReactBlockSpec } from "@blocknote/react";
import type { BlockNoteEditor } from "@blocknote/core";
import { Link2 } from "lucide-react";
import i18n from "@/i18n";
import { nr } from "@/lib/bridge";
import { BlockConvertMenu } from "./BlockConvertMenu";
import { EmptyLinkInput } from "./EmptyLinkInput";
import { LinkPreviewCard } from "./LinkPreviewCard";
import { ResizableMediaFrame } from "./ResizableMediaFrame";

interface BookmarkProps {
  url: string; title: string; description: string; image: string; favicon: string; siteName: string; width?: number;
}

function BookmarkCard({ props, onMeta, editor, block, onResize }: { props: BookmarkProps; onMeta: (m: Partial<BookmarkProps>) => void; editor: BlockNoteEditor<any, any, any>; block: unknown; onResize: (width: number) => void }) {
  const fetched = useRef(false);
  useEffect(() => {
    // Récupère l'OpenGraph une seule fois (titre encore vide = pas de snapshot) → fige dans les props.
    if (fetched.current || props.title || !nr.notebook) return;
    fetched.current = true;
    void nr.notebook.linkMeta(props.url).then((r) => {
      if (r.ok && r.meta) onMeta({ title: r.meta.title, description: r.meta.description, image: r.meta.image, favicon: r.meta.favicon, siteName: r.meta.siteName });
    });
  }, [props.url, props.title, onMeta]);

  return (
    <ResizableMediaFrame width={props.width} onResize={onResize} className="my-1">
      <LinkPreviewCard meta={props} layout="horizontal" menu={<BlockConvertMenu editor={editor} block={block} url={props.url} />} />
    </ResizableMediaFrame>
  );
}

export const bookmarkSpec = createReactBlockSpec(
  {
    type: "bookmark",
    propSchema: {
      url: { default: "" }, title: { default: "" }, description: { default: "" },
      image: { default: "" }, favicon: { default: "" }, siteName: { default: "" },
      width: { default: 0 },
    },
    content: "none",
  },
  {
    render: ({ block, editor }) => {
      const p = block.props as unknown as BookmarkProps;
      if (!p.url) {
        return (
          <EmptyLinkInput
            icon={<Link2 className="h-4 w-4 text-primary" />}
            placeholder={i18n.t("notebook:blocks.bookmark.pastePlaceholder")}
            onSubmit={(url) => editor.updateBlock(block, { type: "bookmark", props: { url } })}
          />
        );
      }
      return <BookmarkCard props={p} editor={editor} block={block} onMeta={(m) => editor.updateBlock(block, { type: "bookmark", props: m })} onResize={(width) => editor.updateBlock(block, { type: "bookmark", props: { width } } as never)} />;
    },
  },
)();
