// Formes de données partagées de la pipeline d'export AE (timelineRead → prepareMedia → aeExport).
// Référencées en JSDoc via `import('./types.js').X` → tsc (@ts-check) vérifie les champs entre modules
// sans changer le runtime. Champs optionnels = peuvent manquer selon la branche (rendu / freeze / bake).

export type ClipKind = "video" | "audio";

/** Un plan lu sur la timeline (sortie de `collect`/`readTimelineEdit`). */
export interface ClipItem {
  kind: ClipKind;
  track: number;
  path: string;
  name: string;
  fpsClip: number;
  srcFrames: number;
  /** Dimensions de la source ; 0 = inconnues. Le point d'ancrage s'y rapporte. */
  srcWidth?: number;
  srcHeight?: number;
  srcIn: number;
  srcOut: number;
  tlStart: number;
  tlEnd: number;
  /** Transform Resolve (vidéo seulement), `null` si identité/indispo. */
  xf: Record<string, number> | null;
  /**
   * Propriétés ANIMÉES lues dans l'export FCP7 XML (l'API n'expose aucune image clé), dans la
   * convention du document d'échange : position en pixels de timeline depuis le centre (Y vers le
   * bas), échelle en facteur, ancrage en pixels source depuis le coin haut-gauche.
   */
  anim?: Record<string, { value: any; keyframes: { frame: number; value: any; interpolation?: string }[] }>;
  /** Objet TimelineItem conservé uniquement pendant la projection vers le document NetsuBridge. */
  nativeItem?: any;
  group?: string;
  freeze?: boolean;
  reverse?: boolean;
  retimed?: boolean;
  /** Issu d'une timeline imbriquée (pas de remux). */
  nested?: boolean;
  /** Timeline imbriquée rendue par Resolve en un fichier unique. */
  rendered?: boolean;
  /** Format audio forcé (timeline imbriquée audio seule) : wav | aiff | aac. */
  aFmt?: string;
}

/** Précompo issue d'une timeline imbriquée (mode 'comp'). */
export interface Group {
  id: string;
  name: string;
  w: number;
  h: number;
  fps: number;
  nestedStart: number;
  winStart: number;
  parentTlStart: number;
  parentTlEnd: number;
}

/** Lecture réussie d'une timeline. */
export interface EditOk {
  ok: true;
  timeline: string;
  fps: number;
  width: number;
  height: number;
  startFrame: number;
  endFrame: number;
  items: ClipItem[];
  /** Plans dont le FICHIER est absent : une source à retrouver sur le disque. */
  missing: string[];
  /** Éléments sans média par nature (titres Text+, générateurs Fusion) : rien à retrouver. */
  generators?: string[];
  groups: Group[];
  /** Plans dont au moins une propriété animée a été greffée depuis l'export FCP7 XML. */
  animated?: number;
}

/** Résultat de `readTimelineEdit` : succès complet ou échec `{ ok:false, error }`. */
export type EditResult = EditOk | { ok: false; error: string };

/** Plan préparé sur disque (sortie de `prepareMedia`) : ClipItem + cible fichier. */
export interface PreparedClip extends ClipItem {
  /** Fichier à importer dans AE (source liée, remux, réencode, still…). */
  file: string;
  /** Frame d'entrée DANS le fichier préparé (0 si trimmé/rendu). */
  fileInFrame: number;
  /** Freeze extrait en .png (still tenu sur l'occupation). */
  freezeStill?: boolean;
  /** Réencodé à la vitesse timeline (pose 1:1, pas de time-remap). */
  baked?: boolean;
  /** Durée d'occupation du plan baked (secondes). */
  bakedDur?: number;
  /** Cadrage (zoom/pan/rotation/recadrage/miroir) rendu DANS le fichier : rien à reposer dans AE. */
  xfBaked?: boolean;
}
