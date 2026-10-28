// En-tête de page : image de couverture (optionnelle) + icône (emoji / lucide / image) +
// titre éditable. Écrit dans le store (nbSetPageMeta → autosave). L'icône se choisit via IconPicker
// (Emojis énormes + Icônes + Upload) ; la couverture = fichier image local.
import { Button } from "@/components/ui/button";
import { useEffect, useRef, useState } from "react";
import { useApp } from "@/store";
import { nr } from "@/lib/bridge";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { NetsuIcon } from "@/components/ui/netsu-icon";
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
            <Button variant="ghost" type="button" onClick={pickCover} className="h-auto gap-0 rounded-none px-0 py-0 text-[length:inherit] font-normal whitespace-normal hover:bg-transparent dark:hover:bg-transparent nr-chip rounded px-2 py-1 text-xs text-white">{i18n.t("notebook:pageHeader.change")}</Button>
             <Button variant="ghost" type="button" aria-label={i18n.t("common:action.delete")} onClick={() => setMeta({ cover: null })} className="h-auto gap-0 rounded-none px-0 py-0 text-[length:inherit] font-normal whitespace-normal hover:bg-transparent dark:hover:bg-transparent nr-chip rounded p-1 text-white"><NetsuIcon name="close" className="size-3.5" /></Button>
          </div>
        </div>
      ) : null}

      <div className={`flex items-end gap-3 px-1 ${page.cover ? "-mt-6" : "mt-2"}`}>
        <div ref={iconWrap} className="relative">
          <Tooltip>
            <TooltipTrigger render={
              <Button variant="ghost" type="button" onClick={() => setEmojiOpen((v) => !v)} className="h-auto gap-0 rounded-none px-0 py-0 text-[length:inherit] font-normal whitespace-normal hover:bg-transparent dark:hover:bg-transparent flex size-14 items-center justify-center rounded-lg bg-card shadow-sm ring-1 ring-border">
                {renderPageIcon(page.icon, "size-8")}
              </Button>
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
          <Button variant="ghost" type="button" onClick={pickCover} className="h-auto gap-0 rounded-none px-0 py-0 text-[length:inherit] font-normal whitespace-normal hover:bg-transparent dark:hover:bg-transparent mb-1 flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
            <NetsuIcon name="image-add" className="size-3.5" /> {i18n.t("notebook:pageHeader.cover")}
          </Button>
        )}
      </div>

      <input autoComplete="off"
        value={page.title}
        onChange={(e) => setMeta({ title: e.target.value })}
        placeholder={i18n.t("notebook:panel.untitled")}
        className="mt-3 w-full bg-transparent px-1 text-[2.1rem] leading-tight font-bold tracking-tight outline-none placeholder:text-muted-foreground/60"
      />
    </div>
  );
}
