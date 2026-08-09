// Inline « mention de lien » (linkMention) — puce compacte favicon + titre au fil du texte, avec
// CARTE D'APERÇU au survol (image/titre/description/hôte + actions).
// Les métadonnées (OpenGraph, récupérées côté core) sont figées dans les props via updateInlineContent
// → pas de re-fetch au rechargement. Clic sur la puce = ouvre le lien externe.
import { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { createReactInlineContentSpec } from "@blocknote/react";
import { Link2, ExternalLink, Copy, Repeat, AtSign, Bookmark, Globe } from "lucide-react";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuGroup } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { nr } from "@/lib/bridge";
import i18n from "@/i18n";
import { useViewportAnchor } from "@/lib/useViewportAnchor";
import { PreviewImage } from "./LinkPreviewCard";
import { LINK_AS_OPTIONS, type LinkAs } from "../notebookPaste";

interface Meta { url: string; title: string; description: string; image: string; favicon: string; siteName: string; }

function hostOf(url: string, fallback: string) {
  if (fallback) return fallback;
  try { return new URL(url).hostname; } catch { return url; }
}

const CONVERT_ICONS: Record<LinkAs, typeof AtSign> = { mention: AtSign, url: Link2, bookmark: Bookmark, embed: Globe };
const INLINE_CONVERT_OPTIONS = LINK_AS_OPTIONS.filter((option) => option.key === "mention" || option.key === "url");

function InlineConvertMenu({ onConvert }: { onConvert: (kind: LinkAs) => void }) {
  return (
    <div contentEditable={false} onClick={(e) => e.stopPropagation()} className="absolute right-1.5 top-1.5 z-10 opacity-0 transition-opacity group-hover/mention-card:opacity-100">
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                render={<button type="button" className="rounded bg-background/80 p-1 text-muted-foreground shadow-sm backdrop-blur hover:text-foreground"><Repeat className="h-3.5 w-3.5" /></button>}
              />
            }
          />
          <TooltipContent>{i18n.t("notebook:finalPass.convertOptions")}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end">
          <DropdownMenuGroup>
            <DropdownMenuLabel>{i18n.t("notebook:finalPass.convertTo")}</DropdownMenuLabel>
            {INLINE_CONVERT_OPTIONS.map((o) => {
              const Icon = CONVERT_ICONS[o.key];
              return <DropdownMenuItem key={o.key} onClick={() => onConvert(o.key)}><Icon className="mr-2 h-3.5 w-3.5" /> {o.label}</DropdownMenuItem>;
            })}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function HoverCard({ meta, anchor, onEnter, onLeave, onConvert }: { meta: Meta; anchor: HTMLElement; onEnter: () => void; onLeave: () => void; onConvert: (kind: LinkAs) => void }) {
  const W = 288;
  const getRect = useCallback(() => anchor.getBoundingClientRect(), [anchor]);
  const position = useViewportAnchor(true, getRect, { width: W, height: meta.image ? 270 : 150 });
  const host = hostOf(meta.url, meta.siteName);
  return createPortal(
    <div
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      className="group/mention-card fixed z-50 overflow-y-auto rounded-xl border border-border bg-popover shadow-lg"
      style={{ width: W, left: position.left, top: position.top, maxHeight: position.maxHeight }}
    >
      <InlineConvertMenu onConvert={onConvert} />
      {meta.image && <PreviewImage src={meta.image} className="h-28 w-full overflow-hidden bg-muted" />}
      <div className="flex flex-col gap-1 p-3">
        <div className="line-clamp-1 text-sm font-semibold text-foreground">{meta.title || host}</div>
        {meta.description && <div className="line-clamp-3 text-xs leading-4 text-muted-foreground">{meta.description}</div>}
        <div className="mt-1 flex items-center gap-1.5">
          {meta.favicon ? <img src={meta.favicon} alt="" className="h-4 w-4 rounded-sm" draggable={false} /> : <Link2 className="h-4 w-4 text-muted-foreground" />}
          <span className="flex-1 truncate text-xs font-semibold text-foreground">{host}</span>
          <Tooltip>
            <TooltipTrigger render={<button type="button" onClick={() => void navigator.clipboard?.writeText(meta.url)} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><Copy className="h-3.5 w-3.5" /></button>} />
            <TooltipContent>{i18n.t("notebook:finalPass.copyLink")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={<button type="button" onClick={() => void nr.openExternal(meta.url)} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><ExternalLink className="h-3.5 w-3.5" /></button>} />
            <TooltipContent>{i18n.t("notebook:blocksUi.open")}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function LinkMentionView({ meta, persist, convert }: { meta: Meta; persist: (m: Meta) => void; convert: (kind: LinkAs, meta: Meta) => void }) {
  const [m, setM] = useState(meta);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const chip = useRef<HTMLSpanElement>(null);
  const overChip = useRef(false);
  const overCard = useRef(false);
  const fetched = useRef(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (fetched.current || m.title || !m.url || !nr.notebook) return;
    fetched.current = true;
    void nr.notebook.linkMeta(m.url).then((r) => {
      if (r.ok && r.meta) { const full = { ...m, ...r.meta } as Meta; setM(full); persist(full); }
    });
  }, [m, persist]);

  const scheduleClose = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { if (!overChip.current && !overCard.current) setAnchor(null); }, 220);
  }, []);
  const open = useCallback(() => { overChip.current = true; setAnchor(chip.current); }, []);

  const host = hostOf(m.url, m.siteName);
  return (
    <>
      <Tooltip>
        <TooltipTrigger render={
          <span
            ref={chip}
            className="nb-link-mention"
            contentEditable={false}
            onClick={() => { if (m.url) void nr.openExternal(m.url); }}
            role="link"
            tabIndex={0}
            onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && m.url) { e.preventDefault(); void nr.openExternal(m.url); } }}
            onMouseEnter={open}
            onMouseLeave={() => { overChip.current = false; scheduleClose(); }}
          >
            {m.favicon ? <img src={m.favicon} alt="" className="nb-link-mention-ico" draggable={false} /> : <Link2 className="nb-link-mention-ico" />}
            {m.siteName && m.siteName !== (m.title || host) && <span className="nb-link-mention-site">{m.siteName}</span>}
            <span className="truncate">{m.title || host}</span>
          </span>
        } />
        <TooltipContent>{m.url}</TooltipContent>
      </Tooltip>
      {anchor && <HoverCard meta={m} anchor={anchor} onEnter={() => { overCard.current = true; }} onLeave={() => { overCard.current = false; scheduleClose(); }} onConvert={(kind) => convert(kind, m)} />}
    </>
  );
}

export const linkMentionSpec = createReactInlineContentSpec(
  {
    type: "linkMention",
    propSchema: {
      url: { default: "" }, title: { default: "" }, description: { default: "" },
      image: { default: "" }, favicon: { default: "" }, siteName: { default: "" },
    },
    content: "none",
  },
  {
    render: ({ inlineContent, updateInlineContent }) => {
      const p = inlineContent.props as unknown as Meta;
      return (
        <LinkMentionView
          meta={p}
          persist={(full) => updateInlineContent({ type: "linkMention", props: { ...full } } as never)}
          convert={(kind, meta) => {
            if (kind === "mention") updateInlineContent({ type: "linkMention", props: { ...meta } } as never);
            else if (kind === "url") updateInlineContent({ type: "link", href: meta.url, content: meta.url } as never);
          }}
        />
      );
    },
  },
);
