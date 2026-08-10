// Slice NetsuLab (hub de traitements image/vidéo). Détient le BAC de sélection persistant
// (les sources cochées à travers plusieurs dossiers atterrissent ici, désélection depuis le bac)
// + la chaîne ordonnée. Le mode d'op (upscale/interp/depth/removebg) reste dans la slice `process`.
import { type StateCreator } from "zustand";
import { type AppState } from "./index";
import { type PipelineOpKind } from "@/lib/bridge";
import { type UpSource } from "@/components/upscale/upscaleShared";

// Étape d'une chaîne ordonnée (transform vidéo→vidéo). `settings` = réglages figés de l'étape.
interface NlChainStep { id: string; kind: PipelineOpKind; settings: Record<string, unknown>; }

let _stepSeq = 0;
const stepId = () => `step-${Date.now().toString(36)}-${(_stepSeq++).toString(36)}`;

let _srcSeq = 0;
const srcUid = () => `src-${Date.now().toString(36)}-${(_srcSeq++).toString(36)}`;
// Chaque entrée du bac porte un uid stable (posé ici, jamais recalculé) — identité d'aperçu.
const withUid = (s: UpSource): UpSource => (s.uid ? s : { ...s, uid: srcUid() });

// Clé d'identité d'une source (mêmes règles que useProcSources.srcKey) : chemin seul pour un fichier
// entier, chemin + portion pour un plan de timeline (plans distincts du même fichier = sources distinctes).
export const nlSrcKey = (s: { path: string; in?: number; out?: number }): string =>
  (s.in != null && s.out != null) ? `${s.path}#${s.in.toFixed(3)}-${s.out.toFixed(3)}` : s.path;

export interface NetsulabSlice {
  // Bac de sélection : la vérité unique des sources cochées, partagée navigateur ↔ bac ↔ ops.
  nlSources: UpSource[];
  // Source aperçue (index dans nlSources). Suit la dernière source cochée ; reclampé au retrait.
  nlActiveIdx: number;
  // Nonce d'intention de LECTURE : incrémenté par un choix d'aperçu explicite (clic bac, chevrons)
  // → le lecteur lance la lecture en boucle. Cocher une source (nlToggleSource) ne l'incrémente pas
  // → l'aperçu change mais reste en pause (la sélection ne relance jamais la lecture).
  nlPlayNonce: number;

  // Chaîne ordonnée de transforms (upscale/interpolate) : vide = mode op unique.
  nlChain: NlChainStep[];
  nlChainMode: boolean;   // false = op unique (défaut), true = éditer/lancer une chaîne
  nlRoto: boolean;        // true = Roto Studio (segmentation interactive) au centre à la place des ops

  nlSetActiveIdx: (i: number) => void;
  nlSetRoto: (on: boolean) => void;
  // Rogne une source du bac (in/out en secondes) — null efface (source = clip entier). Marche pour
  // chaque source, y compris en multi-sélection ; jobFor lit l'in/out par source au run.
  nlSetSourceRange: (idx: number, inS: number | null, outS: number | null) => void;
  nlSetChainMode: (on: boolean) => void;
  nlAddStep: (kind: PipelineOpKind, settings: Record<string, unknown>) => void;
  nlRemoveStep: (id: string) => void;
  nlMoveStep: (id: string, dir: -1 | 1) => void;
  nlClearChain: () => void;
  // Bascule une source (ajout si absente, retrait sinon) — dédup par clé. Cocher rend la source
  // ACTIVE (aperçue au centre immédiatement) → feedback direct de ce qui vient d'être sélectionné.
  nlToggleSource: (s: UpSource) => void;
  // Ajout en lot dédupliqué par clé (glisser-déposer, « tout ajouter ») ; la dernière ajoutée devient active.
  nlAddSources: (items: UpSource[]) => void;
  // Retrait ciblé depuis le bac (croix sur une puce).
  nlRemoveSource: (key: string) => void;
  // Retrait EN LOT (désélectionner tous les plans d'une timeline d'un coup — une seule maj du store).
  nlRemoveSources: (keys: string[]) => void;
  nlClearSources: () => void;
}

export const createNetsulabSlice: StateCreator<AppState, [], [], NetsulabSlice> = (set) => ({
  nlSources: [],
  nlActiveIdx: 0,
  nlPlayNonce: 0,
  nlChain: [],
  nlChainMode: false,
  nlRoto: false,

  // Choix d'aperçu explicite → intention de lecture (le lecteur démarre en boucle sur la source).
  nlSetActiveIdx: (nlActiveIdx) => set((s) => ({ nlActiveIdx, nlPlayNonce: s.nlPlayNonce + 1 })),
  nlSetRoto: (nlRoto) => set({ nlRoto }),
  nlSetSourceRange: (idx, inS, outS) => set((s) => {
    if (idx < 0 || idx >= s.nlSources.length) return {};
    const nlSources = s.nlSources.slice();
    const src = nlSources[idx];
    // null/null (ou plage vide) → efface le rognage (source = clip entier). uid conservé
    // (identité d'aperçu stable : rogner/dérogner ne recharge pas le lecteur).
    nlSources[idx] = (inS == null || outS == null || outS <= inS)
      ? { name: src.name, path: src.path, uid: src.uid }
      : { ...src, in: inS, out: outS };
    return { nlSources };
  }),
  nlSetChainMode: (nlChainMode) => set({ nlChainMode }),

  nlAddStep: (kind, settings) => set((s) => ({ nlChain: [...s.nlChain, { id: stepId(), kind, settings }] })),
  nlRemoveStep: (id) => set((s) => ({ nlChain: s.nlChain.filter((x) => x.id !== id) })),
  nlMoveStep: (id, dir) => set((s) => {
    const i = s.nlChain.findIndex((x) => x.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= s.nlChain.length) return {};
    const chain = s.nlChain.slice();
    [chain[i], chain[j]] = [chain[j], chain[i]];
    return { nlChain: chain };
  }),
  nlClearChain: () => set({ nlChain: [] }),

  nlToggleSource: (c) => set((s) => {
    const k = nlSrcKey(c);
    const i = s.nlSources.findIndex((x) => nlSrcKey(x) === k);
    if (i < 0) {
      // Ajout → la nouvelle source devient l'aperçu (SANS intention de lecture : cocher ne relance
      // jamais la lecture, le lecteur charge la source en pause sur son point d'entrée).
      return { nlSources: [...s.nlSources, withUid(c)], nlActiveIdx: s.nlSources.length };
    }
    const nlSources = s.nlSources.filter((_, j) => j !== i);
    // Retrait → l'index actif suit la même source si possible, sinon se reclampe.
    const nlActiveIdx = Math.max(0, Math.min(s.nlActiveIdx > i ? s.nlActiveIdx - 1 : s.nlActiveIdx, nlSources.length - 1));
    return { nlSources, nlActiveIdx };
  }),

  nlAddSources: (items) => set((s) => {
    const known = new Set(s.nlSources.map(nlSrcKey));
    const add = items.filter((a) => !known.has(nlSrcKey(a))).map(withUid);
    if (!add.length) return {};
    const nlSources = [...s.nlSources, ...add];
    return { nlSources, nlActiveIdx: nlSources.length - 1 };
  }),

  nlRemoveSource: (key) => set((s) => {
    const i = s.nlSources.findIndex((x) => nlSrcKey(x) === key);
    if (i < 0) return {};
    const nlSources = s.nlSources.filter((_, j) => j !== i);
    const nlActiveIdx = Math.max(0, Math.min(s.nlActiveIdx > i ? s.nlActiveIdx - 1 : s.nlActiveIdx, nlSources.length - 1));
    return { nlSources, nlActiveIdx };
  }),

  nlRemoveSources: (keys) => set((s) => {
    const drop = new Set(keys);
    const nlSources = s.nlSources.filter((x) => !drop.has(nlSrcKey(x)));
    if (nlSources.length === s.nlSources.length) return {};
    const nlActiveIdx = Math.max(0, Math.min(s.nlActiveIdx, nlSources.length - 1));
    return { nlSources, nlActiveIdx };
  }),

  nlClearSources: () => set({ nlSources: [], nlActiveIdx: 0 }),
});
