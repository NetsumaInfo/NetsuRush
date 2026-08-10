// Modèle partagé du Roto Studio : objets multi (id + couleur) et formats d'export.
// ROTO_COLORS = MIROIR de PALETTE dans python/nrroto/overlay.py (l'overlay est rendu côté python).

const ROTO_COLORS = ["#22c55e", "#3b82f6", "#f97316", "#e11d48", "#a855f7", "#eab308"];

export const colorOf = (obj: number) => ROTO_COLORS[(obj - 1) % ROTO_COLORS.length];

// Modèles de segmentation sélectionnables (mêmes ids que le registre/manifeste). Le picker n'affiche
// que ceux réellement installés (statut via nr.modelsList). Libellés = NOM EXACT des poids tirés par
// core/models.js (facebook/sam2.1-hiera-*).
export const SAM_MODELS: { id: string; label: string; hintKey: string }[] = [
  { id: "sam3.1", label: "SAM 3.1", hintKey: "sam.sam31" },
  { id: "sam2.1-large", label: "SAM 2.1 Hiera Large", hintKey: "sam.large" },
  { id: "sam2.1", label: "SAM 2.1 Hiera Base+", hintKey: "sam.base" },
  { id: "samurai", label: "SAMURAI", hintKey: "sam.samurai" },
  { id: "sam2long", label: "SAM2Long", hintKey: "sam.sam2long" },
  { id: "sam2.1-small", label: "SAM 2.1 Hiera Small", hintKey: "sam.small" },
  { id: "sam2.1-tiny", label: "SAM 2.1 Hiera Tiny", hintKey: "sam.tiny" },
  { id: "edgetam", label: "EdgeTAM", hintKey: "sam.edgetam" },
];

export interface RotoObject {
  id: number;        // id SAM (1..n), stable pour la session
  name: string;      // renommable (organisation des exports)
}

export interface RotoPoint { x: number; y: number; label: 0 | 1; obj: number; }

// Post-traitement NON destructif du masque (overlay live + cuit à l'export). Unités = pixels
// (grow ±, feather rayon, border bande, smooth rayon) ou taille max en px (trous/poussières :
// aire ≤ v²). gamma = densité d'alpha (1 = neutre). 0 / 1.0 = inactif.
export interface RotoPostState {
  grow: number; feather: number; holes: number; dots: number;
  border: number; smooth: number; gamma: number;
}
export const DEFAULT_POST: RotoPostState = { grow: 0, feather: 0, holes: 0, dots: 0, border: 0, smooth: 0, gamma: 1 };
export const isDefaultPost = (p: RotoPostState) =>
  !p.grow && !p.feather && !p.holes && !p.dots && !p.border && !p.smooth && Math.abs(p.gamma - 1) < 1e-3;

// Modes d'affichage du masque (rendu côté python ; l'opacité de l'overlay edit = CSS client).
export type RotoViewMode = "edit" | "matte" | "alpha" | "bgcolor";
export interface RotoViewState { mode: RotoViewMode; outline: boolean; bg: string; opacity: number; }
export const DEFAULT_VIEW: RotoViewState = { mode: "edit", outline: false, bg: "#00ff00", opacity: 100 };
export const VIEW_MODES: { id: RotoViewMode; labelKey: string; hintKey: string }[] = [
  { id: "edit", labelKey: "viewMode.editLabel", hintKey: "viewMode.editHint" },
  { id: "matte", labelKey: "viewMode.matteLabel", hintKey: "viewMode.matteHint" },
  { id: "alpha", labelKey: "viewMode.alphaLabel", hintKey: "viewMode.alphaHint" },
  { id: "bgcolor", labelKey: "viewMode.bgcolorLabel", hintKey: "viewMode.bgcolorHint" },
];

// Moteurs de suppression d'objet (pilotés par le masque roto). MiniMax est le seul câblé ;
// DiffuEraser = repo à installer (sélectionnable, moteur à venir).
// ⚠️ L'ORDRE compte : EngineRow présélectionne engines[0].
// ⚠️ Depuis le retrait de Big LaMa, la tâche n'a PLUS de moteur permissif — c'est la seule exception
// à l'invariant NC de lib/modelRegistry, assumée : Big LaMa reconstruisait image par image et son
// scintillement rendait le résultat inutilisable en vidéo.
export const REMOVE_ENGINES: { id: string; label: string; hint: string }[] = [
  { id: "minimax-remover", label: "MiniMax-Remover", hint: "Diffusion en 6 étapes environ, cohérente dans le temps — plus propre sur les fonds en mouvement." },
  { id: "diffueraser", label: "DiffuEraser", hint: "Suppression d’objet dans la vidéo. Moteur non connecté." },
];

// Réglages de suppression d'objet. `steps` et `quality` ne concernent QUE la diffusion MiniMax ;
// `grow`, `plate`, `harmonize` et `grain` valent pour les deux moteurs.
// Défauts choisis pour que la zone effacée soit indiscernable sans réglage : la plaque propre
// récupère le fond réellement filmé (donc exact), le raccord rattrape la dérive du modèle, et le
// grain s'auto-annule sur une source propre puisqu'il est mesuré sur le voisinage.
// Deux familles à ne pas confondre : ce qui décrit le MASQUE (grow, plate, harmonize, grain) et ce
// qui pilote le MODÈLE (steps, quality, seed, window, overlap, vaeTiling, cpuOffload).
export interface RotoRemoveParams {
  steps: number; grow: number; quality: number;
  plate: boolean; harmonize: number; grain: number;
  seed: number; window: number; overlap: number; vaeTiling: boolean; cpuOffload: boolean;
}
export const DEFAULT_REMOVE_PARAMS: RotoRemoveParams = {
  steps: 12, grow: 8, quality: 704, plate: true, harmonize: 85, grain: 100,
  // Graine FIXE par défaut : sans elle deux lancements identiques donnent deux résultats
  // différents, donc un remplissage réussi ne peut pas être rejoué ni un raté re-tenté à
  // l'identique. Le bouton « autre tirage » sert précisément à en changer volontairement.
  seed: 42, window: 81, overlap: 8, vaeTiling: true, cpuOffload: false,
};
// Paliers de résolution de diffusion, en pixels (côté le plus long traité par le modèle). Plus
// haut = remplissage plus net, mais la VRAM grimpe avec le carré de la dimension ; le sidecar
// redescend d'un palier tout seul s'il manque de mémoire.
export const REMOVE_QUALITY_STEPS: { value: number; labelKey: string }[] = [
  { value: 352, labelKey: "remove.qualityTiny" },
  { value: 512, labelKey: "remove.qualityFast" },
  { value: 704, labelKey: "remove.qualityStandard" },
  { value: 960, labelKey: "remove.qualityMax" },
  { value: 1080, labelKey: "remove.qualityUltra" },
];

// Réglages du matte fin. `warmup` = passes de stabilisation sur chaque image d'amorçage (la
// première prédiction d'un segment part d'un masque à bords durs, il faut la laisser se détendre) ;
// `maxSize` = plafond du PETIT côté envoyé au modèle, 0 = pleine résolution.
export interface RotoMatteParams {
  warmup: number; maxSize: number; combined: boolean;
  // Moteurs par lots seulement. `overlap` fond la jonction entre deux lots, qui sauterait sans lui.
  batch: number; overlap: number;
}
export const DEFAULT_MATTE_PARAMS: RotoMatteParams = {
  warmup: 10, maxSize: 0, combined: false, batch: 16, overlap: 2,
};
export const MATTE_SIZE_STEPS: { value: number; labelKey: string }[] = [
  { value: 480, labelKey: "matte.size480" },
  { value: 720, labelKey: "matte.size720" },
  { value: 1080, labelKey: "matte.size1080" },
  { value: 0, labelKey: "matte.sizeFull" },
];

// Moteurs de matte fin (affinent l'alpha du roto, cohérence temporelle).
export const REFINE_ENGINES: { id: string; label: string; hint: string }[] = [
  { id: "matanyone", label: "MatAnyone", hint: "Suivi par mémoire, adapté aux cheveux et aux bords fins." },
  { id: "matanyone2", label: "MatAnyone 2", hint: "Détails plus fins et meilleure robustesse que la v1." },
  { id: "videomama", label: "VideoMaMa", hint: "Diffusion par lots — bords très fins, plus lent et plus gourmand." },
];

// Moteurs qui traitent par LOTS au lieu de propager une mémoire (miroir de VIDEOMAMA_ENGINES côté
// python). Ils n'ont ni amorçage ni stabilisation : leurs réglages sont la taille du lot et son
// recouvrement, et afficher ceux de l'autre famille laisserait croire qu'ils agissent.
export const BATCHED_REFINE = new Set(["videomama"]);

export const EXPORT_FORMATS: { id: string; label: string; hint: string }[] = [
  { id: "prores_4444", label: "ProRes 4444 (alpha)", hint: "Vidéo + couche alpha — montage (Resolve/AE)" },
  { id: "webm_alpha", label: "WebM VP9 (alpha)", hint: "Léger, avec alpha — web et aperçu" },
  { id: "ffv1_alpha", label: "FFV1 (alpha, sans perte)", hint: "Sans perte, avec alpha — archivage MKV" },
  { id: "matte_mp4", label: "Masque N&B (MP4)", hint: "Masque noir et blanc seul" },
  { id: "bgcolor_mp4", label: "Fond couleur (MP4)", hint: "Objet composé sur la couleur de fond du mode d'affichage" },
  { id: "png_seq", label: "Séquence PNG (masque)", hint: "Une image de masque par image vidéo" },
];
