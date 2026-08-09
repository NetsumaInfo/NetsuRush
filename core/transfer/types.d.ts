// Contrat d'échange versionné entre hôtes de montage. Un lecteur par hôte produit ce document, un
// écrivain par hôte le consomme. Les champs v2 restent optionnels pour accepter les snapshots v1.

export type TransferHost = "resolve" | "ppro" | "aeft";
export type TransferKind = "video" | "audio";
export type TransferExactness = "exact" | "derived" | "approx" | "unknown";
export type TransferInterpolation = "hold" | "linear" | "bezier" | "unknown";

export interface TransferRational {
  numerator: number;
  denominator: number;
}

export interface TransferPropertySource {
  host: TransferHost;
  api: string;
  exactness: TransferExactness;
  reason?: string;
}

export interface TransferKeyframe<T = number> {
  /** Position relative au début du plan, en frames de timeline. */
  frame: number;
  value: T;
  interpolation?: TransferInterpolation;
  inEase?: { speed?: number; influence?: number };
  outEase?: { speed?: number; influence?: number };
}

export interface TransferAnimated<T = number> {
  value: T;
  keyframes?: TransferKeyframe<T>[];
  source?: TransferPropertySource;
}

export interface TransferPoint {
  x: number;
  y: number;
}

export interface TransferVideoTransform {
  /** Décalage depuis le centre de l'image, en pixels de timeline. */
  position?: TransferAnimated<TransferPoint>;
  /** Facteur d'échelle : 1 = 100 %. */
  scale?: TransferAnimated<TransferPoint>;
  /** Point d'ancrage en pixels source. */
  anchor?: TransferAnimated<TransferPoint>;
  /** Rotation en degrés. */
  rotation?: TransferAnimated<number>;
  opacity?: TransferAnimated<number>;
  flipX?: TransferAnimated<boolean>;
  flipY?: TransferAnimated<boolean>;
  crop?: {
    left?: TransferAnimated<number>;
    right?: TransferAnimated<number>;
    top?: TransferAnimated<number>;
    bottom?: TransferAnimated<number>;
  };
}

export interface TransferVideoProperties {
  transform?: TransferVideoTransform;
}

export interface TransferAudioProperties {
  /** Gain du plan en décibels, quand l'hôte l'expose. */
  gainDb?: TransferAnimated<number>;
  /** Niveau linéaire normalisé : 1 = unité. */
  volume?: TransferAnimated<number>;
  /** Panoramique normalisé : -1 = gauche, 0 = centre, 1 = droite. */
  pan?: TransferAnimated<number>;
  /** Mute du plan, jamais confondu avec le mute de sa piste. */
  mute?: TransferAnimated<boolean>;
}

export interface TransferTiming {
  /** Rapport vitesse source/timeline : 1/1 = vitesse normale. */
  speed: TransferRational;
  reverse: boolean;
  freeze: boolean;
  /** Courbe temporelle optionnelle : valeur = frame source relative. */
  timeMap?: TransferKeyframe<number>[];
  source?: TransferPropertySource;
}

export interface TransferClipIdentity {
  /** Identité native stable quand l'hôte en fournit une. */
  nativeId?: string;
  /** Ordinal stable parmi les plans ayant le même fingerprint. */
  ordinal?: number;
  sourceHost?: TransferHost;
}

/** Un plan monté, exprimé en FRAMES dans les deux espaces (source et timeline). */
export interface TransferClip {
  kind: TransferKind;
  /** Index 1-based DANS son type de piste (V1 et A1 portent tous deux `track: 1`). */
  track: number;
  path: string;
  name: string;
  /** Cadence de la SOURCE — celle de la timeline peut différer (`TransferDoc.fps`). */
  fps: number;
  /** Longueur de la source ; 0 = inconnue (Premiere ne l'expose pas). */
  srcFrames: number;
  /** Dimensions de la SOURCE quand l'hôte les expose ; le point d'ancrage s'y rapporte. */
  srcWidth?: number;
  srcHeight?: number;
  /** Bornes source INCLUSIVES (convention Resolve : startFrame 0 / endFrame 23 = 24 frames). */
  srcIn: number;
  srcOut: number;
  /** Position timeline en frames. `tlEnd` est EXCLUSIF. */
  tlStart: number;
  tlEnd: number;

  identity?: TransferClipIdentity;
  video?: TransferVideoProperties;
  audio?: TransferAudioProperties;
  timing?: TransferTiming;
  /** Ancienne forme Resolve, gardée pendant migration des writers existants. */
  xf?: Record<string, number> | null;
  /** Ticks hôte exacts, utiles au diagnostic et à la réconciliation. */
  hostTicks?: { start?: string; end?: string; in?: string; out?: string };
  /** Exactitude des bornes source ; une timeline imbriquée Premiere repasse par les secondes. */
  trimExactness?: TransferExactness;
  /** Propriétés rencontrées mais volontairement hors du socle natif. */
  deferred?: string[];
}

/**
 * Titre du montage. Ce n'est PAS un plan : aucun fichier, aucune borne source — d'où une liste à
 * part que les écrivains de plans ne voient jamais. La cible le RECRÉE depuis son texte et son
 * style ; il ne traverse donc pas le pont comme un média mais comme une consigne.
 */
export interface TransferGraphic {
  /** Index 1-based de la piste vidéo qui le porte. */
  track: number;
  name: string;
  /** Position timeline en frames. `tlEnd` est EXCLUSIF. */
  tlStart: number;
  tlEnd: number;
  text: string;
  /** Nom de police tel que l'hôte source le nomme ; la cible fait au plus proche. */
  font?: string;
  /** Corps en pixels de la timeline source. */
  size?: number;
  /** Couleur de remplissage en canaux 0..1. */
  color?: { r: number; g: number; b: number };
  transform?: TransferVideoTransform;
}

export interface TransferDoc {
  ok: true;
  /** Version absente = document v1. `upgradeTransferDoc` produit toujours la version 2. */
  version?: 1 | 2;
  host: TransferHost;
  timeline: string;
  fps: number;
  fpsRational?: TransferRational;
  width: number;
  height: number;
  /** Frame de début de la timeline source ; remise à 0 par `normalizeDoc`. */
  startFrame: number;
  endFrame: number;
  clips: TransferClip[];
  /** Fichiers absents du disque. */
  missing: string[];
  /** Éléments SANS média dont rien n'est recréable (cache de couleur, calque d'effet). */
  mediaLess?: string[];
  /** Titres, recréés chez la cible depuis leur texte et leur style. */
  graphics?: TransferGraphic[];
  deferred?: string[];
  /** Provenance des images clés : l'API n'en lit aucune, seul un export d'hôte les porte. */
  animation?: {
    available: boolean;
    /** Plans réellement enrichis. */
    clips?: number;
    /** Plans qu'aucun appariement sûr n'a pu relier (timeline imbriquée aplatie…). */
    unpaired?: number;
    reason?: string;
  };
}

export interface TransferFailure {
  ok: false;
  error: string;
}

export type TransferRead = TransferDoc | TransferFailure;

export interface TransferSummary {
  clips: number;
  video: number;
  audio: number;
  videoTracks: number;
  audioTracks: number;
  durationFrames: number;
  missing: number;
  mediaLess: number;
  graphics: number;
  animated: number;
  transformed: number;
  mixedAudio: number;
  retimed: number;
}

/** Pose d'un plan dans Resolve : ce que `AppendToTimeline` attend, hors `mediaPoolItem`. */
export interface ResolvePlacement {
  startFrame: number;
  endFrame: number;
  recordFrame: number;
  trackIndex: number;
  mediaType: number;
}
