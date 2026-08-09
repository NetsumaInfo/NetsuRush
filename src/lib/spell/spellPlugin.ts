// Plugin ProseMirror du correcteur : souligne les mots inconnus du dictionnaire et expose le mot
// visé au clic droit. Partagé par l'éditeur Carnet (BlockNote) et l'éditeur Script (Tiptap) — les
// deux tournent sur ProseMirror, il n'y a donc qu'une implémentation.
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "prosemirror-state";
import type { EditorState, Transaction } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { EditorView } from "prosemirror-view";
import type { Node as PmNode } from "prosemirror-model";
import { spell } from "./spellClient";
import { badRanges, tokenize, wordsOf, type SpellLang, type SpellToken } from "./spellShared";

export const SPELL_PLUGIN_KEY = new PluginKey<DecorationSet>("nrSpellcheck");
export const SPELL_ERROR_CLASS = "nr-spell-bad";

// Attendre l'accalmie : re-vérifier à chaque frappe ferait clignoter les soulignements sous le curseur.
const IDLE_MS = 400;
// Garde-fou sur un document démesuré — au-delà, on souligne le début et on s'arrête.
const MAX_TOKENS = 20_000;

/** Mot fautif visé par l'utilisateur, transmis à l'infobulle de suggestions. */
export interface SpellTarget {
  word: string;
  from: number;
  to: number;
  lang: SpellLang;
  view: EditorView;
  getRect: () => DOMRect | null;
}

export interface SpellPluginOptions {
  /** Langue courante, ou `null` quand le correcteur doit rester silencieux. */
  getLang: () => SpellLang | null;
  /** Ouvre (ou ferme, avec `null`) l'infobulle de suggestions. */
  onTarget: (target: SpellTarget | null) => void;
}

// ---- Lecture du document -----------------------------------------------------------------------
// Le code (bloc ou marque), les formules et les mentions ne sont pas de la prose : jamais corrigés.
function isCode(node: PmNode): boolean {
  return node.type.spec.code === true || node.marks.some((mark) => mark.type.spec.code === true || mark.type.name === "code");
}

function collectTokens(doc: PmNode): SpellToken[] {
  const tokens: SpellToken[] = [];
  doc.descendants((node, pos) => {
    if (tokens.length >= MAX_TOKENS) return false;
    if (isCode(node)) return false;
    if (!node.isText || !node.text) return true;
    tokens.push(...tokenize(node.text, pos));
    return true;
  });
  return tokens;
}

function decorate(ranges: readonly SpellToken[], doc: PmNode): DecorationSet {
  const size = doc.content.size;
  const decorations = ranges
    .filter((range) => range.to <= size && range.from < range.to)
    .map((range) => Decoration.inline(range.from, range.to, { class: SPELL_ERROR_CLASS, spellcheck: "false" }));
  return DecorationSet.create(doc, decorations);
}

/** Mot fautif contenant `pos`, d'après les soulignements déjà posés. */
export function badWordAt(state: EditorState, pos: number): { from: number; to: number; word: string } | null {
  const set = SPELL_PLUGIN_KEY.getState(state);
  const hit = set?.find(pos, pos)[0];
  if (!hit) return null;
  return { from: hit.from, to: hit.to, word: state.doc.textBetween(hit.from, hit.to) };
}

/** Remplace le mot [from, to) en conservant les marques de l'endroit (gras, lien…). */
export function applyCorrection(view: EditorView, from: number, to: number, replacement: string): void {
  const { tr } = view.state;
  view.dispatch(tr.insertText(replacement, from, to).scrollIntoView());
  view.focus();
}

/** Toutes les occurrences d'un mot dans le document, de la dernière à la première (positions stables). */
export function occurrencesOf(doc: PmNode, word: string): { from: number; to: number }[] {
  const hits: { from: number; to: number }[] = [];
  doc.descendants((node, pos) => {
    if (isCode(node)) return false;
    if (!node.isText || !node.text) return true;
    for (const token of tokenize(node.text, pos)) if (token.word === word) hits.push({ from: token.from, to: token.to });
    return true;
  });
  return hits.reverse();
}

// ---- Plugin ------------------------------------------------------------------------------------
export function spellPlugin(options: SpellPluginOptions): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: SPELL_PLUGIN_KEY,
    state: {
      init: () => DecorationSet.empty,
      apply(tr: Transaction, value: DecorationSet) {
        const fresh = tr.getMeta(SPELL_PLUGIN_KEY) as DecorationSet | undefined;
        if (fresh) return fresh;
        return tr.docChanged ? value.map(tr.mapping, tr.doc) : value;
      },
    },
    props: {
      decorations: (state) => SPELL_PLUGIN_KEY.getState(state),
      // Ctrl/⌘ + . sur un mot souligné : même panneau que le clic droit, sans quitter le clavier
      // (convention « correction rapide » des éditeurs de code).
      handleKeyDown: (view, event) => {
        if (event.key !== "." || !(event.ctrlKey || event.metaKey)) return false;
        const lang = options.getLang();
        if (!lang) return false;
        const hit = badWordAt(view.state, view.state.selection.from);
        if (!hit) return false;
        event.preventDefault();
        options.onTarget({ ...hit, lang, view, getRect: () => rectBetween(view, hit.from, hit.to) });
        return true;
      },
      handleDOMEvents: {
        // Le menu contextuel natif est supprimé partout dans l'app : c'est donc NOTRE infobulle qui
        // porte les corrections. On coupe la propagation pour que le menu global ne s'ouvre pas.
        contextmenu: (view, event) => {
          const lang = options.getLang();
          if (!lang) return false;
          const mouse = event as MouseEvent;
          const at = view.posAtCoords({ left: mouse.clientX, top: mouse.clientY });
          const hit = at ? badWordAt(view.state, at.pos) : null;
          if (!hit) return false;
          event.preventDefault();
          event.stopPropagation();
          options.onTarget({
            ...hit,
            lang,
            view,
            getRect: () => rectBetween(view, hit.from, hit.to),
          });
          return true;
        },
      },
    },
    view(view) {
      let timer = 0;
      let destroyed = false;

      const run = async () => {
        const lang = options.getLang();
        if (!lang) {
          if (SPELL_PLUGIN_KEY.getState(view.state)?.find().length) {
            view.dispatch(view.state.tr.setMeta(SPELL_PLUGIN_KEY, DecorationSet.empty));
          }
          return;
        }
        const doc = view.state.doc;
        const tokens = collectTokens(doc);
        const bad = await spell.check(lang, wordsOf(tokens));
        // Le document a bougé pendant l'attente : les bornes ne valent plus rien, on refait un tour.
        if (destroyed || view.state.doc !== doc) { schedule(); return; }
        view.dispatch(view.state.tr.setMeta(SPELL_PLUGIN_KEY, decorate(badRanges(tokens, bad), doc)));
      };

      const schedule = () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => { void run(); }, IDLE_MS);
      };

      // Dictionnaire chargé, mot appris ou ignoré → les verdicts changent, on repasse sur le document.
      const unsubscribe = spell.subscribe(schedule);
      const lang = options.getLang();
      if (lang) spell.preload(lang);
      schedule();

      return {
        // Comparaison d'IDENTITÉ, pas `doc.eq` : les documents ProseMirror sont immuables, et une
        // comparaison structurelle à chaque transaction coûterait un parcours complet par frappe.
        update: (_view, prevState) => { if (prevState.doc !== view.state.doc) schedule(); },
        destroy: () => {
          destroyed = true;
          window.clearTimeout(timer);
          unsubscribe();
        },
      };
    },
  });
}

/** Rectangle écran couvrant [from, to) — l'ancre de l'infobulle, recalculée au scroll. */
export function rectBetween(view: EditorView, from: number, to: number): DOMRect | null {
  try {
    const start = view.coordsAtPos(from);
    const end = view.coordsAtPos(to);
    const left = Math.min(start.left, end.left);
    const top = Math.min(start.top, end.top);
    return new DOMRect(left, top, Math.max(1, Math.max(start.right, end.right) - left), Math.max(1, Math.max(start.bottom, end.bottom) - top));
  } catch {
    return null; // position démontée entre-temps → l'infobulle se referme
  }
}

/** Extension Tiptap enveloppant le plugin (BlockNote via `_tiptapOptions`, Script via extensions). */
export const SpellcheckExtension = Extension.create<SpellPluginOptions>({
  name: "nrSpellcheck",
  addOptions() {
    return { getLang: () => null, onTarget: () => {} };
  },
  addProseMirrorPlugins() {
    return [spellPlugin(this.options)];
  },
});
