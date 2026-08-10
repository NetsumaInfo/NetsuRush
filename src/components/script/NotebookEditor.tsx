// Éditeur « bloc-notes » sur Tiptap (ProseMirror) — UNE seule surface, un seul curseur : saisie,
// accents (IME), annuler/refaire, sélection, coller gérés nativement. L'éditeur est la source de
// vérité ; on resérialise vers `ScriptBlock[]` (persistance + timeline) en débounce. Le titre du
// document vit EN TÊTE DE FEUILLE. Extensions dans editor/extensions.ts, menu slash
// dans editor/useSlashMenu.ts, insertion/drop de médias dans editor/useMediaDrop.ts.

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import type { Node as PMNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { AudioLines, Bold, FileText, Italic, List, ListOrdered, Strikethrough, Underline } from "lucide-react";
import { spell } from "@/lib/spell/spellClient";
import type { SpellTarget } from "@/lib/spell/spellPlugin";
import type { SpellLang } from "@/lib/spell/spellShared";
import { SpellPopover } from "@/components/common/SpellPopover";
import { nr, type ScriptBlockMedia } from "@/lib/bridge";
import { THUMB_AUTO } from "@/lib/utils";
import { BlockMenu } from "./BlockMenu";
import { BlockMediaEditor } from "./BlockMediaEditor";
import { useScript } from "./useScript";
import { useScriptPrefs, effectivePrefs } from "./scriptPrefs";
import { docTags, NR_FOOTAGE_DND } from "./scriptShared";
import { BlockGutter } from "./editor/BlockGutter";
import { LinkConnector } from "./editor/LinkConnector";
import { EditorContextMenu } from "./editor/EditorContextMenu";
import { TagPopup } from "./editor/TagPopup";
import { buildScriptExtensions } from "./editor/extensions";
import { useSlashMenu } from "./editor/useSlashMenu";
import { useMentionMenu } from "./editor/useMentionMenu";
import { useMediaDrop } from "./editor/useMediaDrop";
import type { MentionHit } from "./editor/useMentionMenu";
import { blocksToDoc, docToBlocks } from "./editor/serialize";
import { noteTextSelection, registerEditMedia, registerScriptEditor, scriptEditorApi } from "./editor/editorApi";
import { AudioWaveThumb } from "./AudioWaveThumb";
import { useThumb } from "./useThumb";
import { Button } from "@/components/ui/button";

// La carte média du doc dont l'id correspond (pour retrouver le média d'un surlignage lié).
function findMediaById(doc: PMNode, mediaId: string): ScriptBlockMedia | null {
  let found: ScriptBlockMedia | null = null;
  doc.descendants((n) => {
    if (found) return false;
    const m = n.type.name === "mediaCard" ? (n.attrs.media as ScriptBlockMedia | null) : null;
    if (m && m.id === mediaId) found = m;
    return !found;
  });
  return found;
}

// Id du bloc portant le caret (remonte jusqu'au premier ancêtre à blockId).
function currentBlockId(e: Editor): string | null {
  const $from = e.state.selection.$from;
  let d = $from.depth;
  while (d > 0 && !$from.node(d).attrs.blockId) d--;
  return d > 0 ? ($from.node(d).attrs.blockId as string) : null;
}

// Un script s'écrit en français : le correcteur (et l'attribut `lang` du DOM) n'ont pas de sélecteur
// de langue ici, contrairement au Carnet où chaque carnet porte la sienne.
const SCRIPT_LANG = "fr";

function MentionVisual({ hit }: { hit: MentionHit }) {
  const thumb = useThumb(hit.kind === "media" && hit.mediaKind === "video" ? hit.path : "", THUMB_AUTO);
  if (hit.kind === "page") return <span className="nb-mention-item-icon">{hit.icon || <FileText />}</span>;
  if (hit.mediaKind === "audio") return <AudioWaveThumb path={hit.path} compact />;
  return <span className="nb-mention-media-thumb">{thumb ? <img src={nr.mediaUrl(thumb)} alt="" /> : null}</span>;
}

export function NotebookEditor() {
  const { t } = useTranslation("script");
  const docId = useScript((s) => s.doc?.id ?? null);
  const title = useScript((s) => s.doc?.title ?? "");
  const docSettings = useScript((s) => s.doc?.settings ?? null);
  const hideTodos = useScript((s) => s.hideTodos);
  const globalPrefs = useScriptPrefs((s) => s.prefs);
  const prefs = effectivePrefs(docSettings, globalPrefs);
  const [tagAt, setTagAt] = useState<{ left: number; top: number } | null>(null);
  const [editingMedia, setEditingMedia] = useState<ScriptBlockMedia | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  // Mot fautif visé (clic droit / Ctrl+.) → panneau de suggestions, partagé avec le Carnet.
  const [spellTarget, setSpellTarget] = useState<SpellTarget | null>(null);
  // Lu par un plugin ProseMirror créé une seule fois : couper le correcteur ne recrée pas l'éditeur.
  const spellLang: SpellLang | null = prefs.spellcheck ? spell.langFor(SCRIPT_LANG) : null;
  const spellLangRef = useRef(spellLang);
  spellLangRef.current = spellLang;

  const serializeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedDocId = useRef<string | null>(null);
  const editorRef = useRef<Editor | null>(null);
  // Drag né DANS l'éditeur (carte média) en cours — sert à autoriser le drop dans la marge
  // (dragover preventDefault) sans dépendre des internes ProseMirror (view.dragging).
  const dragFromEditor = useRef(false);

  const { dropMediaCard, onDrop } = useMediaDrop(editorRef);

  // Ajouter un média = TOUJOURS le tiroir Footages de gauche (exigence : plus aucun picker à
  // droite) : « Attacher un plan/son » ouvre le panneau sur le bon onglet, puis on glisse.
  const openVideos = useCallback(() => useScript.getState().requestFootages("videos"), []);
  const openAudio = useCallback(() => useScript.getState().requestFootages("audio"), []);

  const slashMenu = useSlashMenu(editorRef, {
    onAttach: openVideos,
    onAudio: openAudio,
    onTag: setTagAt,
    onTranscript: () => useScript.getState().requestFootages("paroles"),
  });
  const { slash, cmds, slashIndex, setSlashIndex, refreshSlash, applyCmd, handleSlashKey } = slashMenu;
  const handleSlashKeyRef = useRef(handleSlashKey);
  useEffect(() => { handleSlashKeyRef.current = handleSlashKey; }, [handleSlashKey]);

  const mentionMenu = useMentionMenu(editorRef);
  const { mention, hits, mentionIndex, setMentionIndex, refreshMention, applyMention, handleMentionKey } = mentionMenu;
  const handleMentionKeyRef = useRef(handleMentionKey);
  useEffect(() => { handleMentionKeyRef.current = handleMentionKey; }, [handleMentionKey]);

  // Sérialise le doc Tiptap → modèle de blocs (débounce) : stats, plan, timeline, autosave suivent.
  const scheduleSerialize = useCallback((editor: Editor) => {
    if (serializeTimer.current) clearTimeout(serializeTimer.current);
    serializeTimer.current = setTimeout(() => {
      useScript.getState().replaceBlocks(docToBlocks(editor.getJSON()));
    }, 250);
  }, []);

  const syncSelected = useCallback((editor: Editor) => {
    const id = currentBlockId(editor);
    if (id) useScript.getState().setSelected(id);
  }, []);

  const editor = useEditor({
    extensions: buildScriptExtensions({
      getLang: () => spellLangRef.current,
      onTarget: setSpellTarget,
    }),
    editorProps: {
      attributes: { class: "nb-prose", spellcheck: "false", lang: SCRIPT_LANG },
      handleKeyDown: (_view, event) => handleEditorKeyDown(event),
      // Re-drop d'une carte média : lâchée dans la marge gauche → flotte à gauche du texte ;
      // relâchée dans le flux → bloc pleine largeur. Sinon comportement natif (déplacement).
      handleDrop: (view, event, slice, moved) => dropMediaCard(view, event as DragEvent, slice, moved),
      // Clic sur un texte surligné (lié à un média) → éditeur in/out du plan (le passage EST le
      // plan : cliquer dessus le règle). Le caret se pose normalement partout ailleurs.
      handleClick: (view, pos) => {
        const $pos = view.state.doc.resolve(pos);
        const marks = $pos.nodeAfter?.marks?.length ? $pos.nodeAfter.marks : $pos.marks();
        const hl = marks.find((m) => m.type.name === "mediaHl");
        if (!hl?.attrs.mediaId) return false;
        const media = findMediaById(view.state.doc, String(hl.attrs.mediaId));
        if (!media) return false; // id orphelin (storyboard lié = pas de mediaCard) → clic normal
        setEditingMedia(media);
        return true;
      },
    },
    onUpdate: ({ editor: e }) => { scheduleSerialize(e); refreshSlash(e); refreshMention(e); },
    onSelectionUpdate: ({ editor: e }) => { refreshSlash(e); refreshMention(e); syncSelected(e); noteTextSelection(e); },
  });
  useEffect(() => { editorRef.current = editor; }, [editor]);

  // Charge le contenu au 1er montage + à chaque changement de document (jamais pendant l'édition).
  // setContent DIFFÉRÉ (microtask) : synchrone dans l'effet, Tiptap monte les NodeViews React
  // pendant le rendu → warning « flushSync was called from inside a lifecycle method ».
  useEffect(() => {
    if (!editor || !docId) return;
    if (loadedDocId.current === docId) return;
    loadedDocId.current = docId;
    queueMicrotask(() => {
      if (editor.isDestroyed) return;
      const blocks = useScript.getState().doc?.blocks ?? [];
      editor.commands.setContent(blocksToDoc(blocks), { emitUpdate: false });
    });
  }, [editor, docId]);

  useEffect(() => {
    registerScriptEditor(editor ?? null);
    return () => registerScriptEditor(null);
  }, [editor]);

  // L'éditeur in/out est hébergé ICI (pas dans les NodeViews) : les items du rail et le clic sur
  // un texte surligné l'ouvrent via editorApi.editMedia.
  useEffect(() => {
    registerEditMedia((mediaId) => {
      const e = editorRef.current;
      if (!e) return;
      const media = findMediaById(e.state.doc, mediaId);
      if (media) setEditingMedia(media);
    });
    return () => registerEditMedia(null);
  }, []);

  // Correcteur natif de la WebView : gardé en repli SEULEMENT si aucun dictionnaire embarqué ne
  // couvre la langue — sinon il doublonnerait notre soulignement sans offrir de correction.
  // Attribut posé sur le DOM directement (setOptions({editorProps}) écraserait handleDrop/handleClick).
  useEffect(() => {
    editor?.view.dom.setAttribute("spellcheck", prefs.spellcheck && !spellLang ? "true" : "false");
  }, [editor, prefs.spellcheck, spellLang]);

  // Clavier ProseMirror : navigation du menu slash + raccourcis titre/tags (lit les refs → frais).
  function handleEditorKeyDown(event: KeyboardEvent): boolean {
    const e = editorRef.current;
    if (!e) return false;
    if (handleSlashKeyRef.current(event)) return true;
    if (handleMentionKeyRef.current(event)) return true;
    // Ctrl+Alt+H : titre ↔ paragraphe (pas de « # » auto ; le « # » reste littéral).
    if ((event.metaKey || event.ctrlKey) && event.altKey && event.code === "KeyH") {
      event.preventDefault();
      if (e.isActive("heading")) e.chain().focus().setNode("paragraph").run();
      else e.chain().focus().setNode("heading", { level: 2 }).run();
      return true;
    }
    // Ctrl+1…9 : tag favori sur le bloc courant.
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key >= "1" && event.key <= "9") {
      const fav = useScript.getState().favTags[Number(event.key) - 1];
      if (!fav) return false;
      event.preventDefault();
      event.stopPropagation(); // sinon un raccourci global Ctrl+chiffre passerait aussi
      const $from = e.state.selection.$from;
      let d = $from.depth;
      while (d > 0 && !$from.node(d).attrs.blockId) d--;
      if (d === 0) return true;
      const pos = $from.before(d);
      const node = $from.node(d);
      const tags: string[] = Array.isArray(node.attrs.tags) ? node.attrs.tags : [];
      const next = tags.includes(fav) ? tags.filter((t) => t !== fav) : [...tags, fav];
      e.chain().command(({ tr }) => { tr.setNodeMarkup(pos, undefined, { ...node.attrs, tags: next }); return true; }).run();
      return true;
    }
    return false;
  }

  // Un storyboard est committé au pointerup, mais sa sérialisation store est débouncée. Si le document
  // se ferme pendant cette courte fenêtre, on force le dernier état au lieu d'abandonner le timer.
  useEffect(() => () => {
    if (!serializeTimer.current) return;
    clearTimeout(serializeTimer.current);
    serializeTimer.current = null;
    const activeEditor = editorRef.current;
    if (activeEditor && !activeEditor.isDestroyed) useScript.getState().replaceBlocks(docToBlocks(activeEditor.getJSON()));
  }, []);

  const tagSuggestions = () => {
    const s = useScript.getState();
    return [...new Set([...s.favTags, ...docTags(s.doc)])];
  };

  // Comme dans NetsuBook : un clic dans le vide SOUS le document reprend l'écriture à la fin,
  // sans voler une sélection de texte en cours.
  const focusDocumentEnd = (ev: React.MouseEvent<HTMLDivElement>) => {
    const e = editorRef.current;
    if (!e) return;
    const target = ev.target as HTMLElement;
    if (target.closest(".nb-title, .nb-prose, button, input, textarea, [role='menu']")) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    const proseBottom = e.view.dom.getBoundingClientRect().bottom;
    if (ev.clientY < proseBottom) return;
    e.commands.focus("end");
  };

  return (
    <div
      className={`editor-area ${hideTodos ? "hide-todos" : ""} rail-${prefs.railStyle} ${prefs.hlVisible ? "" : "hide-hl"}`}
      onClick={focusDocumentEnd}
      // Survol d'un texte surligné → l'item du RAIL correspondant s'illumine (sens texte → média ;
      // le sens média → texte est géré par les NodeViews). Délégation : les spans naissent/meurent
      // au fil de la frappe, aucun listener par span.
      onMouseOver={(ev) => {
        const hl = (ev.target as HTMLElement).closest?.(".nr-hl");
        const id = hl?.getAttribute("data-media-id");
        if (id) scriptEditorApi.railHighlight(id, true);
      }}
      onMouseOut={(ev) => {
        const hl = (ev.target as HTMLElement).closest?.(".nr-hl");
        const id = hl?.getAttribute("data-media-id");
        if (id) scriptEditorApi.railHighlight(id, false);
      }}
      // Autoriser le drop du footage ET du re-drag d'une carte de l'éditeur — sans ce
      // preventDefault, lâcher une carte dans la MARGE (hors .nb-prose) ne déclenche jamais
      // `drop` : curseur interdit, impossible de la poser à gauche du texte.
      onDragStartCapture={() => { dragFromEditor.current = true; }}
      onDragEndCapture={() => { dragFromEditor.current = false; }}
      onDragOver={(ev) => {
        // « Files » = fichiers lâchés depuis l'Explorateur : leur chemin se résout côté host au
        // drop (cf. nr.pathsForFiles). Curseur « copier » → le geste s'annonce comme un ajout.
        if (ev.dataTransfer.types.includes("Files")) {
          ev.preventDefault();
          ev.dataTransfer.dropEffect = "copy";
          return;
        }
        if (ev.dataTransfer.types.includes(NR_FOOTAGE_DND) || dragFromEditor.current || editorRef.current?.view.dragging) ev.preventDefault();
      }}
      onDrop={(ev) => { onDrop(ev); dragFromEditor.current = false; }}
      // Clic droit général (texte / bloc) : pose le caret au point du clic (sauf clic DANS la
      // sélection courante → on la garde) puis ouvre le menu. Les médias gardent leur propre menu
      // (leurs handlers stopPropagation).
      onContextMenu={(ev) => {
        const e = editorRef.current;
        if (!e) return;
        const target = ev.target as HTMLElement;
        if (target.closest(".media-card, .media-line, .media-pill, .nb-gutter")) return;
        if (!target.closest(".nb-sheet")) return;   // hors feuille → laisse le menu global du fond de vue
        ev.preventDefault();
        ev.stopPropagation();   // menu éditeur pris en charge → pas le menu custom global par-dessus
        const coords = e.view.posAtCoords({ left: ev.clientX, top: ev.clientY });
        if (coords) {
          const sel = e.state.selection;
          const inside = !sel.empty && coords.pos >= sel.from && coords.pos <= sel.to;
          if (!inside) e.chain().setTextSelection(coords.pos).run();
        }
        setCtxMenu({ x: ev.clientX, y: ev.clientY });
      }}
    >
      <div className="blocks-container nb-sheet">
        <input
          className="nb-title"
          value={title}
          placeholder={t("common.untitled")}
          spellCheck
          lang="fr"
          onChange={(ev) => useScript.getState().setTitle(ev.target.value)}
          onKeyDown={(ev) => { if (ev.key === "Enter" && !ev.nativeEvent.isComposing) { ev.preventDefault(); editor?.commands.focus("start"); } }}
        />
        <EditorContent editor={editor} />
        {editor && (
          <BubbleMenu
            editor={editor}
            options={{ placement: "top", strategy: "fixed", offset: 8 }}
            shouldShow={({ editor: activeEditor }) => {
              const selection = activeEditor.state.selection;
              return activeEditor.isEditable && selection instanceof TextSelection && !selection.empty;
            }}
            className="nb-format-toolbar"
          >
            <Button size="icon-xs" variant={editor.isActive("bold") ? "secondary" : "ghost"} aria-label={t("editor.bold")} onClick={() => editor.chain().focus().toggleBold().run()}><Bold /></Button>
            <Button size="icon-xs" variant={editor.isActive("italic") ? "secondary" : "ghost"} aria-label={t("editor.italic")} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic /></Button>
            <Button size="icon-xs" variant={editor.isActive("underline") ? "secondary" : "ghost"} aria-label={t("editor.underline")} onClick={() => editor.chain().focus().toggleUnderline().run()}><Underline /></Button>
            <Button size="icon-xs" variant={editor.isActive("strike") ? "secondary" : "ghost"} aria-label={t("editor.strike")} onClick={() => editor.chain().focus().toggleStrike().run()}><Strikethrough /></Button>
            <span className="nb-format-separator" />
            <Button size="icon-xs" variant={editor.isActive("bulletList") ? "secondary" : "ghost"} aria-label={t("editor.bulletList")} onClick={() => editor.chain().focus().toggleBulletList().run()}><List /></Button>
            <Button size="icon-xs" variant={editor.isActive("orderedList") ? "secondary" : "ghost"} aria-label={t("editor.numberedList")} onClick={() => editor.chain().focus().toggleOrderedList().run()}><ListOrdered /></Button>
          </BubbleMenu>
        )}
        {editor && <BlockGutter editor={editor} onAttachAt={openVideos} onAudioAt={openAudio} />}
      </div>

      {/* Trait vignette ↔ passage lié, en escalier, tracé au survol seulement. */}
      <LinkConnector />

      <SpellPopover target={spellTarget} onClose={() => setSpellTarget(null)} />


      {slash && cmds.length > 0 && (
        <div style={{ position: "fixed", left: slash.left, top: slash.top, zIndex: 50 }}>
          <div className="relative">
            <BlockMenu commands={cmds} activeIndex={slashIndex} onSelect={applyCmd} onHover={setSlashIndex} />
          </div>
        </div>
      )}

      {mention && hits.length > 0 && (
        <div
          className="nb-mention-menu"
          style={{
            position: "fixed",
            left: Math.max(8, Math.min(mention.left, window.innerWidth - 336)),
            top: mention.top > window.innerHeight - 330 ? Math.max(8, mention.top - 320) : mention.top,
            zIndex: 50,
          }}
        >
          <div className="nb-mention-menu-label"><AudioLines /> {t("mentions.searchMedia")}</div>
          {hits.map((hit, i) => (
            <button
              key={hit.id}
              type="button"
              className={`nb-mention-item ${i === mentionIndex ? "active" : ""}`}
              onMouseEnter={() => setMentionIndex(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => applyMention(hit)}
            >
              <MentionVisual hit={hit} />
              <span className="nb-mention-item-copy">
                <span className="nb-mention-item-title">{hit.title}</span>
                <span className="nb-mention-item-meta">{hit.kind === "page" ? t("mentions.page") : t(`mentions.${hit.source ?? "folder"}`)}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {tagAt && (
        <TagPopup
          left={tagAt.left}
          top={tagAt.top}
          suggestions={tagSuggestions()}
          onPick={(tag) => {
            const e = editorRef.current;
            const id = e ? currentBlockId(e) : null;
            if (id) scriptEditorApi.addTag(id, tag);
          }}
          onClose={() => setTagAt(null)}
        />
      )}

      {editingMedia && (
        <BlockMediaEditor
          media={editingMedia}
          onClose={() => setEditingMedia(null)}
          onCommit={(inFrame, outFrame) => {
            if (editingMedia.id) scriptEditorApi.updateMediaAttrs(editingMedia.id, { inFrame, outFrame });
            setEditingMedia(null);
          }}
          onInsertTranscript={(text) => {
            const e = editorRef.current;
            if (e && editingMedia.id) {
              // Paragraphe inséré AVANT la carte du média (même geste que l'ancien in-NodeView).
              let at: number | null = null;
              e.state.doc.descendants((n, pos) => {
                if (at != null) return false;
                const m = n.type.name === "mediaCard" ? (n.attrs.media as ScriptBlockMedia | null) : null;
                if (m?.id === editingMedia.id) at = pos;
                return at == null;
              });
              if (at != null) e.chain().insertContentAt(at, { type: "paragraph", content: text ? [{ type: "text", text }] : [] }).focus().run();
            }
            setEditingMedia(null);
          }}
        />
      )}

      {ctxMenu && editor && (
        <EditorContextMenu
          editor={editor}
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          onAttach={openVideos}
          onAudio={openAudio}
          onTag={setTagAt}
        />
      )}
    </div>
  );
}
