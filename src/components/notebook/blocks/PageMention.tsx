// Inline custom « @mention de page » — lien cliquable vers une autre page du carnet, avec ANCRE de
// bloc optionnelle (props.blockId) : le clic ouvre la page cible ET scrolle/surligne ce bloc (lien
// « Copier le lien du bloc »). DEUX affichages (props.display, clic droit pour
// basculer) : « chip » = pastille compacte avec aperçu au survol ; « card » = carte résumé (icône +
// titre + extrait du bloc/de la page cible). Persisté avec props.pageId (+ label figé au moment du
// lien) → l'index de rétroliens (core) scanne ce type. content:"none" (pas de texte éditable).
import { useEffect, useRef, useState } from "react";
import { createReactInlineContentSpec, useBlockNoteEditor } from "@blocknote/react";
import { CornerDownRight, ExternalLink, Link2, RefreshCw, CreditCard, Tag } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { useApp } from "@/store";
import { nr } from "@/lib/bridge";
import { NBPAGE_LINK_PREFIX, type NoteBlock } from "../notebookShared";
import { renderPageIcon } from "../IconPicker";
import i18n from "@/i18n";

// ---- Aperçu de la cible (extrait) ---------------------------------------------------------------
// Charge la page cible via le core et extrait un court résumé : le TEXTE DU BLOC ancré (blockId) si
// le lien pointe un bloc précis, sinon les premières lignes de texte de la page. Cache court (30 s)
// pour ne pas re-fetch à chaque survol.
type Excerpt = { text: string; found: boolean };
const excerptCache = new Map<string, { at: number; p: Promise<Excerpt> }>();

function inlineText(b: NoteBlock): string {
  const content = (b as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  let s = "";
  for (const c of content) {
    if (!c || typeof c !== "object") continue;
    const cc = c as { text?: unknown; props?: { label?: unknown } };
    if (typeof cc.text === "string") s += cc.text;
    else if (typeof cc.props?.label === "string") s += cc.props.label;
  }
  return s;
}

// Libellé de repli pour les blocs sans texte inline (équation, média…).
const typeLabel = (type: string) => i18n.t(`notebook:mention.type.${type}`, { defaultValue: i18n.t("notebook:mention.block") });

function loadExcerpt(pageId: string, blockId: string): Promise<Excerpt> {
  const key = `${pageId}#${blockId}`;
  const hit = excerptCache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.p;
  const p: Promise<Excerpt> = (async () => {
    const r = await nr.notebook?.loadPage(pageId).catch(() => null);
    const blocks = (r && "page" in (r as object) ? (r as { page?: { blocks?: NoteBlock[] } }).page?.blocks : undefined) || [];
    if (blockId) {
      let found: NoteBlock | null = null;
      const walk = (bs: NoteBlock[]) => {
        for (const b of bs) {
          if (found) return;
          if ((b as { id?: string }).id === blockId) { found = b; return; }
          const kids = (b as { children?: NoteBlock[] }).children;
          if (Array.isArray(kids)) walk(kids);
        }
      };
      walk(blocks);
      if (!found) return { text: "", found: false };
      const t = inlineText(found).trim();
      const type = String((found as { type?: string }).type || "");
      return { text: t || typeLabel(type), found: true };
    }
    // Pas d'ancre : premières lignes de texte de la page.
    let out = "";
    const walk = (bs: NoteBlock[]) => {
      for (const b of bs) {
        if (out.length > 180) return;
        const t = inlineText(b).trim();
        if (t) out += (out ? " · " : "") + t;
        const kids = (b as { children?: NoteBlock[] }).children;
        if (Array.isArray(kids)) walk(kids);
      }
    };
    walk(blocks);
    return { text: out, found: true };
  })();
  excerptCache.set(key, { at: Date.now(), p });
  return p;
}

// Petit hook : extrait chargé au montage (carte) ou à l'ouverture (tooltip de la pastille).
function useExcerpt(pageId: string, blockId: string): Excerpt | null {
  const [ex, setEx] = useState<Excerpt | null>(null);
  useEffect(() => {
    let alive = true;
    void loadExcerpt(pageId, blockId).then((e) => { if (alive) setEx(e); });
    return () => { alive = false; };
  }, [pageId, blockId]);
  return ex;
}

// ---- Mutation des props de l'inline (affichage / libellé) ---------------------------------------
// Un inline content n'a pas d'API updateBlock : on retrouve le nœud ProseMirror depuis l'élément DOM
// (posAtDOM) et on réécrit ses attrs via une transaction — précis même avec des mentions identiques.
function setMentionAttrs(editor: { prosemirrorView?: import("prosemirror-view").EditorView }, el: HTMLElement | null, patch: Record<string, string>) {
  const view = editor.prosemirrorView;
  if (!view || !el) return;
  let pos = -1;
  try { pos = view.posAtDOM(el, 0); } catch { return; }
  const doc = view.state.doc;
  let node = doc.nodeAt(pos);
  if (!node || node.type.name !== "pageMention") { pos -= 1; node = pos >= 0 ? doc.nodeAt(pos) : null; }
  if (!node || node.type.name !== "pageMention") return;
  view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...patch }));
}

// ---- Vues ----------------------------------------------------------------------------------------
function MentionView({ pageId, blockId, label, display }: { pageId: string; blockId: string; label: string; display: string }) {
  const openPage = useApp((s) => s.nbOpenPage);
  const pages = useApp((s) => s.nbPages);
  const editor = useBlockNoteEditor();
  const root = useRef<HTMLSpanElement>(null);
  const target = pages.find((p) => p.id === pageId);
  const gone = !target; // page supprimée / dans la corbeille → grisé
  const title = target?.title || label || "page";
  const open = () => { if (pageId && !gone) void openPage(pageId, { blockId: blockId || undefined }); };

  const body = display === "card"
    ? <CardView pageId={pageId} blockId={blockId} title={title} icon={target?.icon ?? null} gone={gone} onOpen={open} rootRef={root} />
    : <ChipView pageId={pageId} blockId={blockId} title={title} icon={target?.icon ?? null} gone={gone} onOpen={open} rootRef={root} />;

  return (
    <ContextMenu>
      <ContextMenuTrigger render={<span contentEditable={false} />}>{body}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem disabled={gone} onClick={open}>
          <ExternalLink /> {blockId ? i18n.t("notebook:mention.openBlock") : i18n.t("notebook:blocksUi.open")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={display !== "card"} onClick={() => setMentionAttrs(editor, root.current, { display: "chip" })}>
          <Tag /> {i18n.t("notebook:mention.showChip")}
        </ContextMenuItem>
        <ContextMenuItem disabled={display === "card"} onClick={() => setMentionAttrs(editor, root.current, { display: "card" })}>
          <CreditCard /> {i18n.t("notebook:mention.showCard")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={gone} onClick={() => setMentionAttrs(editor, root.current, { label: title })}>
          <RefreshCw /> {i18n.t("notebook:mention.refreshLabel")}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => void navigator.clipboard.writeText(`${NBPAGE_LINK_PREFIX}${pageId}${blockId ? `#${blockId}` : ""}`)}>
          <Link2 /> {i18n.t("notebook:finalPass.copyLink")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// Pastille compacte : @titre + aperçu (titre + extrait de la cible) au survol.
function ChipView({ pageId, blockId, title, icon, gone, onOpen, rootRef }: {
  pageId: string; blockId: string; title: string; icon: string | null; gone: boolean; onOpen: () => void;
  rootRef: React.RefObject<HTMLSpanElement | null>;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={
        <span
          ref={rootRef}
          className={`nb-page-mention ${gone ? "nb-page-mention-gone" : ""}`}
          onClick={onOpen}
          role="link"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
        >
          @{title}
        </span>
      } />
      <TooltipContent className="max-w-72">
        {gone ? i18n.t("notebook:mention.deletedPage") : <ChipPreview pageId={pageId} blockId={blockId} title={title} icon={icon} />}
      </TooltipContent>
    </Tooltip>
  );
}

// Contenu du tooltip de la pastille — monté à l'ouverture seulement (fetch lazy de l'extrait).
function ChipPreview({ pageId, blockId, title, icon }: { pageId: string; blockId: string; title: string; icon: string | null }) {
  const ex = useExcerpt(pageId, blockId);
  return (
    <span className="flex max-w-full flex-col gap-0.5">
      <span className="flex items-center gap-1.5 font-medium">
        <span className="shrink-0">{renderPageIcon(icon, "h-3.5 w-3.5", "text-sm")}</span>
        <span className="truncate">{title}</span>
      </span>
      {blockId && ex && !ex.found && <span className="text-muted-foreground">{i18n.t("notebook:mention.blockMissing")}</span>}
      {ex?.text ? (
        <span className="line-clamp-3 whitespace-normal text-muted-foreground">
          {blockId && <CornerDownRight className="mr-1 inline h-3 w-3" />}
          {ex.text}
        </span>
      ) : null}
    </span>
  );
}

// Carte résumé : icône + titre + extrait de la cible, cliquable — un « embed » léger du bloc visé.
function CardView({ pageId, blockId, title, icon, gone, onOpen, rootRef }: {
  pageId: string; blockId: string; title: string; icon: string | null; gone: boolean; onOpen: () => void;
  rootRef: React.RefObject<HTMLSpanElement | null>;
}) {
  const ex = useExcerpt(pageId, blockId);
  return (
    <span
      ref={rootRef}
      onClick={onOpen}
      role="link"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      className={`my-0.5 inline-flex w-full max-w-xl cursor-pointer flex-col gap-0.5 rounded-lg border border-border bg-card px-3 py-2 align-top transition-colors hover:border-primary/50 hover:bg-muted/40 ${gone ? "opacity-60" : ""}`}
    >
      <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
        <span className="shrink-0">{renderPageIcon(icon, "h-4 w-4", "text-base")}</span>
        <span className="truncate">{gone ? i18n.t("notebook:mention.deletedTitle", { title }) : title}</span>
        {blockId && <span className="ml-auto shrink-0 text-[10px] font-normal text-muted-foreground">{i18n.t("notebook:mention.linkedBlock")}</span>}
      </span>
      {ex?.text ? (
        <span className="line-clamp-2 text-xs text-muted-foreground">
          {blockId && <CornerDownRight className="mr-1 inline h-3 w-3" />}
          {ex.text}
        </span>
      ) : ex && blockId && !ex.found ? (
        <span className="text-xs text-muted-foreground">{i18n.t("notebook:mention.blockMissing")}</span>
      ) : null}
    </span>
  );
}

export const pageMentionSpec = createReactInlineContentSpec(
  {
    type: "pageMention",
    propSchema: {
      pageId: { default: "" },
      blockId: { default: "" },   // ancre optionnelle : bloc précis de la page cible
      label: { default: "" },
      display: { default: "chip", values: ["chip", "card"] }, // pastille compacte ou carte résumé
    },
    content: "none",
  },
  {
    render: ({ inlineContent }) => (
      <MentionView
        pageId={String(inlineContent.props.pageId)}
        blockId={String(inlineContent.props.blockId)}
        label={String(inlineContent.props.label)}
        display={String(inlineContent.props.display)}
      />
    ),
  },
);
