// Pont impératif vers l'éditeur Tiptap pour les panneaux annexes (RightPanel, TimelineStrip) : depuis
// la refonte, l'éditeur EST la source de vérité du contenu → toute mutation de contenu déclenchée
// hors éditeur (cocher un todo, sauter à un bloc) doit passer par lui, sinon la resérialisation
// l'écrase. Singleton enregistré par NotebookEditor au montage.

import type { Editor } from "@tiptap/react";
import type { ScriptBlockMedia } from "@/lib/bridge";
import { makeMedia } from "../scriptShared";
import type { MediaSpec } from "../useScript";

let ed: Editor | null = null;

// Dernière sélection de TEXTE non vide (mémorisée par NotebookEditor à chaque changement de
// sélection) : cliquer une carte média remplace la sélection par une NodeSelection → l'action
// « Lier au texte sélectionné » du menu doit retrouver la plage de texte d'AVANT le clic.
let lastTextSel: { from: number; to: number } | null = null;

// L'éditeur in/out vit au NIVEAU de NotebookEditor (pas dans chaque NodeView) : les items du rail
// et le clic sur un texte surligné demandent son ouverture par ce callback.
let editMediaCb: ((mediaId: string) => void) | null = null;

export function registerScriptEditor(e: Editor | null): void {
  ed = e;
  if (!e) lastTextSel = null;
}

export function registerEditMedia(cb: ((mediaId: string) => void) | null): void {
  editMediaCb = cb;
}

export function noteTextSelection(e: Editor): void {
  const sel = e.state.selection;
  if (!sel.empty && sel.$from.parent.isTextblock) lastTextSel = { from: sel.from, to: sel.to };
}

function findById(id: string): { pos: number; attrs: Record<string, unknown> } | null {
  if (!ed) return null;
  let found: { pos: number; attrs: Record<string, unknown> } | null = null;
  ed.state.doc.descendants((node, pos) => {
    if (!found && node.attrs && node.attrs.blockId === id) found = { pos, attrs: node.attrs };
  });
  return found;
}

export const scriptEditorApi = {
  // Ouvre l'éditeur in/out du média (hébergé par NotebookEditor).
  editMedia(mediaId: string): void {
    editMediaCb?.(mediaId);
  },

  // Illumine (ou éteint) l'item du RAIL correspondant — survol du texte surligné → on voit à quel
  // média il est lié (sens texte → média ; le sens média → texte passe par .hl-active).
  railHighlight(mediaId: string, on: boolean): void {
    if (!ed) return;
    ed.view.dom
      .querySelectorAll(`.nb-media-wrap[data-media-id="${mediaId}"]`)
      .forEach((el) => el.classList.toggle("rail-hot", on));
  },

  // Applique un patch au média d'une carte (retrouvée par media.id) — commit de l'éditeur in/out.
  updateMediaAttrs(mediaId: string, patch: Record<string, unknown>): void {
    if (!ed) return;
    let hitPos: number | null = null;
    ed.state.doc.descendants((n, pos) => {
      if (hitPos != null) return false;
      const m = n.type.name === "mediaCard" ? (n.attrs.media as { id?: string } | null) : null;
      if (m?.id === mediaId) hitPos = pos;
      return hitPos == null;
    });
    if (hitPos == null) return;
    const pos = hitPos;
    ed.chain()
      .command(({ tr }) => {
        const node = tr.doc.nodeAt(pos);
        if (!node) return false;
        const media = (node.attrs.media ?? {}) as Record<string, unknown>;
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, media: { ...media, ...patch } });
        return true;
      })
      .run();
  },

  toggleTodo(id: string): void {
    const f = findById(id);
    if (!ed || !f) return;
    ed.chain()
      .command(({ tr }) => { tr.setNodeMarkup(f.pos, undefined, { ...f.attrs, checked: !f.attrs.checked }); return true; })
      .run();
  },

  focusBlock(id: string): void {
    if (!ed) return;
    const el = ed.view.dom.querySelector(`[data-block-id="${id}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  },

  // Attache un média SOUS le bloc donné (nœud mediaCard inséré après lui) — utilisé par les
  // panneaux (enregistrements, recherche par paroles) : mutation par l'éditeur, jamais par le store.
  attachMedia(blockId: string, spec: MediaSpec): void {
    const f = findById(blockId);
    if (!ed || !f) return;
    const node = ed.state.doc.nodeAt(f.pos);
    if (!node) return;
    const existing: ScriptBlockMedia[] = [];
    ed.state.doc.descendants((n) => {
      const m = n.type.name === "mediaCard" ? (n.attrs.media as ScriptBlockMedia | null) : null;
      if (m) existing.push(m);
      return true;
    });
    const media = makeMedia(spec.kind, spec.filePath, spec.label, spec.fps ?? 0, existing, {
      inFrame: spec.inFrame ?? 0,
      outFrame: spec.outFrame ?? null,
      source: spec.source,
    });
    ed.chain().insertContentAt(f.pos + node.nodeSize, { type: "mediaCard", attrs: { media } }).run();
  },

  // Plage de texte disponible pour une liaison (sélection mémorisée, toujours valide dans le doc ?).
  linkableSelection(): { from: number; to: number } | null {
    if (!ed || !lastTextSel) return null;
    const size = ed.state.doc.content.size;
    if (lastTextSel.from >= size || lastTextSel.to > size) return null;
    return lastTextSel;
  },

  // Lie un média à la dernière sélection de texte : surlignage mediaHl de sa couleur (liaison
  // bidirectionnelle vignette ↔ texte, comme le drop sur sélection). Retourne false si pas de plage.
  linkMediaToSelection(mediaId: string, color: string): boolean {
    const sel = this.linkableSelection();
    if (!ed || !sel) return false;
    const markType = ed.schema.marks.mediaHl;
    const tr = ed.state.tr;
    tr.addMark(sel.from, sel.to, markType.create({ color, mediaId }));
    ed.view.dispatch(tr);
    return true;
  },

  // Tags d'un bloc : mutation par l'éditeur (source de vérité), utilisée par les chips et /tag.
  addTag(id: string, tag: string): void {
    const f = findById(id);
    if (!ed || !f || !tag) return;
    const tags: string[] = Array.isArray(f.attrs.tags) ? (f.attrs.tags as string[]) : [];
    if (tags.includes(tag)) return;
    ed.chain()
      .command(({ tr }) => { tr.setNodeMarkup(f.pos, undefined, { ...f.attrs, tags: [...tags, tag] }); return true; })
      .run();
  },

  removeTag(id: string, tag: string): void {
    const f = findById(id);
    if (!ed || !f) return;
    const tags: string[] = Array.isArray(f.attrs.tags) ? (f.attrs.tags as string[]) : [];
    if (!tags.includes(tag)) return;
    ed.chain()
      .command(({ tr }) => { tr.setNodeMarkup(f.pos, undefined, { ...f.attrs, tags: tags.filter((t) => t !== tag) }); return true; })
      .run();
  },
};
