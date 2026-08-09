// Menu slash « / » de l'éditeur Script — extrait de NotebookEditor. Détection regex au caret,
// navigation clavier, application des commandes (types de bloc, listes, actions attach/audio/tag/
// transcript). TOUTES les commandes de SLASH_COMMANDS sont désormais accessibles.

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { Editor } from "@tiptap/react";
import { filterSlash, type SlashCommand } from "../scriptShared";
import { effectivePrefs } from "../scriptPrefs";
import { useScript } from "../useScript";

// Un état slash actif : requête tapée + plage à effacer + position écran du caret.
export interface SlashState { query: string; from: number; to: number; left: number; top: number }

export interface SlashActions {
  onAttach: (pos: number) => void;                 // → ouvre le panneau Footages (vidéos)
  onAudio: (pos: number) => void;                  // → choisir un fichier son
  onTag: (at: { left: number; top: number }) => void; // → TagPopup au caret
  onTranscript: () => void;                        // → panneau Footages en mode Paroles
}

export function useSlashMenu(editorRef: RefObject<Editor | null>, actions: SlashActions) {
  const [slash, setSlash] = useState<SlashState | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  // Refs miroir pour le handler clavier de ProseMirror (capturé une fois, lit toujours l'état frais).
  const slashRef = useRef<SlashState | null>(null);
  const slashIndexRef = useRef(0);
  useEffect(() => { slashRef.current = slash; }, [slash]);
  useEffect(() => { slashIndexRef.current = slashIndex; }, [slashIndex]);

  const cmds = useMemo(
    () => (slash ? filterSlash(slash.query, effectivePrefs(useScript.getState().doc?.settings).multiHeadings) : []),
    [slash],
  );
  const cmdsRef = useRef<SlashCommand[]>([]);
  useEffect(() => { cmdsRef.current = cmds; }, [cmds]);

  const refreshSlash = useCallback((editor: Editor) => {
    const sel = editor.state.selection;
    if (!sel.empty || !sel.$from.parent.isTextblock) { setSlash(null); return; }
    const $from = sel.$from;
    const before = editor.state.doc.textBetween($from.start(), $from.pos, "\n", "\n");
    const m = /(^|\s)\/([^/\s]*)$/.exec(before);
    if (!m) { setSlash(null); return; }
    const query = m[2];
    const to = $from.pos;
    const from = to - (query.length + 1);
    const c = editor.view.coordsAtPos(to);
    setSlash({ query, from, to, left: c.left, top: c.bottom });
    setSlashIndex(0);
  }, []);

  const applyCmd = useCallback((cmd: SlashCommand) => {
    const e = editorRef.current;
    const s = slashRef.current;
    if (!e || !s) return;
    // Le bloc courant ne contient-il QUE la commande slash (« /tit ») ? Sinon on ne convertit PAS le
    // paragraphe existant (le bug « ça met tout en titre ») : on ouvre une NOUVELLE ligne du type
    // voulu (split), et seul ce que l'utilisateur y tape devient le titre.
    const blockText = e.state.selection.$from.parent.textContent;
    const onlyCommand = blockText === "/" + s.query;
    const chain = e.chain().focus().deleteRange({ from: s.from, to: s.to });
    const setBlock = (type: string, attrs?: Record<string, unknown>) => {
      if (onlyCommand) chain.setNode(type, attrs).run();
      else chain.splitBlock().setNode(type, attrs).run();
    };
    if (cmd.id === "text") chain.setNode("paragraph").run();
    else if (cmd.type === "heading") setBlock("heading", { level: cmd.level ?? 2 });
    else if (cmd.id === "note") setBlock("comment");
    else if (cmd.id === "todo") { if (onlyCommand) chain.toggleTaskList().run(); else chain.splitBlock().toggleTaskList().run(); }
    else if (cmd.id === "bullet") { if (onlyCommand) chain.toggleBulletList().run(); else chain.splitBlock().toggleBulletList().run(); }
    else if (cmd.id === "numbered") { if (onlyCommand) chain.toggleOrderedList().run(); else chain.splitBlock().toggleOrderedList().run(); }
    else if (cmd.id === "storyboard") chain.insertContent({ type: "storyboard" }).run();
    else if (cmd.id === "callout") setBlock("callout");
    else if (cmd.id === "divider") chain.insertContent({ type: "divider" }).run();
    else if (cmd.action === "attach") { chain.run(); actions.onAttach(s.from); }
    else if (cmd.action === "audio") { chain.run(); actions.onAudio(s.from); }
    else if (cmd.action === "tag") { chain.run(); actions.onTag({ left: s.left, top: s.top }); }
    else if (cmd.action === "transcript") { chain.run(); actions.onTranscript(); }
    else chain.run();
    setSlash(null);
  }, [editorRef, actions]);
  const applyRef = useRef(applyCmd);
  useEffect(() => { applyRef.current = applyCmd; }, [applyCmd]);

  // Navigation clavier du menu (appelé depuis handleKeyDown de l'éditeur). true = consommé.
  const handleSlashKey = useCallback((event: KeyboardEvent): boolean => {
    if (!slashRef.current) return false;
    const list = cmdsRef.current;
    if (event.key === "ArrowDown") { event.preventDefault(); setSlashIndex((i) => Math.min(i + 1, list.length - 1)); return true; }
    if (event.key === "ArrowUp") { event.preventDefault(); setSlashIndex((i) => Math.max(i - 1, 0)); return true; }
    if (event.key === "Enter" && list.length) { event.preventDefault(); applyRef.current(list[slashIndexRef.current]); return true; }
    if (event.key === "Escape") { event.preventDefault(); setSlash(null); return true; }
    return false;
  }, []);

  return { slash, cmds, slashIndex, setSlashIndex, refreshSlash, applyCmd, handleSlashKey };
}
