// Carte d'aperçu de lien PARTAGÉE (signet + intégration de site non-iframable + survol de mention).
// Présentationnel : reçoit les métadonnées déjà résolues + une disposition. SOURCE UNIQUE du « beau
// look » de carte, pour un rendu cohérent partout.
import { Button } from "@/components/ui/button";
import { useEffect, useState, type ReactNode } from "react";
import { NetsuIcon } from "@/components/ui/netsu-icon";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { nr } from "@/lib/bridge";
import i18n from "@/i18n";

export interface CardMeta { url: string; title?: string; description?: string; image?: string; favicon?: string; siteName?: string; }

function hostOf(m: CardMeta): string {
  if (m.siteName) return m.siteName;
  try { return new URL(m.url).hostname; } catch { return m.url; }
}

function Actions({ url }: { url: string }) {
  return (
    <>
      <Tooltip>
        <TooltipTrigger render={<Button variant="ghost" type="button" onClick={(e) => { e.stopPropagation(); void navigator.clipboard?.writeText(url); }} className="h-auto gap-0 rounded-none px-0 py-0 text-[length:inherit] font-normal whitespace-normal hover:bg-transparent dark:hover:bg-transparent justify-start shrink select-auto active:not-aria-[haspopup]:translate-y-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><NetsuIcon name="copy" className="size-3.5" /></Button>} />
        <TooltipContent>{i18n.t("notebook:finalPass.copyLink")}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger render={<Button variant="ghost" type="button" onClick={(e) => { e.stopPropagation(); void nr.openExternal(url); }} className="h-auto gap-0 rounded-none px-0 py-0 text-[length:inherit] font-normal whitespace-normal hover:bg-transparent dark:hover:bg-transparent justify-start shrink select-auto active:not-aria-[haspopup]:translate-y-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><NetsuIcon name="open-external" className="size-3.5" /></Button>} />
        <TooltipContent>{i18n.t("notebook:blocksUi.open")}</TooltipContent>
      </Tooltip>
    </>
  );
}

function Favicon({ src }: { src?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return src && !failed
    ? <img src={src} alt="" onError={() => setFailed(true)} className="size-4 rounded-sm" draggable={false} referrerPolicy="no-referrer" />
    : <NetsuIcon name="link" className="size-4 text-muted-foreground" />;
}

export function PreviewImage({ src, className }: { src?: string; className: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (!src || failed) return null;
  return (
    <div className={className}>
      <img src={src} alt="" onError={() => setFailed(true)} className="h-full w-full object-cover" draggable={false} referrerPolicy="no-referrer" />
    </div>
  );
}

export function LinkPreviewCard({
  meta, layout = "vertical", menu,
}: { meta: CardMeta; layout?: "vertical" | "horizontal"; menu?: ReactNode }) {
  const host = hostOf(meta);
  const open = () => void nr.openExternal(meta.url);

  if (layout === "horizontal") {
    return (
      <div role="link" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } }} onClick={open} className="group relative my-1.5 flex h-24 cursor-pointer overflow-hidden rounded-xl border border-border bg-card/50 transition-colors hover:border-primary/40 hover:bg-muted/60">
        {menu}
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-1 px-4 py-3">
          <div className="line-clamp-1 text-sm font-semibold text-foreground">{meta.title || host}</div>
          {meta.description && <div className="line-clamp-2 text-xs leading-4 text-muted-foreground">{meta.description}</div>}
          <div className="mt-0.5 flex items-center gap-1.5 text-xs">
            <Favicon src={meta.favicon} />
            <span className="flex-1 truncate font-medium text-foreground/80">{host}</span>
            <Actions url={meta.url} />
          </div>
        </div>
        {meta.image && <PreviewImage src={meta.image} className="h-full w-36 shrink-0 border-l border-border" />}
      </div>
    );
  }

  return (
    <div role="link" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } }} onClick={open} className="group relative my-1.5 max-w-xl cursor-pointer overflow-hidden rounded-2xl border border-border bg-card/50 transition-colors hover:border-primary/40 hover:bg-muted/50">
      {menu}
      {meta.image && <PreviewImage src={meta.image} className="h-40 w-full overflow-hidden bg-muted" />}
      <div className="flex flex-col gap-1.5 p-4">
        <div className="line-clamp-1 text-base font-semibold text-foreground">{meta.title || host}</div>
        {meta.description && <div className="line-clamp-3 text-sm leading-5 text-muted-foreground">{meta.description}</div>}
        <div className="mt-1 flex items-center gap-2">
          <Favicon src={meta.favicon} />
          <span className="flex-1 truncate text-xs font-semibold text-foreground/80">{host}</span>
          <Actions url={meta.url} />
        </div>
      </div>
    </div>
  );
}
