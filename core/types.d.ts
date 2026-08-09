// Formes de données partagées du core (référencées en JSDoc via `import('./types').X`).
// Vérif de types entre modules sans changer le runtime (cf. tsconfig.core.json + `// @ts-check`).

/** Plage source d'un plan à poser sur la timeline. Soit en frames (`inFrame`/`outFrame`, prioritaires),
 *  soit en secondes (`in`/`out`) converties au fps du clip. `outFrame`/`out` = inclusifs côté appelant. */
export interface Segment {
  in?: number;
  out?: number;
  inFrame?: number;
  outFrame?: number;
}

/** Un plan détecté (sortie detect.py / cache). Frames prioritaires sur secondes. `endFrame` inclusif. */
export interface Scene {
  start?: number;
  end?: number;
  startFrame?: number;
  endFrame?: number;
}

/** Options de `buildTimeline`. */
export interface BuildTimelineOpts {
  name: string;
  input: string;
  segments?: Segment[];
  srcFrames?: number | string;
  mode?: "new" | "append";
  /** Timeline visée en mode "append" : nom exact. Absent/introuvable → la timeline ouverte. */
  timelineName?: string;
  whole?: boolean;
  /** Destination : "timeline" (racine, défaut) ou "bin" → range la timeline dans un dossier Media Pool. */
  dest?: "timeline" | "bin";
  /** Nom du dossier Media Pool cible quand dest === "bin". */
  binName?: string;
  /** Vidéo seule : n'importe que la piste vidéo (mediaType 1), pas d'audio. */
  videoOnly?: boolean;
  /** Placement when appending to an existing timeline. */
  insertion?: "insert" | "overwrite" | "replace" | "fit" | "above" | "end" | "ripple_overwrite";
  /** Couleur de clip Resolve par segment (parallèle à `segments`) — code-couleur des découpes. */
  colors?: string[];
}
