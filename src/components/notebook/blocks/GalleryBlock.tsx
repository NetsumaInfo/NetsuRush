// Bloc custom « Galerie » (gallery) — plusieurs images : 3 affichages (bande / carrousel
// / grille), hauteur du carrousel réglable (S/M/L/XL), vignettes RÉORDONNABLES par glisser, légende par
// image (carrousel + lightbox), visionneuse plein écran pro (zoom, diaporama, vignettes). URLs et
// légendes persistées en JSON dans les props (`urls` / `captions`, tableaux alignés).
import { useRef, useState, type DragEvent } from "react";
import i18n from "@/i18n";
import { createReactBlockSpec } from "@blocknote/react";
import type { BlockNoteEditor } from "@blocknote/core";
import { Images, ChevronLeft, ChevronRight, Plus, Trash2, GalleryHorizontal, GalleryHorizontalEnd, LayoutGrid, Maximize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Lightbox } from "./Lightbox";

type Ed = BlockNoteEditor<any, any, any>;

export function parseUrls(raw: unknown): string[] {
  try { const a = JSON.parse(String(raw || "[]")); return Array.isArray(a) ? a.filter((x) => typeof x === "string") : []; } catch { return []; }
}
function parseCaptions(raw: unknown): string[] {
  try { const a = JSON.parse(String(raw || "[]")); return Array.isArray(a) ? a.map((x) => (typeof x === "string" ? x : "")) : []; } catch { return []; }
}

// Envoie des fichiers image via l'uploadFile de l'éditeur (écrit sur disque, renvoie une URL /media).
async function uploadImages(editor: Ed, files: File[]): Promise<string[]> {
  const imgs = files.filter((f) => f.type.startsWith("image/"));
  const out: string[] = [];
  for (const f of imgs) {
    try { const r = await editor.uploadFile?.(f); if (typeof r === "string") out.push(r); } catch { /* ignore un fichier */ }
  }
  return out;
}

function GalleryEmpty({ onAdd }: { onAdd: (urls: string[], files: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState("");
  const [over, setOver] = useState(false);
  const onDrop = (e: DragEvent) => {
    e.preventDefault(); setOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length) onAdd([], files);
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
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-background text-primary shadow-sm"><Images className="h-4 w-4" /></span>
        <Button size="sm" onClick={() => input.current?.click()}>{i18n.t("notebook:gallery.chooseImages")}</Button>
        <span className="text-xs text-muted-foreground">{i18n.t("notebook:gallery.dropFiles")}</span>
        <input ref={input} type="file" accept="image/*" multiple hidden onChange={(e) => { const f = Array.from(e.target.files || []); if (f.length) onAdd([], f); }} />
      </div>
      <div className="flex items-center gap-2">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.nativeEvent.isComposing) return; if (e.key === "Enter" && /^https?:\/\//i.test(url.trim())) { e.preventDefault(); onAdd([url.trim()], []); setUrl(""); } }}
          placeholder={i18n.t("notebook:gallery.imageUrl")}
          className="min-w-0 flex-1 rounded border border-border bg-muted px-2 py-1 text-xs outline-none placeholder:text-muted-foreground"
        />
      </div>
    </div>
  );
}

type Layout = "row" | "carousel" | "grid";

// Hauteurs du carrousel (préréglages cyclés par les boutons S/M/L/XL).
const HEIGHTS = [320, 440, 560, 700] as const;
const HEIGHT_LABELS = ["S", "M", "L", "XL"];

function Gallery({ editor, block, urls, captions, layout, height }: {
  editor: Ed; block: unknown; urls: string[]; captions: string[]; layout: Layout; height: number;
}) {
  const [idx, setIdx] = useState(0);
  const [over, setOver] = useState(false);
  const [lb, setLb] = useState<number | null>(null);      // index ouvert en plein écran (null = fermé)
  const dragFrom = useRef<number | null>(null);            // index de la vignette en cours de glisser
  const input = useRef<HTMLInputElement>(null);
  const b = block as never;
  const i = Math.min(idx, urls.length - 1);

  // Commit urls + captions ALIGNÉES (retrait/réordonnancement déplacent la légende avec l'image).
  const commit = (nextUrls: string[], nextCaptions: string[], at = i) => {
    editor.updateBlock(b, { type: "gallery", props: { urls: JSON.stringify(nextUrls), captions: JSON.stringify(nextCaptions) } });
    setIdx(Math.max(0, Math.min(at, nextUrls.length - 1)));
  };
  const setLayout = (l: Layout) => editor.updateBlock(b, { type: "gallery", props: { layout: l } });
  const setHeight = (h: number) => editor.updateBlock(b, { type: "gallery", props: { height: h } });
  const addFiles = async (files: File[]) => {
    const up = await uploadImages(editor, files);
    if (up.length) commit([...urls, ...up], [...captions, ...up.map(() => "")], urls.length);
  };
  const removeAt = (k: number) => {
    const nextU = urls.filter((_, x) => x !== k);
    const nextC = captions.filter((_, x) => x !== k);
    if (nextU.length) commit(nextU, nextC, Math.min(i, nextU.length - 1));
    else editor.removeBlocks([b]);
  };
  const setCaption = (k: number, text: string) => {
    const nextC = [...captions];
    while (nextC.length < urls.length) nextC.push("");
    nextC[k] = text;
    editor.updateBlock(b, { type: "gallery", props: { captions: JSON.stringify(nextC) } });
  };
  const moveImage = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0) return;
    const u = [...urls]; const c = [...captions];
    while (c.length < u.length) c.push("");
    const [mu] = u.splice(from, 1); u.splice(to, 0, mu);
    const [mc] = c.splice(from, 1); c.splice(to, 0, mc);
    commit(u, c, to);
  };

  // Poignées de glisser natives (réordonner les vignettes) — pas de lib, payload = index source.
  const dragProps = (k: number) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => { dragFrom.current = k; e.dataTransfer.effectAllowed = "move"; e.stopPropagation(); },
    onDragOver: (e: DragEvent) => { e.preventDefault(); e.stopPropagation(); },
    onDrop: (e: DragEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (dragFrom.current != null) moveImage(dragFrom.current, k);
      dragFrom.current = null;
    },
  });

  const heightIdx = Math.max(0, HEIGHTS.findIndex((h) => h >= height));

  return (
    <div
      contentEditable={false}
      onDragOver={(e) => { if (dragFrom.current == null) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { if (dragFrom.current == null) { e.preventDefault(); setOver(false); void addFiles(Array.from(e.dataTransfer.files)); } }}
      className={`group my-1.5 flex flex-col gap-2 rounded-xl border p-2 ${over ? "border-primary bg-primary/5" : "border-border bg-card/40"}`}
    >
      {/* Barre : bascule d'affichage + hauteur (carrousel) + ajout */}
      <div className="flex items-center gap-1">
        <div className="flex items-center gap-0.5 rounded-md bg-muted/60 p-0.5">
          <Tooltip>
            <TooltipTrigger render={<button type="button" onClick={() => setLayout("row")} className={`rounded p-1 ${layout === "row" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}><GalleryHorizontalEnd className="h-3.5 w-3.5" /></button>} />
            <TooltipContent>{i18n.t("notebook:gallery.row")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={<button type="button" onClick={() => setLayout("carousel")} className={`rounded p-1 ${layout === "carousel" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}><GalleryHorizontal className="h-3.5 w-3.5" /></button>} />
            <TooltipContent>{i18n.t("notebook:gallery.carousel")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={<button type="button" onClick={() => setLayout("grid")} className={`rounded p-1 ${layout === "grid" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}><LayoutGrid className="h-3.5 w-3.5" /></button>} />
            <TooltipContent>{i18n.t("notebook:gallery.grid")}</TooltipContent>
          </Tooltip>
        </div>
        {layout === "carousel" && (
          <div className="flex items-center gap-0.5 rounded-md bg-muted/60 p-0.5">
            {HEIGHTS.map((h, k) => (
              <Tooltip key={h}>
                <TooltipTrigger render={<button type="button" onClick={() => setHeight(h)} className={`rounded px-1.5 py-0.5 text-[11px] ${k === heightIdx ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}>{HEIGHT_LABELS[k]}</button>} />
                <TooltipContent>{i18n.t("notebook:gallery.height", { size: HEIGHT_LABELS[k] })}</TooltipContent>
              </Tooltip>
            ))}
          </div>
        )}
        <span className="text-xs text-muted-foreground">{i18n.t("notebook:gallery.imageCount", { count: urls.length })}</span>
        <button type="button" onClick={() => input.current?.click()} className="ml-auto flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"><Plus className="h-3.5 w-3.5" /> {i18n.t("notebook:gallery.add")}</button>
      </div>

      {layout === "row" ? (
        // Bande : toutes les images sur une SEULE ligne, défilement horizontal. Glisser = réordonner.
        <div className="nb-gallery-row flex items-stretch gap-2 overflow-x-auto pb-1">
          {urls.map((u, k) => (
            <div key={u + k} {...dragProps(k)} className="group/img relative h-48 shrink-0 overflow-hidden rounded-lg bg-muted/40">
              <img src={u} alt={i18n.t("notebook:gallery.openImage")} role="button" tabIndex={0} aria-label={i18n.t("notebook:gallery.openImage")} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setLb(k); } }} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); setLb(k); }} className="h-full w-auto cursor-zoom-in object-cover" draggable={false} />
              <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all group-hover/img:bg-black/25 group-hover/img:opacity-100"><Maximize2 className="h-5 w-5 text-white drop-shadow" /></span>
              <Tooltip>
                 <TooltipTrigger render={<button type="button" aria-label="Remove image" onClick={() => removeAt(k)} className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-md bg-background/80 text-muted-foreground opacity-0 shadow backdrop-blur transition-opacity hover:text-destructive group-hover/img:opacity-100"><Trash2 className="h-3.5 w-3.5" /></button>} />
                <TooltipContent>{i18n.t("notebook:gallery.remove")}</TooltipContent>
              </Tooltip>
            </div>
          ))}
           <button type="button" aria-label="Add image" onClick={() => input.current?.click()} className="flex h-48 w-32 shrink-0 items-center justify-center rounded-lg border-2 border-dashed border-border text-muted-foreground hover:border-primary hover:text-primary"><Plus className="h-6 w-6" /></button>
        </div>
      ) : layout === "grid" ? (
        // Grille : plusieurs par ligne. Glisser = réordonner.
        <div className="grid grid-cols-3 gap-2">
          {urls.map((u, k) => (
            <div key={u + k} {...dragProps(k)} className="group/img relative aspect-square overflow-hidden rounded-lg bg-muted/40">
              <img src={u} alt={i18n.t("notebook:gallery.openImage")} role="button" tabIndex={0} aria-label={i18n.t("notebook:gallery.openImage")} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setLb(k); } }} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); setLb(k); }} className="h-full w-full cursor-zoom-in object-cover" draggable={false} />
              <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all group-hover/img:bg-black/25 group-hover/img:opacity-100"><Maximize2 className="h-5 w-5 text-white drop-shadow" /></span>
              <Tooltip>
                 <TooltipTrigger render={<button type="button" aria-label="Remove image" onClick={() => removeAt(k)} className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-md bg-background/80 text-muted-foreground opacity-0 shadow backdrop-blur transition-opacity hover:text-destructive group-hover/img:opacity-100"><Trash2 className="h-3.5 w-3.5" /></button>} />
                <TooltipContent>{i18n.t("notebook:gallery.remove")}</TooltipContent>
              </Tooltip>
            </div>
          ))}
           <button type="button" aria-label="Add image" onClick={() => input.current?.click()} className="flex aspect-square items-center justify-center rounded-lg border-2 border-dashed border-border text-muted-foreground hover:border-primary hover:text-primary"><Plus className="h-6 w-6" /></button>
        </div>
      ) : (
        <>
          {/* Carrousel immersif : image courante pleine largeur, hauteur réglable, légende éditable */}
          <div className="relative flex items-center justify-center overflow-hidden rounded-xl bg-muted/40" style={{ height }}>
            <img src={urls[i]} alt={i18n.t("notebook:gallery.openImage")} role="button" tabIndex={0} aria-label={i18n.t("notebook:gallery.openImage")} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setLb(i); } }} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); setLb(i); }} className="max-h-full max-w-full cursor-zoom-in object-contain" draggable={false} />
            {urls.length > 1 && (
              <>
                 <button type="button" aria-label="Previous image" onClick={() => setIdx((i - 1 + urls.length) % urls.length)} className="absolute left-2 flex h-8 w-8 items-center justify-center rounded-full bg-background/80 text-foreground shadow backdrop-blur hover:bg-background"><ChevronLeft className="h-4 w-4" /></button>
                 <button type="button" aria-label="Next image" onClick={() => setIdx((i + 1) % urls.length)} className="absolute right-2 flex h-8 w-8 items-center justify-center rounded-full bg-background/80 text-foreground shadow backdrop-blur hover:bg-background"><ChevronRight className="h-4 w-4" /></button>
                <span className="absolute bottom-2 rounded-full bg-background/80 px-2 py-0.5 text-xs text-foreground shadow backdrop-blur">{i + 1} / {urls.length}</span>
              </>
            )}
            <Tooltip>
              <TooltipTrigger render={<button type="button" aria-label="Remove image" onClick={() => removeAt(i)} className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-md bg-background/80 text-muted-foreground opacity-0 shadow backdrop-blur transition-opacity hover:text-destructive group-hover:opacity-100"><Trash2 className="h-3.5 w-3.5" /></button>} />
              <TooltipContent>{i18n.t("notebook:gallery.removeImage")}</TooltipContent>
            </Tooltip>
          </div>
          {/* Légende de l'image courante (persistée, affichée aussi en plein écran) */}
          <input
            value={captions[i] ?? ""}
            onChange={(e) => setCaption(i, e.target.value)}
            placeholder={i18n.t("notebook:gallery.caption")}
            className="w-full bg-transparent px-1 text-center text-xs text-muted-foreground outline-none placeholder:text-muted-foreground/60"
          />
          {/* Bande de vignettes : clic = afficher, glisser = réordonner */}
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
            {urls.map((u, k) => (
              <button
                key={u + k}
                type="button"
                onClick={() => setIdx(k)}
                {...dragProps(k)}
                className={`h-14 w-16 shrink-0 overflow-hidden rounded-lg transition-all ${k === i ? "ring-2 ring-primary ring-offset-2 ring-offset-card" : "opacity-70 hover:opacity-100"}`}
              >
                <img src={u} alt="" className="h-full w-full object-cover" draggable={false} />
              </button>
            ))}
          </div>
        </>
      )}
      <input ref={input} type="file" accept="image/*" multiple hidden onChange={(e) => { const f = Array.from(e.target.files || []); if (f.length) void addFiles(f); }} />
      {lb !== null && <Lightbox urls={urls} captions={captions} index={Math.min(lb, urls.length - 1)} onClose={() => setLb(null)} onIndex={setLb} />}
    </div>
  );
}

export const gallerySpec = createReactBlockSpec(
  {
    type: "gallery",
    propSchema: {
      urls: { default: "[]" },
      captions: { default: "[]" },
      layout: { default: "row", values: ["row", "carousel", "grid"] },
      height: { default: 440 },
    },
    content: "none",
  },
  {
    render: ({ block, editor }) => {
      const urls = parseUrls(block.props.urls);
      const captions = parseCaptions(block.props.captions);
      const add = async (urlList: string[], files: File[]) => {
        const up = await uploadImages(editor, files);
        const next = [...urls, ...urlList, ...up];
        if (next.length) editor.updateBlock(block, { type: "gallery", props: { urls: JSON.stringify(next) } });
      };
      if (urls.length === 0) return <GalleryEmpty onAdd={add} />;
      const raw = String(block.props.layout);
      const layout: Layout = raw === "grid" ? "grid" : raw === "carousel" ? "carousel" : "row";
      const height = Number(block.props.height) || 440;
      return <Gallery editor={editor} block={block} urls={urls} captions={captions} layout={layout} height={height} />;
    },
  },
)();
