// Bloc « Fichier » custom — REMPLACE le bloc fichier par défaut de BlockNote. Tout fichier NON
// image/vidéo/audio (PDF, Word, Excel, ZIP, txt…) uploadé/glissé/collé atterrit ici. PDF → vrai aperçu
// PDF.js défilable ; texte/csv/json/code → aperçu texte défilable ; autre → carte de téléchargement.
import { createElement, useRef, useState, type DragEvent } from "react";
import i18n from "@/i18n";
import { createReactBlockSpec } from "@blocknote/react";
import { defaultProps, type BlockNoteEditor } from "@blocknote/core";
import { Paperclip, Download, ExternalLink, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { fileKind, kindMeta, extOf, type FileKind } from "./fileKinds";
import { PdfPreview, TextPreview } from "./DocPreview";

type Ed = BlockNoteEditor<any, any, any>;

// Types dont on sait faire un aperçu intégré (le reste = carte de téléchargement seule).
const TEXTUAL: FileKind[] = ["text", "code"];
function canPreview(kind: FileKind, ext: string): boolean {
  return kind === "pdf" || TEXTUAL.includes(kind) || ext === "csv" || ext === "json" || ext === "md" || ext === "txt";
}

function FileEmpty({ editor, block }: { editor: Ed; block: unknown }) {
  const input = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState("");
  const [over, setOver] = useState(false);
  const set = (u: string, name = "") => editor.updateBlock(block as never, { type: "file", props: { url: u, name } });
  const pick = async (file?: File) => {
    if (!file) return;
    const u = await editor.uploadFile?.(file);
    if (typeof u === "string") set(u, file.name);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault(); setOver(false);
    const f = Array.from(e.dataTransfer.files)[0];
    if (f) void pick(f);
  };
  return (
    <div
      contentEditable={false}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={`my-1.5 flex flex-col gap-2 rounded-xl border border-dashed px-4 py-5 transition-colors ${over ? "border-primary bg-primary/5" : "border-border bg-muted/30 hover:bg-muted/50"}`}
    >
      <div className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-background text-primary shadow-sm"><Paperclip className="h-4 w-4" /></span>
        <Button size="sm" onClick={() => input.current?.click()}>{i18n.t("notebook:blocksUi.chooseFile")}</Button>
        <span className="text-xs text-muted-foreground">{i18n.t("notebook:blocksUi.fileDrop")}</span>
        <input ref={input} type="file" hidden onChange={(e) => void pick(e.target.files?.[0] || undefined)} />
      </div>
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => { if (e.nativeEvent.isComposing) return; if (e.key === "Enter" && /^https?:\/\//i.test(url.trim())) { e.preventDefault(); set(url.trim()); } }}
        placeholder={i18n.t("notebook:blocksUi.fileUrl")}
        className="rounded border border-border bg-muted px-2 py-1 text-xs outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}

function FileCard({ url, name }: { url: string; name: string }) {
  const label = name || url.split(/[\\/]/).pop() || i18n.t("notebook:fileKind.other");
  const kind = fileKind(name || url);
  const meta = kindMeta(kind);
  const ext = extOf(name || url);
  const previewable = canPreview(kind, ext);
  const [preview, setPreview] = useState(previewable); // aperçu déplié par défaut si possible

  return (
    <div contentEditable={false} className="my-1.5 overflow-hidden rounded-xl border border-border bg-card/40">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white" style={{ background: meta.color }}>
          {createElement(meta.icon, { className: "h-4 w-4" })}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">{label}</div>
          <div className="text-xs text-muted-foreground">{meta.label}{ext ? ` · ${ext.toUpperCase()}` : ""}</div>
        </div>
        {previewable && (
          <button type="button" onClick={() => setPreview((v) => !v)} className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
            {preview ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />} {i18n.t("notebook:blocksUi.preview")}
          </button>
        )}
        <Tooltip>
          <TooltipTrigger render={<a href={url} target="_blank" rel="noreferrer" className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"><ExternalLink className="h-4 w-4" /></a>} />
          <TooltipContent>{i18n.t("notebook:blocksUi.open")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<a href={url} download={label} className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"><Download className="h-4 w-4" /></a>} />
          <TooltipContent>{i18n.t("notebook:blocksUi.download")}</TooltipContent>
        </Tooltip>
      </div>
      {preview && previewable && (kind === "pdf" ? <PdfPreview url={url} label={label} /> : <TextPreview url={url} />)}
    </div>
  );
}

export const fileSpec = createReactBlockSpec(
  {
    type: "file",
    propSchema: {
      backgroundColor: defaultProps.backgroundColor,
      name: { default: "" },
      url: { default: "" },
      caption: { default: "" },
    },
    content: "none",
  },
  {
    render: ({ block, editor }) => {
      const url = String(block.props.url || "");
      if (!url) return <FileEmpty editor={editor} block={block} />;
      return <FileCard url={url} name={String(block.props.name || "")} />;
    },
  },
)();
