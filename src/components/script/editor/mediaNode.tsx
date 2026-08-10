// Nœud `mediaCard` : un plan/son attaché. AUCUNE vignette dans le flux du texte (choix produit,
// refonte 2026-07) : la VIDÉO vit TOUJOURS dans le rail gauche — pastille couleur (défaut) ou
// micro-vignette selon les préférences (classe rail-dot/rail-thumb sur .editor-area, CSS pur, pas
// de re-render). GRISE tant qu'aucun texte n'est lié (hors montage) ; colorée dès qu'une plage de
// texte porte son surlignage. L'AUDIO garde 3 formes : fine ligne entre les lignes (ambiance),
// pastille dans le rail, et liable comme un plan. Survol = pop-up d'aperçu + texte lié illuminé
// (bidirectionnel) ; double-clic = éditeur in/out (hébergé par NotebookEditor via editorApi) ;
// clic droit = menu flottant (lier/délier, couleur, régler, supprimer).

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Node, mergeAttributes, type Editor } from "@tiptap/core";
import { ReactNodeViewRenderer, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { AudioLines, Link2, Link2Off, SlidersHorizontal, Trash2 } from "lucide-react";
import { nr } from "@/lib/bridge";
import { basename, thumbTime, THUMB_AUTO } from "@/lib/utils";
import { useThumb } from "../useThumb";
import { fmtSecs, mediaDurationSec, type MediaColor, type ScriptBlockMedia } from "../scriptShared";
import { COLOR_HEX, MEDIA_COLORS, mcClass } from "./mediaColors";
import { scriptEditorApi } from "./editorApi";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

// Met à jour (couleur) ou retire (color=null) toutes les marques de surlignage liées à ce média.
// Une SEULE transaction : parcourt le doc, cible les marques mediaHl portant le même mediaId.
export function updateHlMarks(editor: Editor, mediaId: string, color: MediaColor | null) {
  const { state, view } = editor;
  const markType = state.schema.marks.mediaHl;
  if (!markType) return;
  const tr = state.tr;
  state.doc.descendants((node, pos) => {
    if (!node.isText) return;
    for (const m of node.marks) {
      if (m.type === markType && m.attrs.mediaId === mediaId) {
        const from = pos, to = pos + node.nodeSize;
        tr.removeMark(from, to, m);
        if (color) tr.addMark(from, to, markType.create({ color, mediaId }));
      }
    }
  });
  if (tr.docChanged) view.dispatch(tr);
}

// Y a-t-il du texte lié à ce média ? (pastille grise = hors montage sinon.)
function hasLink(editor: Editor, mediaId: string): boolean {
  const markType = editor.state.schema.marks.mediaHl;
  if (!markType) return false;
  let linked = false;
  editor.state.doc.descendants((node) => {
    if (linked || !node.isText) return;
    if (node.marks.some((m) => m.type === markType && m.attrs.mediaId === mediaId)) linked = true;
  });
  return linked;
}

// État « lié » suivi par abonnement aux transactions : ProseMirror RÉUTILISE la NodeView quand les
// attrs sont identiques (delete+insert, re-stamp…) → un calcul au render se figerait.
function useLinked(editor: Editor, mediaId: string): boolean {
  const [linked, setLinked] = useState(false);
  useEffect(() => {
    if (!mediaId) return;
    const update = () => setLinked(hasLink(editor, mediaId));
    update();
    const onTx = ({ transaction }: { transaction: { docChanged: boolean } }) => { if (transaction.docChanged) update(); };
    editor.on("transaction", onTx);
    return () => { editor.off("transaction", onTx); };
  }, [editor, mediaId]);
  return linked;
}

// Instant de vignette d'un média : plan TRIMÉ → son in-point (l'image du plan) ; clip ENTIER → AUTO
// (le core vise ~10 % de la durée, sinon on affiche le noir du début de fichier).
function mediaThumbTime(m: ScriptBlockMedia): number {
  const fps = m.fps || 24;
  if (m.outFrame == null) return THUMB_AUTO;
  return thumbTime(m.inFrame / fps, (m.outFrame + 1) / fps);
}

// Fiche compacte du média. Elle est rendue dans le portail du Tooltip afin de pouvoir s'ouvrir
// réellement À GAUCHE du rail sans être coupée par la zone d'édition scrollable.
function MediaNameTooltip({ media }: { media: ScriptBlockMedia }) {
  const d = mediaDurationSec(media);
  return (
    <TooltipContent side="left" align="center" sideOffset={8}>
      <span className="block break-words leading-snug">{media.label || basename(media.filePath)}</span>
      {d != null && <span className="mt-0.5 block font-mono text-[10px] text-muted-foreground">{fmtSecs(d)}</span>}
    </TooltipContent>
  );
}

function MediaCardView({ node, updateAttributes, deleteNode, editor, selected }: NodeViewProps) {
  const { t } = useTranslation("script");
  const media = node.attrs.media as ScriptBlockMedia | null;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const isAudio = media?.kind === "audio";
  const mediaId = media?.id ?? "";
  const linked = useLinked(editor, mediaId);

  // Survol de l'item → illumine le texte lié (spans .nr-hl portant le même id de média).
  const linkHighlight = (on: boolean) => {
    if (!media?.id) return;
    const root = cardRef.current?.closest(".ProseMirror");
    root?.querySelectorAll(`.nr-hl[data-media-id="${media.id}"]`).forEach((el) => el.classList.toggle("hl-active", on));
  };
  const thumb = useThumb(isAudio || !media ? "" : media.filePath, media ? mediaThumbTime(media) : 0);

  if (!media) return <NodeViewWrapper className="nb-media-wrap" />;
  const name = media.label || basename(media.filePath);
  const d = mediaDurationSec(media);

  // Supprimer le média EFFACE d'abord ses surlignages : le mark ne meurt pas avec le nœud (ils
  // vivent sur le texte, pas sur la carte) → sans ça le passage resterait souligné pour un plan
  // qui n'existe plus.
  const removeMedia = () => { updateHlMarks(editor, mediaId, null); deleteNode(); };
  const detach = (e: React.SyntheticEvent) => { e.stopPropagation(); removeMedia(); };
  const openMenu = (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY }); };
  const setColor = (c: MediaColor) => { updateAttributes({ media: { ...media, color: c } }); updateHlMarks(editor, mediaId, c); };

  // Empêche le drag de démarrer ET préserve la sélection de texte quand on clique un micro-contrôle
  // posé sur l'item (×).
  const btnDown = (e: React.MouseEvent) => e.preventDefault();

  const hoverProps = {
    onMouseEnter: () => linkHighlight(true),
    onMouseLeave: () => linkHighlight(false),
  };

  // Menu flottant (couleur de liaison, lier/délier le texte, régler, supprimer). Positionné au
  // curseur, fermé au clic ailleurs. « Lier au texte sélectionné » = la même liaison que le drop
  // sur sélection, mais EXPLICITE : surligne la dernière sélection de texte de la couleur du média.
  const canLink = !!scriptEditorApi.linkableSelection();
  const menuEl = menu && (
    <>
      <button type="button" aria-label={t("common:action.close")} className="fixed inset-0 z-40" onMouseDown={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
      <div
        className="fixed z-50 min-w-44 rounded-md bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
        style={{ left: menu.x, top: menu.y }}
        contentEditable={false}
      >
        {/* Palette : les pastilles parlent d'elles-mêmes, pas d'infobulle par couleur. */}
        <div className="flex gap-1 px-1.5 py-1.5">
          {MEDIA_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={t("storyboard.color", { color: c })}
              className="size-5 rounded-full ring-1 ring-foreground/15 transition-transform hover:scale-110"
              style={{ background: COLOR_HEX[c], outline: c === media.color ? "2px solid var(--foreground)" : "none", outlineOffset: "1px" }}
              onClick={() => { setColor(c); setMenu(null); }}
            />
          ))}
        </div>
        <button type="button"
          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
          disabled={!canLink}
          onClick={() => { scriptEditorApi.linkMediaToSelection(mediaId, media.color); setMenu(null); }}
        >
          <Link2 className="size-4" /> {canLink ? t("editor.linkSelectedText") : t("editor.selectTextFirst")}
        </button>
        {linked && (
          <button type="button" className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent" onClick={() => { updateHlMarks(editor, mediaId, null); setMenu(null); }}>
            <Link2Off className="size-4" /> {t("storyboard.unlinkText")}
          </button>
        )}
        <button type="button" className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent" onClick={() => { scriptEditorApi.editMedia(mediaId); setMenu(null); }}>
          <SlidersHorizontal className="size-4" /> {t("editor.adjustShot")}
        </button>
        <button type="button" className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-destructive hover:bg-destructive/10" onClick={() => { removeMedia(); setMenu(null); }}>
          <Trash2 className="size-4" /> {t("common.delete")}
        </button>
      </div>
    </>
  );

  const stateCls = `${mcClass(media.color)} ${linked ? "is-linked" : "is-unlinked"} ${selected ? "sel" : ""}`;

  // Son dans le RAIL GAUCHE = petite PASTILLE discrète (icône teintée couleur de liaison) : on
  // sait qu'il est là, il ne prend aucune place dans le flux et ne déplace pas les items.
  if (isAudio && media.side === "left") {
    return (
      <NodeViewWrapper className="nb-media-wrap is-mini side-left" data-media-id={mediaId} data-drag-handle>
        <Tooltip>
          <TooltipTrigger
            render={
              <div
                className={`media-pill ${stateCls}`}
                contentEditable={false}
                onDoubleClick={() => scriptEditorApi.editMedia(mediaId)}
                onContextMenu={openMenu}
                {...hoverProps}
                role="button"
                aria-label={name}
                tabIndex={0}
              />
            }
          >
            <AudioLines className="mp-icon" aria-hidden />
            <span className="mc-x mp-x" role="button" aria-label={t("editor.detach")} tabIndex={0} onMouseDown={btnDown} onClick={detach} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); detach(e); } }}>×</span>
          </TooltipTrigger>
          <MediaNameTooltip media={media} />
        </Tooltip>
        {menuEl}
      </NodeViewWrapper>
    );
  }

  // Son entre les lignes = FINE LIGNE quasi invisible (couleur de liaison). Survol = nom + durée
  // seulement ; double-clic = éditeur in/out ; le reste au clic droit.
  if (isAudio) {
    return (
      <NodeViewWrapper className="nb-media-wrap is-line" data-media-id={mediaId} data-drag-handle>
        <div
          className={`media-line ${mcClass(media.color)} ${selected ? "sel" : ""}`}
          contentEditable={false}
          onDoubleClick={() => scriptEditorApi.editMedia(mediaId)}
          onContextMenu={openMenu}
          onMouseEnter={() => linkHighlight(true)}
          onMouseLeave={() => linkHighlight(false)}
          role="button"
          tabIndex={0}
        >
          <AudioLines className="ml-icon" aria-hidden />
          <span className="ml-track" />
          <span className="ml-info">
            <span className="ml-name">{name}</span>
            {d != null && <span className="mc-dur">{fmtSecs(d)}</span>}
          </span>
          <span className="mc-x ml-x" role="button" aria-label={t("editor.detach")} tabIndex={0} onMouseDown={btnDown} onClick={detach} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); detach(e); } }}>×</span>
        </div>
        {menuEl}
      </NodeViewWrapper>
    );
  }

  // VIDÉO = item du rail gauche, toujours. Le même DOM sert les deux styles : .editor-area.rail-dot
  // réduit la carte en pastille couleur (CSS), .rail-thumb garde la micro-vignette.
  return (
    <NodeViewWrapper className="nb-media-wrap is-mini side-left" data-media-id={mediaId} data-drag-handle>
      <Tooltip>
        <TooltipTrigger
          render={
            <div
              ref={cardRef}
              className={`media-card is-rail ${stateCls}`}
              contentEditable={false}
              onDoubleClick={() => scriptEditorApi.editMedia(mediaId)}
              onContextMenu={openMenu}
              {...hoverProps}
              role="button"
              aria-label={name}
              tabIndex={0}
            />
          }
        >
          <div className="mc-thumb">{thumb && <img src={nr.mediaUrl(thumb)} alt="" draggable={false} />}</div>
          <span className="mc-x" role="button" aria-label={t("editor.detach")} tabIndex={0} onMouseDown={btnDown} onClick={detach} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); detach(e); } }}>×</span>
        </TooltipTrigger>
        <MediaNameTooltip media={media} />
      </Tooltip>
      {menuEl}
    </NodeViewWrapper>
  );
}

export const MediaCardNode = Node.create({
  name: "mediaCard",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return { media: { default: null } };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="media-card"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "media-card" })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MediaCardView);
  },
});
