// Insertion & drop de médias dans l'éditeur Script — extrait de NotebookEditor. Quatre entrées :
// insertion à une position (slash, gouttière), média LIÉ à une sélection de texte (drop sur
// sélection → vignette rail gauche + surlignage couleur), re-drop d'une carte existante (marge
// gauche ↔ flux), et fichiers lâchés depuis l'Explorateur Windows. `onDrop` gère le payload
// NR_FOOTAGE_DND du panneau Footages/recherche.

import { useCallback, type RefObject } from "react";
import type { Editor } from "@tiptap/react";
import { Fragment, Slice } from "@tiptap/pm/model";
import { NodeSelection } from "@tiptap/pm/state";
import { dropPoint } from "@tiptap/pm/transform";
import type { EditorView } from "@tiptap/pm/view";
import { nr, type ScriptBlockMedia } from "@/lib/bridge";
import { useApp } from "@/store";
import { basename } from "@/lib/utils";
import type { MediaSpec } from "../useScript";
import { makeMedia, secToFrame, mediaKindFromPath, NR_FOOTAGE_DND, type FootageDrag } from "../scriptShared";
import { scriptEditorApi } from "./editorApi";

// Largeur (px depuis le bord gauche du texte) de la zone « marge » : lâcher une carte média là
// la fait flotter à GAUCHE du texte ; la relâcher dans le flux la remet en bloc pleine largeur.
const LEFT_DROP_ZONE = 120;

// FootageDrag → MediaSpec (hit de recherche paroles → in-point au mot exact, fps réel via playInfo).
async function specFromDrag(f: FootageDrag): Promise<MediaSpec> {
  if (f.startSec == null) return { kind: f.kind ?? "video", filePath: f.filePath, label: f.label, fps: f.fps || 24, source: f.source };
  let fps = 24;
  try { const info = await nr.playInfo(f.filePath); if (info?.fps) fps = info.fps; } catch { /* repli 24 */ }
  const inFrame = secToFrame(f.startSec, fps);
  const outSec = (f.endSec ?? f.startSec) + 1;
  return { kind: "video", filePath: f.filePath, label: f.label, fps, inFrame, outFrame: Math.max(inFrame, secToFrame(outSec, fps) - 1) };
}

// Chemin disque (fichier lâché depuis l'Explorateur) → MediaSpec. fps réel via playInfo, comme
// pour un footage du tiroir : la frame-math en dépend.
async function specFromPath(path: string): Promise<MediaSpec | null> {
  const kind = mediaKindFromPath(path);
  if (!kind) return null;
  let fps = 24;
  try { const info = await nr.playInfo(path); if (info?.fps) fps = info.fps; } catch { /* repli 24 */ }
  return { kind, filePath: path, label: basename(path), fps };
}

// Début du bloc de profondeur 1 contenant `pos` (pour poser une vignette rail ALIGNÉE sur son
// paragraphe) ; pos brut si on est déjà entre deux blocs.
function blockStartAt(e: Editor, pos: number): number {
  const $pos = e.state.doc.resolve(Math.min(pos, e.state.doc.content.size));
  return $pos.depth > 0 ? $pos.before(1) : pos;
}

export function useMediaDrop(editorRef: RefObject<Editor | null>) {
  const insertMediaAt = useCallback((pos: number, spec: MediaSpec, side?: "left" | "block") => {
    const e = editorRef.current;
    if (!e) return;
    const media = makeMedia(spec.kind, spec.filePath, spec.label, spec.fps ?? 0, [], { inFrame: spec.inFrame ?? 0, outFrame: spec.outFrame ?? null, source: spec.source });
    // La vidéo vit TOUJOURS au rail gauche (item gris tant que rien n'est lié).
    const eff = spec.kind === "video" ? "left" : side;
    e.chain().insertContentAt(pos, { type: "mediaCard", attrs: { media: eff ? { ...media, side: eff } : media } }).focus().run();
  }, [editorRef]);

  // Drop d'un média SUR une sélection de texte : la vignette se pose à GAUCHE du bloc (float, le
  // texte s'enroule à droite) et le texte sélectionné se surligne de la couleur du média (mark
  // mediaHl). Liaison bidirectionnelle : survol de la vignette → le texte lié s'illumine ; clic
  // sur le texte → pop-up d'aperçu. La carte est insérée AVANT le bloc, le mark remappé du décalage.
  const insertLinkedMedia = useCallback((from: number, to: number, spec: MediaSpec) => {
    const e = editorRef.current;
    if (!e) return;
    const existing: ScriptBlockMedia[] = [];
    e.state.doc.descendants((n) => {
      const m = n.type.name === "mediaCard" ? (n.attrs.media as ScriptBlockMedia | null) : null;
      if (m) existing.push(m);
      return true;
    });
    const media = makeMedia(spec.kind, spec.filePath, spec.label, spec.fps ?? 0, existing, { inFrame: spec.inFrame ?? 0, outFrame: spec.outFrame ?? null, source: spec.source });
    const schema = e.schema;
    // Média lié → dans le rail gauche : vignette (vidéo) ou petite pastille (audio) — le texte lié
    // porte le soulignement pointillé de la même couleur, rien ne prend de place dans le flux.
    const node = schema.nodes.mediaCard.create({ media: { ...media, side: "left" } });
    const blockStart = e.state.doc.resolve(from).before(1);
    const tr = e.state.tr;
    tr.insert(blockStart, node);
    const shift = node.nodeSize;
    tr.addMark(from + shift, to + shift, schema.marks.mediaHl.create({ color: media.color, mediaId: media.id }));
    e.view.dispatch(tr);
    e.commands.focus();
  }, [editorRef]);

  // Re-drop d'une carte média existante : décide gauche/bloc selon la zone de lâcher. Retourne
  // true (drop consommé) seulement si le placement change — sinon ProseMirror déplace normalement.
  // `force` (chemin React, drop HORS de .nb-prose) : déplacer même si le side ne change pas, car
  // ProseMirror ne voit pas ce drop et ne fera aucun déplacement natif.
  const dropMediaCard = useCallback((view: EditorView, event: DragEvent, slice: Slice, moved: boolean, force = false): boolean => {
    const first = slice.content.firstChild;
    if (slice.content.childCount !== 1 || !first || first.type.name !== "mediaCard" || !first.attrs.media) return false;
    const media = first.attrs.media as ScriptBlockMedia;
    const rect = view.dom.getBoundingClientRect();
    // Vidéo = TOUJOURS au rail gauche (plus de vignette dans le flux) ; seul l'audio bascule
    // pastille de rail ↔ fine ligne dans le flux selon la zone de lâcher.
    const side = media.kind !== "audio" || event.clientX < rect.left + LEFT_DROP_ZONE ? "left" : "block";
    const coords = view.posAtCoords({
      left: Math.max(rect.left + 4, Math.min(event.clientX, rect.right - 4)),
      top: event.clientY,
    });
    if (!coords) return false;
    const tr = view.state.tr;
    // Supprime l'ORIGINAL par identité (même media.id), pas via deleteSelection : si la sélection
    // n'est plus la carte au moment du drop, deleteSelection ratait l'original → carte DUPLIQUÉE
    // (mêmes ids → « two children with the same key » dans la mini-timeline).
    const deleteOriginal = () => {
      if (!moved || !media.id) return;
      view.state.doc.descendants((n, pos) => {
        const m = n.type.name === "mediaCard" ? (n.attrs.media as ScriptBlockMedia | null) : null;
        if (m?.id === media.id) { tr.delete(tr.mapping.map(pos), tr.mapping.map(pos + n.nodeSize)); return false; }
        return true;
      });
    };
    // Carte lâchée SUR la dernière sélection de texte (le dragstart a remplacé la sélection par une
    // NodeSelection → on lit la plage mémorisée) → LIAISON : média au rail gauche + soulignement
    // pointillé de sa couleur sur la plage. Même geste que le drop d'un footage frais sur sélection.
    const linkSel = scriptEditorApi.linkableSelection();
    if (linkSel && coords.pos >= linkSel.from && coords.pos <= linkSel.to) {
      event.preventDefault();
      deleteOriginal();
      const $sel = tr.doc.resolve(tr.mapping.map(linkSel.from));
      const blockStart = $sel.depth > 0 ? $sel.before(1) : tr.mapping.map(linkSel.from);
      tr.insert(blockStart, first.type.create({ media: { ...media, side: "left" } }));
      const markType = view.state.schema.marks.mediaHl;
      if (media.id && markType) {
        tr.addMark(tr.mapping.map(linkSel.from), tr.mapping.map(linkSel.to), markType.create({ color: media.color, mediaId: media.id }));
      }
      view.dispatch(tr);
      return true;
    }
    if (!force && (media.side ?? "block") === side) return false;
    event.preventDefault();
    const node = first.type.create({ media: { ...media, side } });
    deleteOriginal();
    const pos = dropPoint(tr.doc, tr.mapping.map(coords.pos), new Slice(Fragment.from(node), 0, 0)) ?? tr.mapping.map(coords.pos);
    tr.insert(pos, node);
    view.dispatch(tr);
    return true;
  }, []);

  // Drop React (zone éditeur entière) : footage du panneau gauche / recherche, fichiers lâchés
  // depuis l'Explorateur, ou carte PM lâchée hors du texte (marge de la feuille) — la zone gauche
  // doit marcher là aussi, PM ne voit pas ce drop.
  const onDrop = useCallback((ev: React.DragEvent) => {
    const e = editorRef.current;
    if (!e) return;
    const frag = ev.dataTransfer.getData(NR_FOOTAGE_DND);
    // Les objets File doivent être lus MAINTENANT : `dataTransfer` est vidé à la fin de l'événement.
    const osFiles = frag ? [] : Array.from(ev.dataTransfer.files || []);
    if (!frag && !osFiles.length) {
      // Re-drop d'une carte existante HORS de .nb-prose (marge de la feuille) : PM ne voit pas ce
      // drop → on le consomme nous-mêmes (force=true, déplace même si le side ne change pas).
      // MAIS si le drop a eu lieu DANS la prose, PM l'a déjà traité (preventDefault posé) — ne pas
      // repasser derrière, sinon 2e insertion = carte dupliquée.
      if (ev.defaultPrevented || ev.nativeEvent.defaultPrevented) return;
      // Slice depuis view.dragging, sinon repli sur la NodeSelection posée au dragstart.
      const dragging = e.view.dragging;
      let slice = dragging?.slice ?? null;
      const sel = e.state.selection;
      if (!slice && sel instanceof NodeSelection && sel.node.type.name === "mediaCard") {
        slice = new Slice(Fragment.from(sel.node), 0, 0);
      }
      if (slice && dropMediaCard(e.view, ev.nativeEvent, slice, dragging?.move ?? true, true)) {
        ev.preventDefault();
        e.view.dragging = null;
      }
      return;
    }
    ev.preventDefault();
    // Coords CLAMPÉES dans la prose : un drop dans la MARGE (clientX hors .nb-prose) donnait
    // posAtCoords=null → insertion en FIN de document au lieu du paragraphe visé.
    const rect = e.view.dom.getBoundingClientRect();
    const coords = e.view.posAtCoords({
      left: Math.max(rect.left + 4, Math.min(ev.clientX, rect.right - 4)),
      top: Math.max(rect.top + 4, Math.min(ev.clientY, rect.bottom - 4)),
    });
    const pos = coords ? coords.pos : e.state.doc.content.size;
    // Lâché SUR une sélection de texte → média LIÉ : surlignage couleur + item dans le rail
    // gauche. La sélection lue est la DERNIÈRE sélection de TEXTE mémorisée (linkableSelection) —
    // PAS la sélection vivante : manipuler le tiroir Footages (clic sur la carte à glisser) vide
    // la sélection de l'éditeur, et le drop ne liait alors JAMAIS (bug « rien ne se passe »).
    // Sinon : vidéo → rail gauche ancré au paragraphe visé (pastille grise, non liée) ; audio →
    // fine ligne au point de drop (ambiance entre les lignes).
    const linkSel = scriptEditorApi.linkableSelection();
    const onSelection = linkSel != null && coords != null && coords.pos >= linkSel.from && coords.pos <= linkSel.to;
    // `link` : seul le PREMIER média d'un lot se lie à la sélection — lier 5 fichiers à la même
    // phrase empilerait 5 soulignements sur les mêmes mots.
    const place = (spec: MediaSpec, link: boolean) => {
      if (link && onSelection && linkSel) insertLinkedMedia(linkSel.from, linkSel.to, spec);
      else if (spec.kind === "video") insertMediaAt(blockStartAt(e, pos), spec, "left");
      else insertMediaAt(pos, spec);
    };

    if (osFiles.length) {
      // Fichiers de l'Explorateur : le chemin disque se résout côté host (WebView2), les octets ne
      // sont jamais lus. Les rushs rejoignent aussi la bibliothèque → ils apparaissent au tiroir.
      void nr.pathsForFiles(osFiles).then(async (paths) => {
        const media = paths.filter((p) => p && mediaKindFromPath(p));
        if (!media.length) return;
        useApp.getState().addLocalClips(media);
        for (const [i, p] of media.entries()) {
          const spec = await specFromPath(p);
          if (spec) place(spec, i === 0);
        }
      });
      return;
    }

    let f: FootageDrag;
    try { f = JSON.parse(frag); } catch { return; }
    void specFromDrag(f).then((spec) => place(spec, true));
  }, [editorRef, dropMediaCard, insertLinkedMedia, insertMediaAt]);

  return { insertMediaAt, insertLinkedMedia, dropMediaCard, onDrop };
}
