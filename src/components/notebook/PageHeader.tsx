// En-tête de page : image de couverture (optionnelle) + icône (emoji / lucide / image) +
// titre éditable. Écrit dans le store (nbSetPageMeta → autosave). L'icône se choisit via IconPicker
// (Emojis énormes + Icônes + Upload) ; la couverture = fichier image local.
import { useEffect, useRef, useState } from "react";
import { useApp } from "@/store";
import { nr } from "@/lib/bridge";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { ImagePlus, X } from "lucide-react";
import { IconPicker, renderPageIcon } from "./IconPicker";
import type { NotebookPage } from "./notebookShared";
import i18n from "@/i18n";

export function PageHeader({ page }: { page: NotebookPage }) {
  const setMeta = useApp((s) => s.nbSetPageMeta);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const iconWrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!emojiOpen) return;
    const onDown = (e: MouseEvent) => { if (iconWrap.current && !iconWrap.current.contains(e.target as Node)) setEmojiOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [emojiOpen]);

  const pickCover = async () => {
    const files = await nr.chooseImages();
    if (files && files[0]) setMeta({ cover: files[0] });
  };

  return (
    <div className="mb-2">
      {page.cover ? (
        <div className="group relative h-40 w-full overflow-hidden rounded-lg">
          <img src={nr.mediaUrl(page.cover)} alt="" className="h-full w-full object-cover" draggable={false} />
          <div className="absolute right-2 top-2 hidden gap-1 group-hover:flex">
            <button type="button" onClick={pickCover} className="nr-chip rounded px-2 py-1 text-xs text-white">{i18n.t("notebook:pageHeader.change")}</button>
             <button type="button" aria-label={i18n.t("common:action.delete")} onClick={() => setMeta({ cover: null })} className="nr-chip rounded p-1 text-white"><X className="h-3.5 w-3.5" /></button>
          </div>
        </div>
      ) : null}

      <div className={`flex items-end gap-3 px-1 ${page.cover ? "-mt-6" : "mt-2"}`}>
        <div ref={iconWrap} className="relative">
          <Tooltip>
            <TooltipTrigger render={
              <button type="button" onClick={() => setEmojiOpen((v) => !v)} className="flex h-14 w-14 items-center justify-center rounded-lg bg-card shadow-sm ring-1 ring-border">
                {renderPageIcon(page.icon, "h-8 w-8")}
              </button>
            } />
            <TooltipContent>{i18n.t("notebook:pageHeader.icon")}</TooltipContent>
          </Tooltip>
          {emojiOpen && (
            <div className="absolute left-0 top-full z-50 mt-1 rounded-xl border border-border bg-card p-2 shadow-2xl">
              <IconPicker
                current={page.icon}
                onPick={(v) => { setMeta({ icon: v }); setEmojiOpen(false); }}
                onRemove={() => { setMeta({ icon: null }); setEmojiOpen(false); }}
              />
            </div>
          )}
        </div>

        {!page.cover && (
          <button type="button" onClick={pickCover} className="mb-1 flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
            <ImagePlus className="h-3.5 w-3.5" /> {i18n.t("notebook:pageHeader.cover")}
          </button>
        )}
      </div>

      <input
        value={page.title}
        onChange={(e) => setMeta({ title: e.target.value })}
        placeholder={i18n.t("notebook:panel.untitled")}
        className="mt-3 w-full bg-transparent px-1 text-[2.1rem] leading-tight font-bold tracking-tight outline-none placeholder:text-muted-foreground/60"
      />
    </div>
  );
}
