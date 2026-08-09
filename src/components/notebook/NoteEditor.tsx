// Éditeur de page — enveloppe BlockNote (flavor Mantine, thème sombre mappé sur la palette). Monté avec
// une `key={page.id}` par le parent → recréé à chaque page (initialContent = blocs de la page). onChange
// pousse les blocs au store (autosave débouncé ailleurs). Menus : slash « / » (défaut + blocs custom) et
// « @ » (mention d'une autre page → lien + rétrolien).
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BlockNoteView, type Theme } from "@blocknote/mantine";
import { useCreateBlockNote, SuggestionMenuController, getDefaultReactSlashMenuItems, FormattingToolbarController, FormattingToolbar, getFormattingToolbarItems, type DefaultReactSuggestionItem } from "@blocknote/react";
import { filterSuggestionItems } from "@blocknote/core";
import { fr as bnFr } from "@blocknote/core/locales";
import { codeBlockOptions } from "@blocknote/code-block";
import { TextSelection } from "prosemirror-state";
import { useApp } from "@/store";
import { nr } from "@/lib/bridge";
import { spell } from "@/lib/spell/spellClient";
import { SpellcheckExtension, type SpellTarget } from "@/lib/spell/spellPlugin";
import { SpellPopover } from "@/components/common/SpellPopover";
import { isImageUrl, isVideoUrl } from "@/components/reference/embeds";
import { nbId, makeEmptyDatabase, parseNbLink, NBPAGE_LINK_PREFIX, type NotebookPage, type NoteBlock } from "./notebookShared";
import { notebookSchema, noteSlashItems, insertOrUpdate, todayIso } from "./notebookSchema";
import { applyPasteAs, type LinkAs } from "./notebookPaste";
import { PasteAsMenu, type PasteAnchor } from "./PasteAsMenu";
import { LinkToPageButton } from "./LinkToPageButton";
import { CopyTextButton, CopyAnchorButton } from "./SelectionActions";
import { NoteSideMenu } from "./NoteSideMenu";
import { parseUrls } from "./blocks/GalleryBlock";

// Thème BlockNote construit depuis les tokens CSS de l'app (source unique = palette d'index.css).
// Passer un OBJET theme (pas "dark") injecte les variables --bn-* inline sur les racines des portals
// Mantine → les menus/popovers suivent la DA quel que soit l'ordre de chargement des feuilles CSS.
function bnThemeFromTokens(): Theme {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const fg = v("--color-fg", "#e3e4e8");
  const surface = v("--color-surface", "#111319");
  const surface2 = v("--color-surface-2", "#1a1d25");
  const muted = v("--color-muted", "#888d99");
  return {
    colors: {
      editor: { text: fg, background: "transparent" },
      menu: { text: fg, background: surface },
      tooltip: { text: fg, background: surface2 },
      hovered: { text: fg, background: surface2 },
      selected: { text: v("--color-primary-fg", "#ffffff"), background: v("--color-primary", "#4f86f7") },
      disabled: { text: muted, background: surface2 },
      shadow: "rgba(0, 0, 0, 0.45)",
      border: v("--color-border", "#262a34"),
      sideMenu: muted,
    },
    borderRadius: 10,
  };
}

// Mémoïsé sur page.id : le parent passe un NOUVEL objet `page` à chaque frappe (nbSetPageBlocks), mais
// l'éditeur BlockNote gère son propre contenu → inutile de re-render à chaque touche (jank d'édition/
// sélection évité). Les listes fraîches (mentions, arbre) restent à jour via les hooks useApp internes.
function NoteEditorInner({ page }: { page: NotebookPage }) {
  const { t } = useTranslation("notebook");
  const setBlocks = useApp((s) => s.nbSetPageBlocks);
  const saveDatabase = useApp((s) => s.nbSaveDatabase);
  const pages = useApp((s) => s.nbPages);
  const openPage = useApp((s) => s.nbOpenPage);
  const createPage = useApp((s) => s.nbCreatePage);
  const language = useApp((s) => s.nbList.find((notebook) => notebook.id === s.nbActiveId)?.language ?? "fr");
  const spellEnabled = useApp((s) => s.nbPrefs.spellcheck);
  const editorWrap = useRef<HTMLDivElement>(null);
  // Ancre du menu « Coller comme » (null = fermé). Ouvert au collage d'un lien seul.
  const [pasteAnchor, setPasteAnchor] = useState<PasteAnchor | null>(null);
  // Mot fautif visé (clic droit / Ctrl+.) → panneau de suggestions.
  const [spellTarget, setSpellTarget] = useState<SpellTarget | null>(null);
  // Thème BlockNote figé au montage (la palette de l'app est statique).
  const nbTheme = useMemo(() => bnThemeFromTokens(), []);

  // Langue de correction EFFECTIVE, lue par un plugin ProseMirror créé une seule fois : elle vit
  // dans un ref pour que changer de langue ou couper le correcteur n'exige pas de recréer l'éditeur.
  const spellLang = spellEnabled ? spell.langFor(language) : null;
  const spellLangRef = useRef(spellLang);
  spellLangRef.current = spellLang;

  const editor = useCreateBlockNote({
    schema: notebookSchema,
    dictionary: bnFr, // libellés BlockNote en français (menus par défaut, placeholders, toolbar)
    // Correcteur MAISON : la WebView souligne les fautes mais ses suggestions n'existent que dans
    // son menu contextuel natif, que l'app supprime partout → sans ce plugin, aucune correction
    // n'est atteignable. Il apporte aussi le dictionnaire personnel et « remplacer partout ».
    _tiptapOptions: {
      extensions: [
        SpellcheckExtension.configure({
          getLang: () => spellLangRef.current,
          onTarget: setSpellTarget,
        }),
      ],
    },
    codeBlock: codeBlockOptions, // coloration syntaxique (shiki) + sélecteur de langage sur le bloc code
    initialContent: (page.blocks.length ? page.blocks : undefined) as never,
    // Médias de l'ordinateur (upload/drag-drop/collage d'image) → écrits sur disque par le core,
    // servis via /media (URL durable, survit au reload). Alimente les blocs image/vidéo/audio/fichier.
    uploadFile: async (file: File): Promise<string> => {
      const ext = (file.name.split(".").pop() || file.type.split("/")[1] || "png").toLowerCase();
      const buf = await file.arrayBuffer();
      // Le carnet visé décide de la DESTINATION : dans un carnet-document, le média va au dossier
      // compagnon du .netsu, pas au magasin global (sinon le fichier serait muet une fois déplacé).
      const r = await nr.notebook?.saveAsset(buf, ext, useApp.getState().nbActiveId ?? undefined);
      if (r?.ok && r.url) return r.url;
      throw new Error(r?.error || t("editor.uploadFailed"));
    },
    // Collage d'un lien seul : image/vidéo directe → bloc média direct ; sinon on ouvre le menu
    // « Coller comme » (Mention / Lien / Signet / Intégration) — l'utilisateur choisit.
    // Tout le reste (texte, markdown, images du presse-papier) → comportement par défaut de BlockNote.
    pasteHandler: ({ event, editor: ed, defaultPasteHandler }) => {
      const text = event.clipboardData?.getData("text/plain")?.trim() || "";
      // Lien interne collé (`nbpage:<id>` ou `nbpage:<id>#<blockId>`) → mention cliquable de la page
      // cible, ancre de bloc conservée (« Copier le lien vers ce bloc » → coller ailleurs → clic saute).
      const nbLink = parseNbLink(text);
      if (nbLink && !/\s/.test(text)) {
        const target = useApp.getState().nbPages.find((p) => p.id === nbLink.pageId);
        ed.insertInlineContent([
          { type: "pageMention", props: { pageId: nbLink.pageId, blockId: nbLink.blockId || "", label: target?.title || "page" } },
          " ",
        ] as never);
        return true;
      }
      const isLoneUrl = /^https?:\/\/\S+$/i.test(text) && !/\s/.test(text);
      if (!isLoneUrl || event.clipboardData?.files.length) return defaultPasteHandler();
      // Texte SÉLECTIONNÉ + collage d'un lien → on ENVELOPPE la sélection dans un lien (on ne remplace
      // pas le texte). Pas de menu ni de bloc.
      if (ed.getSelectedText()) { ed.createLink(text); return true; }
      if (isImageUrl(text)) { insertOrUpdate(ed, { type: "image", props: { url: text } }); return true; }
      if (isVideoUrl(text)) { insertOrUpdate(ed, { type: "video", props: { url: text } }); return true; }
      // Caret vide → menu flottant « Coller comme » à la position exacte du curseur.
      // La sélection DOM peut être absente/effondrée dans BlockNote (et donner 0,0) :
      // ProseMirror connaît toujours la position client réelle, y compris dans un bloc vide.
      const view = ed.prosemirrorView;
      const pos = ed.prosemirrorState.selection.from;
      const readSelectionRect = () => {
        try {
          const selection = window.getSelection();
          const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
          const rect = range?.getBoundingClientRect();
          if (rect && (rect.width || rect.height || rect.left || rect.top)) return rect;
          const line = range?.getClientRects?.()[0];
          if (line && (line.width || line.height || line.left || line.top)) return line;
        } catch { /* le caret peut être absent pendant le paste */ }
        return null;
      };
      const initialSelectionRect = readSelectionRect();
      setPasteAnchor({
        url: text,
        getRect: () => {
          const currentSelectionRect = readSelectionRect();
          if (currentSelectionRect) return currentSelectionRect;
          try {
            const coords = view.coordsAtPos(pos);
            return new DOMRect(coords.left, coords.top, Math.max(1, coords.right - coords.left), Math.max(1, coords.bottom - coords.top));
          } catch {
            // Dernier repli : le menu reste dans la zone de l’éditeur, jamais à (0, 0).
            if (initialSelectionRect) return initialSelectionRect;
            const rect = editorWrap.current?.getBoundingClientRect();
            return rect ? new DOMRect(rect.left, rect.top, 1, 20) : null;
          }
        },
      });
      return true;
    },
  });

  // Correcteur natif de la WebView : gardé UNIQUEMENT pour les langues sans dictionnaire embarqué
  // (es/de/ja/zh — dictionnaires Hunspell sous licence GPL, non distribuables ici). Sinon il ferait
  // doublon avec notre soulignement, en double couche et sans suggestions accessibles.
  useEffect(() => {
    const editable = editorWrap.current?.querySelector<HTMLElement>(".bn-editor[contenteditable]");
    if (!editable) return;
    editable.lang = language;
    editable.spellcheck = spellEnabled && !spellLang;
  }, [editor, language, spellEnabled, spellLang]);

  const onPasteAs = (kind: LinkAs) => { if (pasteAnchor) applyPasteAs(editor, pasteAnchor.url, kind); setPasteAnchor(null); };

  // Ancre de bloc (lien `nbpage:<id>#<blockId>`, recherche, rétrolien…) : déplie les bascules
  // ancêtres, scrolle le bloc au centre et le fait clignoter. Bloc introuvable (supprimé / doc pas
  // encore rendu) → petites tentatives en rAF puis abandon silencieux (la page reste ouverte en haut).
  const anchor = useApp((s) => s.nbAnchor);
  const clearAnchor = useApp((s) => s.nbClearAnchor);
  useEffect(() => {
    if (!anchor) return;
    // Déplie les bascules contenant le bloc cible (sinon il est masqué en CSS, scroll impossible).
    const openAncestorToggles = () => {
      const walk = (blocks: readonly { id: string; type?: string; children?: unknown }[], chain: string[]): string[] | null => {
        for (const b of blocks) {
          if (b.id === anchor) return chain;
          const kids = (b as { children?: { id: string; type?: string }[] }).children;
          if (Array.isArray(kids) && kids.length) {
            const found = walk(kids as never, b.type === "toggle" ? [...chain, b.id] : chain);
            if (found) return found;
          }
        }
        return null;
      };
      const toggles = walk(editor.document as never, []);
      for (const id of toggles || []) {
        const blk = editor.getBlock(id);
        if (blk && (blk.props as { open?: boolean }).open === false) editor.updateBlock(blk, { props: { open: true } } as never);
      }
    };
    let tries = 0;
    let raf = 0;
    const find = () => document.querySelector(`[data-id="${CSS.escape(anchor)}"]`) as HTMLElement | null;
    // Centre le bloc dans SON conteneur scrollable uniquement (le plus proche overflow auto/scroll).
    // `scrollIntoView` remonte TOUS les ancêtres scrollables jusqu'au layout de l'app → la fenêtre
    // entière sautait à chaque saut d'ancre. On scrolle donc à la main ce seul conteneur.
    const scrollToCenter = (target: HTMLElement) => {
      let sc = target.parentElement;
      while (sc && sc !== document.body) {
        const oy = getComputedStyle(sc).overflowY;
        if ((oy === "auto" || oy === "scroll") && sc.scrollHeight > sc.clientHeight) break;
        sc = sc.parentElement;
      }
      if (!sc || sc === document.body) return;
      const cr = sc.getBoundingClientRect();
      const tr = target.getBoundingClientRect();
      sc.scrollTop += (tr.top - cr.top) - (sc.clientHeight - tr.height) / 2;
    };
    // Scroll + flash APRÈS stabilisation (l'hydratation/autofocus BlockNote juste après le montage
    // recadre en haut et re-synchronise les attributs des nœuds → une classe posée sur le bloc serait
    // balayée par ProseMirror). Le flash = OVERLAY indépendant posé sur le rect du bloc, hors DOM PM.
    // Timer volontairement NON annulé au cleanup : clearAnchor() re-déclenche l'effet immédiatement.
    const settle = () => {
      const target = find();
      if (!target) return;
      scrollToCenter(target);
      const rect = target.getBoundingClientRect();
      const glow = document.createElement("div");
      glow.className = "nb-anchor-flash";
      glow.style.cssText = `position:fixed;left:${rect.left - 4}px;top:${rect.top - 2}px;width:${rect.width + 8}px;height:${rect.height + 4}px;pointer-events:none;z-index:60;`;
      document.body.appendChild(glow);
      setTimeout(() => glow.remove(), 1800);
    };
    const attempt = () => {
      const el = find();
      if (el) {
        openAncestorToggles();
        scrollToCenter(el);
        setTimeout(settle, 160);
        clearAnchor();
        return;
      }
      if (++tries < 24) raf = requestAnimationFrame(attempt);
      else clearAnchor(); // bloc disparu → la page reste ouverte en haut
    };
    raf = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(raf);
  }, [anchor, clearAnchor, editor]);

  // Crée une database vierge dans le store (optimiste, sync) et renvoie son id pour le bloc /database.
  const onInsertDatabase = useMemo(
    () => () => { const id = nbId(); void saveDatabase(makeEmptyDatabase(id)); return id; },
    [saveDatabase],
  );

  // Items « @ » : pages du carnet (hors page courante) + création d'une page à la volée.
  const mentionItems = async (query: string): Promise<DefaultReactSuggestionItem[]> => {
    const q = query.trim().toLowerCase();
    const matches = pages
      .filter((p) => p.id !== page.id && (!q || p.title.toLowerCase().includes(q)))
      .slice(0, 20)
      .map((p): DefaultReactSuggestionItem => ({
        title: p.title || t("panel.untitled"),
        onItemClick: () => editor.insertInlineContent([{ type: "pageMention", props: { pageId: p.id, label: p.title || t("panel.untitled") } }, " "] as never),
      }));
    // Entrée « Date » (@ ouvre aussi l'insertion de date).
    if (!q || "date".includes(q) || "aujourd'hui".includes(q)) {
      matches.unshift({
        title: t("editor.dateToday"),
        onItemClick: () => editor.insertInlineContent([{ type: "dateMention", props: { date: todayIso() } }, " "] as never),
      });
    }
    if (query.trim()) {
      matches.push({
        title: t("editor.createNamed", { name: query.trim() }),
        onItemClick: async () => {
          // Création SANS naviguer (silent) : la mention s'insère au fil de la frappe, on reste ici.
          const id = await createPage(page.id, { title: query.trim(), silent: true });
          if (id) editor.insertInlineContent([{ type: "pageMention", props: { pageId: id, label: query.trim() } }, " "] as never);
        },
      });
    }
    return matches;
  };

  // Clic sur un lien interne `nbpage:<id>` ou `nbpage:<id>#<blockId>` → ouvre la page cible (à l'ancre
  // du bloc le cas échéant) au lieu de naviguer.
  const onClickCapture = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest?.("a[href^='" + NBPAGE_LINK_PREFIX + "']") as HTMLAnchorElement | null;
    if (!a) return;
    e.preventDefault(); e.stopPropagation();
    const link = parseNbLink(a.getAttribute("href") || "");
    if (link) void openPage(link.pageId, { blockId: link.blockId });
  };

  // FIX sélection : quand des BLOCS sont sélectionnés (surbrillance bleue = NodeSelection/block-selection
  // de BlockNote), un clic-glisser DANS le texte ne repassait pas en sélection de texte → on était obligé
  // de cliquer dehors d'abord. Ici, au pointerdown dans le contenu éditable, si la sélection courante
  // N'EST PAS une sélection de texte, on la convertit en curseur texte à l'endroit cliqué AVANT le drag
  // → la sélection de texte repart normalement, sans désélectionner manuellement.
  const onEditorPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (!t.closest(".bn-block-content") || t.closest("a, button, input, textarea")) return;
    try {
      const view = editor.prosemirrorView;
      const state = editor.prosemirrorState;
      if (!view || !state || state.selection instanceof TextSelection) return; // déjà en texte → rien
      const coords = view.posAtCoords({ left: e.clientX, top: e.clientY });
      if (!coords) return;
      const tr = state.tr.setSelection(TextSelection.near(state.doc.resolve(coords.pos)));
      view.dispatch(tr);
    } catch { /* API PM absente → no-op */ }
  };

  // Clic dans le VIDE du document (sous le dernier bloc, ou dans la marge) → place le curseur en fin de
  // document (cliquer n'importe où dans la page focalise l'écriture). N'agit QUE si le
  // clic n'a pas atterri sur du contenu éditable (sinon on laisse la sélection normale se faire).
  const onEmptyClick = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest(".bn-block-content") || t.closest("a, button, input, textarea")) return;
    // NE PAS voler une sélection existante : si l'utilisateur vient de sélectionner du texte (drag qui
    // finit dans le vide sous le doc), laisser la sélection intacte — sinon elle serait collapsée.
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    // Seulement SOUS le dernier bloc (pas dans la marge latérale d'un paragraphe → éviter un saut surprenant).
    const editable = (e.currentTarget as HTMLElement).querySelector(".bn-editor");
    const bottom = editable?.getBoundingClientRect().bottom ?? 0;
    if (e.clientY < bottom) return;
    const blocks = editor.document;
    const last = blocks[blocks.length - 1];
    if (last) { editor.focus(); editor.setTextCursorPosition(last, "end"); }
  };

  // Glisser une (des) image(s) SUR un bloc image/galerie existant → fusion en galerie (carrousel).
  // On intercepte en phase capture AVANT le drop
  // de BlockNote (stopImmediatePropagation sur l'event natif) puis on envoie les fichiers sur disque.
  const onDropCapture = (e: React.DragEvent) => {
    const files = Array.from(e.dataTransfer?.files || []).filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    const host = (e.target as HTMLElement).closest?.("[data-id]") as HTMLElement | null;
    const id = host?.getAttribute("data-id");
    const blk = id ? editor.getBlock(id) : null;
    if (!blk || (blk.type !== "image" && blk.type !== "gallery")) return; // laisse BlockNote gérer
    e.preventDefault(); e.stopPropagation(); e.nativeEvent.stopImmediatePropagation();
    void (async () => {
      const up: string[] = [];
      for (const f of files) { const u = await editor.uploadFile?.(f); if (typeof u === "string") up.push(u); }
      if (!up.length) return;
      if (blk.type === "image") {
        const imgUrl = (blk.props as Record<string, unknown>).url;
        const first = imgUrl ? [String(imgUrl)] : [];
        editor.replaceBlocks([blk], [{ type: "gallery", props: { urls: JSON.stringify([...first, ...up]), layout: "carousel" } }] as never);
      } else {
        const cur = parseUrls((blk.props as Record<string, unknown>).urls);
        editor.updateBlock(blk, { type: "gallery", props: { urls: JSON.stringify([...cur, ...up]) } } as never);
      }
    })();
  };

  return (
    <div ref={editorWrap} className="bn-container" data-spellcheck-native="true" lang={language} onPointerDownCapture={onEditorPointerDown} onClickCapture={onClickCapture} onClick={onEmptyClick} onDropCapture={onDropCapture}>
      <BlockNoteView
        editor={editor}
        theme={nbTheme}
        lang={language}
        spellCheck={spellEnabled && !spellLang}
        slashMenu={false}
        sideMenu={false}
        formattingToolbar={false}
        onChange={() => setBlocks(editor.document as unknown as NoteBlock[])}
      >
        <FormattingToolbarController
          formattingToolbar={() => (
            <FormattingToolbar>
              {getFormattingToolbarItems()}
              <LinkToPageButton key="linkToPage" />
              <CopyTextButton key="copyText" />
              <CopyAnchorButton key="copyAnchor" />
            </FormattingToolbar>
          )}
        />
        <NoteSideMenu />
        <SuggestionMenuController
          triggerCharacter="/"
          getItems={async (query) => {
            // Nos blocs custom remplacent audio/vidéo/fichier : on écarte les items de menu par défaut
            // dont le titre entre en collision (ex. « Audio ») — sinon deux entrées de même clé dans
            // le menu slash (avertissement React « two children with the same key »).
            const custom = noteSlashItems(editor, onInsertDatabase, () => createPage(page.id, { silent: true }));
            const taken = new Set(custom.map((i) => i.title));
            const defaults = getDefaultReactSlashMenuItems(editor).filter((i) => !taken.has(i.title));
            // Regroupe par nom de groupe (1re apparition) : défauts FR et customs partagent « Médias »
            // → sans fusion, deux groupes homonymes non contigus = clés React en double dans le menu.
            const merged = [...defaults, ...custom];
            const groups = [...new Set(merged.map((i) => i.group))];
            return filterSuggestionItems(groups.flatMap((g) => merged.filter((i) => i.group === g)), query);
          }}
        />
        <SuggestionMenuController triggerCharacter="@" getItems={mentionItems} />
      </BlockNoteView>
      {pasteAnchor && (
        <PasteAsMenu anchor={pasteAnchor} onPick={onPasteAs} onClose={() => setPasteAnchor(null)} />
      )}
      <SpellPopover target={spellTarget} onClose={() => setSpellTarget(null)} />
    </div>
  );
}

export const NoteEditor = memo(NoteEditorInner, (a, b) => a.page.id === b.page.id);
