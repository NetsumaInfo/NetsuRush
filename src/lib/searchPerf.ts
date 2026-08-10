// Options de performance de la recherche. Miroir EXACT de `python/nrsearch/config.py` : les deux
// listes de valeurs doivent rester alignées, sinon l'interface propose un réglage que le sidecar
// écarte en silence. Le core ne fait que traduire ces clés en variables d'environnement
// (`core/prefs.js#perfEnv`), donc rien ici ne connaît le nom des variables.
//
// Module PUR (aucun import du store) : la carte des options sert aussi bien au panneau des
// Paramètres qu'aux bascules rapides de la recherche.

export type VramProfile = "economy" | "balanced" | "performance";

export interface SearchPerfSettings {
  /** Un seul process ffmpeg par plan au lieu d'un par image. Mêmes pixels, donc mêmes vecteurs. */
  shotDecode: boolean;
  /** Accélérer ONNX Runtime par le GPU (visages, dictée). Coupé = repli processeur. */
  onnxGpu: boolean;
  /** Plafonds mémoire de l'indexation : processus de décodage, taille de batch, taille de lot. */
  vramProfile: VramProfile;
  /** Résolution d'analyse SigLIP 2 naflex (patches par image). 256 = le défaut du modèle. */
  maxPatches: number;
}

export const DEFAULT_SEARCH_PERF: SearchPerfSettings = {
  shotDecode: true,
  onnxGpu: true,
  vramProfile: "balanced",
  maxPatches: 256,
};

export const VRAM_PROFILES: VramProfile[] = ["economy", "balanced", "performance"];

// Puissances de deux et leurs milieux : au-delà de 1024 le modèle naflex ne suit plus, en dessous de
// 128 l'image est trop grossière pour distinguer deux plans proches.
export const MAX_PATCHES_CHOICES = [128, 192, 256, 384, 512, 768, 1024];

const STORAGE_KEY = "nr-search-perf.v1";

function normalizeSearchPerf(raw: unknown): SearchPerfSettings {
  const value = (raw && typeof raw === "object" ? raw : {}) as Partial<SearchPerfSettings>;
  const patches = Number(value.maxPatches);
  return {
    shotDecode: typeof value.shotDecode === "boolean" ? value.shotDecode : DEFAULT_SEARCH_PERF.shotDecode,
    onnxGpu: typeof value.onnxGpu === "boolean" ? value.onnxGpu : DEFAULT_SEARCH_PERF.onnxGpu,
    vramProfile: VRAM_PROFILES.includes(value.vramProfile as VramProfile)
      ? (value.vramProfile as VramProfile)
      : DEFAULT_SEARCH_PERF.vramProfile,
    maxPatches: MAX_PATCHES_CHOICES.includes(patches) ? patches : DEFAULT_SEARCH_PERF.maxPatches,
  };
}

export function readSearchPerf(): SearchPerfSettings {
  if (typeof localStorage === "undefined") return { ...DEFAULT_SEARCH_PERF };
  try {
    return normalizeSearchPerf(JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"));
  } catch {
    return { ...DEFAULT_SEARCH_PERF };
  }
}

export function writeSearchPerf(settings: SearchPerfSettings): SearchPerfSettings {
  const next = normalizeSearchPerf(settings);
  if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

/**
 * Une autre résolution d'analyse = un autre tag d'index côté python (`MODEL_TAG` porte le suffixe
 * `@p<N>`), donc un index à construire — et l'index d'origine reste intact si on revient en arrière.
 */
export function needsReindex(settings: SearchPerfSettings): boolean {
  return settings.maxPatches !== DEFAULT_SEARCH_PERF.maxPatches;
}
