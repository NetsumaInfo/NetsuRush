// Vocabulaire partagé de Paramètres › Stockage : icône et famille de chaque type de cache.
// `fmtBytes` vient d'optimizeShared — même problème, même formateur (pas de second exemplaire).
import { HardDrive, Image, Film, AudioLines, FlaskConical, Lasso, Scissors, Captions, Sparkles, Images, SmilePlus } from "lucide-react";
import type { ComponentType, CSSProperties } from "react";
import { CACHE_KIND_LIST, type CacheKind } from "@/lib/bridge";

/** Signature commune des icônes lucide employées ici : `style` sert à teinter par type (KIND_TINT). */
type IconCmp = ComponentType<{ className?: string; style?: CSSProperties }>;

export { fmtBytes } from "@/components/optimize/optimizeShared";
export { CACHE_KIND_LIST };
export type { CacheKind };

export const KIND_ICON: Record<CacheKind, IconCmp> = {
  thumb: Image,
  proxy: Film,
  voice: AudioLines,
  upscaleTest: FlaskConical,
  roto: Lasso,
  scenes: Scissors,
  transcripts: Captions,
  embeddings: Sparkles,
  indexThumbs: Images,
  faces: SmilePlus,
};

export const STORAGE_ICON = HardDrive;

/** Types stockés en base plutôt qu'en fichiers. Ils n'ont pas de suivi d'usage par entrée → pas
 *  d'auto-purge possible (l'UI le dit au lieu de proposer un réglage inerte). Miroir de
 *  cacheDb.DB_KINDS (core). */
export const DB_KINDS: CacheKind[] = ["scenes", "transcripts", "embeddings", "indexThumbs", "faces"];
export const isDbKind = (k: CacheKind) => DB_KINDS.includes(k);

/** Types en base qui appartiennent quand même à la famille des APERÇUS : leur contenu se refabrique
 *  en quelques secondes d'ffmpeg, sans modèle ni GPU. Les ranger avec les analyses coûteuses laissait
 *  croire qu'on perdait des heures de calcul en vidant 150 Mo de vignettes. Miroir de
 *  cacheDb.REUSABLE_DB_KINDS (core, qui fait foi). */
export const DB_REUSABLE_KINDS: CacheKind[] = ["indexThumbs"];

/** Analyses coûteuses à recalculer : les types en base moins ceux qui relèvent des aperçus. */
export const isDurableKind = (k: CacheKind) => isDbKind(k) && !DB_REUSABLE_KINDS.includes(k);

/** Fichiers de travail utiles seulement pendant l'app ouverte. Le core les place sous une racine
 * unique supprimée à la fermeture et au boot suivant après crash. */
export const SESSION_KINDS: CacheKind[] = ["voice", "upscaleTest", "roto"];
export const isSessionKind = (k: CacheKind) => SESSION_KINDS.includes(k);

/** Types dont la régénération coûte cher (heures de GPU) → confirmation renforcée avant purge.
 *  `indexThumbs` en est EXCLU : un simple passage d'indexation les régénère à l'ffmpeg, sans modèle. */
export const EXPENSIVE_KINDS: CacheKind[] = ["embeddings", "faces", "transcripts"];
export const isExpensive = (kinds: CacheKind[] | undefined) => !!kinds && kinds.some((k) => EXPENSIVE_KINDS.includes(k));

/** Teinte d'un type : icône de sa rangée et segment de la barre de répartition.
 *
 *  Prise dans les SEULS tokens de marque destinés au premier plan — `--color-primary`, `--color-ok`,
 *  `--color-warn`, `--color-fg`. `--color-accent` est une couleur de SURFACE (le fond des rangées
 *  survolées, `#1a2030` sur le thème sombre) et `--color-muted` la couleur du texte secondaire :
 *  posées sur une icône, elles la peignaient à la teinte du panneau — cinq types sur dix
 *  s'affichaient donc sans icône visible.
 *
 *  Deux types de la MÊME famille partagent leur teinte à dessein : `thumb` et `indexThumbs` sont
 *  désormais les mêmes images (cf. `core/thumbs.js` — source unique des vignettes de l'app). Ce qui
 *  distingue deux rangées voisines reste leur glyphe, jamais la seule couleur. */
export const KIND_TINT: Record<CacheKind, string> = {
  thumb: "var(--color-primary)",
  indexThumbs: "var(--color-primary)",
  proxy: "var(--color-ok)",
  roto: "var(--color-primary)",
  upscaleTest: "var(--color-warn)",
  voice: "var(--color-ok)",
  scenes: "var(--color-warn)",
  embeddings: "var(--color-primary)",
  transcripts: "var(--color-ok)",
  faces: "var(--color-fg)",
};

const GB = 1024 * 1024 * 1024;
export const gbToBytes = (gb: number) => gb * GB;
export const bytesToGb = (b: number) => b / GB;
