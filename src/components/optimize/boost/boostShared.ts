// Données et helpers de l'onglet NetsuBoost côté Premiere Pro / After Effects.
//
// Toutes les listes d'opérations ci-dessous sont alignées sur les chaînes ACCEPTÉES par les jsx
// (`adobe-cep/jsx/host-ppro.jsx`, `host-aeft.jsx`) : une valeur inventée ici produirait un
// « opération inconnue » côté hôte, visible seulement au runtime — c'est-à-dire jamais ici.
import { Database, FolderClock, HardDrive, Film, AudioWaveform, Save } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { AdobeApp, BoostCacheKind, BoostCacheRoot, BoostDiagnosis } from "@/lib/bridge";

export type { AdobeApp };

/** Première génération où Premiere Pro fait d'UXP le standard : ExtendScript n'y reçoit plus de
 *  travaux et son support s'arrête en septembre 2026, donc tout ce qui passe par le QE DOM peut
 *  cesser de répondre d'un build à l'autre. After Effects n'a pas d'UXP et n'est pas concerné. */
const UXP_ERA_YEAR = 2026;

const FIRST_YEAR_ALIGNED_MAJOR = 22; // depuis 22.x, le numéro majeur EST le millésime moins 2000
const YEAR_IN_PATH = /\b(20\d\d)\b/;

/** Millésime de l'hôte, ou `null` faute de source. La version rapportée par l'extension prime ; à
 *  défaut le chemin d'installation le porte, seule source quand l'extension ne se charge pas. */
export function hostYear(diag: BoostDiagnosis | null): number | null {
  const major = parseInt(String(diag?.live?.appVersion ?? ""), 10);
  if (major >= FIRST_YEAR_ALIGNED_MAJOR) return 2000 + major;
  const fromPath = diag?.exe?.match(YEAR_IN_PATH);
  return fromPath ? Number(fromPath[1]) : null;
}

/** Hôte de l'ère UXP : Premiere Pro 2026 ou plus récent, où ExtendScript et CEP ne sont plus la
 *  voie par défaut — l'extension peut ne pas se charger et la purge par script n'est plus garantie. */
export function isUxpEraHost(app: AdobeApp, diag: BoostDiagnosis | null): boolean {
  const year = hostYear(diag);
  return app === "ppro" && year != null && year >= UXP_ERA_YEAR;
}

/** Icône par nature de cache. */
const KIND_ICONS: Record<BoostCacheKind, LucideIcon> = {
  mediaCache: Film,
  mediaCacheDb: Database,
  peak: AudioWaveform,
  diskCache: HardDrive,
  autoSave: Save,
  previews: FolderClock,
};

export function cacheIcon(kind: BoostCacheKind): LucideIcon {
  return KIND_ICONS[kind] || HardDrive;
}

/** Racines dont l'identifiant est FIXE côté core et mérite donc son propre libellé. */
const NAMED_ROOTS = new Set([
  "mediaCacheFiles",
  "mediaCacheDb",
  "peakFiles",
  "videoPreviews",
  "audioPreviews",
  "aeProjectAutoSave",
]);

/** Clé i18n du libellé d'une racine.
 *  Deux identifiants sont FORGÉS À L'EXÉCUTION par le core et ne peuvent donc pas avoir de clé à eux :
 *  le cache disque d'AE quand il y en a plusieurs (`aeDiskCache`, `aeDiskCache1`…) et les sauvegardes
 *  automatiques de Premiere, une par version installée (`autoSave-25.0`). Les normaliser évite
 *  d'afficher la clé brute — le chemin affiché juste dessous porte déjà la version. */
export function rootLabelKey(id: string, kind: BoostCacheKind): string {
  if (NAMED_ROOTS.has(id)) return `boost.cache.roots.${id}`;
  if (id.startsWith("aeDiskCache")) return "boost.cache.roots.aeDiskCache";
  if (id.startsWith("autoSave")) return "boost.cache.roots.autoSave";
  return `boost.cache.kinds.${kind}`;
}

/** Purger la BASE du media cache force un reconform long de tous les médias : jamais coché d'office,
 *  toujours accompagné de son avertissement. */
export function isSlowToRebuild(kind: BoostCacheKind): boolean {
  return kind === "mediaCacheDb";
}

/** Les caches communs (PPro/AE/AME/Audition) d'abord : ce sont eux qui pèsent et qui profitent à
 *  plusieurs applications d'un coup. Les données utilisateur (auto-saves) ferment la marche. */
export function sortRoots(roots: BoostCacheRoot[]): BoostCacheRoot[] {
  const rank = (r: BoostCacheRoot) => (!r.regenerable ? 2 : r.shared ? 0 : 1);
  return [...roots].sort((a, b) => rank(a) - rank(b) || (b.size || 0) - (a.size || 0));
}

/** Tranches d'ancienneté proposées à la purge. Miroir d'`AGE_BUCKETS` (core/adobeCache.js) : les
 *  poids affichés viennent de `buckets`, un filtre sans tranche correspondante n'aurait rien à dire.
 *  `0` = tout purger. */
export const AGE_FILTERS = [0, 7, 30, 90] as const;
export type AgeFilter = (typeof AGE_FILTERS)[number];

/** Cibles de purge mémoire After Effects. Chaînes attendues par `nrAeftPurgeTargets`. */
export interface PurgeTargetDef {
  id: string;
  /** Purge le cache DISQUE en plus de la RAM : long à reconstruire, et le dialogue AE n'est neutralisé
   *  qu'au mieux (`beginSuppressDialogs` en try/catch). D'où l'isolement et l'avertissement. */
  heavy?: boolean;
}
export const AEFT_PURGE_TARGETS: PurgeTargetDef[] = [
  { id: "memory" },
  { id: "image" },
  { id: "undo" },
  { id: "snapshot" },
  { id: "all", heavy: true },
];

/** Opérations d'hygiène projet, par hôte. AE : `removeUnusedFootage` / `consolidateFootage`.
 *  Premiere : `consolidateDuplicates` seule (rien d'autre n'est exposé par son DOM). */
export interface HygieneDef {
  id: string;
  /** L'hôte renvoie un nombre d'éléments touchés → on peut l'afficher. */
  counts: boolean;
}
const HYGIENE: Record<AdobeApp, HygieneDef[]> = {
  aeft: [
    { id: "removeUnused", counts: true },
    { id: "consolidate", counts: true },
  ],
  ppro: [{ id: "consolidateDuplicates", counts: false }],
};

export function hygieneOps(app: AdobeApp): HygieneDef[] {
  return HYGIENE[app];
}
